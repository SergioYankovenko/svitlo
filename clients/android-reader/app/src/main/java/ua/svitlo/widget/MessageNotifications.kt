package ua.svitlo.widget

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent

internal object MessageNotifications {
    const val SERVICE_CHANNEL="service_messages"
    const val UPDATE_CHANNEL="app_updates"
    private const val ID=160000001
    internal val deliveryLock=Any()
    fun channels(context:Context){
        val manager=context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(SERVICE_CHANNEL,"Службові повідомлення",NotificationManager.IMPORTANCE_DEFAULT))
        manager.createNotificationChannel(NotificationChannel(UPDATE_CHANNEL,"Нові версії застосунку",NotificationManager.IMPORTANCE_DEFAULT))
    }
    fun announce(context:Context,repository:RemoteMessageRepository=RemoteMessageRepository(context),updates:AppUpdateRepository=AppUpdateRepository(context))=synchronized(deliveryLock){announceLocked(context,repository,updates)}
    private fun announceLocked(context:Context,repository:RemoteMessageRepository,updates:AppUpdateRepository) {
        channels(context)
        val manager=context.getSystemService(NotificationManager::class.java)
        val visible=repository.visible();val ids=visible.map{"remote:${it.id}"}.toSet()
        manager.activeNotifications.filter{it.tag?.startsWith("remote:")==true && (it.tag !in ids ||
            it.notification.channelId==UPDATE_CHANNEL && !updates.enabled())}.forEach{manager.cancel(it.tag,it.id)}
        if(!ScheduleNotifications.notificationPermission(context) || !manager.areNotificationsEnabled())return
        visible.forEach{message->
            val channel=if(message.type=="app_update")UPDATE_CHANNEL else SERVICE_CHANNEL
            if(message.type=="app_update" && !updates.enabled())return@forEach
            if(manager.getNotificationChannel(channel)?.importance==NotificationManager.IMPORTANCE_NONE)return@forEach
            if(repository.posted(message.id))return@forEach
            if(message.targetVersion!=null && message.targetVersion<=updates.notifiedCode()){
                repository.markPosted(message.id);return@forEach // Migration from the legacy release notice, never a second alert.
            }
            val open=Intent(context,MainActivity::class.java).putExtra("screen","inbox").putExtra("message_id",message.id)
                .setData(android.net.Uri.parse("svitlo://message/${message.id}"))
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            val pending=PendingIntent.getActivity(context,ID,open,PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val notification=Notification.Builder(context,channel).setSmallIcon(R.drawable.ic_svitlo)
                .setContentTitle(message.title).setContentText(message.body).setStyle(Notification.BigTextStyle().bigText(message.body))
                .setWhen(message.published.toEpochMilli()).setContentIntent(pending).setAutoCancel(true).setOnlyAlertOnce(true)
                .setTimeoutAfter(repository.remainingLifetime(message))
                .setVisibility(Notification.VISIBILITY_PRIVATE).build()
            try {
                // Stable tag + numeric ID replaces the same notification after a process interruption.
                manager.notify("remote:${message.id}",ID,notification)
                repository.markPosted(message.id)
                message.targetVersion?.let{updates.markNotifiedCode(it)}
            }catch(_:SecurityException){ /* Revoked permission does not consume the delivery. */ }
        }
    }
}
