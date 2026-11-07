package ua.svitlo.widget

import org.junit.Assert.*
import org.junit.Test
import ua.svitlo.widget.core.*
import java.time.Instant
import java.time.LocalDate

class HomeScheduleTest {
    private val sunday=LocalDate.of(2026,10,25)
    private val now=Instant.parse("2026-10-25T10:00:00Z")
    private fun snapshot(date:LocalDate)=Snapshot(emptyMap(),plans=listOf(
        PublishedPlan(date,"3.2",emptyList(),now,now,"https://example.test","test")))
    @Test fun sevenDatesAreCalendarWeekMondayToSunday(){
        assertEquals((-6L..0L).map(sunday::plusDays),HomeSchedule.week(sunday))
    }
    @Test fun mondayTomorrowAndPastInboxDatesHaveTheirOwnCompleteWeek(){
        assertEquals(sunday.plusDays(7),HomeSchedule.week(sunday.plusDays(1)).last())
        assertEquals(LocalDate.of(2025,12,29),HomeSchedule.week(LocalDate.of(2026,1,1)).first())
    }
    @Test fun noOutagePublicationIsSelectableButMissingTomorrowIsNot(){
        val published=snapshot(sunday)
        assertTrue(HomeSchedule.selectable(sunday,published))
        assertFalse(HomeSchedule.selectable(sunday.plusDays(1),published))
        assertTrue(HomeSchedule.selectable(sunday.plusDays(1),snapshot(sunday.plusDays(1))))
    }
    @Test fun stalePublicationStaysSelectableWithoutTurningItsUnknownHoursGreen(){
        val cached=snapshot(sunday)
        assertTrue(HomeSchedule.selectable(sunday,cached))
        assertTrue(HourlySchedule.tiles(sunday,cached,now.plusSeconds(10800)).all{tile->tile.segments.all{it.uncertain}})
    }
}
