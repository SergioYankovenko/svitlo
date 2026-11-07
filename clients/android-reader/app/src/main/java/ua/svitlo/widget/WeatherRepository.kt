package ua.svitlo.widget

import android.content.Context
import org.json.JSONObject
import java.io.IOException
import java.net.URL
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.util.UUID
import javax.net.ssl.HttpsURLConnection

interface WeatherSource {
    fun search(city: String, region: String): String
    fun fetch(location: WeatherLocation): String
}

class OpenMeteoSource(private val request: (String) -> String = ::weatherHttpsGet) : WeatherSource {
    override fun search(city: String, region: String): String {
        val name = AddressWeather.settlementName(city)
        // This API accepts public settlement names, never an account or full address.
        val placeName = Regex("[\\p{L}\\p{M} '\u2019\u02bc.\\-]{2,100}")
        require(placeName.matches(name)) { "Потрібна лише назва населеного пункту" }
        val addressPrefix = Regex("^(вул(?:иця)?\\.?|улица|ул\\.?|пров(?:улок)?\\.?|просп(?:ект)?\\.?|буд(?:инок)?\\.?|квартира|кв\\.?|street|avenue|road)\\s", RegexOption.IGNORE_CASE)
        require(!addressPrefix.containsMatchIn(name)) { "Потрібна лише назва населеного пункту" }
        require(region.isBlank() || placeName.matches(region.trim())) { "Некоректна назва області" }
        val query = if (region.isBlank()) name else "$name, ${region.trim()}"
        return request("https://geocoding-api.open-meteo.com/v1/search?name=" +
            URLEncoder.encode(query, "UTF-8") + "&count=100&language=uk&format=json&countryCode=UA")
    }

    override fun fetch(location: WeatherLocation): String = request(
        "https://api.open-meteo.com/v1/forecast?latitude=${location.latitude}&longitude=${location.longitude}" +
            "&current=temperature_2m,weather_code,is_day&hourly=temperature_2m,weather_code,is_day" +
            "&temperature_unit=celsius&timeformat=unixtime&timezone=GMT&past_days=1&forecast_days=2")
}

class WeatherRepository(context: Context, private val source: WeatherSource = OpenMeteoSource(),
    private val now: () -> Instant = { Instant.now() }) {
    private val prefs = context.applicationContext.getSharedPreferences("svitlo_weather", Context.MODE_PRIVATE)

    /** Manual travel search. Initial setup uses ensureAddressLocation instead. */
    fun searchLocations(city: String, region: String = ""): List<WeatherLocation> =
        WeatherParser.locations(source.search(city, region), region)

    fun bindLocation(location: WeatherLocation, addressBased: Boolean = false) = synchronized(bindingLock) {
        val json = JSONObject().put("name", location.name).put("region", location.region)
            .put("latitude", location.latitude).put("longitude", location.longitude)
            .put("district", location.district).put("population", location.population ?: JSONObject.NULL)
        revision++
        check(prefs.edit().clear().putString("location", json.toString())
            .putString("mode", if (addressBased) "home" else "travel")
            .putString("generation", UUID.randomUUID().toString()).commit()) { "Не вдалося зберегти місто" }
    }

    /** Version 1.3 always follows the confirmed outage address. */
    fun discardTravelLocation() = synchronized(bindingLock) {
        if(readLocation()!=null && !isAtAddress())clear()
    }

    fun isAtAddress(): Boolean = synchronized(bindingLock) { prefs.getString("mode", null) == "home" }

    /** Blocking, retried by the normal worker. A failed geocoder never blocks address setup. */
    fun ensureAddressLocation(binding: ConfirmedBinding, isCurrent: () -> Boolean): Boolean = synchronized(resolveLock) resolve@{
        val requestRevision = synchronized(bindingLock) {
            if (!isCurrent()) return@resolve false
            discardTravelLocation()
            readLocation()?.let {
                if (AddressWeather.matches(binding.city, it)) return@resolve true
                clear()
            }
            revision
        }
        try {
            val location = AddressWeather.knownLocation(binding.city)
                ?: resolveSettlement(binding.city)
                ?: throw IllegalArgumentException("Неоднозначний населений пункт")
            synchronized(bindingLock) {
                if (revision != requestRevision || !isCurrent()) return@resolve false
                bindLocation(location, addressBased = true)
                true
            }
        } catch (_: Exception) {
            synchronized(bindingLock) {
                if (revision == requestRevision && isCurrent()) {
                    prefs.edit().putString("error", "Не вдалося визначити погоду за адресою. Повторимо під час оновлення.").commit()
                }
            }
            false
        }
    }

    private fun resolveSettlement(city: String): WeatherLocation? {
        val native = searchLocations(city, AddressWeather.REGION)
        // An ambiguous native result must remain ambiguous; a second spelling cannot disambiguate it.
        if (native.any { AddressWeather.matches(city, it) }) return AddressWeather.uniqueLocation(city, native)
        val latin = AddressWeather.latinName(city)
        if (latin.equals(AddressWeather.settlementName(city), ignoreCase = true)) return null
        return AddressWeather.uniqueLocation(city, searchLocations(latin, AddressWeather.REGION))
            ?.copy(name = city.trim())
    }

    fun location(): WeatherLocation? = synchronized(bindingLock) { readLocation() }

    fun snapshot(): WeatherSnapshot? = synchronized(bindingLock) {
        val location = readLocation() ?: return@synchronized null
        val raw = prefs.getString("forecast", null) ?: return@synchronized null
        val fetched = prefs.getLong("fetched_at", 0L)
        if (fetched <= 0L) return@synchronized null
        runCatching { WeatherParser.parse(raw, location, Instant.ofEpochMilli(fetched))
            .copy(error = prefs.getString("error", null)) }.getOrNull()
    }

    fun lastError(): String? = synchronized(bindingLock) { prefs.getString("error", null) }

    fun snapshotFor(binding: ConfirmedBinding?): WeatherSnapshot? = synchronized(bindingLock) {
        if (binding == null || !isAtAddress()) return@synchronized null
        snapshot()?.takeIf { AddressWeather.matches(binding.city, it.location) }
    }

    /** Serial across instances so an older request cannot overwrite a newer result. */
    fun refresh(isCurrent: () -> Boolean = { true }): Boolean = synchronized(refreshLock) refresh@{
        val request = synchronized(bindingLock) {
            if (!isCurrent()) return@refresh false
            val location = readLocation() ?: return@refresh false
            val generation = prefs.getString("generation", null) ?: return@refresh false
            location to generation
        }
        try {
            val raw = source.fetch(request.first)
            val fetchedAt = now()
            WeatherParser.parse(raw, request.first, fetchedAt)
            synchronized(bindingLock) {
                if (prefs.getString("generation", null) != request.second || !isCurrent()) return@refresh false
                prefs.edit().putString("forecast", raw).putLong("fetched_at", fetchedAt.toEpochMilli())
                    .remove("error").commit()
            }
        } catch (_: Exception) {
            synchronized(bindingLock) {
                if (prefs.getString("generation", null) == request.second && isCurrent()) {
                    prefs.edit().putString("error", "Не вдалося оновити погоду").commit()
                }
            }
            false
        }
    }

    fun clear() = synchronized(bindingLock) {
        revision++
        check(prefs.edit().clear().commit()) { "Не вдалося видалити погоду" }
    }

    private fun readLocation(): WeatherLocation? = runCatching {
        val raw = prefs.getString("location", null) ?: return@runCatching null
        val value = JSONObject(raw)
        WeatherLocation(value.getString("name"), value.getString("region"), value.getDouble("latitude"),
            value.getDouble("longitude"), value.optString("district"),
            if (value.isNull("population")) null else value.getLong("population"))
    }.getOrNull()

    companion object {
        private val bindingLock = Any()
        private val refreshLock = Any()
        private val resolveLock = Any()
        private var revision = 0L
    }
}

/** Uses platform HTTPS trust and hostname checks; outage-specific ApiTls does not apply. */
private fun weatherHttpsGet(address: String): String {
    val url = URL(address)
    require(url.protocol == "https" && url.host in setOf("api.open-meteo.com", "geocoding-api.open-meteo.com"))
    val connection = url.openConnection() as HttpsURLConnection
    connection.connectTimeout = 15_000
    connection.readTimeout = 20_000
    connection.instanceFollowRedirects = false
    connection.setRequestProperty("Accept", "application/json")
    connection.setRequestProperty("User-Agent", "SvitloWidget/1.0 (personal weather display)")
    try {
        if (connection.responseCode != 200) throw IOException("Погодний сервіс недоступний")
        return connection.inputStream.bufferedReader(StandardCharsets.UTF_8).use { reader ->
            val buffer = CharArray(4096)
            val response = StringBuilder()
            while (true) {
                val count = reader.read(buffer)
                if (count < 0) break
                if (response.length + count > 262_144) throw IOException("Завелика відповідь погоди")
                response.append(buffer, 0, count)
            }
            response.toString()
        }
    } finally { connection.disconnect() }
}
