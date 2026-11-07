package ua.svitlo.widget

import java.util.Locale

/** Public settlement centres only. No account, street, house or device position is used. */
object AddressWeather {
    const val REGION = "Черкаська область"
    private val prefix = Regex("^(м\\.|с\\.|смт\\.?|с-ще|місто\\s|село\\s|селище\\s)\\s*", RegexOption.IGNORE_CASE)

    fun settlementName(city: String): String = city.trim().replace(prefix, "").trim()

    private fun normalized(value: String): String = value.trim().lowercase(Locale.ROOT)
        .replace(Regex("[’'ʼ]"), "").replace(Regex("\\s+"), " ")

    /** Cabinet of Ministers No. 55 transliteration; GeoNames lacks Ukrainian aliases for some villages. */
    fun latinName(city: String): String {
        val name = normalized(settlementName(city))
        val letters = mapOf('а' to "a", 'б' to "b", 'в' to "v", 'г' to "h", 'ґ' to "g",
            'д' to "d", 'е' to "e", 'ж' to "zh", 'з' to "z", 'и' to "y", 'і' to "i",
            'к' to "k", 'л' to "l", 'м' to "m", 'н' to "n", 'о' to "o", 'п' to "p",
            'р' to "r", 'с' to "s", 'т' to "t", 'у' to "u", 'ф' to "f", 'х' to "kh",
            'ц' to "ts", 'ч' to "ch", 'ш' to "sh", 'щ' to "shch", 'ь' to "")
        return buildString {
            name.forEachIndexed { index, letter ->
                val initial = index == 0 || name[index - 1].isWhitespace() || name[index - 1] == '-'
                append(when (letter) {
                    'є' -> if (initial) "ye" else "ie"
                    'ї' -> if (initial) "yi" else "i"
                    'й' -> if (initial) "y" else "i"
                    'ю' -> if (initial) "yu" else "iu"
                    'я' -> if (initial) "ya" else "ia"
                    'г' -> if (index > 0 && name[index - 1] == 'з') "gh" else "h"
                    else -> letters[letter] ?: letter.toString()
                })
            }
        }
    }

    fun matches(city: String, location: WeatherLocation): Boolean =
        latinName(city) == latinName(location.name) &&
            (knownLocation(city)?.let { it.latitude == location.latitude && it.longitude == location.longitude } ?: true)

    /**
     * Both names are PPL in GeoNames, so population/order cannot identify the town.
     * Public references verified 2026-10-22: GeoNames 706200 (town), 11524325 (village).
     * These anchors also work while the name-search service is unavailable.
     */
    fun knownLocation(city: String): WeatherLocation? {
        if (normalized(settlementName(city)) != "христинівка") return null
        val typed = normalized(city)
        val coordinates = when {
            Regex("^(м\\.|місто\\s)").containsMatchIn(typed) -> 48.81282 to 29.96885
            Regex("^(с\\.|село\\s)").containsMatchIn(typed) -> 48.84958 to 29.96641
            else -> return null
        }
        return WeatherLocation(city.trim(), REGION, coordinates.first, coordinates.second, "Уманський район")
    }

    /** A prefix search may return other names; never choose its first/largest result. */
    fun uniqueLocation(city: String, candidates: List<WeatherLocation>): WeatherLocation? {
        val exact = candidates.filter { matches(city, it) }
            .distinctBy { it.latitude to it.longitude }
        return exact.singleOrNull()
    }
}
