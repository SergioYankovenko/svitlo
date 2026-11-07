package ua.svitlo.widget

import android.content.Context
import androidx.work.Configuration
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.ListenableWorker
import androidx.work.workDataOf
import androidx.work.testing.WorkManagerTestInitHelper
import androidx.work.testing.WorkManagerTestInitHelper.ExecutorsMode
import androidx.work.testing.TestListenableWorkerBuilder
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit
import java.time.Instant
import java.io.IOException

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class WeatherSchedulingTest {
    private lateinit var context: Context
    private lateinit var manager: WorkManager

    @Before fun setup() {
        context = RuntimeEnvironment.getApplication()
        listOf("svitlo_private", "svitlo_weather", "svitlo_runtime", "svitlo_official").forEach {
            context.getSharedPreferences(it, Context.MODE_PRIVATE).edit().clear().commit()
        }
        // Schedule real WorkManager records but hold network execution.
        WorkManagerTestInitHelper.initializeTestWorkManager(context, Configuration.Builder()
            .setExecutor(Executor { }).setTaskExecutor(Executor { it.run() }).build(),
            ExecutorsMode.PRESERVE_EXECUTORS)
        manager = WorkManager.getInstance(context)
        val raw = """{"DATETIME":"09:30 23.10.2026","DISCONNECTIONS":[],"DISCONN_QUEUQ":[]}"""
        val repo = OutageRepository(context, OutageSource { _, _, _, _ -> raw })
        assertTrue(repo.bindConfirmed("12345678901", "с. Бойківщина, вул. Тестова, 1",
            repo.prepare("12345678901"), "с. Бойківщина"))
    }

    private fun weatherJobs() = manager.getWorkInfosByTag("svitlo-weather").get(5, TimeUnit.SECONDS)
        .filter { !it.state.isFinished }

    @Test fun manualRefreshQueuesWeatherWithoutWaitingForOutageRequests() {
        RefreshWorker.request(context)
        assertEquals(1, weatherJobs().size)
    }

    @Test fun missingWeatherIsRequestedEvenWhileChartsAreRunningAndForegroundIsThrottled() {
        context.getSharedPreferences("svitlo_runtime", Context.MODE_PRIVATE).edit()
            .putLong("running", System.currentTimeMillis())
            .putLong("foreground_request", System.currentTimeMillis()).commit()
        RefreshWorker.requestIfStale(context)
        assertEquals(1, weatherJobs().size)
    }

    @Test fun repeatedRequestsCoalesceButNewAddressIsNotSuppressedByOldJob() {
        RefreshWorker.request(context)
        RefreshWorker.request(context)
        assertEquals(1, weatherJobs().size)
        replaceAddress()
        RefreshWorker.request(context)
        assertEquals(2, weatherJobs().size)
    }

    @Test fun freshWeatherDoesNotEnqueueOnEveryResume() {
        val repo = repository()
        repo.bindLocation(WeatherLocation("Бойківщина", AddressWeather.REGION, 49.91035, 32.25007), true)
        assertTrue(repo.refresh())
        WeatherRefreshWorker.requestIfStale(context)
        assertTrue(weatherJobs().isEmpty())
    }

    @Test fun missingForecastWithKnownCoordinatesIsRequested() {
        repository().bindLocation(WeatherLocation("Бойківщина", AddressWeather.REGION, 49.91035, 32.25007), true)
        WeatherRefreshWorker.requestIfStale(context)
        assertEquals(1, weatherJobs().size)
    }

    @Test fun failedAttemptIsThrottledOnlyForItsOwnAddressAndManualRefreshBypassesIt() {
        val prefs = context.getSharedPreferences("svitlo_runtime", Context.MODE_PRIVATE)
        prefs.edit().putString("weather_attempt_generation", OutageRepository(context).generationToken())
            .putLong("weather_attempt", System.currentTimeMillis()).commit()
        WeatherRefreshWorker.requestIfStale(context)
        assertTrue(weatherJobs().isEmpty())
        RefreshWorker.request(context)
        assertEquals(1, weatherJobs().size)
        replaceAddress()
        WeatherRefreshWorker.requestIfStale(context)
        assertEquals(2, weatherJobs().size)
    }

    @Test fun weatherWorkerLoadsBoykivshchynaWithoutAnyOutageFetch() {
        val worker = worker().apply { weather = repository() }
        assertEquals(ListenableWorker.Result.success(), execute(worker))
        assertEquals("Бойківщина", worker.weather.snapshot()!!.location.name)
        assertTrue(worker.weather.snapshot()!!.isFresh())
    }

    @Test fun weatherCanRunEvenWhenSharedBlockingWorkerExecutorHasNoFreeThreads() {
        val builder = TestListenableWorkerBuilder<WeatherRefreshWorker>(context = context,
            inputData = workDataOf("binding_generation" to OutageRepository(context).generationToken()))
        // WorkManager's test builder exposes this setter only to its Java package.
        builder.javaClass.getDeclaredMethod("setExecutor", Executor::class.java).apply { isAccessible = true }
            .invoke(builder, Executor { })
        val independent = builder.build()
        independent.weather = repository()
        assertEquals(ListenableWorker.Result.success(), independent.startWork().get(3, TimeUnit.SECONDS))
    }

    @Test fun weatherFailuresRetryEvenWhenChartQueueIsUnaffected() {
        val broken = repository(fail = true)
        assertEquals(ListenableWorker.Result.retry(), execute(worker().apply { weather = broken }))
        assertEquals(ListenableWorker.Result.failure(), execute(worker(attempt = 2).apply { weather = broken }))
        assertNotNull(broken.lastError())
        assertNull(broken.snapshot())
    }

    @Test fun obsoleteQueuedAddressCannotSearchOrFetch() {
        val oldWorker = worker().apply { weather = repository(onFetch = { fail("Old request fetched weather") }) }
        replaceAddress()
        assertEquals(ListenableWorker.Result.success(), execute(oldWorker))
        assertNull(oldWorker.weather.location())
    }

    @Test fun changingAddressDuringForecastDiscardsResponseWithoutPollutingNewAddress() {
        val worker = worker().apply { weather = repository(onFetch = { replaceAddress() }) }
        assertEquals(ListenableWorker.Result.success(), execute(worker))
        assertNull(worker.weather.snapshot())
        assertNull(worker.weather.lastError())
    }

    private fun execute(worker: WeatherRefreshWorker) = runBlocking { worker.doWork() }

    private fun worker(attempt: Int = 0) = TestListenableWorkerBuilder<WeatherRefreshWorker>(
        context = context, runAttemptCount = attempt,
        inputData = workDataOf("binding_generation" to OutageRepository(context).generationToken())).build()

    private fun repository(fail: Boolean = false, onFetch: () -> Unit = {}) = WeatherRepository(context, object : WeatherSource {
        override fun search(city: String, region: String): String {
            if (fail) throw IOException("Simulated offline")
            return """{"results":[{"name":"Бойківщина","latitude":49.91035,"longitude":32.25007,"country_code":"UA","admin1":"Черкаська область","feature_code":"PPL"}]}"""
        }
        override fun fetch(location: WeatherLocation): String { onFetch(); return weatherFixture(Instant.now()) }
    })

    private fun replaceAddress() {
        val raw = """{"DATETIME":"09:30 23.10.2026","DISCONNECTIONS":[],"DISCONN_QUEUQ":[]}"""
        val repo = OutageRepository(context, OutageSource { _, _, _, _ -> raw })
        assertTrue(repo.bindConfirmed("12345678902", "м. Сміла, вул. Тестова, 2", repo.prepare("12345678902"), "м. Сміла"))
    }
}
