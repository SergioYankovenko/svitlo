package ua.svitlo.widget

import android.content.Context
import android.content.Intent
import androidx.work.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

/** No binding, provider, weather, socket or Firebase prerequisite. */
class MessageWorker(context:Context,parameters:WorkerParameters):CoroutineWorker(context,parameters) {
    internal var messages=RemoteMessageRepository(applicationContext)
    internal var releases=AppUpdateRepository(applicationContext)
    override suspend fun doWork():Result=withContext(Dispatchers.IO){
        val outcomes=coroutineScope {
            val legacy=async{releases.refreshResult()}
            val remote=async{messages.refresh()}
            listOf(legacy.await())+remote.await()
        }
        MessageNotifications.announce(applicationContext,messages,releases)
        AppUpdateWorker.announce(applicationContext,releases)
        applicationContext.sendBroadcast(Intent(AppUpdateWorker.UPDATED).setPackage(applicationContext.packageName))
        scheduleRecovery(applicationContext,outcomes)
        completion(outcomes,runAttemptCount)
    }
    companion object {
        internal fun scheduleRecovery(context:Context,outcomes:List<MessageRefresh>){
            val next=outcomes.filter{it.retry && it.nextAttempt>0}.minOfOrNull{it.nextAttempt} ?: return
            // Persist a wake-up at Retry-After/backoff even if WorkManager's short retry budget ends first.
            // The fetch gate bounds real attempts; foreground/periodic/recovery jobs share that same gate.
            val delay=(next-System.currentTimeMillis()).coerceAtLeast(1_000)
            WorkManager.getInstance(context).enqueueUniqueWork("svitlo-messages-recovery-$next",ExistingWorkPolicy.KEEP,
                OneTimeWorkRequestBuilder<MessageWorker>().setInitialDelay(delay,TimeUnit.MILLISECONDS)
                    .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL,60,TimeUnit.SECONDS).addTag("svitlo-message-recovery").build())
        }
        internal fun completion(outcomes:List<MessageRefresh>,attempt:Int):Result=when{
            outcomes.any{it.retry} && attempt<4->Result.retry()
            outcomes.any{!it.successful}->Result.failure()
            else->Result.success()
        }
        fun schedule(context:Context){
            val manager=WorkManager.getInstance(context)
            listOf("svitlo-app-versions","svitlo-app-version-now").forEach{manager.cancelUniqueWork(it)}
            val constraints=Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
            manager.enqueueUniquePeriodicWork("svitlo-messages-daily",ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<MessageWorker>(24,TimeUnit.HOURS).setConstraints(constraints)
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL,60,TimeUnit.SECONDS).build())
            request(context)
            MessageNotifications.announce(context)
            AppUpdateWorker.announce(context,AppUpdateRepository(context))
        }
        fun request(context:Context){
            WorkManager.getInstance(context).enqueueUniqueWork("svitlo-messages-now",ExistingWorkPolicy.KEEP,
                OneTimeWorkRequestBuilder<MessageWorker>().setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL,60,TimeUnit.SECONDS).build())
        }
    }
}
