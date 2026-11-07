package ua.svitlo.widget.core

import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class ReminderPlanTest {
    private val now=Instant.parse("2026-10-23T04:00:00Z")
    private fun outage(start:Long,end:Long?,category:Category=Category.SCHEDULE)=Outage(category,now.plusSeconds(start),end?.let{now.plusSeconds(it)},false,"","ГПВ")
    private fun data(vararg events:Outage)=Snapshot(Category.entries.associateWith{category->
        CategorySnapshot(category,now,now,events.filter{it.category==category},testQueue(category))})
    @Test fun schedulesConfiguredThirtyMinutesBeforeBothTransitions(){
        val events=ReminderPlan.create(data(outage(7200,14400)),now,true,true)
        assertEquals(listOf(now.plusSeconds(5400),now.plusSeconds(12600)),events.map{it.at})
        assertEquals(listOf("before_off","before_on"),events.map{it.kind})
    }
    @Test fun overlapsAndAdjacentCategoriesBecomeOneSupplyInterruption(){
        val events=ReminderPlan.create(data(outage(7200,14400),outage(10800,18000,Category.EMERGENCY),outage(18000,21600)),now,true,true)
        assertEquals(2,events.size);assertEquals(now.plusSeconds(21600),events.last().transition)
    }
    @Test fun pastAlarmTimesAreNotDeliveredImmediately(){
        val events=ReminderPlan.create(data(outage(600,3600)),now,true,true)
        assertEquals(1,events.size);assertEquals("before_on",events.single().kind)
    }
    @Test fun openEndedEmergencyDoesNotPromiseRestoration(){
        val events=ReminderPlan.create(data(outage(7200,null,Category.EMERGENCY),outage(10800,18000)),now,true,true)
        assertEquals(listOf("before_off"),events.map{it.kind})
    }
    @Test fun staleConflictOrPartialSourceDoesNotScheduleReminders(){
        val snapshot=data(outage(7200,14400))
        assertTrue(ReminderPlan.create(snapshot.copy(feedFailed=true),now,true,true).isEmpty())
        assertTrue(ReminderPlan.create(snapshot.copy(failures=setOf(Category.PLANNED)),now,true,true).isEmpty())
        assertTrue(ReminderPlan.create(snapshot,now.plusSeconds(10800),true,true).isEmpty())
    }
    @Test fun switchesAreIndependent(){
        val snapshot=data(outage(7200,14400))
        assertEquals(listOf("before_on"),ReminderPlan.create(snapshot,now,false,true).map{it.kind})
        assertTrue(ReminderPlan.create(snapshot,now,false,false).isEmpty())
    }
}
