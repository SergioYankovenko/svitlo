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
class WeatherRepositoryTest {
    private lateinit var context: Context
    private val city = WeatherLocation("Приклад", "Черкаська область", 49.0, 31.0)
    private val otherCity = city.copy(name = "Інше місто", latitude = 49.1)
    private var now = Instant.parse("2026-10-22T08:10:00Z")
    private class FakeSource(var result: String) : WeatherSource {
        var calls = 0
        var failing = false
        var onFetch: (() -> Unit)? = null
        override fun search(city: String, region: String) = "{}"
        override fun fetch(location: WeatherLocation): String {
            calls++
            onFetch?.also { onFetch = null }?.invoke()
            if (failing) throw IOException("private server response must not reach UI")
            return result
        }
    }

    @Before fun setup() {
        context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences("svitlo_weather", Context.MODE_PRIVATE).edit().clear().commit()
    }

    @Test fun unboundRefreshCannotSendCoordinatesOrCreateACache() {
        val source = FakeSource(weatherFixture(now))
        val repo = WeatherRepository(context, source) { now }
        assertFalse(repo.refresh())
        assertEquals(0, source.calls)
        assertNull(repo.snapshot())
    }

    @Test fun independentWeatherCacheSurvivesReopeningAndContainsNoAccountData() {
        val source = FakeSource(weatherFixture(now))
        val repo = WeatherRepository(context, source) { now }
        repo.bindLocation(city)
        assertTrue(repo.refresh())
        val reopened = WeatherRepository(context, source) { now }
        assertEquals(city, reopened.location())
        assertEquals(now, reopened.snapshot()?.fetchedAt)
        assertEquals(9.25, reopened.snapshot()!!.temperatureC, 0.001)
        assertFalse(context.getSharedPreferences("svitlo_weather", Context.MODE_PRIVATE).all.keys.any { it.contains("account") || it.contains("address") })
    }

    @Test fun refreshFailurePreservesGoodCacheTimestampAndMarksItStale() {
        val source = FakeSource(weatherFixture(now))
        val repo = WeatherRepository(context, source) { now }
        repo.bindLocation(city)
        assertTrue(repo.refresh())
        val before = repo.snapshot()!!
        now = now.plusSeconds(600)
        source.failing = true
        assertFalse(repo.refresh())
        val after = repo.snapshot()!!
        assertEquals(before.fetchedAt, after.fetchedAt)
        assertEquals(before.temperatureC, after.temperatureC, 0.001)
        assertFalse(after.isFresh(now))
        assertNotNull(repo.lastError())
        assertFalse(repo.lastError()!!.contains("private server response"))
        source.failing = false
        source.result = weatherFixture(now)
        assertTrue(repo.refresh())
        assertNull(repo.lastError())
    }

    @Test fun malformedResponseNeverOverwritesLastGoodCache() {
        val source = FakeSource(weatherFixture(now))
        val repo = WeatherRepository(context, source) { now }
        repo.bindLocation(city)
        assertTrue(repo.refresh())
        source.result = "{}"
        assertFalse(repo.refresh())
        assertEquals(9.25, repo.snapshot()!!.temperatureC, 0.001)
    }

    @Test fun changingLocationAcrossInstancesDiscardsInflightResponse() {
        val source = FakeSource(weatherFixture(now))
        val repo = WeatherRepository(context, source) { now }
        repo.bindLocation(city)
        source.onFetch = { WeatherRepository(context, source).bindLocation(otherCity) }
        assertFalse(repo.refresh())
        assertEquals(otherCity, repo.location())
        assertNull(repo.snapshot())
        assertNull(repo.lastError())
    }

    @Test fun resetDuringRequestCannotRecreateDeletedData() {
        val source = FakeSource(weatherFixture(now))
        val repo = WeatherRepository(context, source) { now }
        repo.bindLocation(city)
        source.onFetch = { WeatherRepository(context, source).clear() }
        assertFalse(repo.refresh())
        assertNull(repo.location())
        assertNull(repo.snapshot())
        assertTrue(context.getSharedPreferences("svitlo_weather", Context.MODE_PRIVATE).all.isEmpty())
    }

    @Test fun rebindingTheSameCoordinatesStillInvalidatesOldRequestGeneration() {
        val source = FakeSource(weatherFixture(now))
        val repo = WeatherRepository(context, source) { now }
        repo.bindLocation(city)
        source.onFetch = { WeatherRepository(context, source).bindLocation(city) }
        assertFalse(repo.refresh())
        assertNull(repo.snapshot())
    }

    @Test fun citySearchNeverAutomaticallyBindsALocation() {
        val repo = WeatherRepository(context, FakeSource(weatherFixture(now))) { now }
        assertTrue(repo.searchLocations("Приклад", "Черкаська область").isEmpty())
        assertNull(repo.location())
    }

    @Test fun currentAddressDisplayNeverReturnsAnotherSettlementsCachedForecast() {
        val repo = WeatherRepository(context, FakeSource(weatherFixture(now))) { now }
        repo.bindLocation(city, addressBased = true)
        assertTrue(repo.refresh())
        val binding = ConfirmedBinding("12345678901", "Тестова адреса", "м. Приклад")
        assertNotNull(repo.snapshotFor(binding))
        assertNull(repo.snapshotFor(binding.copy(city = "с. Бойківщина")))
        assertNull(repo.snapshotFor(null))
    }

    @Test fun searchRejectsFullAddressesBeforeSendingAnyRequest() {
        var requested = false
        val source = OpenMeteoSource { requested = true; "{}" }
        assertThrows(IllegalArgumentException::class.java) { source.search("Приклад, вул. Тестова, 1", "Черкаська область") }
        assertFalse(requested)
    }

    @Test fun searchRejectsStreetOnlyInputWithoutCommasOrHouseNumbers() {
        var requested = false
        val source = OpenMeteoSource { requested = true; "{}" }
        assertThrows(IllegalArgumentException::class.java) { source.search("вул. Шевченка", "Черкаська область") }
        assertThrows(IllegalArgumentException::class.java) { source.search("вулиця Шевченка", "Черкаська область") }
        assertFalse(requested)
    }

    @Test fun requestsUseOnlyCoordinatesAndPublicCityWithCountryAndRegionFilters() {
        val requests = mutableListOf<String>()
        val source = OpenMeteoSource { requests += it; "{}" }
        source.search("Приклад", "Черкаська область")
        source.fetch(city)
        assertEquals(2, requests.size)
        val decoded = java.net.URLDecoder.decode(requests.first(), "UTF-8")
        assertTrue(decoded.contains("name=Приклад, Черкаська область"))
        assertTrue(decoded.contains("countryCode=UA"))
        assertTrue(requests.last().startsWith("https://api.open-meteo.com/v1/forecast?latitude=49.0&longitude=31.0&"))
        assertTrue(requests.last().contains("timeformat=unixtime"))
        assertTrue(requests.last().contains("timezone=GMT"))
        assertTrue(requests.last().contains("past_days=1"))
        assertTrue(requests.last().contains("forecast_days=2"))
        assertTrue(requests.last().contains("current=temperature_2m,weather_code,is_day"))
        assertTrue(requests.last().contains("hourly=temperature_2m,weather_code,is_day"))
        assertFalse(requests.last().contains("Приклад"))
    }
}
