package ua.svitlo.widget

import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import ua.svitlo.widget.core.*
import java.time.Instant
import java.time.LocalDate

@RunWith(RobolectricTestRunner::class) @Config(sdk=[28])
class Emergency141Test {
    private val now=Instant.parse("2026-10-23T21:53:00Z") // Kyiv, 24 October 00:53
    private val day=LocalDate.of(2026,10,24)
    private fun at(hour:Int)=day.atTime(hour,0).atZone(KYIV_ZONE).toInstant()
    private fun notices()=EmergencyParser.parse(OfficialScheduleParser.article(javaClass.getResource("/emergency/oct23.json")!!.readText()))
    private fun plan(queue:String="3.2")=PublishedPlan(day,queue,listOf(Outage(Category.SCHEDULE,at(12),at(14),false,"","")),
        Instant.parse("2026-10-23T17:00:00Z"),now,"https://www.cherkasyoblenergo.com/media/test","next-day")
    private fun snapshot(policy:EmergencyPolicy,failed:Boolean=false)=Snapshot(Category.entries.associateWith{
        CategorySnapshot(it,now,now,emptyList(),emptyList())},plans=listOf(plan()),feedFailed=failed,
        effectiveEvents=plan().events,emergency=policy)
    @Test fun midnightWithFreshSourcePreservesExplicitHourlyValidityAndTotals(){
        val p=EmergencyPolicy(notices(),"3.2",now)
        assertTrue(p.status(now,listOf(plan())).active)
        assertFalse(p.status(now,listOf(plan())).stale)
        assertEquals(HourlyValidity.ACTIVE,p.status(now,listOf(plan())).hourly)
        val s=snapshot(p)
        assertFalse(p.affects(day,s.plans,now));assertTrue(s.knownDay(day,now))
        val total=HourlySchedule.summary(day,s,now)
        assertEquals(120L,total.outageMinutes);assertEquals(0L,total.unknownMinutes)
        assertFalse(TimelineViewport(day).segments(s,now).any{it.uncertain})
    }
    @Test fun networkFailureDoesNotInventHourlySuspensionOrGuaranteedClearDay(){
        val p=EmergencyPolicy(notices(),"3.2",now.minusSeconds(10800),true)
        val state=p.status(now,listOf(plan()))
        assertTrue(state.active);assertTrue(state.stale);assertEquals(HourlyValidity.ACTIVE,state.hourly)
        assertFalse(p.uncertain(now,listOf(plan())))
        val s=snapshot(p,true)
        assertFalse(s.checkedEmptyToday(day,now));assertFalse(s.isCompleteAndFresh(now))
        assertTrue(TimelineViewport(day).segments(s,now).any{it.uncertain})
    }
    @Test fun fractionalCurrentInstantCannotLoseAMinuteInDayTotals(){
        val instant=now.plusNanos(123456789)
        val total=HourlySchedule.summary(day,snapshot(EmergencyPolicy(notices(),"3.2",now)),instant)
        assertEquals(120L,total.outageMinutes);assertEquals(1320L,total.clearMinutes)
        assertEquals(1440L,total.outageMinutes+total.clearMinutes+total.unknownMinutes)
    }
    @Test fun unknownOrSuspendedEmergencyIsNotSilentlyEndedAtMidnight(){
        for(validity in listOf(HourlyValidity.UNKNOWN,HourlyValidity.SUSPENDED)){
            val command=notices().first().copy(hourly=validity)
            val p=EmergencyPolicy(listOf(command),"3.2",now)
            assertTrue(p.status(now).active);assertTrue(p.uncertain(now,emptyList()))
            assertEquals(validity,p.status(now,listOf(plan("2.1"))).hourly)
            assertEquals(HourlyValidity.ACTIVE,p.status(now,listOf(plan())).hourly)
        }
    }
    @Test fun explicitEndReplacesPriorStateWithoutCreatingAnAddressOutage(){
        val end=notices().first().copy(id="end",publishedAt=now,effectiveAt=at(0),active=false,hourly=null)
        val p=EmergencyPolicy(notices()+end,"3.2",now)
        assertFalse(p.status(now,listOf(plan())).active)
        assertFalse(TimelineViewport(day).segments(snapshot(p),now).any{it.category==Category.EMERGENCY})
    }
    @Test fun switchingProfilesKeepsRegionalHistoryAndDoesNotTransferAddressEmergency(){
        val c=RuntimeEnvironment.getApplication()
        listOf("svitlo_private","svitlo_profiles","svitlo_official").forEach{c.getSharedPreferences(it,0).edit().clear().commit()}
        val a="12345678901";val b="12345678902"
        val source=OutageSource{account,category,_,_->
            val events=if(account==a && category==Category.EMERGENCY)"""[{"DATE_START":"00:15 24.10.2026","DATE_STOP":"01:15 24.10.2026","DISCONN_TYPE":"Аварія","STATE_CHAR":"Триває"}]""" else "[]"
            val queue=if(account==a)"3 черга 2 підчерга" else "2 черга 1 підчерга"
            """{"DATETIME":"00:53 24.10.2026","DISCONNECTIONS":$events,"DISCONN_QUEUQ":[{"QUEUE_INFO":"Графік погодинних відключень: $queue"}]}"""
        }
        val repo=OutageRepository(c,source){now};val profiles=AddressProfiles(c)
        assertTrue(profiles.confirm(a,"Тестова адреса А",repo.prepare(a),name="А",add=true));val idA=profiles.active()!!.id
        assertTrue(profiles.confirm(b,"Тестова адреса Б",repo.prepare(b),name="Б",add=true));val idB=profiles.active()!!.id
        val article=OfficialScheduleParser.article(javaClass.getResource("/emergency/oct23.json")!!.readText())
        val official=OfficialScheduleRepository(c,OfficialFeedSource{listOf(article)},{now})
        assertTrue(official.refresh());val history=official.changes()
        for(id in listOf(idA,idB,idA)){
            assertTrue(profiles.activate(id));val s=repo.snapshot()
            assertEquals(HourlyValidity.ACTIVE,s.emergency.status(now).hourly)
            assertFalse(s.emergency.status(now).confirmedActive)
            assertFalse(s.emergency.status(now).stale)
            assertEquals(id==idA,s.allEvents().any{it.category==Category.EMERGENCY})
            assertEquals(history,official.changes())
        }
        official.clear()
        for(id in listOf(idB,idA,idB)){
            assertTrue(profiles.activate(id));assertFalse(repo.snapshot().emergency.status(now).active)
        }
    }
}
