package ua.svitlo.widget

import android.content.Context
import android.os.Build
import org.json.JSONObject
import ua.svitlo.widget.core.KYIV_ZONE
import ua.svitlo.widget.core.OfficialChange
import java.net.URI
import java.net.URL
import java.time.Instant
import javax.net.ssl.HttpsURLConnection

data class AppRelease(val code:Long,val name:String,val publishedAt:Instant,val apk:String,val sha256:String) {
    fun change()=OfficialChange(id="app-version-$code",at=publishedAt,date=publishedAt.atZone(KYIV_ZONE).toLocalDate(),queue="*",
        kind="app_update",title="Вийшла нова версія $name",sourceUrl=AppUpdateRepository.SITE,revision=code.toString())
}

/** Public version metadata only. No address, account or device identifier leaves this repository. */
class AppUpdateRepository(
    context:Context,
    private val fetch:()->String={download()},
    private val now:()->Instant={Instant.now()},
    private val installed:Long=installedCode(context),
    private val sdk:Int=Build.VERSION.SDK_INT
) {
    private val prefs=context.getSharedPreferences("svitlo_app_updates",Context.MODE_PRIVATE)
    private val gate=MessageFetchGate(prefs,now)
    fun available():AppRelease?=runCatching{parse(prefs.getString("manifest",null) ?: return null,now(),sdk)}
        .getOrNull()?.takeIf{it.code>installed}
    fun enabled()=prefs.getBoolean("notifications",false)
    fun setEnabled(value:Boolean){prefs.edit().putBoolean("notifications",value).apply()}
    fun needsNotification()=enabled() && available()?.let{it.code>prefs.getLong("notified",0)}==true
    fun markNotified(release:AppRelease){prefs.edit().putLong("notified",release.code).commit()}
    internal fun notifiedCode()=prefs.getLong("notified",0)
    internal fun inNotificationWindow(release:AppRelease)=now()<release.publishedAt.plusSeconds(7*86400)
    internal fun notificationLifetime(release:AppRelease)=java.time.Duration.between(now(),release.publishedAt.plusSeconds(7*86400)).toMillis().coerceAtLeast(1)
    internal fun markNotifiedCode(code:Long){prefs.edit().putLong("notified",maxOf(code,notifiedCode())).commit()}
    internal fun receivedAt(code:Long)=prefs.getLong("received:$code",0).takeIf{it>0}?.let(Instant::ofEpochMilli)
    internal fun viewed(code:Long)=prefs.getBoolean("viewed:$code",false)
    internal fun markViewed(code:Long){if(!viewed(code))prefs.edit().putBoolean("viewed:$code",true).commit()}
    fun failed()=prefs.getBoolean("failed",false)
    fun checkedAt():Instant?=prefs.getLong("success",0).takeIf{it>0}?.let(Instant::ofEpochMilli)
    fun due():Boolean=gate.due()
    internal fun lastAttemptAt():Instant?=gate.attemptedAt().takeIf{it>0}?.let(Instant::ofEpochMilli)
    fun refresh(force:Boolean=false):Boolean=refreshResult(force).successful
    internal fun refreshResult(force:Boolean=false):MessageRefresh=synchronized(lock){
        val at=now()
        if(!force && !due())return@synchronized gate.waiting()
        gate.begin()
        try {
            val raw=fetch();val release=parse(raw,at,sdk)
            val editor=prefs.edit().putString("manifest",raw)
            if(!prefs.contains("received:${release.code}"))editor.putLong("received:${release.code}",at.toEpochMilli())
            gate.success(editor)
        }catch(error:Exception){gate.failure(error)}
    }
    companion object {
        const val CHECK_INTERVAL_MS=86_400_000L
        const val SITE="https://sergioyankovenko.github.io/svitlo/"
        const val MANIFEST=SITE+"update.json"
        private val lock=Any()
        @Suppress("DEPRECATION") fun installedCode(context:Context):Long {
            val info=context.packageManager.getPackageInfo(context.packageName,0)
            return if(Build.VERSION.SDK_INT>=28)info.longVersionCode else info.versionCode.toLong()
        }
        @Suppress("DEPRECATION") fun installedName(context:Context):String=
            context.packageManager.getPackageInfo(context.packageName,0).versionName.orEmpty()
        internal fun parse(raw:String,now:Instant,sdk:Int):AppRelease {
            require(raw.toByteArray(Charsets.UTF_8).size<=65536)
            val json=JSONObject(raw)
            require(json.getInt("schema")==1 && json.getString("packageId")=="ua.svitlo.widget")
            val code=json.getLong("versionCode");require(code in 1..2_100_000_000L)
            val name=json.getString("versionName");require(name.matches(Regex("[0-9]+\\.[0-9]+\\.[0-9]+")) && name.length<=24)
            val date=Instant.parse(json.getString("publishedAt"));require(date<=now && date>=Instant.parse("2026-01-01T00:00:00Z"))
            require(json.getInt("minSdk") in 1..sdk)
            val apk=json.getString("apkUrl");val uri=URI(apk)
            require(uri.scheme=="https" && uri.host=="sergioyankovenko.github.io" && uri.port==-1 &&
                uri.rawUserInfo==null && uri.rawQuery==null && uri.rawFragment==null &&
                uri.rawPath=="/svitlo/downloads/Svitlo-$name.apk")
            val hash=json.getString("sha256");require(hash.matches(Regex("[a-fA-F0-9]{64}")))
            return AppRelease(code,name,date,apk,hash.lowercase())
        }
        private fun download():String=MessageHttp.get(MANIFEST).body
    }
}
