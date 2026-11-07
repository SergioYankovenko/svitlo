package ua.svitlo.widget

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.work.*
import ua.svitlo.widget.core.*
import java.time.Instant
import java.time.Duration
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class RefreshWorker(context:Context, parameters:WorkerParameters):Worker(context,parameters) {
    override fun doWork():Result {
        MessageWorker.request(applicationContext)
        if(inputData.getBoolean("refresh_weather",false))WeatherRefreshWorker.request(applicationContext)
        else WeatherRefreshWorker.requestIfStale(applicationContext)
        return synchronized(lock) {
        val repo=OutageRepository(applicationContext)
        if(repo.binding()==null) return@synchronized Result.success()
        val prefs=applicationContext.getSharedPreferences("svitlo_runtime",Context.MODE_PRIVATE)
        val cycleGeneration=repo.generationToken()
        if(prefs.getString("cycle_generation",null)==cycleGeneration && System.currentTimeMillis()-prefs.getLong("cycle_completed",0) in 0..10_000)return@synchronized Result.success()
        prefs.edit().putLong("running",System.currentTimeMillis()).putString("running_generation",cycleGeneration).apply()
        notifyUi(applicationContext)
        val requests=Executors.newFixedThreadPool(2)
        try {
            val address=requests.submit<Boolean>{
                prefs.edit().putLong("address_attempt",System.currentTimeMillis()).apply()
                val result=MultiAddressRefresh.refresh(applicationContext)
                notifyUi(applicationContext)
                result
            }
            val publications=requests.submit<Boolean>{
                prefs.edit().putLong("feed_attempt",System.currentTimeMillis()).apply()
                val result=OfficialScheduleRepository(applicationContext).refresh();notifyUi(applicationContext);result
            }
            val accountOk=runCatching{address.get(150,TimeUnit.SECONDS)}.getOrDefault(false)
            val feedOk=runCatching{publications.get(150,TimeUnit.SECONDS)}.getOrDefault(false)
            if(accountOk && feedOk && repo.generationToken()==cycleGeneration)prefs.edit().putLong("cycle_completed",System.currentTimeMillis()).putString("cycle_generation",cycleGeneration).apply()
            when(RefreshPolicy.completion(accountOk,feedOk,runAttemptCount)){
                RefreshCompletion.SUCCESS->Result.success()
                RefreshCompletion.RETRY->Result.retry()
                RefreshCompletion.FAILURE->Result.failure()
            }
        } catch (_:Exception) { if(runAttemptCount<2)Result.retry()else Result.failure() }
        finally { requests.shutdownNow();prefs.edit().remove("running").remove("running_generation").apply(); notifyUi(applicationContext) }
        }
    }
    companion object {
        private val lock=Any()
        const val UPDATED="ua.svitlo.widget.UPDATED"
        fun online(context:Context):Boolean {
            val manager=context.getSystemService(ConnectivityManager::class.java)
            val capabilities=manager.getNetworkCapabilities(manager.activeNetwork) ?: return false
            return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        }
        fun running(context:Context):Boolean {
            val prefs=context.getSharedPreferences("svitlo_runtime",Context.MODE_PRIVATE)
            val at=prefs.getLong("running",0);val token=prefs.getString("running_generation",null)
            return at>0 && System.currentTimeMillis()-at in 0..600_000 && (token==null || token==OutageRepository(context).generationToken())
        }
        fun schedule(context:Context) {
            if(OutageRepository(context).binding()==null) return
            val minutes=OutageRepository(context).intervalMinutes().toLong()
            val request=PeriodicWorkRequestBuilder<RefreshWorker>(minutes,TimeUnit.MINUTES)
                .setInputData(workDataOf("refresh_weather" to true))
                .setInitialDelay(minutes,TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork("svitlo-periodic",ExistingPeriodicWorkPolicy.UPDATE,request)
        }
        fun requestIfStale(context:Context){
            WeatherRefreshWorker.requestIfStale(context)
            if(OutageRepository(context).binding()==null || running(context))return
            val prefs=context.getSharedPreferences("svitlo_runtime",Context.MODE_PRIVATE)
            val now=Instant.now();val last=prefs.getLong("foreground_request",0)
            if(now.toEpochMilli()-last in 0..900_000)return
            val snapshot=OutageRepository(context).snapshot()
            val checked=OfficialScheduleRepository(context).snapshot().checkedAt
            if(!snapshot.isCompleteAndFresh(now) || checked==null || Duration.between(checked,now)>Duration.ofHours(1)){
                prefs.edit().putLong("foreground_request",now.toEpochMilli()).apply();request(context)
            }
        }
        fun request(context:Context) {
            if(OutageRepository(context).binding()==null) return
            if(running(context)){WidgetRenderer.enqueueUpdate(context);return}
            WeatherRefreshWorker.request(context)
            WorkManager.getInstance(context).enqueueUniqueWork("svitlo-manual",ExistingWorkPolicy.KEEP,
                OneTimeWorkRequestBuilder<RefreshWorker>().setBackoffCriteria(BackoffPolicy.EXPONENTIAL,30,TimeUnit.SECONDS)
                    .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build())
            WidgetRenderer.enqueueUpdate(context)
        }
        fun cancel(context:Context){WorkManager.getInstance(context).cancelUniqueWork("svitlo-periodic");WorkManager.getInstance(context).cancelUniqueWork("svitlo-manual");WeatherRefreshWorker.cancel(context)}
        fun notifyUi(context:Context){
            runCatching{OutageRepository(context).boundSnapshot()?.let{InboxRepository(context).record(it)}}
            runCatching{ScheduleNotifications.rebuild(context)}
            WidgetRenderer.updateAll(context)
            context.sendBroadcast(Intent(UPDATED).setPackage(context.packageName))
        }
    }
}
