package ua.svitlo.widget

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

class WeatherTest {
    private val city = WeatherLocation("Місто", "Черкаська область", 49.0, 31.0)
    private val now = Instant.parse("2026-10-22T08:10:00Z")

    @Test fun currentConditionsUseCurrentTimestampRatherThanNextHourlyForecast() {
        val snapshot = WeatherParser.parse(weatherFixture(now), city, now)
        assertEquals(9.25, snapshot.temperatureC, 0.001)
        assertEquals(now.minusSeconds(600), snapshot.currentAt)
        assertEquals(Instant.parse("2026-10-22T09:00:00Z"), snapshot.nextHours(now).first().time)
        assertEquals(3, snapshot.nextHours(now).size)
        assertTrue(snapshot.isFresh(now))
    }

    @Test fun dailyExtremesUseTheKyivDayIncludingThePreviousUtcEvening() {
        val raw = JSONObject(weatherFixture(now))
        val hours = raw.getJSONObject("hourly")
        val times = hours.getJSONArray("time")
        val values = hours.getJSONArray("temperature_2m")
        for (i in 0 until times.length()) {
            val instant = Instant.ofEpochSecond(times.getLong(i))
            values.put(i, when (instant) {
                Instant.parse("2026-10-21T20:00:00Z") -> -90.0 // Yesterday in Kyiv.
                Instant.parse("2026-10-21T21:00:00Z") -> -7.5 // Today at 00:00.
                Instant.parse("2026-10-22T20:00:00Z") -> 24.5 // Today at 23:00.
                Instant.parse("2026-10-22T21:00:00Z") -> 90.0 // Tomorrow in Kyiv.
                else -> 10.0
            })
        }
        val snapshot = WeatherParser.parse(raw.toString(), city, now)
        assertEquals(LocalDate.parse("2026-10-22"), snapshot.dailyDate)
        assertEquals(-7.5, snapshot.minC, 0.001)
        assertEquals(24.5, snapshot.maxC, 0.001)
    }

    @Test fun fallClockChangeKeepsBothRepeatedHoursAsSeparateInstants() {
        val time = Instant.parse("2026-10-25T00:10:00Z")
        val snapshot = WeatherParser.parse(weatherFixture(time), city, time)
        val day = snapshot.hourly.filter { it.time.atZone(ZoneId.of("Europe/Kiev")).toLocalDate() == snapshot.dailyDate }
        assertEquals(25, day.size)
        assertEquals(2, day.count { it.time.atZone(ZoneId.of("Europe/Kiev")).hour == 3 })
        assertEquals(time.epochSecond / 3600 * 3600 + 3600, snapshot.nextHours(time).first().time.epochSecond)
    }

    @Test fun springClockChangeAcceptsAComplete23HourDay() {
        val time = Instant.parse("2026-03-29T00:10:00Z")
        val snapshot = WeatherParser.parse(weatherFixture(time), city, time)
        assertEquals(23, snapshot.hourly.count { it.time.atZone(ZoneId.of("Europe/Kiev")).toLocalDate() == snapshot.dailyDate })
        assertTrue(snapshot.isFresh(time))
    }

    @Test fun incompleteLocalDayCannotProduceMisleadingDailyExtremes() {
        val raw = JSONObject(weatherFixture(now))
        val hours = raw.getJSONObject("hourly")
        val i = (0 until hours.getJSONArray("time").length()).first {
            hours.getJSONArray("time").getLong(it) == Instant.parse("2026-10-22T12:00:00Z").epochSecond
        }
        hours.getJSONArray("temperature_2m").put(i, JSONObject.NULL)
        assertThrows(IllegalArgumentException::class.java) { WeatherParser.parse(raw.toString(), city, now) }
    }

    @Test fun nullCurrentTemperatureNeverBecomesZeroDegrees() {
        val raw = JSONObject(weatherFixture(now))
        raw.getJSONObject("current").put("temperature_2m", JSONObject.NULL)
        assertThrows(IllegalArgumentException::class.java) { WeatherParser.parse(raw.toString(), city, now) }
    }

    @Test fun duplicateHourCannotHideMissingHourEvenWhenTheCountIsCorrect() {
        val raw = JSONObject(weatherFixture(now))
        val times = raw.getJSONObject("hourly").getJSONArray("time")
        times.put(36, times.getLong(35))
        assertThrows(IllegalArgumentException::class.java) { WeatherParser.parse(raw.toString(), city, now) }
    }

    @Test fun staleCurrentTimeFetchFailureAndDayRolloverAllInvalidateFreshness() {
        val snapshot = WeatherParser.parse(weatherFixture(now), city, now)
        assertFalse(snapshot.copy(currentAt = now.minusSeconds(7201)).isFresh(now))
        assertFalse(snapshot.copy(error = "Не вдалося оновити").isFresh(now))
        assertFalse(snapshot.copy(fetchedAt = now.plusSeconds(3600)).isFresh(now))
        assertFalse(snapshot.copy(currentAt = now.plusSeconds(3600)).isFresh(now))
        assertFalse(snapshot.isFresh(now.plusSeconds(7201)))
        val late = Instant.parse("2026-10-22T20:59:00Z")
        val midnight = WeatherParser.parse(weatherFixture(late), city, late)
        assertFalse(midnight.isFresh(late.plusSeconds(120)))
    }

    @Test fun geocodingRejectsForeignAndWrongRegionButPreservesAmbiguousLocalPlaces() {
        val raw = """{"results":[
          {"name":"Приклад","latitude":49.0,"longitude":31.0,"country_code":"UA","admin1":"Cherkasy Oblast","admin2":"Район","population":5000,"feature_code":"PPL"},
          {"name":"Приклад","latitude":49.1,"longitude":31.1,"country_code":"UA","admin1":"Черкаська область","feature_code":"PPL"},
          {"name":"Приклад","latitude":50.1,"longitude":31.1,"country_code":"UA","admin1":"Київська область","feature_code":"PPL"},
          {"name":"Приклад","latitude":49.1,"longitude":31.1,"country_code":"PL","admin1":"Черкаська область","feature_code":"PPL"},
          {"name":"Приклад","latitude":49.1,"longitude":31.1,"country_code":"UA","admin1":"Черкаська область","feature_code":"ADM1"}
        ]}"""
        val places = WeatherParser.locations(raw, "Черкаська область")
        assertEquals(2, places.size)
        assertEquals(5000L, places.first().population)
        assertNotEquals(places[0].displayLabel, places[1].displayLabel)
    }

    @Test fun invalidCoordinatesAndMissingRegionAreNotSuggestedForKnownRegion() {
        val raw = """{"results":[
          {"name":"Приклад","latitude":999,"longitude":31,"country_code":"UA","admin1":"Черкаська область","feature_code":"PPL"},
          {"name":"Приклад","latitude":49,"longitude":31,"country_code":"UA","feature_code":"PPL"}
        ]}"""
        assertTrue(WeatherParser.locations(raw, "Черкаська область").isEmpty())
    }

    @Test fun providerErrorsAreNotInterpretedAsAnEmptySuccessfulSearch() {
        assertThrows(IllegalArgumentException::class.java) {
            WeatherParser.locations("""{"error":true,"reason":"limit"}""", "Черкаська область")
        }
        assertTrue(WeatherParser.locations("{}", "Черкаська область").isEmpty())
    }
}

internal fun weatherFixture(now: Instant): String {
    val start = now.atZone(ZoneId.of("UTC")).toLocalDate().minusDays(1).atStartOfDay(ZoneId.of("UTC")).toInstant()
    val times = JSONArray()
    val temperatures = JSONArray()
    val codes = JSONArray()
    val daylight = JSONArray()
    repeat(72) { i ->
        times.put(start.plusSeconds(i * 3600L).epochSecond)
        temperatures.put(10.0 + i % 12)
        codes.put(3)
        daylight.put(1)
    }
    val units = JSONObject().put("time", "unixtime").put("temperature_2m", "°C")
    return JSONObject()
        .put("current_units", units)
        .put("hourly_units", units)
        .put("current", JSONObject().put("time", now.minusSeconds(600).epochSecond)
            .put("temperature_2m", 9.25).put("weather_code", 2).put("is_day", 1))
        .put("hourly", JSONObject().put("time", times).put("temperature_2m", temperatures)
            .put("weather_code", codes).put("is_day", daylight)).toString()
}
