package ua.svitlo.widget.core

import org.junit.Assert.*
import org.junit.Test
import java.time.Duration
import java.time.Instant
import java.time.LocalDate

class TimelineViewportTest {
    private val date = LocalDate.of(2026, 10, 22)
    private val now = Instant.parse("2026-10-22T07:00:00Z")
    private fun at(time: String) = OutageParser.parseTime("$time 22.10.2026")
    private fun snapshot(events: List<Outage>) = Snapshot(Category.entries.associateWith { category ->
        CategorySnapshot(category, now, now, events.filter { it.category == category }, testQueue(category))
    })
    private fun event(start: String, end: String?, category: Category = Category.SCHEDULE) =
        Outage(category, at(start), end?.let(::at), false, "Застосовано", category.label)

    @Test fun civilDayBoundsAndEveryRealHourSurviveBothDstTransitions() {
        listOf(date to 24, LocalDate.of(2026, 3, 29) to 23, LocalDate.of(2026, 10, 25) to 25).forEach { (day, hours) ->
            val viewport = TimelineViewport(day)
            assertEquals(hours.toLong(), Duration.between(viewport.start, viewport.end).toHours())
            val ticks = viewport.ticks()
            assertEquals(hours + 1, ticks.size)
            assertEquals(viewport.start, ticks.first().at)
            assertEquals(viewport.end, ticks.last().at)
            assertTrue(ticks.zipWithNext().all { (a, b) -> Duration.between(a.at, b.at) == Duration.ofHours(1) })
            assertEquals("24", ticks.last().label)
        }
    }

    @Test fun repeatedHourHasDistinctCursorOffsetsAndNoInventedSpringHour() {
        assertEquals("22.10 · 10:15", TimelineViewport.describeTime(at("10:15")))
        val autumn = TimelineViewport(LocalDate.of(2026, 10, 25))
        val repeated = autumn.ticks().filter { it.at.atZone(KYIV_ZONE).hour == 3 }
        assertEquals(2, repeated.size)
        assertTrue(TimelineViewport.describeTime(repeated[0].at).contains("UTC+03:00"))
        assertTrue(TimelineViewport.describeTime(repeated[1].at).contains("UTC+02:00"))
        assertFalse(TimelineViewport.describeTime(autumn.dayStart).contains("UTC"))
        assertFalse(TimelineViewport(LocalDate.of(2026, 3, 29)).ticks().any { it.at.atZone(KYIV_ZONE).hour == 3 })
    }

    @Test fun oneHourZoomUsesFiveMinuteMarksAndQuarterHourLabels() {
        val viewport = TimelineViewport(date, TimelineZoom.HOUR, at("10:00"), at("10:15"))
        assertEquals(13, viewport.ticks().size)
        assertEquals(listOf("10:00", "10:15", "10:30", "10:45", "11:00"), viewport.ticks().mapNotNull { it.label })
        assertEquals(at("10:15"), viewport.instantAt(0.25))
        assertEquals(0.25, viewport.fractionAt(at("10:15")), 0.00001)
        assertEquals(at("10:00"), viewport.instantAt(-1.0))
        assertEquals(at("11:00"), viewport.instantAt(2.0))
    }

    @Test fun zoomKeepsSelectedInstantAndPanCannotEscapeCivilDay() {
        val day = TimelineViewport(date, selectedAt = at("10:07"))
        val hour = day.zoomTo(TimelineZoom.HOUR)
        assertEquals(at("10:07"), hour.selectedAt)
        assertEquals(0.5, hour.fractionAt(hour.selectedAt), 0.00001)
        val first = hour.pan(-100.0)
        val last = hour.pan(100.0)
        assertEquals(first.dayStart, first.start)
        assertEquals(last.dayEnd, last.end)
        assertTrue(first.selectedAt >= first.start && first.selectedAt <= first.end)
        assertTrue(last.selectedAt >= last.start && last.selectedAt <= last.end)
        assertEquals(60L, Duration.between(last.start, last.end).toMinutes())
    }

    @Test fun exactSegmentsDoNotExpandToFiveMinuteBinsAndEndIsExclusive() {
        val outage = event("10:02", "10:07")
        val data = snapshot(listOf(outage))
        val viewport = TimelineViewport(date, TimelineZoom.HOUR, at("10:00"))
        val marked = viewport.segments(data, now).filter { it.category != null }.single()
        assertEquals(outage.start, marked.start)
        assertEquals(outage.end, marked.end)
        assertTrue(TimelineViewport.eventsAt(data, at("10:01")).isEmpty())
        assertEquals(listOf(outage), TimelineViewport.eventsAt(data, at("10:02")))
        assertTrue(TimelineViewport.eventsAt(data, at("10:07")).isEmpty())
    }

    @Test fun overlappingPriorityClipsDrawingButSelectionRetainsEveryOriginalInterval() {
        val hourly = event("10:02", "10:40")
        val emergency = event("10:12", "10:17", Category.EMERGENCY)
        val data = snapshot(listOf(hourly, emergency))
        val viewport = TimelineViewport(date, TimelineZoom.HOUR, at("10:00"))
        val segment = viewport.segments(data, now).single { it.start == emergency.start }
        assertEquals(Category.EMERGENCY, segment.category)
        assertEquals(emergency.end, segment.end)
        assertEquals(listOf(emergency, hourly), TimelineViewport.eventsAt(data, at("10:15")))
    }

    @Test fun openEndsAndStaleDataRemainUncertainWhileCheckedEmptyTodayIsClear() {
        val viewport = TimelineViewport(date, TimelineZoom.HOUR, at("10:00"))
        val open = snapshot(listOf(event("10:12", null)))
        val segment = viewport.segments(open, now).last()
        assertEquals(viewport.end, segment.end)
        assertTrue(segment.uncertain)
        assertTrue(viewport.segments(open.copy(failures = setOf(Category.PLANNED)), now).all { it.uncertain })
        assertTrue(viewport.segments(snapshot(emptyList()), now).all { !it.uncertain && it.category == null })
    }

    @Test fun intervalNavigationIsChronologicalAndCanSelectOutsideCurrentWindow() {
        val data = snapshot(listOf(event("10:02", "10:07"), event("16:17", "17:20")))
        val viewport = TimelineViewport(date, TimelineZoom.HOUR, at("10:00"), at("10:02"))
        val next = viewport.adjacentEvent(data, forward = true)!!
        assertEquals(at("16:17"), next.start)
        val selected = viewport.select(next.start)
        assertEquals(next.start, selected.selectedAt)
        assertTrue(next.start >= selected.start && next.start <= selected.end)
        assertEquals(at("10:02"), selected.adjacentEvent(data, forward = false)!!.start)
    }

    @Test fun nextIntervalStartingAtRightBoundaryMovesIntoTheVisibleWindow() {
        val outage = event("11:00", "11:15")
        val data = snapshot(listOf(outage))
        val viewport = TimelineViewport(date, TimelineZoom.HOUR, at("10:00"), at("10:30"))
        val next = viewport.adjacentEvent(data, forward = true)!!

        val selected = viewport.select(next.start)

        assertEquals(date, selected.date)
        assertEquals(outage.start, selected.selectedAt)
        assertTrue(selected.start < outage.start)
        assertTrue("The selected interval must be inside the chart, not its excluded right edge", selected.end > outage.start)
        val visible = selected.segments(data, now).single { it.category != null }
        assertEquals(outage.start, visible.start)
        assertEquals(outage.end, visible.end)
    }

    @Test fun selectingMidnightIntervalAdvancesTheCivilDateAndShowsItsDuration() {
        // Cross into a 25-hour Kyiv day as well as testing the ordinary midnight boundary.
        val previousDate = LocalDate.of(2026, 10, 24)
        val nextDate = previousDate.plusDays(1)
        val midnight = nextDate.atStartOfDay(KYIV_ZONE).toInstant()
        val outage = Outage(Category.SCHEDULE, midnight, midnight.plusSeconds(900), false, "", "")
        val data = snapshot(listOf(outage))
        val viewport = TimelineViewport(previousDate, TimelineZoom.HOUR, midnight.minusSeconds(3600), midnight.minusSeconds(300))

        val selected = viewport.select(viewport.adjacentEvent(data, forward = true)!!.start)

        assertEquals(nextDate, selected.date)
        assertEquals(midnight, selected.selectedAt)
        assertEquals(midnight, selected.start)
        assertEquals(25L, Duration.between(selected.dayStart, selected.dayEnd).toHours())
        val visible = selected.segments(data, now).single { it.category != null }
        assertEquals(outage.start, visible.start)
        assertEquals(outage.end, visible.end)
    }
}
