package ua.svitlo.widget

import android.app.*
import android.content.Context
import android.content.Intent
import androidx.work.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

/** Independent of the selected address and of outage/weather network requests. */
class AppUpdateWorker(context:Context,parameters:WorkerParameters):CoroutineWorker(context,parameters) {
    internal var updates=AppUpdateRepository(applicationContext)
    override suspend fun doWork():Result=withContext(Dispatchers.IO){
        val repo=updates
        // Legacy 1.4.0 one-time jobs may still carry force=true after upgrading.
        // They must obey the same persisted daily limit as periodic work.
        val result=repo.refreshResult()
        announce(applicationContext,repo)
        applicationContext.sendBroadcast(Intent(UPDATED).setPackage(applicationContext.packageName))
        MessageWorker.completion(listOf(result),runAttemptCount)
    }
    companion object {
        const val UPDATED="ua.svitlo.widget.APP_UPDATE_CHECKED"
        private const val CHANNEL="app_updates"
        private const val ID=140000001
        fun schedule(context:Context){
            val constraints=Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
            val manager=WorkManager.getInstance(context)
            manager.cancelUniqueWork("svitlo-app-version-now")
            manager.enqueueUniquePeriodicWork("svitlo-app-versions",ExistingPeriodicWorkPolicy.UPDATE,
                PeriodicWorkRequestBuilder<AppUpdateWorker>(24,TimeUnit.HOURS).setConstraints(constraints).build())
            val repository=AppUpdateRepository(context)
            // Clear an obsolete notification immediately after installation, even offline.
            announce(context,repository)
        }
        internal fun announce(context:Context,repo:AppUpdateRepository)=synchronized(MessageNotifications.deliveryLock){announceLocked(context,repo)}
        private fun announceLocked(context:Context,repo:AppUpdateRepository){
            val manager=context.getSystemService(NotificationManager::class.java)
            val release=repo.available()?.takeIf{repo.inNotificationWindow(it)}
            if(release==null || !repo.enabled()){manager.cancel(ID);return}
            if(!repo.needsNotification() || !ScheduleNotifications.notificationPermission(context) || !manager.areNotificationsEnabled())return
            manager.createNotificationChannel(NotificationChannel(CHANNEL,"Нові версії застосунку",NotificationManager.IMPORTANCE_DEFAULT))
            if(manager.getNotificationChannel(CHANNEL).importance==NotificationManager.IMPORTANCE_NONE)return
            val intent=Intent(Intent.ACTION_VIEW,android.net.Uri.parse(AppUpdateRepository.SITE))
            val pending=PendingIntent.getActivity(context,ID,intent,PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            try {
                manager.notify(ID,Notification.Builder(context,CHANNEL).setSmallIcon(R.drawable.ic_svitlo)
                    .setContentTitle("Вийшла нова версія ${release.name}")
                    .setContentText("Натисніть, щоб відкрити сторінку завантаження")
                    .setTimeoutAfter(repo.notificationLifetime(release))
                    .setContentIntent(pending).setAutoCancel(true).setOnlyAlertOnce(true).build())
                repo.markNotified(release)
            }catch(_:SecurityException){ /* A revoked permission must not mark the release as announced. */ }
        }
    }
}
