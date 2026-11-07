package ua.svitlo.widget

import androidx.work.*
import androidx.work.testing.TestListenableWorkerBuilder
import androidx.work.testing.WorkManagerTestInitHelper
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.time.Instant
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class) @Config(sdk=[28])
class MessageWorker160Test {
    private val c get()=RuntimeEnvironment.getApplication()
    private val at=Instant.now()
    private fun empty()=JSONObject().put("schema",1).put("packageId","ua.svitlo.widget").put("generatedAt",at.toString()).put("messages",JSONArray()).toString()
    @Before fun clear(){listOf("svitlo_remote_messages","svitlo_app_updates","svitlo_activity").forEach{c.getSharedPreferences(it,0).edit().clear().commit()}
        WorkManagerTestInitHelper.initializeTestWorkManager(c,Configuration.Builder().setExecutor(Executor{}).setTaskExecutor(Executor{it.run()}).build(),WorkManagerTestInitHelper.ExecutorsMode.PRESERVE_EXECUTORS)}
    @Test fun networkFailureRequestsRetryEvenWithNoAddressAndKeepsOtherSourceSuccess(){
        assertNull(OutageRepository(c).binding())
        val worker=TestListenableWorkerBuilder<MessageWorker>(context=c).build()
        worker.releases=AppUpdateRepository(c,{throw java.io.IOException("offline")},{at},25,28)
        worker.messages=RemoteMessageRepository(c,{MessageResponse(200,empty())},PrivateMessageSource{_,_,_->empty()},{at},25)
        assertEquals(ListenableWorker.Result.retry(),runBlocking{worker.doWork()})
        assertTrue(c.getSharedPreferences("svitlo_remote_messages",0).getLong("public:success",0)>0)
        assertTrue(c.getSharedPreferences("svitlo_remote_messages",0).getLong("private:success",0)>0)
    }
    @Test fun workerStopsAfterBoundedRetriesAndPermanentErrorsDoNotRetry(){
        assertEquals(ListenableWorker.Result.failure(),MessageWorker.completion(listOf(MessageRefresh(false,true)),4))
        assertEquals(ListenableWorker.Result.failure(),MessageWorker.completion(listOf(MessageRefresh(false,false)),0))
        assertEquals(ListenableWorker.Result.success(),MessageWorker.completion(listOf(MessageRefresh(true)),0))
    }
    @Test fun scheduleMigratesLegacyJobsAndWorksWithoutAddress(){
        val wm=WorkManager.getInstance(c)
        wm.enqueueUniquePeriodicWork("svitlo-app-versions",ExistingPeriodicWorkPolicy.KEEP,PeriodicWorkRequestBuilder<AppUpdateWorker>(24,TimeUnit.HOURS).build()).result.get()
        repeat(4){MessageWorker.schedule(c)}
        assertTrue(wm.getWorkInfosForUniqueWork("svitlo-app-versions").get().all{it.state.isFinished})
        val daily=wm.getWorkInfosForUniqueWork("svitlo-messages-daily").get().filterNot{it.state.isFinished}
        assertEquals(1,daily.size);assertEquals(TimeUnit.HOURS.toMillis(24),daily.single().periodicityInfo!!.repeatIntervalMillis)
        assertEquals(NetworkType.CONNECTED,daily.single().constraints.requiredNetworkType)
        assertEquals(1,wm.getWorkInfosForUniqueWork("svitlo-messages-now").get().count{!it.state.isFinished})
    }
    @Test fun longRetryAfterHasOnePersistedRecoveryWakeupEvenWhenWorkerBudgetEnds(){
        val next=System.currentTimeMillis()+3_600_000
        repeat(3){MessageWorker.scheduleRecovery(c,listOf(MessageRefresh(false,true,next,true)))}
        val jobs=WorkManager.getInstance(c).getWorkInfosForUniqueWork("svitlo-messages-recovery-$next").get().filterNot{it.state.isFinished}
        assertEquals(1,jobs.size);assertTrue(jobs.single().initialDelayMillis in 3_590_000..3_600_000)
        assertEquals(ListenableWorker.Result.failure(),MessageWorker.completion(listOf(MessageRefresh(false,true,next)),4))
    }
}
