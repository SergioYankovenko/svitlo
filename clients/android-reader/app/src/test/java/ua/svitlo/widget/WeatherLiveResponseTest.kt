package ua.svitlo.widget

import android.content.Context
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.net.URLDecoder
import java.time.Instant

/** Public Open-Meteo responses captured 2026-10-23. Tests make no network requests. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class WeatherLiveResponseTest {
    private lateinit var context: Context
    @Before fun setup() { context = RuntimeEnvironment.getApplication(); WeatherRepository(context).clear() }
    private fun raw(name: String) = javaClass.getResource("/weather/$name.json")!!.readText()
    private val binding = ConfirmedBinding("12345678901", "Тестова адреса", "с. Бойківщина")

    @Test fun boykivshchynaLiveResponseParsesAndHas24FutureHours() {
        val place = WeatherParser.locations(raw("boykivshchyna"), AddressWeather.REGION).single()
        assertNotNull(AddressWeather.uniqueLocation(binding.city, listOf(place)))
        val forecast = WeatherParser.parse(raw("boykivshchyna-forecast"), place, Instant.parse("2026-10-23T14:40:00Z"))
        assertEquals(24, forecast.nextHours(Instant.parse("2026-10-23T14:40:00Z"), 24).size)
        assertTrue(forecast.isFresh(Instant.parse("2026-10-23T14:40:00Z")))
    }

    @Test fun ruralSettlementsWithMissingUkrainianAliasesUseExactLatinMatchInSameRegion() {
        for ((city, key, lat) in listOf(Triple("с. Білозір’я", "biloziria", 49.30105), Triple("с. Білоусівка", "bilousivka", 49.94131))) {
            val queries = mutableListOf<String>()
            val source = OpenMeteoSource { url ->
                val decoded = URLDecoder.decode(url, "UTF-8"); queries += decoded
                raw(if (decoded.contains("name=$key,")) key else "$key-native")
            }
            val repo = WeatherRepository(context, source)
            repo.clear()
            assertTrue(city, repo.ensureAddressLocation(binding.copy(city = city)) { true })
            assertEquals(lat, repo.location()!!.latitude, 0.00001)
            assertEquals(city, repo.location()!!.name)
            assertEquals(2, queries.size)
        }
    }

    @Test fun townsResolveButHomonymousVillagesRemainAmbiguous() {
        for ((city, key) in listOf("м. Черкаси" to "cherkasy", "м. Умань" to "uman", "м. Сміла" to "smila"))
            assertNotNull(city, AddressWeather.uniqueLocation(city, WeatherParser.locations(raw(key), AddressWeather.REGION)))
        assertNull(AddressWeather.uniqueLocation("с. Михайлівка", WeatherParser.locations(raw("mykhailivka"), AddressWeather.REGION)))
    }

    @Test fun transliterationPreservesWordBoundariesApostrophesAndZgh() {
        assertEquals("biloziria", AddressWeather.latinName("с. Білозір’я"))
        assertEquals("boikivshchyna", AddressWeather.latinName("с. Бойківщина"))
        assertEquals("yizhaky yabluniv-yurkivka", AddressWeather.latinName("Їжаки Яблунів-Юрківка"))
        assertEquals("zghurivka", AddressWeather.latinName("Згурівка"))
        assertFalse(AddressWeather.matches("Білозір’я", WeatherLocation("Biloziria Nova", AddressWeather.REGION, 49.0, 31.0)))
    }
}
