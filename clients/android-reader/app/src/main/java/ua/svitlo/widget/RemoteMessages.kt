package ua.svitlo.widget

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Instant
import java.util.UUID

internal data class RemoteMessage(val id:String,val type:String,val title:String,val body:String,val published:Instant,
    val expires:Instant,val minVersion:Long?,val maxVersion:Long?,val installation:String?,val targetVersion:Long?,val action:String?) {
    fun visible(at:Instant,version:Long,id:String)=published<=at && at<expires && at<published.plusSeconds(7*86400) &&
        (minVersion==null || version>=minVersion) && (maxVersion==null || version<=maxVersion) &&
        (installation==null || installation==id) && (targetVersion==null || targetVersion>version)
    fun json()=JSONObject().put("id",id).put("type",type).put("title",title).put("body",body)
        .put("publishedAt",published.toString()).put("expiresAt",expires.toString())
        .put("audience",when{
            installation!=null->JSONObject().put("kind","installation").put("installationId",installation)
            minVersion!=null || maxVersion!=null->JSONObject().put("kind","versions").put("minVersionCode",minVersion ?: JSONObject.NULL).put("maxVersionCode",maxVersion ?: JSONObject.NULL)
            else->JSONObject().put("kind","all")
        }).apply{targetVersion?.let{put("targetVersionCode",it)};action?.let{put("action",JSONObject().put("kind","open_url").put("url",it))}}
    fun fingerprint():String=MessageDigest.getInstance("SHA-256").digest(json().toString().toByteArray()).joinToString(""){"%02x".format(it)}
}

internal object RemoteMessageSchema {
    const val PUBLIC_URL="https://sergioyankovenko.github.io/svitlo/android-messages.json"
    const val DOWNLOAD="https://www.svitlo.guru/"
    private fun keys(json:JSONObject,allowed:Set<String>){require(json.keys().asSequence().all{it in allowed})}
    private fun string(json:JSONObject,key:String,max:Int):String {
        val value=json.get(key);require(value is String && value.length in 1..max && value.none{it=='\u0000' || (it<' ' && it!='\n' && it!='\t')})
        return value
    }
    private fun code(json:JSONObject,key:String):Long? {
        if(!json.has(key) || json.isNull(key))return null
        val v=json.get(key);require(v is Int || v is Long);val n=(v as Number).toLong();require(n in 1..2_100_000_000L);return n
    }
    fun allowedUrl(url:String):Boolean=runCatching{
        val uri=URI(url)
        uri.scheme=="https" && uri.port==-1 && uri.rawUserInfo==null && uri.rawQuery==null && uri.rawFragment==null &&
            ((uri.host in listOf("www.svitlo.guru","svitlo.guru") && uri.rawPath in listOf("","/")) ||
                (uri.host=="sergioyankovenko.github.io" && uri.rawPath=="/svitlo/"))
    }.getOrDefault(false)
    fun parse(raw:String,privateFeed:Boolean):List<RemoteMessage> {
        require(raw.toByteArray(Charsets.UTF_8).size<=65_536)
        val root=JSONObject(raw);keys(root,setOf("schema","packageId","generatedAt","messages"))
        require(root.get("schema")==1 && root.getString("packageId")=="ua.svitlo.widget")
        Instant.parse(string(root,"generatedAt",40))
        val array=root.getJSONArray("messages");require(array.length()<=100)
        val result=(0 until array.length()).map{parseMessage(array.getJSONObject(it),privateFeed)}
        require(result.map{it.id}.distinct().size==result.size)
        return result
    }
    private fun parseMessage(json:JSONObject,privateFeed:Boolean):RemoteMessage {
        keys(json,setOf("id","type","title","body","publishedAt","expiresAt","audience","targetVersionCode","action"))
        val id=string(json,"id",128);require(id.matches(Regex("[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}")))
        val type=string(json,"type",24);require(type in listOf("app_update","maintenance","service"))
        val title=string(json,"title",120);val body=string(json,"body",2000)
        val published=Instant.parse(string(json,"publishedAt",40));val expires=Instant.parse(string(json,"expiresAt",40));require(expires>published)
        val audience=json.getJSONObject("audience");var min:Long?=null;var max:Long?=null;var installation:String?=null
        when(audience.getString("kind")){
            "all"->keys(audience,setOf("kind"))
            "versions"->{keys(audience,setOf("kind","minVersionCode","maxVersionCode"));min=code(audience,"minVersionCode");max=code(audience,"maxVersionCode");require(min!=null || max!=null);require(min==null || max==null || min<=max)}
            "installation"->{require(privateFeed);keys(audience,setOf("kind","installationId"));installation=string(audience,"installationId",36);require(UUID.fromString(installation).toString()==installation)}
            else->error("audience")
        }
        val target=code(json,"targetVersionCode");require((type=="app_update")== (target!=null))
        val action=if(!json.has("action") || json.isNull("action"))null else json.getJSONObject("action").let{
            keys(it,setOf("kind","url"));require(it.getString("kind")=="open_url");string(it,"url",256).also{url->require(allowedUrl(url))}
        }
        require(type!="app_update" || action!=null)
        return RemoteMessage(id,type,title,body,published,expires,min,max,installation,target,action)
    }
}

/** Identity is independent of address profiles. The secret is a credential, the UUID is not. Backup is disabled. */
internal class MessageInstallation(context:Context) {
    private val identity=context.getSharedPreferences("svitlo_message_identity",0)
    private val activity=context.getSharedPreferences("svitlo_activity",0)
    fun id():String=synchronized(lock){activity.getString("installation",null) ?: UUID.randomUUID().toString().also{check(activity.edit().putString("installation",it).commit())}}
    fun proof():String=synchronized(lock){identity.getString("proof",null) ?: ByteArray(32).also{SecureRandom().nextBytes(it)}
        .joinToString(""){"%02x".format(it)}.also{check(identity.edit().putString("proof",it).commit())}}
    companion object{internal val lock=Any()}
}

internal fun interface PrivateMessageSource {fun fetch(installation:String,proof:String,version:Long):String}
internal class RemoteMessageRepository(context:Context,
    private val publicSource:(String?)->MessageResponse={MessageHttp.get(RemoteMessageSchema.PUBLIC_URL,it)},
    private val privateSource:PrivateMessageSource=PrivateMessageSource{id,proof,code->RegistryClient(context).messages(id,proof,code).toString()},
    private val now:()->Instant={Instant.now()},private val installed:Long=AppUpdateRepository.installedCode(context)) {
    private val app=context.applicationContext
    private val prefs=app.getSharedPreferences("svitlo_remote_messages",0)
    private val identity=MessageInstallation(app)
    private fun gate(source:String)=MessageFetchGate(prefs,now,"$source:")
    fun refresh():List<MessageRefresh> = synchronized(fetchLock){listOf(refreshSource("public"),refreshSource("private"))}
    private fun refreshSource(source:String):MessageRefresh {
        val gate=gate(source);if(!gate.due())return gate.waiting()
        gate.begin()
        return try{
            val response=if(source=="public")publicSource(prefs.getString("etag",null))else try{
                MessageResponse(200,privateSource.fetch(identity.id(),identity.proof(),installed))
            }catch(e:SupabaseHttpFailure){throw MessageHttpError(e.status,e.retryAfter)}
            val raw=when(response.status){200->response.body;304->prefs.getString("public:cache",null) ?: error("304 without cache");else->throw MessageHttpError(response.status)}
            val parsed=RemoteMessageSchema.parse(raw,source=="private")
            synchronized(lock){
            val states=states()
            // Published content is immutable per ID. Reject a silently rewritten event as a whole.
            parsed.forEach{message->
                val old=states.optJSONObject(message.id)
                require(old==null || old.optString("fingerprint")==message.fingerprint())
                if(old==null)states.put(message.id,JSONObject().put("received",now().toEpochMilli()).put("fingerprint",message.fingerprint()).put("viewed",false).put("posted",false))
            }
            val editor=prefs.edit().putString("$source:cache",raw).putString("states",states.toString())
            if(source=="public" && response.status==200){if(response.etag==null)editor.remove("etag")else editor.putString("etag",response.etag)}
            gate.success(editor)
            }
        }catch(e:Exception){gate.failure(e)}
    }
    private fun states()=runCatching{JSONObject(prefs.getString("states","{}")!!)}.getOrElse{JSONObject()}
    fun visible():List<RemoteMessage> = synchronized(lock){
        val messages=listOf("public","private").flatMap{source->runCatching{RemoteMessageSchema.parse(prefs.getString("$source:cache","{}")!!,source=="private")}.getOrDefault(emptyList())}
        messages.filter{it.visible(now(),installed,identity.id())}.distinctBy{it.id}.sortedByDescending{it.published}
    }
    fun viewed(id:String)=synchronized(lock){states().optJSONObject(id)?.optBoolean("viewed")==true}
    fun posted(id:String)=synchronized(lock){states().optJSONObject(id)?.optBoolean("posted")==true}
    fun markViewed(id:String)=mark(id,"viewed")
    fun markPosted(id:String)=mark(id,"posted")
    private fun mark(id:String,key:String)=synchronized(lock){val states=states();val value=states.optJSONObject(id) ?: return@synchronized
        if(!value.optBoolean(key)){value.put(key,true);check(prefs.edit().putString("states",states.toString()).commit())}}
    fun receivedAt(id:String)=synchronized(lock){states().optJSONObject(id)?.optLong("received",0)}
    fun remainingLifetime(message:RemoteMessage):Long=java.time.Duration.between(now(),minOf(message.expires,message.published.plusSeconds(7*86400))).toMillis().coerceAtLeast(1)
    companion object {internal val lock=Any();private val fetchLock=Any()}
}
