package ua.svitlo.widget

import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.json.JSONObject
import org.json.JSONArray
import ua.svitlo.widget.core.*
import java.time.*
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicBoolean

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[28])
class NextPatchDataTest {
    private val now=Instant.parse("2026-10-28T10:00:00Z")
    private val date=now.atZone(KYIV_ZONE).toLocalDate()
    private val context get()=RuntimeEnvironment.getApplication()
    private val address=DictionaryAddress("18","801","м. Христинівка","11807","вул. Тестова","7")
    @Before fun clear(){for(name in listOf("svitlo_private","svitlo_registry"))context.getSharedPreferences(name,0).edit().clear().commit()}
    private fun raw(events:JSONArray=JSONArray())=JSONObject().put("DATETIME","12:00 28.10.2026").put("DISCONNECTIONS",events).toString()
    private fun empty()=Snapshot(Category.entries.associateWith{CategorySnapshot(it,now,now,emptyList(),emptyList())})
    private fun event(from:String,to:String?,category:Category=Category.SCHEDULE)=Outage(category,Instant.parse(from),to?.let(Instant::parse),false,"Опубліковано","ГПВ")
    @Test fun threeRequestsStartTogetherWithoutAdditionalRequests(){
        val barrier=CountDownLatch(3);val active=AtomicInteger();val maximum=AtomicInteger();val calls=AtomicInteger()
        val source=OutageSource{_,_,_,_->
            calls.incrementAndGet();val n=active.incrementAndGet();maximum.updateAndGet{maxOf(it,n)};barrier.countDown()
            try{check(barrier.await(4,TimeUnit.SECONDS));raw()}finally{active.decrementAndGet()}
        }
        val result=OutageRepository(context,source){now}.prepare("12345678901")
        assertEquals(3,calls.get());assertEquals(3,maximum.get());assertEquals(3,result.categories.size);assertTrue(result.failures.isEmpty())
        assertNull(OutageRepository(context).binding())
    }
    @Test fun partialFailureKeepsItsOriginalCauseAndOtherResults(){
        val result=OutageRepository(context,OutageSource{_,cat,_,_->if(cat==Category.PLANNED)throw java.net.SocketTimeoutException()else raw()}){now}.prepare("12345678901")
        assertEquals(setOf(Category.PLANNED),result.failures);assertEquals(SourceFailure.TIMEOUT,result.failureReasons[Category.PLANNED]);assertEquals(2,result.categories.size)
    }
    @Test fun cancellationInterruptsOwnedTasksAndCannotPublishAPreview(){
        val started=CountDownLatch(3);val stopped=CountDownLatch(3);val release=CountDownLatch(1)
        val preserved=AtomicBoolean(false)
        val repo=OutageRepository(context,OutageSource{_,_,_,_->
            started.countDown()
            try{release.await();raw()}finally{stopped.countDown()}
        }){now}
        val caller=Thread {
            try{repo.prepare("12345678901")}
            catch(_:InterruptedException){preserved.set(Thread.currentThread().isInterrupted)}
        }
        caller.start()
        try{
            assertTrue(started.await(4,TimeUnit.SECONDS));caller.interrupt();caller.join(4000)
            assertFalse(caller.isAlive);assertTrue(preserved.get());assertTrue(stopped.await(4,TimeUnit.SECONDS));assertNull(repo.binding())
        }finally{release.countDown();caller.interrupt();caller.join(4000)}
    }
    @Test fun explicitExclusionIsExactAddressScopedFreshAndInvalidatedByUnknown(){
        fun repository(value:JSONObject)=QueueRegistryRepository(context,RegistrySource{JSONObject().put("resolution",value)}){now}
        val negative=JSONObject().put("status","not_found").put("queue",JSONObject.NULL).put("inclusion","not_in_queue")
        val registry=repository(negative)
        assertTrue(registry.refresh(address,true));assertTrue(registry.excluded(address));assertNull(registry.cached(address))
        assertFalse(registry.excluded(address.copy(house="8")));assertFalse(registry.excluded(address,now.plusSeconds(7201)))
        assertFalse(QueueRegistryRepository(context,RegistrySource{throw java.net.SocketTimeoutException()}){now}.refresh(address,true))
        assertTrue(registry.excluded(address))
        assertTrue(repository(JSONObject().put("status","not_found").put("queue",JSONObject.NULL)).refresh(address,true))
        assertFalse(registry.excluded(address))
    }
    @Test fun onlyExplicitExclusionCanConfirmAnEmptyCurrentDay(){
        val data=empty()
        assertFalse(data.knownDay(date,now));assertFalse(data.isCompleteAndFresh(now))
        val excluded=data.copy(hourlyExcluded=true)
        assertTrue(excluded.knownDay(date,now));assertEquals(1440,HourlySchedule.summary(date,excluded,now).clearMinutes)
        assertFalse(excluded.knownDay(date.plusDays(1),now))
        assertFalse(excluded.copy(failures=setOf(Category.EMERGENCY)).knownDay(date,now))
        assertFalse(excluded.knownDay(date,now.plusSeconds(7201)))
    }
    @Test fun minuteDifferenceDoesNotConflictButDifferentHalfHourDoes(){
        val from="2026-10-28T20:00:00Z";val until="2026-10-28T22:00:00Z"
        val actual=event(from,"2026-10-28T21:59:00Z")
        val plan=PublishedPlan(date,"3.2",listOf(event(from,until)),now.minusSeconds(60),now,"https://www.cherkasyoblenergo.com/off","r1")
        val data=empty().copy(categories=empty().categories.toMutableMap().apply{put(Category.SCHEDULE,CategorySnapshot(Category.SCHEDULE,now,now,listOf(actual),emptyList()))})
        val result=ScheduleFusion.merge(data,listOf(plan),now)
        assertTrue(result.conflictDates.isEmpty());assertEquals(Instant.parse(until),result.allEvents().single().end)
        assertEquals(actual.end,result.categories[Category.SCHEDULE]!!.events.single().end)
        val different=actual.copy(end=Instant.parse("2026-10-28T21:29:00Z"))
        assertEquals(setOf(date),ScheduleFusion.merge(data.copy(categories=data.categories.toMutableMap().apply{put(Category.SCHEDULE,data.categories[Category.SCHEDULE]!!.copy(events=listOf(different)))}),listOf(plan),now).conflictDates)
    }
    @Test fun gavInScheduleTransportStaysEmergencyAndSurvivesGpvReplacement(){
        val item=JSONObject().put("DATE_START","14:00 28.10.2026").put("DATE_STOP","15:00 28.10.2026").put("STATE_CHAR","Завершено").put("DISCONN_TYPE","ГАВ")
        val parsed=OutageParser.parse(raw(JSONArray().put(item)),Category.SCHEDULE,now)
        val gav=parsed.events.single();assertEquals(Category.EMERGENCY,gav.category);assertEquals(Category.SCHEDULE,gav.sourceCategory)
        val plan=PublishedPlan(date,"3.2",emptyList(),now,now,"https://www.cherkasyoblenergo.com/off","r1")
        val merged=ScheduleFusion.merge(empty().copy(categories=empty().categories.toMutableMap().apply{put(Category.SCHEDULE,parsed)}),listOf(plan),now)
        assertTrue(merged.conflictDates.isEmpty());assertEquals(listOf(gav),merged.allEvents())
    }
    @Test fun publicGpvCannotMakeCachedAddressGavFresh(){
        val gav=event("2026-10-28T11:00:00Z","2026-10-28T12:00:00Z",Category.EMERGENCY).copy(type="ГАВ",sourceCategory=Category.SCHEDULE)
        val plan=PublishedPlan(date,"3.2",emptyList(),now,now,"https://www.cherkasyoblenergo.com/off","r1")
        val data=empty().copy(categories=empty().categories.toMutableMap().apply{put(Category.SCHEDULE,CategorySnapshot(Category.SCHEDULE,now,now,listOf(gav),emptyList()))},failures=setOf(Category.SCHEDULE))
        assertFalse(ScheduleFusion.merge(data,listOf(plan),now).isCompleteAndFresh(now))
    }
    @Test fun directoryExclusionNeverOverridesAmbiguousAddressQueueEvidence(){
        val base=empty().copy(hourlyExcluded=true)
        assertTrue(base.explicitHourlyExclusion())
        val info=listOf("Графік погодинних відключень: 3 черга 2 підчерга", "Графік погодинних відключень: 2 черга 1 підчерга")
        val contradictory=base.copy(categories=base.categories.toMutableMap().apply{put(Category.SCHEDULE,base.categories.getValue(Category.SCHEDULE).copy(queueInfo=info))})
        assertNull(contradictory.queueLabel());assertFalse(contradictory.explicitHourlyExclusion());assertFalse(contradictory.knownDay(date,now))
        assertFalse(base.copy(registryQueue="3.2").explicitHourlyExclusion())
    }
    @Test fun legacyRefreshIntervalsMigrateToOneHour(){
        for(value in listOf(30,60,120,999)){
            context.getSharedPreferences("svitlo_private",0).edit().putInt("interval_minutes",value).commit()
            assertEquals(60,OutageRepository(context).intervalMinutes())
            assertEquals(60,context.getSharedPreferences("svitlo_private",0).getInt("interval_minutes",0))
        }
    }
}
