package ua.svitlo.widget
import org.junit.Assert.*
import org.junit.Test
import ua.svitlo.widget.core.*
import java.time.Instant
import java.time.LocalDate

class WeekNavigation140Test {
    private val sunday=LocalDate.of(2026,10,25)
    private val monday=sunday.plusDays(1)
    private val now=Instant.parse("2026-10-25T16:00:00Z")
    private fun snapshot(date:LocalDate=monday)=Snapshot(emptyMap(),plans=listOf(PublishedPlan(date,"3.2",emptyList(),now,now,"","x")))
    @Test fun weekIsMondayToSundayAcrossYearBoundary(){
        assertEquals((0L..6L).map(LocalDate.of(2025,12,29)::plusDays),HomeSchedule.week(LocalDate.of(2026,1,1)))
    }
    @Test fun publishedMondayUnlocksNextWeekAndBackUntilMidnight(){
        assertEquals(monday,HomeSchedule.swipe(sunday,true,snapshot(),sunday))
        assertEquals(sunday,HomeSchedule.swipe(monday,false,snapshot(),sunday))
        assertNull(HomeSchedule.swipe(monday,false,snapshot(),monday))
        assertNull(HomeSchedule.swipe(monday,false,snapshot(),monday.plusDays(2)))
    }
    @Test fun missingMondayCannotOpenAnEmptyWeek(){
        assertNull(HomeSchedule.swipe(sunday,true,Snapshot(emptyMap()),sunday))
        assertNull(HomeSchedule.swipe(sunday,true,snapshot(monday.plusDays(1)),sunday))
    }
    @Test fun cannotSwipeIntoPastEvenWhenItsScheduleExists(){
        assertNull(HomeSchedule.swipe(sunday,false,snapshot(sunday.minusWeeks(1)),sunday))
        assertNull(HomeSchedule.swipe(monday,true,snapshot(monday.plusWeeks(1)),sunday))
    }
    @Test fun oldOpenWeekMovesForwardOnMondayButExplicitHistoryRemainsAccessible(){
        assertEquals(monday,HomeSchedule.normalize(sunday,monday,false))
        assertEquals(sunday,HomeSchedule.normalize(sunday,monday,true))
        assertNull(HomeSchedule.swipe(sunday,false,snapshot(),monday))
        assertNull(HomeSchedule.swipe(sunday,true,snapshot(),monday))
    }
    @Test fun dstSundayKeepsSevenCivilDates(){
        assertEquals(7,HomeSchedule.week(sunday).size)
        assertEquals(sunday,HomeSchedule.week(sunday).last())
        assertEquals(monday,HomeSchedule.week(monday).first())
    }
}
