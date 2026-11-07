package ua.svitlo.widget

import android.content.Context
import androidx.work.*
import androidx.work.testing.WorkManagerTestInitHelper
import androidx.work.testing.TestListenableWorkerBuilder
import kotlinx.coroutines.runBlocking
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
class AppUpdateDailyTest {
    private val context:Context get()=RuntimeEnvironment.getApplication()
    private var time=Instant.parse("2026-10-24T10:00:00Z")
    private var calls=0
    private fun repository()=AppUpdateRepository(context,{calls++;throw java.io.IOException("404")},{time},11,28)
    @Before fun clear(){context.getSharedPreferences("svitlo_app_updates",0).edit().clear().commit()}
    @Test fun transientFailureRetriesAfterMinuteAcrossRepositoryRestart(){
        val first=time
        assertFalse(repository().refresh());assertEquals(1,calls)
        for(seconds in listOf(1L,30L,59L)){
            time=first.plusSeconds(seconds);repository().refresh();assertEquals(1,calls)
        }
        time=first.plusSeconds(60);repository().refresh();assertEquals(2,calls)
    }
    @Test fun clockRollbackDoesNotCauseRepeatedRequests(){
        repository().refresh();time=time.minusSeconds(60)
        repeat(3){repository().refresh()};assertEquals(1,calls)
    }
    @Test fun legacyForcedJobCannotBypassDailyLimit(){
        repository().refresh()
        val worker=TestListenableWorkerBuilder<AppUpdateWorker>(context=context,inputData=workDataOf("force" to true)).build()
        worker.updates=repository()
        assertEquals(ListenableWorker.Result.retry(),runBlocking{worker.doWork()})
        assertEquals(1,calls)
    }
    @Test fun migratesSixHourlyWorkWithoutDuplicatesAndCancelsOldManualRequest(){
        WorkManagerTestInitHelper.initializeTestWorkManager(context,Configuration.Builder()
            .setExecutor(Executor{}).setTaskExecutor(Executor{it.run()}).build(),
            WorkManagerTestInitHelper.ExecutorsMode.PRESERVE_EXECUTORS)
        val manager=WorkManager.getInstance(context)
        val old=PeriodicWorkRequestBuilder<AppUpdateWorker>(6,TimeUnit.HOURS).build()
        manager.enqueueUniquePeriodicWork("svitlo-app-versions",ExistingPeriodicWorkPolicy.KEEP,old).result.get()
        manager.enqueueUniqueWork("svitlo-app-version-now",ExistingWorkPolicy.KEEP,
            OneTimeWorkRequestBuilder<AppUpdateWorker>().build()).result.get()
        repeat(3){AppUpdateWorker.schedule(context)}
        val pending=manager.getWorkInfosForUniqueWork("svitlo-app-versions").get().filter{!it.state.isFinished}
        assertEquals(1,pending.size);assertEquals(old.id,pending.single().id)
        assertEquals(TimeUnit.HOURS.toMillis(24),pending.single().periodicityInfo!!.repeatIntervalMillis)
        assertEquals(NetworkType.CONNECTED,pending.single().constraints.requiredNetworkType)
        assertTrue(manager.getWorkInfosForUniqueWork("svitlo-app-version-now").get().all{it.state.isFinished})
    }
}
