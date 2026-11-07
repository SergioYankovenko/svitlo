package ua.svitlo.widget

import org.junit.Assert.*
import org.junit.Test
import ua.svitlo.widget.core.*
import java.net.SocketTimeoutException
import java.time.*
import java.util.concurrent.*
import java.util.concurrent.atomic.AtomicBoolean

class InitialScheduleLoaderTest {
    private val now=Instant.parse("2026-10-28T12:00:00Z")
    private val day=now.atZone(KYIV_ZONE).toLocalDate()
    private fun data(queue:Boolean=false)=PreparedData("12345678901",day.minusDays(1),day.plusDays(1),Category.entries.associateWith{
        PreparedCategory("{}",CategorySnapshot(it,now,now,emptyList(),if(queue && it==Category.SCHEDULE)listOf("Графік погодинних відключень: 3 черга 2 підчерга")else emptyList()))
    },emptySet())
    private fun snapshot(data:PreparedData,queue:String?="3.2",excluded:Boolean=false)=Snapshot(data.categories.mapValues{it.value.snapshot},registryQueue=queue,hourlyExcluded=excluded)
    @Test fun waitsForEveryPrerequisiteWithoutActivatingAnything(){
        val started=CountDownLatch(2);val release=CountDownLatch(1);val previewed=AtomicBoolean()
        fun step(){started.countDown();check(release.await(2,TimeUnit.SECONDS))}
        val loader=InitialScheduleLoader({step();data()},{step()},{step()},{previewed.set(true);snapshot(it)},now={now},timeoutMs=1500)
        val pool=Executors.newSingleThreadExecutor()
        try{val result=pool.submit<PreparedData>{loader.load()};assertTrue(started.await(1,TimeUnit.SECONDS));assertFalse(result.isDone);assertFalse(previewed.get())
            release.countDown();assertTrue(result.get(1,TimeUnit.SECONDS).failures.isEmpty());assertTrue(previewed.get())
        }finally{release.countDown();pool.shutdownNow()}
    }
    @Test fun oneDeadlineBoundsSlowSourceAndLateWorkNeverReachesPreview(){
        val previewed=AtomicBoolean();val interrupted=CountDownLatch(1)
        val loader=InitialScheduleLoader({data()},{try{Thread.sleep(5000)}catch(e:InterruptedException){interrupted.countDown();throw e}},{},
            {previewed.set(true);snapshot(it)},now={now},timeoutMs=100)
        val start=System.nanoTime()
        try{loader.load();fail("Expected deadline")}catch(_:SocketTimeoutException){}
        assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-start)<1500)
        assertTrue(interrupted.await(1,TimeUnit.SECONDS));assertFalse(previewed.get())
    }
    @Test fun knownApiQueueDoesNotWaitForOptionalRegistryFailure(){
        val loader=InitialScheduleLoader({data(true)},{throw IllegalStateException("registry offline")},{},{snapshot(it)},now={now})
        assertEquals("3.2",Snapshot(loader.load().categories.mapValues{it.value.snapshot}).queueLabel())
    }
    @Test fun partialAddressResponseIsAnErrorBeforeConfirmation(){
        val previewed=AtomicBoolean();val partial=data().copy(failures=setOf(Category.EMERGENCY))
        try{InitialScheduleLoader({partial},{},{},{previewed.set(true);snapshot(it)},now={now}).load();fail("Expected incomplete data failure")}
        catch(_:SourceException){}
        assertFalse(previewed.get())
    }
    @Test fun unknownQueueNeverBecomesSuccessfulEmptyDay(){
        try{InitialScheduleLoader({data()},{},{},{snapshot(it,null)},now={now}).load();fail("Expected unknown queue")}
        catch(error:SetupDataUnavailable){assertTrue(error.message!!.contains("чергу"))}
    }
    @Test fun explicitAddressExclusionIsSuccessfulWithoutQueue(){
        assertTrue(InitialScheduleLoader({data()},{},{},{snapshot(it,null,true)},now={now}).load().failures.isEmpty())
    }
    @Test fun publicFailureAndConflictDoNotOpenAnEmptyDashboard(){
        for(conflict in listOf(false,true))try{
            InitialScheduleLoader({data()},{},{},{snapshot(it).copy(feedFailed=!conflict,conflictDates=if(conflict)setOf(day)else emptySet())},now={now}).load()
            fail("Expected unresolved publication")
        }catch(_:SetupDataUnavailable){}
    }
    @Test fun genuineEmergencyUncertaintyDoesNotPreventAddingConfirmedAddress(){
        // Unknown restoration is real information, distinct from an unfinished request.
        assertTrue(InitialScheduleLoader({data()},{},{},{snapshot(it).copy(effectiveEvents=listOf(Outage(Category.EMERGENCY,now.minusSeconds(60),null,false,"","Аварійні")))},now={now}).load().failures.isEmpty())
    }
}
