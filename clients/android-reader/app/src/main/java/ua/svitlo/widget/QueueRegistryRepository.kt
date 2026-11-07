package ua.svitlo.widget

import android.content.Context
import org.json.JSONObject
import java.net.URL
import java.time.Instant
import java.time.LocalDate
import ua.svitlo.widget.core.KYIV_ZONE
import javax.net.ssl.HttpsURLConnection

data class RegistryQueue(val queue:String,val scope:String,val url:String,val page:Int,val version:String,
    val validUntil:LocalDate,val checkedAt:Instant) {
    fun description()="Офіційний перелік · ${if(scope=="settlement_all")"населений пункт"else if(scope=="street_all")"вулиця"else"будинок"} · стор. $page"
    companion object {
        fun parse(value:JSONObject,now:Instant):RegistryQueue? {
            if(value.optString("status")!="matched")return null
            require(value.getString("source")=="official_registry")
            val queue=value.getString("queue");require(Regex("[1-6]\\.[12]").matches(queue))
            val scope=value.getString("scope");require(scope in listOf("house","street_all","settlement_all"))
            val uri=java.net.URI(value.getString("url"))
            require(uri.scheme=="https" && uri.host=="www.cherkasyoblenergo.com" && uri.port==-1 && uri.rawUserInfo==null && uri.rawQuery==null && uri.rawFragment==null && uri.path.endsWith(".pdf"))
            val page=value.getInt("page");require(page in 1..1000)
            val until=LocalDate.parse(value.getString("validUntil"));require(until>=now.atZone(KYIV_ZONE).toLocalDate())
            val checked=Instant.ofEpochMilli(value.getLong("checkedAt"))
            require(checked<=now.plusSeconds(300) && checked>=now.minusSeconds(15*86400L))
            val version=value.getString("version");require(version.isNotBlank() && version.length<=2048)
            return RegistryQueue(queue,scope,uri.toString(),page,version,until,checked)
        }
    }
}

fun interface RegistrySource { fun resolve(address:DictionaryAddress):JSONObject }

/** Uses the same authenticated resolve_queue contract as PWA; stores no server secrets. */
class QueueRegistryRepository(context:Context,private val source:RegistrySource=RegistryClient(context),private val now:()->Instant={Instant.now()}) {
    private val prefs=context.applicationContext.getSharedPreferences("svitlo_registry",Context.MODE_PRIVATE)
    private fun key(address:DictionaryAddress)=listOf(address.departmentId,address.cityId,address.streetId,address.house).joinToString("|")
    fun cached(address:DictionaryAddress,at:Instant=now()):RegistryQueue?=runCatching{
        RegistryQueue.parse(JSONObject(prefs.getString("data:${key(address)}",null) ?: return null),at)
    }.getOrNull()
    /** An explicit address-scoped negative, never an inference from a null queue. */
    fun excluded(address:DictionaryAddress,at:Instant=now()):Boolean=runCatching {
        val name=key(address)
        val value=JSONObject(prefs.getString("data:$name",null) ?: return false)
        val checked=Instant.ofEpochMilli(prefs.getLong("verified:$name",0))
        value.optString("status")=="not_found" && value.optString("inclusion")=="not_in_queue" &&
            value.isNull("queue") && checked<=at.plusSeconds(300) && checked>=at.minusSeconds(7200)
    }.getOrDefault(false)
    fun refresh(address:DictionaryAddress,force:Boolean=false):Boolean=synchronized(lock){
        val key=key(address);val at=now()
        if(!force && at.toEpochMilli()-prefs.getLong("attempt:$key",0) in 0..3_599_999)return@synchronized cached(address,at)!=null || excluded(address,at)
        prefs.edit().putLong("attempt:$key",at.toEpochMilli()).commit()
        try {
            val value=source.resolve(address).getJSONObject("resolution")
            // A current negative response invalidates previous evidence. A network failure retains it.
            if(value.optString("status")!="matched"){
                require(value.optString("status") in listOf("unavailable","incomplete_address","not_found","ambiguous"))
                val editor=prefs.edit().remove("data:$key").remove("verified:$key").putString("status:$key",value.optString("status"))
                if(value.optString("inclusion")=="not_in_queue"){
                    require(value.optString("status")=="not_found" && value.isNull("queue"))
                    editor.putString("data:$key",value.toString()).putLong("verified:$key",at.toEpochMilli())
                }
                editor.commit();return@synchronized true
            }
            RegistryQueue.parse(value,at) ?: error("resolution")
            prefs.edit().putString("data:$key",value.toString()).remove("verified:$key").putString("status:$key","matched").commit();true
        }catch(_:Exception){false}
    }
    companion object { private val lock=Any() }
}

internal fun interface SupabaseTransport { fun post(path:String,body:JSONObject,token:String?):JSONObject }
internal class SupabaseHttpFailure(val status:Int,val retryAfter:String?=null):java.io.IOException("HTTP $status")
internal class RegistryClient(context:Context,private val transport:SupabaseTransport?=null,private val nowMs:()->Long={System.currentTimeMillis()}):RegistrySource {
    private val prefs=context.applicationContext.getSharedPreferences("svitlo_registry_auth",Context.MODE_PRIVATE)
    private fun token():String {
            if(prefs.getLong("expires",0)>nowMs()+60_000)return prefs.getString("access",null) ?: error("session")
            val refresh=prefs.getString("refresh",null)
            val session=if(refresh==null)post("/auth/v1/signup",JSONObject(),null) else try {
                post("/auth/v1/token?grant_type=refresh_token",JSONObject().put("refresh_token",refresh),null)
            }catch(error:SupabaseHttpFailure){
                if(error.status !in listOf(400,401))throw error
                prefs.edit().clear().commit();post("/auth/v1/signup",JSONObject(),null)
            }
            val access=session.getString("access_token");val next=session.getString("refresh_token")
            require(access.length in 20..8192 && next.length in 10..8192)
            val expires=session.getLong("expires_in");require(expires in 1..86400)
            prefs.edit().putString("access",access).putString("refresh",next)
                .putLong("expires",nowMs()+expires*1000).commit()
            return access
    }
    private fun authenticated(path:String,body:JSONObject):JSONObject=synchronized(authLock){
        try{post(path,body,token())}catch(error:SupabaseHttpFailure){
            if(error.status!=401)throw error
            prefs.edit().putLong("expires",0).commit()
            post(path,body,token()) // A single refresh/retry; never an unbounded auth loop.
        }
    }
    override fun resolve(address:DictionaryAddress):JSONObject {
        val body=JSONObject().put("action","resolve_queue").put("address",JSONObject()
            .put("department",address.departmentId).put("cityId",address.cityId).put("streetId",address.streetId).put("house",address.house))
        return authenticated("/functions/v1/svitlo-api",body)
    }
    fun heartbeat(id:String,version:String,isTest:Boolean)=authenticated("/functions/v1/svitlo-android-active",
        JSONObject().put("installationId",id).put("version",version).put("isTest",isTest))
    fun messages(id:String,proof:String,version:Long)=authenticated("/functions/v1/svitlo-android-messages",
        JSONObject().put("installationId",id).put("proof",proof).put("versionCode",version))
    private fun post(path:String,body:JSONObject,token:String?):JSONObject {
        transport?.let{return it.post(path,body,token)}
        val connection=URL(ORIGIN+path).openConnection() as HttpsURLConnection
        return try {
            connection.instanceFollowRedirects=false;connection.connectTimeout=15_000;connection.readTimeout=45_000
            connection.requestMethod="POST";connection.doOutput=true;connection.useCaches=false
            connection.setRequestProperty("Content-Type","application/json");connection.setRequestProperty("Accept","application/json")
            connection.setRequestProperty("apikey",PUBLIC_KEY)
            if(token!=null)connection.setRequestProperty("Authorization","Bearer $token")
            connection.outputStream.use{it.write(body.toString().toByteArray(Charsets.UTF_8))}
            val status=connection.responseCode
            if(status !in 200..299)throw SupabaseHttpFailure(status,connection.getHeaderField("Retry-After"))
            val text=connection.inputStream.bufferedReader(Charsets.UTF_8).use{reader->
                val chars=CharArray(4096);val out=StringBuilder()
                while(true){val n=reader.read(chars);if(n<0)break;require(out.length+n<=65536);out.append(chars,0,n)};out.toString()
            }
            JSONObject(text)
        }catch(error:SupabaseHttpFailure){throw error}catch(error:Exception){throw SourceException(SourceFailure.of(error))}finally{connection.disconnect()}
    }
    companion object {
        private val authLock=Any()
        private const val ORIGIN="https://ovcmluucwzsuflusebcc.supabase.co"
        private const val PUBLIC_KEY="sb_publishable_X-NwBLBqPbCVs2SvJRf0Xw_N6IBsOwb"
    }
}
