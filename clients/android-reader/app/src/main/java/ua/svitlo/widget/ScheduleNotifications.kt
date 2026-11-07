package ua.svitlo.widget

import android.Manifest
import android.app.*
import android.content.*
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import ua.svitlo.widget.core.*
import java.time.Instant
import java.security.MessageDigest

object ScheduleNotifications {
    val options=listOf("before_off" to "Перед відключенням", "before_on" to "Перед очікуваним відновленням",
        "tomorrow" to "Графік на завтра", "changes" to "Зміни графіка", "emergency" to "Аварії за адресою")
    private val lock=Any()
    private fun prefs(context:Context)=context.getSharedPreferences("svitlo_notifications",Context.MODE_PRIVATE)
    fun enabled(context:Context,key:String):Boolean=prefs(context).getBoolean(key,false)
    fun lead(context:Context):Int=prefs(context).getInt("lead",30).takeIf{it in listOf(5,15,30,60)} ?: 30
    fun setLead(context:Context,minutes:Int){require(minutes in listOf(5,15,30,60));prefs(context).edit().putInt("lead",minutes).commit();rebuild(context)}
    fun setEnabled(context:Context,key:String,value:Boolean){
        require(options.any{it.first==key})
        synchronized(lock){
            // Enabling notifications does not announce old cached history as new.
            val seen=prefs(context).getStringSet("seen",emptySet()).orEmpty()+OfficialScheduleRepository(context).changes().map{it.id}
            prefs(context).edit().putBoolean(key,value).putStringSet("seen",seen.takeLastSafe(200).toSet()).commit()
        }
    }
    fun notificationPermission(context:Context):Boolean=Build.VERSION.SDK_INT<33 ||
        ContextCompat.checkSelfPermission(context,Manifest.permission.POST_NOTIFICATIONS)==PackageManager.PERMISSION_GRANTED
    fun exactAllowed(context:Context):Boolean=Build.VERSION.SDK_INT<31 || context.getSystemService(AlarmManager::class.java).canScheduleExactAlarms()
    private fun alarm(context:Context,index:Int,intent:Intent?=null):PendingIntent=PendingIntent.getBroadcast(context,1000+index,
        intent ?: Intent(context,ScheduleAlarmReceiver::class.java).setAction(ALARM),PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    private fun cancelAlarms(context:Context){
        val manager=context.getSystemService(AlarmManager::class.java)
        repeat(prefs(context).getInt("alarm_count",0).coerceIn(0,64)){manager.cancel(alarm(context,it))}
        prefs(context).edit().remove("alarm_count").remove("token").commit()
    }
    fun cancel(context:Context){synchronized(lock){cancelAlarms(context);val manager=context.getSystemService(NotificationManager::class.java)
        manager.activeNotifications.filter{it.notification.channelId=="schedule"}.forEach{manager.cancel(it.tag,it.id)}}}
    private fun fingerprint(generation:String,snapshot:Snapshot):String {
        val material=generation+snapshot.allEvents().joinToString{"${it.category}:${it.start}:${it.end}:${it.plannedEnd}"}+
            snapshot.plans.joinToString{"${it.date}:${it.revision}:${it.uncertain}:${it.cancelled}"}+snapshot.emergency.notices.joinToString()
        return MessageDigest.getInstance("SHA-256").digest(material.toByteArray()).joinToString(""){"%02x".format(it)}
    }
    fun rebuild(context:Context,now:Instant=Instant.now()){synchronized(lock){
        cancelAlarms(context)
        val repo=OutageRepository(context,now={now})
        val state=repo.boundSnapshot() ?: return
        repo.withCurrentBinding(state.generation){
        val snapshot=state.snapshot
        val token=fingerprint(state.generation+":"+lead(context),snapshot)
        val reminders=if(notificationPermission(context)) ReminderPlan.create(snapshot,now,enabled(context,"before_off"),enabled(context,"before_on"),lead(context)) else emptyList()
        prefs(context).edit().putString("token",token).putInt("alarm_count",reminders.size).commit()
        val manager=context.getSystemService(AlarmManager::class.java)
        reminders.forEachIndexed{index,reminder->
            val intent=Intent(context,ScheduleAlarmReceiver::class.java).setAction(ALARM).putExtra("token",token)
                .putExtra("kind",reminder.kind).putExtra("at",reminder.at.toEpochMilli()).putExtra("transition",reminder.transition.toEpochMilli())
            val pending=alarm(context,index,intent)
            try {
                if(exactAllowed(context))manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP,reminder.at.toEpochMilli(),pending)
                else manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP,reminder.at.toEpochMilli(),pending)
            }catch(_:SecurityException){manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP,reminder.at.toEpochMilli(),pending)}
        }
        recordChanges(context,snapshot,now)
        }
    }}
    private fun recordChanges(context:Context,snapshot:Snapshot,now:Instant){
        val queue=snapshot.queueLabel().orEmpty()
        val today=now.atZone(KYIV_ZONE).toLocalDate()
        val seen=prefs(context).getStringSet("seen",emptySet()).orEmpty().toMutableSet()
        OfficialScheduleRepository(context).changes().filter{(it.queue==queue || it.queue=="*") && it.date>=today && it.id !in seen}.forEach{change->
            val key=if(change.kind=="published" && change.date==today.plusDays(1))"tomorrow"else"changes"
            if(enabled(context,key))post(context,change.id.hashCode(),ScheduleLabels.messageTitle(change),ScheduleLabels.queueLine(change.queue),change.date.toString(),change.at)
            seen+=change.id
        }
        snapshot.allEvents().filter{it.category==Category.EMERGENCY && (it.end==null || it.end>now)}.forEach{event->
            val id="emergency:${event.start}:${event.end}"
            if(id !in seen && enabled(context,"emergency"))post(context,id.hashCode(),"Аварійне відключення за адресою",
                if(event.end==null)"Час відновлення уточнюється"else"Очікуване завершення о ${Presentation.time(event.end)}",event.start.atZone(KYIV_ZONE).toLocalDate().toString())
            seen+=id
        }
        prefs(context).edit().putStringSet("seen",seen.takeLastSafe(200).toSet()).commit()
    }
    internal fun deliver(context:Context,intent:Intent,now:Instant=Instant.now()){synchronized(lock){
        val repo=OutageRepository(context,now={now});val state=repo.boundSnapshot() ?: return
        val token=intent.getStringExtra("token") ?: return
        val kind=intent.getStringExtra("kind") ?: return
        val transition=Instant.ofEpochMilli(intent.getLongExtra("transition",0))
        val scheduled=Instant.ofEpochMilli(intent.getLongExtra("at",0))
        repo.withCurrentBinding(state.generation){
        val snapshot=state.snapshot
        if(token!=prefs(context).getString("token",null) || token!=fingerprint(state.generation+":"+lead(context),snapshot) || !enabled(context,kind) ||
            !snapshot.isCompleteAndFresh(now) || snapshot.openEmergency(now) || snapshot.emergency.uncertain(transition,snapshot.plans,now) || now>=transition || now<scheduled.minusSeconds(60))return@withCurrentBinding
        val title=if(kind=="before_off")"Наближається відключення за графіком"else"Наближається очікуване відновлення"
        post(context,token.hashCode()+kind.hashCode(),title,"О ${Presentation.time(transition)} · підчерга ${snapshot.queueLabel() ?: "—"}",transition.atZone(KYIV_ZONE).toLocalDate().toString())
        }
    }}
    private fun post(context:Context,id:Int,title:String,body:String,date:String,updatedAt:Instant?=null){
        if(!notificationPermission(context))return
        val manager=context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("schedule","Графіки та нагадування",NotificationManager.IMPORTANCE_DEFAULT))
        val open=PendingIntent.getActivity(context,id,Intent(context,MainActivity::class.java).putExtra("screen","graph").putExtra("date",date)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification=Notification.Builder(context,"schedule").setSmallIcon(R.drawable.ic_svitlo).setContentTitle(title).setContentText(body)
            .setWhen((updatedAt ?: Instant.now()).toEpochMilli()).setStyle(Notification.BigTextStyle().bigText(body)).setContentIntent(open).setAutoCancel(true).setVisibility(Notification.VISIBILITY_PRIVATE).build()
        runCatching{manager.notify(id,notification)}
    }
    private fun <T> Collection<T>.takeLastSafe(count:Int)=toList().takeLast(count)
    const val ALARM="ua.svitlo.widget.SCHEDULE_ALARM"
}

class ScheduleAlarmReceiver:BroadcastReceiver(){
    override fun onReceive(context:Context,intent:Intent){
        if(intent.action==ScheduleNotifications.ALARM)ScheduleNotifications.deliver(context,intent)
        else {ScheduleNotifications.rebuild(context);RefreshWorker.schedule(context);RefreshWorker.requestIfStale(context);MessageWorker.schedule(context)}
    }
}
