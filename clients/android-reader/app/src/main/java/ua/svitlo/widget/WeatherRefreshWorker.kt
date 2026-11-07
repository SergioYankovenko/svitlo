package ua.svitlo.widget

import android.content.Context
import androidx.work.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.time.Instant
import java.util.concurrent.TimeUnit

/** Weather has its own queue and retry policy; slow outage sources must not hold it up. */
class WeatherRefreshWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    internal var weather = WeatherRepository(context)

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) { refreshAddress() }

    private fun refreshAddress(): Result {
        val repo = OutageRepository(applicationContext)
        val token = inputData.getString("binding_generation") ?: return Result.success()
        val binding = repo.binding() ?: return Result.success()
        val current = { !isStopped && repo.generationToken() == token && repo.binding() == binding }
        if (!current()) return Result.success()
        val prefs = applicationContext.getSharedPreferences("svitlo_runtime", Context.MODE_PRIVATE)
        prefs.edit().putLong("weather_attempt", System.currentTimeMillis())
            .putString("weather_attempt_generation", token).apply()
        val ok = weather.ensureAddressLocation(binding, current) && weather.refresh(current)
        RefreshWorker.notifyUi(applicationContext)
        return when {
            !current() || ok -> Result.success()
            runAttemptCount < 2 -> Result.retry()
            else -> Result.failure()
        }
    }

    companion object {
        private const val TAG = "svitlo-weather"

        fun requestIfStale(context: Context) {
            val repo = OutageRepository(context)
            val binding = repo.binding() ?: return
            val token = repo.generationToken() ?: return
            val weather = WeatherRepository(context)
            val snapshot = weather.snapshot()
            val now = Instant.now()
            if (weather.isAtAddress() && snapshot?.isFresh(now) == true &&
                AddressWeather.matches(binding.city, snapshot.location)) return
            val prefs = context.getSharedPreferences("svitlo_runtime", Context.MODE_PRIVATE)
            // This throttle belongs to this address and this source, independently of charts.
            if (prefs.getString("weather_attempt_generation", null) == token &&
                now.toEpochMilli() - prefs.getLong("weather_attempt", 0) in 0..900_000) return
            request(context)
        }

        fun request(context: Context) {
            val repo = OutageRepository(context)
            if (repo.binding() == null) return
            val token = repo.generationToken() ?: return
            val request = OneTimeWorkRequestBuilder<WeatherRefreshWorker>()
                .setInputData(workDataOf("binding_generation" to token)).addTag(TAG)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build()
            // An older address's pending/running request cannot suppress the new address.
            WorkManager.getInstance(context).enqueueUniqueWork("$TAG-$token", ExistingWorkPolicy.KEEP, request)
        }

        fun cancel(context: Context) { WorkManager.getInstance(context).cancelAllWorkByTag(TAG) }
    }
}
