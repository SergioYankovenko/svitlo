package ua.svitlo.widget.core

import org.junit.Assert.*
import org.junit.Test
import java.time.*

class WidgetLegendSelection158Test {
    private val now=Instant.parse("2026-10-28T06:00:00Z")
    private fun event(category:Category,minutes:Long,type:String="",duration:Long=60)=
        Outage(category,now.plusSeconds(minutes*60),now.plusSeconds((minutes+duration)*60),false,"",type)
    private fun data(events:List<Outage>,checked:Instant=now)=Snapshot(Category.entries.associateWith{category->
        CategorySnapshot(category,now,checked,events.filter{it.sourceCategory==category},emptyList())
    },registryQueue="3.2")
    @Test fun nearestFutureAcrossAddressesWinsAndEndedEventsAreIgnored(){
        val snapshots=listOf(data(listOf(event(Category.EMERGENCY,-120),event(Category.PLANNED,180,"Позапланове відключення"))),
            data(listOf(event(Category.SCHEDULE,60))),data(listOf(event(Category.PLANNED,120,"Планові роботи"))))
        assertEquals(OutageKind.HOURLY,ScheduleLabels.currentOrNextKind(snapshots,now))
    }
    @Test fun activeOutageWinsOverFutureAndActiveEmergencyHasPriority(){
        val active=data(listOf(event(Category.PLANNED,-20,"Позапланове відключення")))
        val future=data(listOf(event(Category.EMERGENCY,5)))
        assertEquals(OutageKind.UNPLANNED,ScheduleLabels.currentOrNextKind(listOf(active,future),now))
        val emergency=data(listOf(event(Category.EMERGENCY,-10)))
        assertEquals(OutageKind.EMERGENCY,ScheduleLabels.currentOrNextKind(listOf(active,future,emergency),now))
    }
    @Test fun equalFutureStartUsesEmergencyThenPlannedThenHourlyPriority(){
        val hourly=data(listOf(event(Category.SCHEDULE,60)))
        val planned=data(listOf(event(Category.PLANNED,60,"Планові роботи")))
        val emergency=data(listOf(event(Category.EMERGENCY,60)))
        assertEquals(OutageKind.EMERGENCY,ScheduleLabels.currentOrNextKind(listOf(hourly,planned,emergency),now))
        assertEquals(OutageKind.PLANNED,ScheduleLabels.currentOrNextKind(listOf(hourly,planned),now))
    }
    @Test fun staleFailedAndConflictingEvidenceDoesNotSelectTheExample(){
        val stale=data(listOf(event(Category.EMERGENCY,5)),now.minusSeconds(3*3600))
        val failed=data(listOf(event(Category.PLANNED,10))).copy(failures=setOf(Category.PLANNED))
        val conflict=data(listOf(event(Category.SCHEDULE,15))).copy(conflictDates=setOf(now.atZone(KYIV_ZONE).toLocalDate()))
        val good=data(listOf(event(Category.PLANNED,30,"Позапланове відключення")))
        assertEquals(OutageKind.UNPLANNED,ScheduleLabels.currentOrNextKind(listOf(stale,failed,conflict,good),now))
    }
    @Test fun exactStartsAndNextDayEventsAreNotRoundedOrDiscarded(){
        val earlier=data(listOf(event(Category.PLANNED,61,"Планові роботи")))
        val later=data(listOf(event(Category.EMERGENCY,62)))
        assertEquals(OutageKind.PLANNED,ScheduleLabels.currentOrNextKind(listOf(later,earlier),now))
        assertEquals(OutageKind.EMERGENCY,ScheduleLabels.currentOrNextKind(listOf(data(listOf(event(Category.EMERGENCY,24*60)))),now))
    }
    @Test fun noConfirmedCurrentOrFutureEventLeavesTheExampleUnspecified(){
        val ended=data(listOf(event(Category.PLANNED,-180)))
        assertNull(ScheduleLabels.currentOrNextKind(listOf(ended),now))
        assertNull(ScheduleLabels.currentOrNextKind(listOf(Snapshot(emptyMap())),now))
    }
}
