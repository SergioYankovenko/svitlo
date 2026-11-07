package ua.svitlo.widget

import android.content.Context
import android.content.pm.ApplicationInfo
import java.time.Instant
import java.util.UUID

fun interface HeartbeatSource { fun send(id:String,version:String,isTest:Boolean):Boolean }

/** Minimum activity signal only. Never reads a binding, address, device ID or account. */
class ActiveInstallRepository(context:Context,private val source:HeartbeatSource=HeartbeatSource{id,version,test->
    RegistryClient(context).heartbeat(id,version,test).optString("status") in listOf("recorded","already_seen")
},private val now:()->Instant={Instant.now()}) {
    private val app=context.applicationContext
    private val prefs=app.getSharedPreferences("svitlo_activity",Context.MODE_PRIVATE)
    fun report():Boolean=synchronized(lock){
        val at=now().toEpochMilli();val attempt=prefs.getLong("attempt",0)
        if(attempt>0 && at-attempt in 0 until DAY)return@synchronized true
        val id=MessageInstallation(app).id()
        if(!prefs.edit().putLong("attempt",at).commit())return@synchronized false
        val test=(app.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE)!=0 || app.packageName.endsWith(".qa")
        runCatching{source.send(id,AppUpdateRepository.installedName(app),test)}.getOrDefault(false)
    }
    companion object { const val DAY=86_400_000L;private val lock=Any() }
}
