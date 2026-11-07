package ua.svitlo.widget.next

import android.Manifest
import android.app.*
import android.content.*
import android.content.pm.PackageManager
import android.os.Build
import androidx.work.*
import org.json.*
import ua.svitlo.widget.AppUpdateRepository
import ua.svitlo.widget.MessageRefresh
import java.security.MessageDigest
import java.time.*
import java.time.format.DateTimeFormatter
import java.util.concurrent.TimeUnit

object NextNotices {
    private val lock=Any()
    private fun prefs(c:Context)=c.getSharedPreferences("next_notices",Context.MODE_PRIVATE)
    fun items(c:Context):List<JSONObject> = synchronized(lock){runCatching{JSONArray(prefs(c).getString("items","[]")).objects().filter{it.optLong("at")>System.currentTimeMillis()-7*86400000L}.sortedByDescending{it.getLong("at")}}.getOrDefault(emptyList())}
    fun markViewed(c:Context){prefs(c).edit().putLong("viewedAt",System.currentTimeMillis()).commit()}
    fun allowed(c:Context):Boolean {val manager=c.getSystemService(NotificationManager::class.java);return (Build.VERSION.SDK_INT<33||c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)==PackageManager.PERMISSION_GRANTED)&&manager.areNotificationsEnabled()&&(manager.getNotificationChannel("svitlo_next_events")?.importance!=NotificationManager.IMPORTANCE_NONE)}
    fun put(c:Context,id:String,title:String,body:String,profile:String?=null,date:String?=null,url:String?=null,enabled:Boolean=false,setting:String?=null,at:Long=System.currentTimeMillis(),expiresAt:Long=Long.MAX_VALUE){synchronized(lock){if(expiresAt<=System.currentTimeMillis()||at<=System.currentTimeMillis()-7*86400000L||at>System.currentTimeMillis()+60000)return;val p=prefs(c);var values=items(c);val exists=values.find{it.optString("id")==id};if(exists==null){val item=JSONObject().put("id",id).put("at",at).put("title",title).put("body",body).put("wantsSystem",enabled).put("expiresAt",expiresAt);setting?.let{item.put("setting",it)};profile?.let{item.put("profile",it)};date?.let{item.put("date",it)};url?.let{item.put("url",it)};values=(values+item).sortedByDescending{it.getLong("at")}.take(120);check(p.edit().putString("items",JSONArray(values).toString()).commit())}
        if(enabled&&!p.getBoolean("shown-$id",false)&&post(c,id,title,body,profile,date))p.edit().putBoolean("shown-$id",true).commit()
    }}
    fun retryPending(c:Context){synchronized(lock){
        val state=NextRepository(c).prefs;val p=prefs(c);val manager=c.getSystemService(NotificationManager::class.java)
        val live=items(c).filter{item->val id=item.getString("id");if(item.optLong("expiresAt",Long.MAX_VALUE)<=System.currentTimeMillis())return@filter false;val code=id.removePrefix("version-").toIntOrNull();if(id.startsWith("version-")&&code!=null&&code<=ua.svitlo.widget.BuildConfig.VERSION_CODE){manager.cancel(id.hashCode());false}else true}
        p.edit().putString("items",JSONArray(live).toString()).commit()
        for(item in live){val id=item.getString("id");val setting=item.optString("setting");if(!item.optBoolean("wantsSystem")||p.getBoolean("shown-$id",false)||setting.isNotEmpty()&&!state.getBoolean(setting,false))continue
            if(post(c,id,item.getString("title"),item.optString("body"),item.optString("profile").takeIf{it.isNotEmpty()},item.optString("date").takeIf{it.isNotEmpty()}))p.edit().putBoolean("shown-$id",true).commit()
        }
    }}
    fun post(c:Context,id:String,title:String,body:String,profile:String?,date:String?):Boolean {val manager=c.getSystemService(NotificationManager::class.java);val channelId="svitlo_next_events";if(Build.VERSION.SDK_INT>=26)manager.createNotificationChannel(NotificationChannel(channelId,"Графіки та датчики",NotificationManager.IMPORTANCE_DEFAULT));if(Build.VERSION.SDK_INT>=33&&c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)return false;if(!manager.areNotificationsEnabled()||manager.getNotificationChannel(channelId)?.importance==NotificationManager.IMPORTANCE_NONE)return false
        val intent=Intent(c,NextActivity::class.java).putExtra("profile",profile).putExtra("date",date).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP);val notificationId=id.hashCode();val pending=PendingIntent.getActivity(c,notificationId,intent,PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE);return try{manager.notify(notificationId,Notification.Builder(c,channelId).setSmallIcon(ua.svitlo.widget.R.drawable.ic_svitlo).setContentTitle(title).setContentText(body).setStyle(Notification.BigTextStyle().bigText(body)).setContentIntent(pending).setAutoCancel(true).build());true}catch(_:SecurityException){false}}
}
object NextWork {
    private val sensorPollLock=Any()
    internal fun checkVersion(c:Context,update:AppUpdateRepository=AppUpdateRepository(c)):MessageRefresh {
        val result=update.refreshResult()
        // The established manifest declares ua.svitlo.widget. A private next
        // package must never offer a different application's production APK.
        val samePackage=c.packageName.removeSuffix(".qa")=="ua.svitlo.widget"
        update.available()?.takeIf{samePackage&&update.inNotificationWindow(it)}?.let{release->NextNotices.put(c,"version-${release.code}","Вийшла нова версія ${release.name}","Оновіть застосунок, коли вам зручно",url="https://www.svitlo.guru/",enabled=NextRepository(c).prefs.getBoolean("versions",false),setting="versions",at=release.publishedAt.toEpochMilli())}
        return result
    }
    internal fun scheduleVersionRetry(c:Context,result:MessageRefresh?,attempts:Int=0){
        if(result?.retry!=true||attempts>=4)return
        val delay=((result.nextAttempt-System.currentTimeMillis()+999)/1000).coerceAtLeast(30)
        val retry=OneTimeWorkRequestBuilder<NextRefreshWorker>().setInputData(workDataOf("retry" to attempts+1)).setInitialDelay(delay,TimeUnit.SECONDS).setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build()
        WorkManager.getInstance(c).enqueueUniqueWork("next-version-retry",ExistingWorkPolicy.REPLACE,retry)
    }
    /** Foreground and worker share one transition path; refreshing the cache must
     * not consume a transition before its card/receipt has been recorded. */
    fun pollSensors(c:Context,repo:NextRepository=NextRepository(c))=synchronized(sensorPollLock){
        fun key(m:JSONObject)="${m.getString("sensorId")}:${m.getLong("bindingEpoch")}"
        val previous=repo.memberships().associate{m->val old=repo.signal(m);val at=runCatching{wireInstant(old?.optString("serverTime").orEmpty())}.getOrDefault(Instant.now());key(m) to SensorPolicy.signal(old,at)}
        repo.refreshSensors()
        for(m in repo.memberships()){
            val profile=repo.profiles().find{it.serverId==m.optString("readerProfileId")} ?:continue
            val signal=repo.signal(m);val current=SensorPolicy.signal(signal,Instant.now());val before=previous[key(m)] ?:"unknown"
            val type=NextDeliveryPolicy.transition(before,current,signal?.optString("transportState").orEmpty()) ?:continue
            val stamp=signal?.optString("lastConfirmedAt").orEmpty()
            NextNotices.put(c,"sensor-${key(m)}-$stamp-$type",NextDeliveryPolicy.title(type),NextDeliveryPolicy.body(type),profile.id,LocalDate.now(NEXT_ZONE).toString(),enabled=repo.prefs.getBoolean("sensor-notify-${profile.id}",false),setting="sensor-notify-${profile.id}")
        }
    }
    fun schedule(c:Context){val work=PeriodicWorkRequestBuilder<NextRefreshWorker>(1,TimeUnit.HOURS).setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).setBackoffCriteria(BackoffPolicy.EXPONENTIAL,30,TimeUnit.SECONDS).build();WorkManager.getInstance(c).enqueueUniquePeriodicWork("next-hourly",ExistingPeriodicWorkPolicy.KEEP,work);planAlarms(c);NextWidgets.scheduleTick(c)}
    fun afterRefresh(c:Context){val repo=NextRepository(c);val now=Instant.now();val today=now.atZone(NEXT_ZONE).toLocalDate();if(!NextPush.active(repo))for(p in repo.profiles()){val snapshot=repo.snapshot(p) ?: continue;for(date in listOf(today,today.plusDays(1))){val day=snapshot.day(date,p.lineId,now);if(!day.publicationAvailable)continue;val key="seen-${p.id}-$date";val fingerprint=MessageDigest.getInstance("SHA-256").digest(day.planEvents.joinToString{"${it.start}/${it.end}/${it.kind}"}.toByteArray()).joinToString(""){"%02x".format(it)};val previous=repo.prefs.getString(key,null);if(previous!=fingerprint){if(previous!=null||date>today){val title=(if(previous==null)"Графік на "else"Оновлено графік на ")+date.format(DateTimeFormatter.ofPattern("d MMMM",java.util.Locale.forLanguageTag("uk")));NextNotices.put(c,"schedule-${p.id}-$date-$fingerprint",title,snapshot.line(p.lineId)?.group?.let{"Черга $it"} ?:"",p.id,date.toString(),enabled=repo.prefs.getBoolean(if(previous==null)"tomorrow"else"changes",false),setting=if(previous==null)"tomorrow"else"changes")};repo.prefs.edit().putString(key,fingerprint).commit()}}}
        planAlarms(c);NextWidgets.update(c)
    }
    fun planAlarms(c:Context){val repo=NextRepository(c);val alarms=c.getSystemService(AlarmManager::class.java);val now=Instant.now();val date=now.atZone(NEXT_ZONE).toLocalDate();val lead=repo.prefs.getInt("lead",30).coerceIn(5,60);val requests=JSONArray();val old=runCatching{JSONArray(repo.prefs.getString("alarms","[]"))}.getOrDefault(JSONArray());for(i in 0 until old.length()){val pi=PendingIntent.getBroadcast(c,old.getInt(i),Intent(c,NextAlarmReceiver::class.java),PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE);if(pi!=null)alarms.cancel(pi)}
        if(!NextPush.active(repo))for(p in repo.profiles())for(day in listOf(date,date.plusDays(1))){val plan=repo.snapshot(p)?.day(day,p.lineId,now) ?:continue;if(!plan.timerAllowed)continue;for(event in plan.events){for((key,at,title)in listOf(Triple("before",event.start,"До відключення"),Triple("restore",event.end,"До відновлення"))){if(!repo.prefs.getBoolean(key,false)||at==null)continue;val whenAt=at.minusSeconds(lead*60L);if(whenAt<=now)continue;val id="$key-${p.id}-$at";val code=id.hashCode();val intent=Intent(c,NextAlarmReceiver::class.java).putExtra("id",id).putExtra("title","$title $lead хв").putExtra("profile",p.id).putExtra("date",day.toString()).putExtra("at",at.toEpochMilli()).putExtra("revision",repo.snapshot(p)?.revision);val pi=PendingIntent.getBroadcast(c,code,intent,PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE);if(Build.VERSION.SDK_INT<31||alarms.canScheduleExactAlarms())alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP,whenAt.toEpochMilli(),pi)else alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP,whenAt.toEpochMilli(),pi);requests.put(code)}}}
        repo.prefs.edit().putString("alarms",requests.toString()).commit()
    }
}
class NextRefreshWorker(c:Context,p:WorkerParameters):Worker(c,p){override fun doWork():Result {val repo=NextRepository(applicationContext);var failure:Exception?=null;if(repo.api.ready())try{repo.refresh(force=true);NextWork.afterRefresh(applicationContext)}catch(e:Exception){failure=e}
        if(repo.api.vault.read("cookie")!=null)try{NextWork.pollSensors(applicationContext,repo)}catch(e:Exception){failure=e}
        // Version polling is independent of catalog/provider errors and retains the established verified source.
        val version=try{NextWork.checkVersion(applicationContext)}catch(_:Exception){null}
        runCatching{NextPush.register(applicationContext)}
        NextNotices.retryPending(applicationContext)
        val attempts=runAttemptCount+inputData.getInt("retry",0)
        NextWork.scheduleVersionRetry(applicationContext,version,attempts)
        if(failure is NextApiException&&(failure as NextApiException).status==429&&attempts<4){val delay=(failure as NextApiException).retryAfter.coerceAtLeast(30);val retry=OneTimeWorkRequestBuilder<NextRefreshWorker>().setInputData(workDataOf("retry" to attempts+1)).setInitialDelay(delay,TimeUnit.SECONDS).setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build();WorkManager.getInstance(applicationContext).enqueueUniqueWork("next-rate-retry",ExistingWorkPolicy.REPLACE,retry);return Result.success()}
        val temporary=failure!=null&&(failure !is NextApiException||(failure as NextApiException).status>=500)
        return if(temporary&&attempts<4)Result.retry()else Result.success()
    }}
class NextAlarmReceiver:BroadcastReceiver(){override fun onReceive(c:Context,intent:Intent){val id=intent.getStringExtra("id");if(id==null){NextWork.schedule(c);return};val repo=NextRepository(c);if(NextPush.active(repo))return;val p=repo.profiles().find{it.id==intent.getStringExtra("profile")} ?:return;val snapshot=repo.snapshot(p) ?:return;val date=runCatching{LocalDate.parse(intent.getStringExtra("date"))}.getOrNull() ?:return;val setting=id.substringBefore('-');if(!repo.prefs.getBoolean(setting,false))return;val now=Instant.now();val at=Instant.ofEpochMilli(intent.getLongExtra("at",0));if(at<now||snapshot.revision!=intent.getStringExtra("revision")||!snapshot.day(date,p.lineId,now).timerAllowed)return;NextNotices.put(c,id,intent.getStringExtra("title") ?:"Нагадування",p.title,p.id,date.toString(),enabled=true)}}
