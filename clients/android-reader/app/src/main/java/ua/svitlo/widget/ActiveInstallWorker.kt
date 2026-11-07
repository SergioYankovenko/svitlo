package ua.svitlo.widget

import android.content.Context
import androidx.work.*
import java.util.concurrent.TimeUnit

class ActiveInstallWorker(context:Context,parameters:WorkerParameters):Worker(context,parameters) {
    override fun doWork():Result { ActiveInstallRepository(applicationContext).report();return Result.success() }
    companion object {
        fun schedule(context:Context){
            val connected=Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
            val manager=WorkManager.getInstance(context)
            manager.enqueueUniquePeriodicWork("svitlo-active-daily",ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<ActiveInstallWorker>(24,TimeUnit.HOURS).setInitialDelay(24,TimeUnit.HOURS).setConstraints(connected).build())
            manager.enqueueUniqueWork("svitlo-active-launch",ExistingWorkPolicy.KEEP,
                OneTimeWorkRequestBuilder<ActiveInstallWorker>().setConstraints(connected).build())
        }
    }
}
