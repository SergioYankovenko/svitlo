package ua.svitlo.widget.next
import android.content.Context
import androidx.work.*
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.TimeUnit
import ua.svitlo.widget.BuildConfig

object NextPush {
    fun initialize(c:Context){
        if(!BuildConfig.NEXT_API||BuildConfig.FIREBASE_APP_ID.isBlank())return
        if(FirebaseApp.getApps(c).isEmpty())FirebaseApp.initializeApp(c,FirebaseOptions.Builder().setApplicationId(BuildConfig.FIREBASE_APP_ID).setProjectId(BuildConfig.FIREBASE_PROJECT_ID).setApiKey(BuildConfig.FIREBASE_API_KEY).setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID).build())
        FirebaseMessaging.getInstance().token.addOnSuccessListener{token->NextApi(c).vault.write("fcm-token",token);schedule(c)}
    }
    fun schedule(c:Context,intent:String?=null){val request=OneTimeWorkRequestBuilder<NextPushWorker>().setInputData(workDataOf("intent" to intent)).setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).setBackoffCriteria(BackoffPolicy.EXPONENTIAL,10,TimeUnit.SECONDS).build();WorkManager.getInstance(c).enqueueUniqueWork("next-push-${intent?:"register"}",ExistingWorkPolicy.KEEP,request)}
    fun active(repo:NextRepository)=repo.api.vault.read("push-owner")==repo.api.vault.read("subject")&&repo.prefs.getBoolean("push-server-ready",false)
    fun register(c:Context){val repo=NextRepository(c);val token=repo.api.vault.read("fcm-token")?:return
        val status=repo.api.owned("/api/v1/notifications",JSONObject().put("schemaVersion",1).put("action","status"));if(!status.optBoolean("enabled")||status.optJSONObject("channels")?.optBoolean("fcm")!=true)return
        val owner=repo.api.vault.read("subject")?:return
        val oldOwner=repo.api.vault.read("push-owner");if(oldOwner!=null&&oldOwner!=owner){repo.api.vault.removePrefix("push-");FirebaseMessaging.getInstance().deleteToken();repo.api.vault.write("fcm-token",null);return}
        val id=repo.api.vault.read("push-id")?:UUID.randomUUID().toString().also{repo.api.vault.write("push-id",it)}
        val request=repo.api.vault.read("push-request")?:UUID.randomUUID().toString().also{repo.api.vault.write("push-request",it)}
        val proof=repo.api.vault.read("push-proof")
        val result=repo.api.owned("/api/v1/notifications",JSONObject().put("schemaVersion",1).put("action","register").put("installationId",id).put("requestId",request).put("channel","fcm").put("token",token).put("permission",if(NextNotices.allowed(c))"granted"else"denied").apply{proof?.let{put("credential",it)}})
        check(result.optBoolean("ok"));repo.api.vault.write("push-proof",result.getString("credential"));repo.api.vault.write("push-owner",owner);repo.api.vault.write("push-request",null)
        for(p in repo.profiles()){val saved=repo.ensureSensorProfile(p);repo.api.owned("/api",JSONObject().put("action","preferences").put("id",saved.serverId).put("preferences",JSONObject().put("reminder",repo.prefs.getBoolean("before",false)).put("restoration",repo.prefs.getBoolean("restore",false)).put("publication",repo.prefs.getBoolean("tomorrow",false)).put("change",repo.prefs.getBoolean("changes",false)).put("emergency",false).put("lead",repo.prefs.getInt("lead",30))))}
        check(repo.prefs.edit().putBoolean("push-server-ready",true).commit());NextWork.planAlarms(c)
    }
    fun receive(c:Context,id:String){require(UUID_RE.matches(id));val repo=NextRepository(c);if(!active(repo))return
        val installation=repo.api.vault.read("push-id")?:return;val credential=repo.api.vault.read("push-proof")?:return
        fun receipt(state:String)=repo.api.owned("/api/v1/notifications",JSONObject().put("schemaVersion",1).put("action","receipt").put("installationId",installation).put("credential",credential).put("intentId",id).put("state",state))
        // A data packet is only a wake-up. The server rechecks its current plan,
        // expiry and preferences before the native notification is displayed.
        val result=receipt("received");if(!result.optBoolean("displayAllowed"))return;val p=result.getJSONObject("payload")
        if(java.time.Instant.parse(p.getString("expiresAt")).toEpochMilli()<=System.currentTimeMillis())return
        val profile=repo.profiles().firstOrNull{it.serverId==p.getString("profileId")}?:return
        NextNotices.put(c,"intent-$id",p.getString("title"),p.getString("body"),profile.id,enabled=true,expiresAt=java.time.Instant.parse(p.getString("expiresAt")).toEpochMilli())
        if(NextNotices.allowed(c))receipt("displayed")
    }
}
class NextMessagingService:FirebaseMessagingService(){override fun onNewToken(token:String){if(BuildConfig.NEXT_API){NextApi(this).vault.write("fcm-token",token);NextPush.schedule(this)}};override fun onMessageReceived(message:RemoteMessage){message.data["intentId"]?.takeIf{UUID_RE.matches(it)}?.let{NextPush.schedule(this,it)}}}
class NextPushWorker(c:Context,p:WorkerParameters):Worker(c,p){override fun doWork():Result=try{val intent=inputData.getString("intent");if(intent==null)NextPush.register(applicationContext)else NextPush.receive(applicationContext,intent);Result.success()}catch(_:Exception){if(runAttemptCount<4)Result.retry()else Result.failure()}}
