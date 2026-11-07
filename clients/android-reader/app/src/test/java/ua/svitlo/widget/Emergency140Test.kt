package ua.svitlo.widget

import android.content.Context
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
class Emergency140Test {
    private val now=Instant.parse("2026-10-23T09:00:00Z")
    private val date=LocalDate.of(2026,10,23)
    private fun at(hour:Int)=date.atTime(hour,0).atZone(KYIV_ZONE).toInstant()
    private fun article(body:String,time:Instant=now,id:String="fixture")=OfficialArticle(id,"Аварійні відключення по Черкаській області",body,time,"https://www.cherkasyoblenergo.com/media/$id")
    private fun notice(active:Boolean?,hourly:HourlyValidity?,hour:Int=10,queue:Set<String> = emptySet())=
        EmergencyNotice("test$hour",at(hour),at(hour),active,hourly,queue,sourceUrl="https://www.cherkasyoblenergo.com/media/test")
    private fun plan(hour:Int=8)=PublishedPlan(date,"3.2",listOf(event(Category.SCHEDULE,8,14)),at(hour),now,"https://www.cherkasyoblenergo.com/media/test","plan")
    private fun event(category:Category,start:Int,end:Int?)=Outage(category,at(start),end?.let(::at),false,"","")
    private fun snapshot(events:List<Outage>,policy:EmergencyPolicy=EmergencyPolicy()):Snapshot=Snapshot(Category.entries.associateWith{c->
        CategorySnapshot(c,now,now,events.filter{it.category==c},emptyList())},plans=listOf(plan()),emergency=policy)

    @Test fun actualOctoberBulletinKeepsHourlyPlanActive(){
        val raw=javaClass.getResource("/emergency/oct23.json")!!.readText()
        val notices=EmergencyParser.parse(OfficialScheduleParser.article(raw))
        val policy=EmergencyPolicy(notices,"3.2",now)
        assertEquals(2,notices.size)
        assertEquals(Instant.parse("2026-10-23T07:32:00Z"),notices.first().effectiveAt)
        assertTrue(policy.status(now).active);assertEquals(HourlyValidity.ACTIVE,policy.status(now).hourly)
    }
    @Test fun actualJulyBulletinHasNoInventedEndOrHourlyCancellation(){
        val notices=EmergencyParser.parse(OfficialScheduleParser.article(javaClass.getResource("/emergency/jul03.json")!!.readText()))
        assertEquals(1,notices.size)
        assertEquals(Instant.parse("2026-07-03T10:44:00Z"),notices.single().effectiveAt)
        assertNull(notices.single().until)
        assertEquals(HourlyValidity.UNKNOWN,EmergencyPolicy(notices).status(Instant.parse("2026-07-03T11:00:00Z")).hourly)
    }
    @Test fun hypotheticalExplainerDoesNotActivateOrCancelAnything(){
        for(body in listOf("По Черкаській області можуть бути застосовані графіки аварійних відключень.",
            "По Черкаській області у разі аварії діють графіки аварійних відключень.",
            "По Черкаській області графіки аварійних відключень не скасовані.",
            "Під час аварійних відключень погодинні графіки не діють у Черкаській області."))
            assertTrue(body,EmergencyParser.parse(article(body)).isEmpty())
    }
    @Test fun otherRegionsDoNotSuspendCherkasy(){
        val result=EmergencyParser.parse(article("По Черкаській області застосовані графіки аварійних відключень. У Київській області погодинні графіки не діють."))
        assertEquals(1,result.size);assertNull(result.single().hourly)
    }
    @Test fun explicitFutureCommandStartsAtItsTime(){
        val result=EmergencyParser.parse(article("По Черкаській області завтра, 24 жовтня, з 08:00 будуть застосовані графіки аварійних відключень."))
        assertEquals(1,result.size)
        val p=EmergencyPolicy(result)
        assertFalse(p.status(now).active)
        assertTrue(p.status(Instant.parse("2026-10-24T05:00:00Z")).active)
    }
    @Test fun scopedHourlySuspensionDoesNotAffectOtherSubgroup(){
        val result=EmergencyParser.parse(article("По Черкаській області з 10:00 графіки аварійних відключень застосовані. Для підчерги 3.2 з 11:00 погодинний графік не діє."))
        assertEquals(HourlyValidity.SUSPENDED,EmergencyPolicy(result,"3.2",now).status(now).hourly)
        assertEquals(HourlyValidity.UNKNOWN,EmergencyPolicy(result,"1.1",now).status(now).hourly)
    }
    @Test fun emergencyQueueIsNotHourlySubqueue(){
        val result=EmergencyParser.parse(article("По Черкаській області лише 3 черга: застосовані графіки аварійних відключень."))
        assertTrue(result.isEmpty())
    }
    @Test fun endedEmergencyDoesNotRestoreSuspendedHourly(){
        val policy=EmergencyPolicy(listOf(notice(true,HourlyValidity.SUSPENDED),notice(false,null,11)),"3.2",now)
        assertFalse(policy.status(now).active);assertEquals(HourlyValidity.SUSPENDED,policy.status(now).hourly)
        assertEquals(HourlyValidity.ACTIVE,policy.status(now,listOf(plan(11))).hourly)
        assertEquals(HourlyValidity.SUSPENDED,policy.status(now,listOf(plan(8))).hourly)
    }
    @Test fun sortingUsesEventTimeNotFetchOrder(){
        val start=notice(true,HourlyValidity.SUSPENDED);val end=notice(false,HourlyValidity.ACTIVE,11)
        assertEquals(EmergencyPolicy(listOf(start,end)).status(now),EmergencyPolicy(listOf(end,start)).status(now))
    }
    @Test fun cancellationClipsOnlyAffectedPartAndCountsOverlapOnce(){
        val policy=EmergencyPolicy(listOf(notice(true,HourlyValidity.SUSPENDED)),"3.2",now)
        val filtered=policy.filterHourly(listOf(event(Category.SCHEDULE,8,14),event(Category.EMERGENCY,9,11)),listOf(plan()))
        assertEquals(at(10),filtered.first{it.category==Category.SCHEDULE}.end)
        assertEquals(at(11),filtered.first{it.category==Category.EMERGENCY}.end)
        val s=snapshot(filtered,policy)
        val summary=HourlySchedule.summary(date,s,now)
        assertEquals(180L,summary.outageMinutes)
        assertTrue(summary.unknownMinutes>0)
        assertTrue(ReminderPlan.create(s,now,true,true).isEmpty())
        assertEquals("Час відновлення уточнюється",Presentation.remainingTime(s,now))
    }
    @Test fun regionalEmergencyAloneNeverPaintsAddressRed(){
        val policy=EmergencyPolicy(listOf(notice(true,HourlyValidity.ACTIVE)),"3.2",now)
        assertFalse(HourlySchedule.tiles(date,snapshot(listOf(event(Category.SCHEDULE,8,14)),policy),now)
            .flatMap{it.segments}.any{it.category==Category.EMERGENCY})
    }
    @Test fun unknownEndIsRedOnlyUntilNowAndPlanRemainsVisibleInFuture(){
        val s=snapshot(listOf(event(Category.SCHEDULE,8,14),event(Category.EMERGENCY,10,null)))
        val segments=TimelineViewport(date).segments(s,now)
        assertTrue(segments.any{it.start==at(10) && it.end==now && it.category==Category.EMERGENCY && !it.uncertain})
        assertFalse(segments.any{it.start>=now && it.category==Category.EMERGENCY})
        assertTrue(segments.any{it.start>=now && it.category==Category.SCHEDULE && it.uncertain})
        assertTrue(segments.any{it.start>=at(14) && it.category==null && it.uncertain})
        assertEquals("Час відновлення уточнюється",Presentation.remainingTime(s,now))
        assertTrue(ReminderPlan.create(s,now,true,true).isEmpty())
        assertEquals(Presentation.WidgetSignal.EMERGENCY,Presentation.widgetSignal(s,now))
    }
    @Test fun offlineRefreshKeepsEmergencyAndNeverClaimsRestoration(){
        val c=RuntimeEnvironment.getApplication()
        c.getSharedPreferences("svitlo_official",Context.MODE_PRIVATE).edit().clear().commit()
        val good=OfficialScheduleRepository(c,OfficialFeedSource{listOf(article("По Черкаській області з 10:00 застосовані графіки аварійних відключень."))},{now})
        assertTrue(good.refresh());assertEquals(1,good.snapshot().emergencies.size)
        val bad=OfficialScheduleRepository(c,OfficialFeedSource{throw java.io.IOException("offline")},{now.plusSeconds(60)})
        assertFalse(bad.refresh());assertEquals(good.snapshot().emergencies,bad.snapshot().emergencies)
        assertTrue(bad.snapshot().failed)
    }
    @Test fun oldFirstDiscoveryCannotActivateCurrentRegime(){
        val c=RuntimeEnvironment.getApplication()
        c.getSharedPreferences("svitlo_official",Context.MODE_PRIVATE).edit().clear().commit()
        val old=OfficialScheduleParser.article(javaClass.getResource("/emergency/jul03.json")!!.readText())
        val repo=OfficialScheduleRepository(c,OfficialFeedSource{listOf(old)},{now})
        assertTrue(repo.refresh());assertTrue(repo.snapshot().emergencies.isEmpty())
    }
    @Test fun ordinaryHourlyPublicationDoesNotCreateADuplicateRegionalCommand(){
        val a=article("23 жовтня з 00:00 по Черкаській області застосовані графіки погодинних відключень.\n3.2 08:00 - 14:00")
            .copy(title="Графіки погодинних відключень на 23 жовтня")
        assertTrue(EmergencyParser.parse(a).isEmpty())
    }
    @Test fun futureSuspensionBoundaryIsNotAFabricatedRestoration(){
        val early=at(9)
        val policy=EmergencyPolicy(listOf(notice(true,HourlyValidity.SUSPENDED)),"3.2",early)
        val p=plan()
        val s=Snapshot(Category.entries.associateWith{c->CategorySnapshot(c,early,early,emptyList(),emptyList())},
            plans=listOf(p.copy(checkedAt=early)),effectiveEvents=policy.filterHourly(p.events,listOf(p)),emergency=policy)
        assertEquals("Час відновлення уточнюється",Presentation.remainingTime(s,early))
        assertFalse(ReminderPlan.create(s,early,true,true).any{it.kind=="before_on"})
    }
    @Test fun sameBulletinIsIdempotentButAnExplicitEndUpdatesStoredRegime(){
        val c=RuntimeEnvironment.getApplication();c.getSharedPreferences("svitlo_official",0).edit().clear().commit()
        var current=article("По Черкаській області з 10:00 застосовані графіки аварійних відключень.")
        val repo=OfficialScheduleRepository(c,OfficialFeedSource{listOf(current)},{now})
        assertTrue(repo.refresh());val first=repo.changes()
        assertTrue(repo.refresh());assertEquals(first,repo.changes())
        current=article("По Черкаській області з 11:00 скасовані графіки аварійних відключень.",now,"ended")
        assertTrue(repo.refresh())
        assertFalse(EmergencyPolicy(repo.snapshot().emergencies,"3.2",now).status(now).active)
        assertEquals(2,repo.changes().count{it.kind=="regime"})
    }
}
