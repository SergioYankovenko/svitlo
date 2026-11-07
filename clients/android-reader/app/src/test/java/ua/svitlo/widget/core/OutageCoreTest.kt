package ua.svitlo.widget.core

import org.junit.Assert.*
import org.junit.Test
import java.time.Duration
import java.time.Instant
import java.time.LocalDate

class OutageCoreTest {
    private val date = LocalDate.of(2026, 10, 22)
    private val now = time("09:30 22.10.2026")

    @Test fun officialScheduleResponseParsesQueueAndPlannedEnd() {
        val parsed = OutageParser.parse(fixture, Category.SCHEDULE, now)
        assertEquals(time("09:06 22.10.2026"), parsed.sourceUpdatedAt)
        assertEquals(1, parsed.events.size)
        assertEquals(time("10:00 22.10.2026"), parsed.events.single().start)
        assertEquals(time("12:00 22.10.2026"), parsed.events.single().end)
        assertTrue(parsed.events.single().plannedEnd)
        assertEquals("3.2", Snapshot(mapOf(Category.SCHEDULE to parsed)).queueLabel())
    }

    @Test fun arrayAndIndexedObjectCollectionsAreEquivalent() {
        val objectJson = fixture.replace("\"DISCONNECTIONS\":[{", "\"DISCONNECTIONS\":{\"7\":{")
            .replace("(план)\"}]", "(план)\"}}")
        assertEquals(
            OutageParser.parse(fixture, Category.SCHEDULE, now),
            OutageParser.parse(objectJson, Category.SCHEDULE, now)
        )
    }

    @Test fun malformedAndErrorPayloadsAreNotEmptySchedules() {
        listOf("<html>unavailable</html>", "{}", "{\"error\":\"failed\",\"DISCONNECTIONS\":[]}",
            "{\"DISCONNECTIONS\":null}", "{\"DISCONNECTIONS\":[false]}",
            "{\"DISCONNECTIONS\":{\"error\":\"failed\"}}").forEach { text ->
            expectFailure { OutageParser.parse(text, Category.PLANNED, now) }
        }
    }

    @Test fun malformedStartAndImpossibleDatesAreRejected() {
        expectFailure { OutageParser.parse(fixture.replace("10:00 22.10.2026", "невідомо"), Category.SCHEDULE, now) }
        expectFailure { OutageParser.parse(fixture.replace("10:00 22.10.2026", "10:00 31.02.2026"), Category.SCHEDULE, now) }
        expectFailure { OutageParser.parse(fixture.replace("12:00 22.10.2026", "12:00 31.02.2026"), Category.SCHEDULE, now) }
    }

    @Test fun reversedIntervalIsRejected() {
        expectFailure { OutageParser.parse(fixture.replace("12:00 22.10.2026", "09:00 22.10.2026"), Category.SCHEDULE, now) }
    }

    @Test fun htmlEndTimeIsParsedWithoutInterpretingHtml() {
        val json = """{"DATETIME":"09:06 22.10.2026","DISCONNECTIONS":[{"DATE_START":"10:00 22.10.2026","DATE_TIME":"<b>12:15 22.10.2026</b>&nbsp;(план)","STATE_CHAR":"Застосовано"}]}"""
        val event = OutageParser.parse(json, Category.EMERGENCY, now).events.single()
        assertEquals(time("12:15 22.10.2026"), event.end)
        assertTrue(event.plannedEnd)
    }

    @Test fun officialDisplayedEndOverridesDifferentLegacyStop() {
        val json = """{"DATETIME":"09:06 22.10.2026","DISCONNECTIONS":[{"DATE_START":"10:00 22.10.2026","DATE_STOP":"12:00 22.10.2026 (план)","DATE_TIME":"<b>12:45 22.10.2026</b>","STATE_CHAR":"Застосовано"}]}"""
        val event = OutageParser.parse(json, Category.PLANNED, now).events.single()
        assertEquals(time("12:45 22.10.2026"), event.end)
        assertFalse(event.plannedEnd)
    }

    @Test fun officialUnknownEndMustNotFallBackToLegacyTime() {
        val json = """{"DATETIME":"09:06 22.10.2026","DISCONNECTIONS":[{"DATE_START":"10:00 22.10.2026","DATE_STOP":"12:00 22.10.2026 (план)","DATE_TIME":"Уточнюється","STATE_CHAR":"Застосовано"}]}"""
        val event = OutageParser.parse(json, Category.EMERGENCY, now).events.single()
        assertNull(event.end)
        assertFalse(event.plannedEnd)
    }

    @Test fun nullDisplayedEndFallsBackToLegacyStopAsOfficialPageDoes() {
        val json = """{"DATETIME":"09:06 22.10.2026","DISCONNECTIONS":[{"DATE_START":"10:00 22.10.2026","DATE_STOP":"12:00 22.10.2026 (план)","DATE_TIME":null,"STATE_CHAR":"Застосовано"}]}"""
        val event = OutageParser.parse(json, Category.PLANNED, now).events.single()
        assertEquals(time("12:00 22.10.2026"), event.end)
        assertTrue(event.plannedEnd)
    }

    @Test fun nullSourceTimeRetainsRecordsButCannotBeFresh() {
        val json = fixture.replace("\"DATETIME\":\"09:06 22.10.2026\"", "\"DATETIME\":null")
        val parsed = OutageParser.parse(json, Category.SCHEDULE, now)
        assertNull(parsed.sourceUpdatedAt)
        assertEquals(1, parsed.events.size)
        assertFalse(parsed.isFresh(now))
    }

    @Test fun explicitCancelledEventsAreRemoved() {
        val json = fixture.replace("Застосовано", "Скасовано")
        assertTrue(OutageParser.parse(json, Category.SCHEDULE, now).events.isEmpty())
    }

    @Test fun absentEndIsRetainedAsUnknownNotDropped() {
        val json = fixture.replace("12:00 22.10.2026 (план)", "Уточнюється")
        val parsed = OutageParser.parse(json, Category.SCHEDULE, now)
        assertNull(parsed.events.single().end)
        val bins = Timeline.bins(date, complete(parsed.events), now)
        assertTrue(bins.filter { it.start >= time("10:00 22.10.2026") }.all {
            it.category == Category.SCHEDULE && it.uncertain
        })
    }

    @Test fun fiveMinuteBinsRespectPreciseIntervalBoundaries() {
        val events = listOf(outage(Category.SCHEDULE, "10:02 22.10.2026", "10:07 22.10.2026"))
        val bins = Timeline.bins(date, complete(events), now)
        assertEquals(288, bins.size)
        val marked = bins.filter { it.category != null }
        assertEquals(2, marked.size)
        assertEquals(time("10:00 22.10.2026"), marked.first().start)
        assertEquals(time("10:10 22.10.2026"), marked.last().end)
        assertNull(bins.first { it.start == time("10:10 22.10.2026") }.category)
    }

    @Test fun overlappingEmergencyWinsAndPlannedWinsOverSchedule() {
        val events = listOf(
            outage(Category.SCHEDULE, "10:00 22.10.2026", "14:00 22.10.2026"),
            outage(Category.PLANNED, "11:00 22.10.2026", "13:00 22.10.2026"),
            outage(Category.EMERGENCY, "12:00 22.10.2026", "12:30 22.10.2026")
        )
        val bins = Timeline.bins(date, complete(events), now)
        fun category(at: String) = bins.first { it.start == time(at) }.category
        assertEquals(Category.SCHEDULE, category("10:00 22.10.2026"))
        assertEquals(Category.PLANNED, category("11:00 22.10.2026"))
        assertEquals(Category.EMERGENCY, category("12:00 22.10.2026"))
        assertEquals(Category.PLANNED, category("12:30 22.10.2026"))
    }

    @Test fun failedCategoryMakesEvenCachedIntervalsUncertain() {
        val data = complete(listOf(outage(Category.SCHEDULE, "10:00 22.10.2026", "12:00 22.10.2026")))
        val partial = data.copy(failures = setOf(Category.EMERGENCY))
        assertTrue(Timeline.bins(date, partial, now).all { it.uncertain })
    }

    @Test fun missingCategoryMakesIntervalsUncertain() {
        val data = complete(emptyList())
        assertFalse(data.copy(categories = data.categories - Category.EMERGENCY).isCompleteAndFresh(now))
    }

    @Test fun recentVerificationConfirmsOlderSourceWithoutRewritingItsTimestamp() {
        val old = CategorySnapshot(Category.PLANNED, now.minus(Duration.ofHours(3)), now, emptyList(), emptyList())
        assertTrue(old.isFresh(now))
        assertFalse(old.copy(sourceUpdatedAt = null).isFresh(now))
        assertFalse(old.copy(sourceUpdatedAt = now.plusSeconds(3600)).isFresh(now))
    }

    @Test fun checkedEmptyTodayIsClearWhileTomorrowRemainsUnknown() {
        val snapshot = complete(emptyList())
        assertTrue(snapshot.isCompleteAndFresh(now))
        assertTrue(Timeline.bins(date, snapshot, now).all { it.category == null && !it.uncertain })
        assertTrue(Timeline.bins(date.plusDays(1), snapshot, now).all { it.category == null && it.uncertain })
    }

    @Test fun midnightSpanningIntervalAppearsOnBothDays() {
        val event = outage(Category.PLANNED, "23:30 22.10.2026", "00:30 23.10.2026")
        val snapshot = complete(listOf(event))
        assertEquals(6, Timeline.bins(date, snapshot, now).count { it.category != null })
        assertEquals(6, Timeline.bins(date.plusDays(1), snapshot, now).count { it.category != null })
    }

    @Test fun springAndAutumnDaysUseActualCivilDayLength() {
        val spring = LocalDate.of(2026, 3, 29)
        val autumn = LocalDate.of(2026, 10, 25)
        assertEquals(276, Timeline.bins(spring, Snapshot(emptyMap()), now).size)
        assertEquals(300, Timeline.bins(autumn, Snapshot(emptyMap()), now).size)
        val autumnBins = Timeline.bins(autumn, Snapshot(emptyMap()), now)
        assertTrue(autumnBins.zipWithNext().all { (left, right) -> left.end == right.start })
    }

    @Test fun nonexistentDstTimeIsRejected() {
        expectFailure { time("03:30 29.03.2026") }
    }

    @Test fun repeatedDstTimeWithoutUtcOffsetIsRejected() {
        expectFailure { time("03:30 25.10.2026") }
    }

    @Test fun activeEmergencyIsSelectedBeforeFutureOutage() {
        val events = listOf(
            outage(Category.SCHEDULE, "10:00 22.10.2026", "12:00 22.10.2026"),
            outage(Category.EMERGENCY, "09:00 22.10.2026", "10:30 22.10.2026"),
            outage(Category.PLANNED, "08:00 22.10.2026", "11:00 22.10.2026")
        )
        assertEquals(Category.EMERGENCY, Timeline.nextOutage(complete(events), now)?.category)
        assertNull(Timeline.nextOutage(complete(events), time("12:00 22.10.2026")))
    }

    @Test fun accountFormatValidationIsNotAccountExistenceValidation() {
        assertTrue(AccountNumber.isValid("71000000000"))
        assertTrue(AccountNumber.isValid("71000 000000"))
        assertFalse(AccountNumber.isValid("71abcdefghj"))
        assertFalse(AccountNumber.isValid("7100000000"))
        assertFalse(AccountNumber.isValid("710000000000"))
        assertEquals("•••••••0000", AccountNumber.masked("71000000000"))
    }

    private fun complete(events: List<Outage>) = Snapshot(Category.entries.associateWith { category ->
        CategorySnapshot(category, now.minusSeconds(60), now, events.filter { it.category == category }, testQueue(category))
    })

    private fun outage(category: Category, start: String, end: String) =
        Outage(category, time(start), time(end), false, "Застосовано", category.label)

    private fun time(value: String): Instant = OutageParser.parseTime(value)

    private fun expectFailure(action: () -> Unit) {
        try { action(); fail("Expected malformed or unavailable data to be rejected") }
        catch (_: IllegalArgumentException) { /* expected */ }
    }

    private val fixture = """{"DATETIME":"09:06 22.10.2026","DISCONN_QUEUQ":[{"QUEUE_INFO":"Графік аварійних відключень - в чергу не включено"},{"QUEUE_INFO":"Графік погодинних відключень - 3 черга 2 підчерга"}],"DISCONNECTIONS":[{"DISCONN_TYPE":"ГПВ","STATE_CHAR":"Застосовано","STATE_INT":"0","DATE_START":"10:00 22.10.2026","DATE_STOP":"12:00 22.10.2026 (план)"}]}"""
}
