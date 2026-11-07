package ua.svitlo.widget

import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import ua.svitlo.widget.core.*
import java.time.Instant

@RunWith(RobolectricTestRunner::class) @Config(sdk=[28])
class Emergency142Test {
    private val now=Instant.parse("2026-10-23T22:22:00Z") // Screenshot: 24 October, 01:22 Kyiv.
    private fun command(start:Instant=now.minusSeconds(600))=EmergencyNotice("start",start,start,true,
        HourlyValidity.ACTIVE,sourceUrl="https://www.cherkasyoblenergo.com/media/test")
    private fun article(name:String)=OfficialScheduleParser.article(javaClass.getResource("/emergency/$name.json")!!.readText())

    @Test fun actualOctoberCommandIsRecentEvidenceOnlyOnItsPublicationDay(){
        val notices=EmergencyParser.parse(article("oct23"))
        val recent=Instant.parse("2026-10-23T08:00:00Z")
        assertTrue(EmergencyPolicy(notices,"3.2",recent).status(recent).confirmedActive)
        val state=EmergencyPolicy(notices,"3.2",now).status(now)
        assertTrue(state.active) // Last known command is retained, no invented restoration.
        assertFalse(state.stale) // Even a successful fresh fetch must not revive old evidence.
        assertFalse(state.confirmedActive)
        assertEquals(HourlyValidity.ACTIVE,state.hourly)
    }
    @Test fun unchangedNewsExpiresAtTwoHoursEvenWithFreshChecks(){
        val notice=command()
        val boundary=notice.publishedAt.plusSeconds(7200)
        for(seconds in listOf(-1L,0L,1L,86400L)){
            val at=boundary.plusSeconds(seconds)
            val state=EmergencyPolicy(listOf(notice),"3.2",at).status(at)
            assertEquals(seconds<0,state.confirmedActive)
            assertTrue(state.active)
        }
    }
    @Test fun aRecentCommandAcrossMidnightDoesNotDisappearJustBecauseTheDateChanged(){
        val started=Instant.parse("2026-10-23T20:50:00Z") // 23:50
        val afterMidnight=Instant.parse("2026-10-23T21:10:00Z") // 00:10
        assertTrue(EmergencyPolicy(listOf(command(started)),"3.2",afterMidnight).status(afterMidnight).confirmedActive)
    }
    @Test fun explicitValidityIntervalIsHonouredWithoutAnInventedTwoHourEnd(){
        val end=now.plusSeconds(1800)
        val notice=command(now.minusSeconds(14400)).copy(until=end)
        assertTrue(EmergencyPolicy(listOf(notice),"3.2",now).status(now).confirmedActive)
        val ended=EmergencyPolicy(listOf(notice),"3.2",end).status(end)
        assertFalse(ended.confirmedActive);assertFalse(ended.active)
    }
    @Test fun missingFailedStaleOrFutureSourceCheckCannotConfirmLiveWarning(){
        for(check in listOf(null,now.minusSeconds(7201),now.plusSeconds(301),now.minusSeconds(601))){
            val state=EmergencyPolicy(listOf(command()),"3.2",check).status(now)
            assertFalse(state.confirmedActive);assertTrue(state.active)
        }
        val failed=EmergencyPolicy(listOf(command()),"3.2",now,true).status(now)
        assertFalse(failed.confirmedActive);assertEquals(HourlyValidity.ACTIVE,failed.hourly)
    }
    @Test fun futureStartAndExplicitCancellationCannotShowLiveWarning(){
        val future=command(now).copy(effectiveAt=now.plusSeconds(3600))
        assertFalse(EmergencyPolicy(listOf(future),"3.2",now).status(now).confirmedActive)
        val started=now.plusSeconds(3600)
        assertTrue(EmergencyPolicy(listOf(future),"3.2",started).status(started).confirmedActive)
        val end=command(now).copy(id="end",active=false)
        assertFalse(EmergencyPolicy(listOf(command(),end),"3.2",now).status(now).confirmedActive)
    }
    @Test fun anotherQueuesCommandAndAnHourlyOnlyUpdateCannotReviveExpiredEmergency(){
        val old=command(now.minusSeconds(10800))
        val scoped=command().copy(id="another",queues=setOf("2.1"))
        val hourly=command(now).copy(id="hourly",active=null)
        assertFalse(EmergencyPolicy(listOf(old,scoped,hourly),"3.2",now).status(now).confirmedActive)
        assertTrue(EmergencyPolicy(listOf(old,scoped,hourly),"2.1",now).status(now).confirmedActive)
        assertTrue(EmergencyPolicy(listOf(old,command()),"3.2",now).status(now).confirmedActive)
    }
    @Test fun hidingExpiredWarningDoesNotTurnUnknownOrSuspendedDataIntoClearDay(){
        for(validity in listOf(HourlyValidity.UNKNOWN,HourlyValidity.SUSPENDED)){
            val policy=EmergencyPolicy(listOf(command(now.minusSeconds(10800)).copy(hourly=validity)),"3.2",now)
            val snapshot=Snapshot(Category.entries.associateWith{CategorySnapshot(it,now,now,emptyList(),emptyList())},emergency=policy)
            assertFalse(policy.status(now).confirmedActive)
            assertTrue(policy.uncertain(now,emptyList()))
            assertFalse(snapshot.knownDay(now.atZone(KYIV_ZONE).toLocalDate(),now))
            assertTrue(HourlySchedule.summary(now.atZone(KYIV_ZONE).toLocalDate(),snapshot,now).unknownMinutes>0)
        }
    }
    @Test fun freshRepositoryFetchAndReopenDoNotReviveRealPreviousDayNews(){
        val context=RuntimeEnvironment.getApplication()
        listOf("svitlo_private","svitlo_profiles","svitlo_official").forEach{context.getSharedPreferences(it,0).edit().clear().commit()}
        var clock=now
        val source=OfficialFeedSource{listOf(article("oct23"),article("oct24"))}
        val official=OfficialScheduleRepository(context,source){clock}
        val raw="""{"DATETIME":"01:22 24.10.2026","DISCONNECTIONS":[],"DISCONN_QUEUQ":[{"QUEUE_INFO":"Графік погодинних відключень: 3 черга 2 підчерга"}]}"""
        val repo=OutageRepository(context,OutageSource{_,_,_,_->raw}){clock}
        assertTrue(repo.bindConfirmed("12345678901","Тестова адреса",repo.prepare("12345678901")))
        assertTrue(official.refresh())
        val before=official.snapshot().emergencies
        repeat(2){
            val snapshot=repo.snapshot();val state=snapshot.emergency.status(clock,snapshot.plans)
            assertFalse(state.confirmedActive);assertTrue(state.active);assertFalse(state.stale)
            assertEquals(HourlyValidity.ACTIVE,state.hourly)
            val totals=HourlySchedule.summary(clock.atZone(KYIV_ZONE).toLocalDate(),snapshot,clock)
            assertEquals(240L,totals.outageMinutes);assertEquals(1200L,totals.clearMinutes)
            assertEquals(before,OfficialScheduleRepository(context).snapshot().emergencies)
            clock=clock.plusSeconds(600);assertTrue(official.refresh())
        }
    }
}
