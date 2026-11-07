package ua.svitlo.widget

import org.json.JSONObject
import ua.svitlo.widget.core.KYIV_ZONE
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.util.Locale

data class WeatherLocation(val name: String, val region: String, val latitude: Double, val longitude: Double,
    val district: String = "", val population: Long? = null) {
    init {
        require(name.isNotBlank())
        require(latitude.isFinite() && latitude in -90.0..90.0)
        require(longitude.isFinite() && longitude in -180.0..180.0)
    }

    /** Coordinates distinguish same-name settlements even within the same district. */
    val displayLabel: String get() = buildString {
        append(listOf(name, region, district).filter { it.isNotBlank() }.joinToString(", "))
        append("\n")
        append(String.format(Locale.ROOT, "%.5f, %.5f", latitude, longitude))
        population?.takeIf { it > 0 }?.let { append(" · населення: $it") }
    }
}

data class WeatherHour(val time: Instant, val temperatureC: Double, val weatherCode: Int, val isDay: Boolean)

data class WeatherSnapshot(val location: WeatherLocation, val fetchedAt: Instant, val currentAt: Instant,
    val temperatureC: Double, val weatherCode: Int, val isDay: Boolean, val hourly: List<WeatherHour>,
    val dailyDate: LocalDate, val minC: Double, val maxC: Double, val error: String? = null) {
    fun isFresh(now: Instant = Instant.now()): Boolean = error == null &&
        dailyDate == now.atZone(KYIV_ZONE).toLocalDate() &&
        listOf(fetchedAt, currentAt).all { it >= now.minus(Duration.ofHours(2)) && it <= now.plusSeconds(300) } &&
        nextHours(now).size == 3

    /** Upcoming clock-hour forecasts, never a replacement for current conditions. */
    fun nextHours(now: Instant = Instant.now(), count: Int = 3): List<WeatherHour> =
        hourly.filter { it.time > now }.take(count.coerceIn(0, 24))
}

object WeatherParser {
    fun parse(raw: String, location: WeatherLocation, fetchedAt: Instant): WeatherSnapshot = validated {
        val root = JSONObject(raw)
        require(!root.optBoolean("error", false))
        for (key in listOf("current_units", "hourly_units")) {
            val units = root.getJSONObject(key)
            require(units.getString("time") == "unixtime")
            require(units.getString("temperature_2m") == "°C")
        }
        val current = root.getJSONObject("current")
        val currentAt = Instant.ofEpochSecond(integer(current.get("time")))
        val currentTemperature = temperature(current.get("temperature_2m"))
        val currentCode = weatherCode(current.get("weather_code"))
        val currentIsDay = daylight(current.get("is_day"))
        val values = root.getJSONObject("hourly")
        val times = values.getJSONArray("time")
        val temperatures = values.getJSONArray("temperature_2m")
        val codes = values.getJSONArray("weather_code")
        val days = values.getJSONArray("is_day")
        require(times.length() in 1..168)
        require(listOf(temperatures, codes, days).all { it.length() == times.length() })
        val hours = (0 until times.length()).map { i ->
            val epochSecond = integer(times.get(i))
            require(epochSecond % 3600L == 0L)
            WeatherHour(Instant.ofEpochSecond(epochSecond), temperature(temperatures.get(i)),
                weatherCode(codes.get(i)), daylight(days.get(i)))
        }.sortedBy { it.time }
        val byTime = hours.associateBy { it.time }
        require(byTime.size == hours.size)
        val date = fetchedAt.atZone(KYIV_ZONE).toLocalDate()
        val from = date.atStartOfDay(KYIV_ZONE).toInstant()
        val until = date.plusDays(1).atStartOfDay(KYIV_ZONE).toInstant()
        val expected = generateSequence(from) { it.plusSeconds(3600) }.takeWhile { it < until }.toList()
        require(expected.all { it in byTime }) { "Неповна доба прогнозу" }
        val nextHour = Instant.ofEpochSecond((fetchedAt.epochSecond / 3600 + 1) * 3600)
        require((0..2).all { nextHour.plusSeconds(it * 3600L) in byTime }) { "Неповний погодинний прогноз" }
        val daily = expected.map { byTime.getValue(it).temperatureC }
        WeatherSnapshot(location, fetchedAt, currentAt, currentTemperature, currentCode, currentIsDay,
            hours, date, daily.min(), daily.max())
    }

    fun locations(raw: String, region: String = ""): List<WeatherLocation> = validated {
        val root = JSONObject(raw)
        require(!root.optBoolean("error", false))
        val results = root.optJSONArray("results") ?: return@validated emptyList()
        (0 until results.length()).mapNotNull { i ->
            runCatching {
                val item = results.getJSONObject(i)
                if (item.optString("country_code") != "UA" || !item.optString("feature_code").startsWith("PPL")) return@runCatching null
                val actualRegion = item.optString("admin1")
                if (region.isNotBlank() && normalizedRegion(region) != normalizedRegion(actualRegion)) return@runCatching null
                WeatherLocation(item.getString("name").trim(), actualRegion,
                    number(item.get("latitude")), number(item.get("longitude")), item.optString("admin2"),
                    item.opt("population")?.let { value -> (value as? Number)?.toLong()?.takeIf { it > 0 } })
            }.getOrNull()
        }.distinctBy { Triple(it.name, it.latitude, it.longitude) }
    }

    private fun normalizedRegion(value: String): String {
        val normalized = value.lowercase(Locale.ROOT).replace(Regex("[’'ʼ]"), "")
            .replace(Regex("\\b(oblast|region)\\b|область"), "").trim().replace(Regex("\\s+"), " ")
        return if (normalized in setOf("черкаська", "черкасская", "cherkasy", "cherkaska", "cherkassy", "cherkasskaya")) "cherkasy" else normalized
    }

    private fun number(value: Any): Double {
        require(value is Number)
        return value.toDouble().also { require(it.isFinite()) }
    }

    private fun integer(value: Any): Long = number(value).let {
        require(it == it.toLong().toDouble())
        it.toLong()
    }

    private fun temperature(value: Any): Double = number(value)
    private fun weatherCode(value: Any): Int = integer(value).also { require(it in 0..99) }.toInt()
    private fun daylight(value: Any): Boolean = integer(value).also { require(it in 0..1) } == 1L

    private inline fun <T> validated(block: () -> T): T = try { block() }
        catch (e: Exception) { throw IllegalArgumentException("Некоректна відповідь погодного сервісу", e) }
}
