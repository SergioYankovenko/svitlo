package ua.svitlo.widget

import android.content.Context
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.IOException
import java.time.Instant

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class AddressWeatherTest {
    private lateinit var context: Context
    private val now = Instant.parse("2026-10-22T08:10:00Z")
    private val binding = ConfirmedBinding("12345678901", "м. Приклад, вул. Умовна, 1", "м. Приклад")
    private class Source(var raw: String = "{}") : WeatherSource {
        val searches = mutableListOf<Pair<String, String>>()
        val forecasts = mutableListOf<WeatherLocation>()
        var onSearch: (() -> Unit)? = null
        var fail = false
        override fun search(city: String, region: String): String {
            searches += city to region
            onSearch?.also { onSearch = null }?.invoke()
            if (fail) throw IOException("private transport detail")
            return raw
        }
        override fun fetch(location: WeatherLocation): String {
            forecasts += location
            return weatherFixture(Instant.parse("2026-10-22T08:10:00Z"))
        }
    }

    @Before fun setup() {
        context = RuntimeEnvironment.getApplication()
        WeatherRepository(context).clear()
    }

    private fun place(name: String = "Приклад", lat: Double = 49.0, region: String = "Черкаська область") =
        """{"name":"$name","latitude":$lat,"longitude":31,"country_code":"UA","admin1":"$region","feature_code":"PPL"}"""

    @Test fun townAndVillageHaveDifferentVerifiedAnchorsWithoutGeocoderOrGps() {
        val source = Source().apply { fail = true }
        val repo = WeatherRepository(context, source) { now }
        assertTrue(repo.ensureAddressLocation(binding.copy(city = "м. Христинівка")) { true })
        val town = repo.location()!!
        assertEquals(48.81282, town.latitude, 0.000001)
        assertTrue(repo.isAtAddress())
        assertTrue(repo.refresh())
        assertEquals(listOf(town), source.forecasts)
        repo.clear()
        assertTrue(repo.ensureAddressLocation(binding.copy(city = "с. Христинівка")) { true })
        assertEquals(48.84958, repo.location()!!.latitude, 0.000001)
        assertTrue(source.searches.isEmpty())
    }

    @Test fun untypedSameNameDoesNotGuessTownOrVillage() {
        assertNull(AddressWeather.knownLocation("Христинівка"))
        assertNotNull(AddressWeather.knownLocation("місто Христинівка"))
        assertNotNull(AddressWeather.knownLocation("село Христинівка"))
    }

    @Test fun exactUniqueSettlementBindsAutomaticallyAndPersistsWithoutAccountData() {
        val source = Source("""{"results":[${place()},${place("Прикладове", 49.2)},${place(region = "Київська область")}]}""")
        val repo = WeatherRepository(context, source) { now }
        assertTrue(repo.ensureAddressLocation(binding) { true })
        assertEquals("Приклад", repo.location()?.name)
        assertTrue(repo.isAtAddress())
        assertEquals(listOf("м. Приклад" to "Черкаська область"), source.searches)
        assertEquals(repo.location(), WeatherRepository(context, source).location())
        val saved = context.getSharedPreferences("svitlo_weather", Context.MODE_PRIVATE).all.toString()
        assertFalse(saved.contains(binding.account))
        assertFalse(saved.contains(binding.address))
    }

    @Test fun ambiguousSearchDoesNotChooseFirstAndNextRefreshCanRecover() {
        val source = Source("""{"results":[${place()},${place(lat = 49.2)}]}""")
        val repo = WeatherRepository(context, source) { now }
        assertFalse(repo.ensureAddressLocation(binding) { true })
        assertNull(repo.location())
        assertNotNull(repo.lastError())
        source.raw = """{"results":[${place()}]}"""
        assertTrue(repo.ensureAddressLocation(binding) { true })
        assertNull(repo.lastError())
    }

    @Test fun sameCoordinatesDuplicatesAreOnePlaceButPrefixOnlyAndWrongRegionAreNotMatches() {
        val source = Source("""{"results":[${place()},${place()}]}""")
        val repo = WeatherRepository(context, source) { now }
        assertTrue(repo.ensureAddressLocation(binding) { true })
        repo.clear()
        source.raw = """{"results":[${place("Прикладове")},${place(region = "Київська область")}]}"""
        assertFalse(repo.ensureAddressLocation(binding) { true })
        assertNull(repo.location())
    }

    @Test fun networkFailureIsScrubbedAndDoesNotCreateWeatherBinding() {
        val source = Source().apply { fail = true }
        val repo = WeatherRepository(context, source) { now }
        assertFalse(repo.ensureAddressLocation(binding) { true })
        assertNull(repo.location())
        assertFalse(repo.lastError()!!.contains("private"))
    }

    @Test fun changedAddressRejectsOldGeocodingResponse() {
        var current = true
        val source = Source("""{"results":[${place()}]}""").apply { onSearch = { current = false } }
        val repo = WeatherRepository(context, source) { now }
        assertFalse(repo.ensureAddressLocation(binding) { current })
        assertNull(repo.location())
        assertNull(repo.lastError())
    }

    @Test fun resetWhileUnboundInvalidatesResponseEvenWhenBothGenerationsAreAbsent() {
        val source = Source("""{"results":[${place()}]}""").apply {
            onSearch = { WeatherRepository(context).clear() }
        }
        val repo = WeatherRepository(context, source) { now }
        assertFalse(repo.ensureAddressLocation(binding) { true })
        assertNull(repo.location())
        assertTrue(context.getSharedPreferences("svitlo_weather", Context.MODE_PRIVATE).all.isEmpty())
    }

    @Test fun explicitTravelConfirmationWinsOverPendingAutomaticResolution() {
        val travel = WeatherLocation("Інше місто", "Інша область", 50.0, 32.0)
        val source = Source("""{"results":[${place()}]}""").apply {
            onSearch = { WeatherRepository(context).bindLocation(travel) }
        }
        val repo = WeatherRepository(context, source) { now }
        assertFalse(repo.ensureAddressLocation(binding) { true })
        assertEquals(travel, repo.location())
        assertFalse(repo.isAtAddress())
        assertTrue(repo.ensureAddressLocation(binding) { true })
        assertEquals("Приклад", repo.location()?.name)
        assertTrue(repo.isAtAddress())
        assertEquals(2, source.searches.size)
    }

    @Test fun confirmedReplacementClearsOldWeatherAndAutomaticallyUsesNewSettlement() {
        val source = Source("""{"results":[${place()}]}""")
        val repo = WeatherRepository(context, source) { now }
        assertTrue(repo.ensureAddressLocation(binding) { true })
        assertTrue(repo.refresh())
        repo.clear() // Called only after the new outage address is successfully confirmed.
        assertNull(repo.snapshot())
        val replacement = binding.copy(city = "с. Христинівка")
        assertTrue(repo.ensureAddressLocation(replacement) { true })
        assertEquals("с. Христинівка", repo.location()?.name)
        assertNull(repo.snapshot())
        assertTrue(repo.refresh())
        assertEquals(repo.location(), repo.snapshot()?.location)
    }

    @Test fun staleBindingCannotTriggerGeocodingOrReplaceExistingLocation() {
        val source = Source()
        val repo = WeatherRepository(context, source) { now }
        assertFalse(repo.ensureAddressLocation(binding) { false })
        assertTrue(source.searches.isEmpty())
        assertNull(repo.location())
    }

    @Test fun latinOnlyVillageCanResolveWithoutSendingTheStreetOrAccount() {
        val queries = mutableListOf<String>()
        val source = OpenMeteoSource { url ->
            val query = java.net.URLDecoder.decode(url, "UTF-8")
            queries += query
            if (query.contains("name=biloziria,"))
                """{"results":[${place("Biloziria", 49.30105)}]}"""
            else "{}"
        }
        val repo = WeatherRepository(context, source) { now }
        val address = binding.copy(city = "с. Білозір’я")
        assertTrue(repo.ensureAddressLocation(address) { true })
        assertEquals(49.30105, repo.location()!!.latitude, 0.000001)
        assertEquals("с. Білозір’я", repo.location()!!.name)
        assertEquals(2, queries.size)
        assertTrue(queries.all { it.contains("countryCode=UA") && it.contains("Черкаська область") })
        assertFalse(queries.any { it.contains(address.account) || it.contains("Умовна") })
    }

    @Test fun cachedHomeFromDifferentSettlementIsNotReusedForCurrentAddress() {
        val source = Source("""{"results":[${place()}]}""")
        val repo = WeatherRepository(context, source) { now }
        repo.bindLocation(WeatherLocation("Інше місто", "Черкаська область", 48.0, 30.0), addressBased = true)
        assertTrue(repo.refresh())
        assertTrue(repo.ensureAddressLocation(binding) { true })
        assertEquals("Приклад", repo.location()!!.name)
        assertNull(repo.snapshot())
    }
}
