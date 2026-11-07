package ua.svitlo.widget.next

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.URL
import java.security.KeyStore
import java.time.Instant
import java.time.LocalDate
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.net.ssl.HttpsURLConnection

/** Per-package Keystore vault. No secret is built into an APK or backed up. */
class NextVault(context:Context){
    private val app=context.applicationContext
    private val prefs=app.getSharedPreferences("next_vault",Context.MODE_PRIVATE)
    private val alias="${app.packageName}.reader.v1"
    companion object { private val keyLock=Any() }
    private fun key():SecretKey = synchronized(keyLock) {val ks=KeyStore.getInstance("AndroidKeyStore").apply{load(null)}; (ks.getKey(alias,null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore").apply{init(KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setRandomizedEncryptionRequired(true).build())}.generateKey()}
    @Synchronized fun read(name:String):String?=prefs.getString(name,null)?.let{encoded->runCatching{val b=Base64.decode(encoded,Base64.NO_WRAP);require(b.size>=29);val c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.DECRYPT_MODE,key(),GCMParameterSpec(128,b.copyOfRange(0,12)));c.updateAAD(name.toByteArray());String(c.doFinal(b.copyOfRange(12,b.size)),Charsets.UTF_8)}.getOrNull()}
    @Synchronized fun write(name:String,value:String?){if(value==null){check(prefs.edit().remove(name).commit());return};val c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.ENCRYPT_MODE,key());c.updateAAD(name.toByteArray());check(prefs.edit().putString(name,Base64.encodeToString(c.iv+c.doFinal(value.toByteArray()),Base64.NO_WRAP)).commit())}
    @Synchronized fun removePrefix(prefix:String){val edit=prefs.edit();prefs.all.keys.filter{it.startsWith(prefix)}.forEach(edit::remove);check(edit.commit())}
    fun consumeBootstrap(){val f=File(app.filesDir,"next-bootstrap.json");if(!f.isFile)return;try{require(f.length()<=1024);val v=JSONObject(f.readText()).getString("pilotKey");require(Regex("pilot_[A-Za-z0-9_-]{43}").matches(v));write("pilot",v)}finally{f.delete()}}
}
class NextApiException(val status:Int,val retryAfter:Long=0,val code:String=""):IOException(when(status){401->"Потрібен доступ до тестового сервера";403->"Доступ до цієї дії відсутній";404->"Дані більше недоступні";409->"Дані змінилися. Перевірте вибір ще раз";429->"Сервер просить зачекати перед повтором";else->"Не вдалося отримати дані. Спробуйте ще раз"})
class NextApi(context:Context){
    val vault=NextVault(context)
    companion object {const val BASE="https://62.83.90.118";private val privateLock=Any();private val routes=setOf("/readyz","/api/session","/api","/api/v1/capabilities","/api/v1/search","/api/v1/resolve","/api/v1/legacy-resolve","/api/v1/snapshots","/api/v1/sensors","/api/v1/map-search","/api/v1/diagnostic-reports","/api/v1/identity","/api/v1/billing","/api/v1/notifications","/api/v1/migration","/api/v1/plan-windows","/api/v1/charging")}
    init{vault.consumeBootstrap()}
    fun ready()=vault.read("pilot")!=null
    fun setPilot(value:String){require(Regex("pilot_[A-Za-z0-9_-]{43}").matches(value));vault.write("pilot",value);call("/readyz")}
    fun call(path:String,data:JSONObject?=null,private:Boolean=false,method:String=if(data==null)"GET"else"POST"):JSONObject {
        require(path in routes);val payload=data?.toString()?.toByteArray(Charsets.UTF_8);require(payload==null||payload.size<=16384)
        val conn=(URL(BASE+path).openConnection() as HttpsURLConnection);conn.instanceFollowRedirects=false;conn.connectTimeout=12000;conn.readTimeout=25000;conn.requestMethod=method;conn.useCaches=false
        conn.setRequestProperty("Accept","application/json");conn.setRequestProperty("X-Svitlo-Pilot-Key",vault.read("pilot") ?: throw NextApiException(401));conn.setRequestProperty("User-Agent","Svitlo-Android/1.7.0-private")
        if(private){conn.setRequestProperty("Origin",BASE);vault.read("cookie")?.let{conn.setRequestProperty("Cookie",it)};vault.read("csrf")?.let{conn.setRequestProperty("X-Svitlo-CSRF",it)}}
        if(path=="/api/v1/diagnostic-reports")conn.setRequestProperty("X-Svitlo-Diagnostic-Consent",data!!.getString("reportId"))
        try{if(payload!=null){conn.doOutput=true;conn.setRequestProperty("Content-Type","application/json");conn.setFixedLengthStreamingMode(payload.size);conn.outputStream.use{it.write(payload)}}
            val status=conn.responseCode
            if(status !in 200..299){val retry=NextDeliveryPolicy.retryAfter(conn.getHeaderField("Retry-After"));val error=runCatching{conn.errorStream?.use{val bytes=ByteArray(4096);val n=it.read(bytes);if(n>0)JSONObject(String(bytes,0,n,Charsets.UTF_8))else JSONObject()}}.getOrNull();val code=(error?.optJSONObject("error")?.optString("code") ?:error?.optString("code")?.ifBlank{error.optString("error")}).orEmpty().takeIf{it.matches(Regex("[a-z_0-9]{1,80}"))}.orEmpty();throw NextApiException(status,retry,code)}
            require((conn.contentType ?: "").substringBefore(';').trim()=="application/json"){"Некоректна відповідь сервера"}
            val body=conn.inputStream.use{input->val out=java.io.ByteArrayOutputStream();val buffer=ByteArray(8192);while(true){val n=input.read(buffer);if(n<0)break;require(out.size()+n<=2_000_000){"Відповідь завелика"};out.write(buffer,0,n)};String(out.toByteArray(),Charsets.UTF_8)}
            val json=JSONObject(body)
            if(private)conn.headerFields.entries.filter{it.key.equals("Set-Cookie",true)}.flatMap{it.value}.forEach{cookie->val first=cookie.substringBefore(';');if(first.startsWith("svitlo_"))vault.write("cookie",first)}
            return json
        }finally{conn.disconnect()}
    }
    fun owned(path:String,data:JSONObject,expectedOwner:String?=null):JSONObject=synchronized(privateLock){
        if(vault.read("csrf")==null||vault.read("cookie")==null){val session=call("/api/session",JSONObject(),true).getJSONObject("session");vault.write("csrf",session.getString("csrf_token"));vault.write("subject",session.getJSONObject("user").getString("id"))}
        if(expectedOwner!=null&&expectedOwner!=vault.read("subject"))throw NextApiException(409,code="identity_changed")
        try{
            val result=call(path,data,true)
            if(path=="/api/v1/identity"&&result.optString("state")=="authenticated"){
                val session=result.getJSONObject("session");val owner=session.getJSONObject("user").getString("id")
                val csrf=session.getString("csrf_token")
                if(!UUID_RE.matches(owner)||!csrf.matches(Regex("[a-f0-9]{64}"))||result.getJSONObject("account").getString("accountId")!=owner){
                    vault.write("csrf",null);vault.write("cookie",null);vault.write("subject",null);throw NextApiException(503,code="invalid_identity_session")
                }
                vault.write("csrf",csrf);vault.write("subject",owner)
            }
            result
        }catch(e:NextApiException){if(e.status==401&&!(path=="/api/v1/identity"&&e.code in setOf("identity_proof_rejected","identity_challenge_expired"))){vault.write("csrf",null);vault.write("cookie",null);vault.write("subject",null)};throw e}
    }
    fun identity(action:String,data:JSONObject=JSONObject(),owner:String?=null)=owned("/api/v1/identity",data.put("schemaVersion",1).put("action",action),owner)
    fun billing(action:String,data:JSONObject=JSONObject(),owner:String?=null)=owned("/api/v1/billing",data.put("schemaVersion",1).put("action",action),owner)
    fun sensors(action:String,fields:JSONObject=JSONObject())=owned("/api/v1/sensors",fields.put("schemaVersion",1).put("action",action))
    fun search(kind:String,parent:String?,q:String,cursor:String?=null):JSONObject=call("/api/v1/search",JSONObject().put("schemaVersion",1).put("kind",kind).put("q",q.take(120)).put("limit",50).apply{if(parent!=null)put("parentId",parent);if(cursor!=null)put("cursor",cursor)})
    fun resolve(address:String,line:String?=null)=call("/api/v1/resolve",JSONObject().put("schemaVersion",1).put("addressId",address).apply{if(line!=null)put("lineId",line)})
    fun snapshots(addresses:List<String>,from:LocalDate,to:LocalDate)=call("/api/v1/snapshots",JSONObject().put("schemaVersion",1).put("fromDate",from.toString()).put("toDate",to.toString()).put("items",JSONArray(addresses.distinct().take(10).map{JSONObject().put("addressId",it)})))
}
data class NextProfile(val id:String,val name:String,val addressId:String,val lineId:String?,val label:String,val city:String,val street:String,val house:String,val operatorId:String,val serverId:String?=null,val mapOnly:Boolean=false){
    val title get()=name.ifBlank{city.ifBlank{label}}
    fun json()=JSONObject().put("id",id).put("name",name).put("addressId",addressId).put("lineId",lineId ?: JSONObject.NULL).put("label",label).put("city",city).put("street",street).put("house",house).put("operatorId",operatorId).put("serverId",serverId ?: JSONObject.NULL).put("mapOnly",mapOnly)
    companion object {fun parse(o:JSONObject)=NextProfile(o.getString("id"),o.optString("name"),o.getString("addressId"),o.optString("lineId").takeUnless{it.isBlank()||it=="null"},o.getString("label"),o.optString("city"),o.optString("street"),o.optString("house"),o.getString("operatorId"),o.optString("serverId").takeUnless{it.isBlank()||it=="null"},o.optBoolean("mapOnly"))}
}
class NextRepository(context:Context){
    private val app=context.applicationContext
    val api=NextApi(app)
    val prefs=app.getSharedPreferences("next_state",Context.MODE_PRIVATE)
    companion object{private val lock=Any();private val refreshLock=Any()}
    fun profiles():List<NextProfile> = synchronized(lock){runCatching{JSONArray(prefs.getString("profiles","[]")).objects().map(NextProfile::parse)}.getOrDefault(emptyList())}
    fun active()=profiles().find{it.id==prefs.getString("active",null)} ?: profiles().firstOrNull()
    fun select(id:String){require(profiles().any{it.id==id});check(prefs.edit().putString("active",id).commit())}
    fun save(profile:NextProfile)=synchronized(lock){val old=profiles();val duplicate=old.find{it.addressId==profile.addressId&&it.lineId==profile.lineId};val value=profile.copy(id=duplicate?.id ?: profile.id);require(old.any{it.id==value.id}||old.any{it.addressId==value.addressId}||old.map{it.addressId}.distinct().size<homeLimit());val next=if(old.any{it.id==value.id})old.map{if(it.id==value.id)value else it}else old+value;check(prefs.edit().putString("profiles",JSONArray(next.map{it.json()}).toString()).putString("active",value.id).commit());value}
    private fun homeLimit()=if(prefs.getLong("premiumUntil",0)>System.currentTimeMillis())10 else 2
    fun saveConfirmed(profile:NextProfile,resolution:JSONObject)=synchronized(lock){
        val ids=CanonicalHomes.confirmed(resolution,profile.addressId)?:throw IllegalStateException("Потрібно уточнити підключення адреси")
        val incoming=if(ids.isEmpty())listOf(profile.copy(lineId=null))else ids.map{line->profile.copy(id=UUID.randomUUID().toString(),lineId=line)}
        val next=CanonicalHomes.merge(profiles(),incoming,homeLimit())
        val first=next.first{it.addressId==profile.addressId&&it.lineId==incoming.first().lineId}
        check(prefs.edit().putString("profiles",JSONArray(next.map{it.json()}).toString()).putString("active",first.id).commit());first
    }
    fun rename(id:String,value:String)=synchronized(lock){val name=value.trim();require(name.length<=80 && name.none{it<' '});val old=active()?.id;save(profiles().first{it.id==id}.copy(name=name));if(old!=null)select(old)}
    fun delete(id:String)=synchronized(lock){val remaining=profiles().filter{it.id!=id};check(prefs.edit().putString("profiles",JSONArray(remaining.map{it.json()}).toString()).apply{if(prefs.getString("active",null)==id)putString("active",remaining.firstOrNull()?.id);if(remaining.isEmpty()){remove("journey");remove("tour");remove("preferencesComplete")}}.commit());api.vault.write("sensor-history-$id",null)}
    fun snapshot(profile:NextProfile):Universal?=runCatching{Universal.parse(JSONObject(prefs.getString("snapshot-${profile.addressId}",null) ?: return null))}.getOrNull()
    fun remember(snapshot:Universal){check(prefs.edit().putString("snapshot-${snapshot.addressId}",snapshot.json.toString()).commit())}
    fun refreshDue(now:Long=System.currentTimeMillis(),force:Boolean=false):Boolean=api.ready()&&NextRefreshPolicy.due(now,profiles().filter{!it.mapOnly}.map{p->snapshot(p)?.json?.let{NextRefreshPolicy.deadline(it.getLong("refreshAfter"),it.getLong("freshUntil"),now)}},prefs.getLong("refreshRetryAt",0),prefs.getLong("refreshRateLimitAt",0),force)
    fun refresh(from:LocalDate=LocalDate.now(NEXT_ZONE).with(java.time.DayOfWeek.MONDAY),to:LocalDate=from.plusDays(13),force:Boolean=false):Boolean=synchronized(refreshLock){
        val items=profiles().filter{!it.mapOnly};if(items.isEmpty())return@synchronized true
        val now=System.currentTimeMillis();if(!refreshDue(now,force))return@synchronized true
        check(prefs.edit().putLong("lastAttempt",now).commit());var all=true
        try{val result=api.snapshots(items.map{it.addressId},from,to);for(row in result.getJSONArray("results").objects()){if(row.optString("status")=="snapshot"){val data=Universal.parse(row.getJSONObject("snapshot"));require(items.any{it.addressId==data.addressId});remember(data)}else if(row.optString("status")!="unchanged")all=false}
            if(all)prefs.edit().putLong("lastSuccess",System.currentTimeMillis()).remove("networkError").remove("refreshFailures").remove("refreshRetryAt").remove("refreshRateLimitAt").commit() else prefs.edit().putString("networkError","Частину графіків поки не вдалося оновити").putLong("refreshRetryAt",System.currentTimeMillis()+60000).commit()
            all
        }catch(e:Exception){val failures=(prefs.getInt("refreshFailures",0)+1).coerceAtMost(5);val delay=if(e is NextApiException&&e.status==429)maxOf(30000L,e.retryAfter*1000)else NextRefreshPolicy.backoff(failures);prefs.edit().putString("networkError",if(e is NextApiException)e.message else"Збережені графіки доступні. Оновлення повториться").putInt("refreshFailures",failures).putLong("refreshRetryAt",System.currentTimeMillis()+delay).apply{if(e is NextApiException&&e.status==429)putLong("refreshRateLimitAt",System.currentTimeMillis()+delay)}.commit();throw e}
    }
    fun ensureSensorProfile(profile:NextProfile):NextProfile {
        val owned=api.owned("/api",JSONObject().put("action","bootstrap")).getJSONArray("profiles").objects()
        val id=SensorProfileBindingPolicy.ownedId(profile,owned) ?:run {
            val created=api.owned("/api",JSONObject().put("action","save").put("confirmed",true).put("name",profile.name).put("address",JSONObject().put("canonicalAddressId",profile.addressId).apply{profile.lineId?.let{put("lineId",it)}}))
            val rows=created.optJSONArray("profiles")?.objects()?:listOf(created.getJSONObject("profile"))
            SensorProfileBindingPolicy.ownedId(profile,rows) ?:throw NextApiException(503,code="profile_binding_unavailable")
        }
        val selected=active()?.id;val saved=save(profile.copy(serverId=id));if(selected!=null)select(selected);return saved
    }
    fun ownerSubscription():MainAppSubscription {val value=MainAppSubscription.parse(api.sensors("entitlement"));check(prefs.edit().putLong("premiumUntil",if(value.active)value.validUntil?.toEpochMilli()?:0 else 0).commit());return value}
    fun synchronizeAccountHomes(){
        val owner=api.vault.read("subject") ?: throw NextApiException(401)
        val existing=api.owned("/api",JSONObject().put("action","bootstrap"),owner).getJSONArray("profiles").objects()
        val savedHomes=existing.mapNotNull{it.optJSONObject("address")?.optString("canonicalAddressId")}.toSet()
        for(profile in profiles().filter{!it.mapOnly&&it.addressId !in savedHomes}.distinctBy{it.addressId}){
            api.owned("/api",JSONObject().put("action","save").put("confirmed",true).put("name",profile.name)
                .put("address",JSONObject().put("canonicalAddressId",profile.addressId)),owner)
        }
        val remote=api.owned("/api",JSONObject().put("action","bootstrap"),owner).getJSONArray("profiles").objects()
        val restored=remote.mapNotNull {row ->
            val address=row.optJSONObject("address") ?:return@mapNotNull null
            val house=address.optString("canonicalAddressId");val line=address.optString("lineId").takeIf{UUID_RE.matches(it)}
            val id=row.optString("id");if(!UUID_RE.matches(id)||!UUID_RE.matches(house))return@mapNotNull null
            val city=address.optString("city");val street=address.optString("street");val number=address.optString("house")
            val label=listOf(city,street,number).filter{it.isNotBlank()}.joinToString(", ").ifBlank{"Збережена адреса"}
            NextProfile(id,row.optString("name"),house,line,label,city,street,number,address.optString("operatorId"),id)
        }
        synchronized(lock){
            if(api.vault.read("subject")!=owner)throw NextApiException(409,code="identity_changed")
            val local=profiles();val byKey=local.associateBy{it.addressId to it.lineId}
            val merged=restored.map{r->byKey[r.addressId to r.lineId]?.copy(serverId=r.serverId)?:r}+
                local.filter{l->restored.none{r->r.addressId==l.addressId&&r.lineId==l.lineId}}
            val selected=active()?.id?.takeIf{id->merged.any{it.id==id}}?:merged.firstOrNull()?.id
            check(prefs.edit().putString("profiles",JSONArray(merged.map{it.json()}).toString()).putString("active",selected).commit())
        }
        ownerSubscription();loadMemberships()
    }
    fun memberships():List<JSONObject> = runCatching{JSONArray(api.vault.read("memberships") ?: "[]").objects()}.getOrDefault(emptyList())
    fun loadMemberships():List<JSONObject>{val result=api.sensors("list");require(result.get("complete")==true);val list=result.getJSONArray("sensors");require(list.length()<=320);val incoming=list.objects();for(m in incoming){require(UUID_RE.matches(m.getString("sensorId"))&&m.getString("role") in setOf("owner","viewer")&&m.get("bindingEpoch") is Number&&m.getLong("bindingEpoch") in 1..999999999)};for(old in memberships())if(incoming.none{it.getString("sensorId")==old.getString("sensorId")&&it.getLong("bindingEpoch")==old.getLong("bindingEpoch")})clearSensorCache(old);api.vault.write("memberships",list.toString());return incoming}
    private fun clearSensorCache(m:JSONObject){val id=m.getString("sensorId");api.vault.write("signal-$id",null);api.vault.removePrefix("overview-$id-")}
    private fun revoked(m:JSONObject){clearSensorCache(m);api.vault.write("memberships",JSONArray(memberships().filterNot{it.getString("sensorId")==m.getString("sensorId")&&it.getLong("bindingEpoch")==m.getLong("bindingEpoch")}).toString())}
    fun member(profile:NextProfile)=memberships().find{it.optString("readerProfileId")==profile.serverId && profile.serverId!=null}
    fun refreshSensors():Boolean {val members=loadMemberships();for(m in members){val fields=JSONObject().put("sensorId",m.getString("sensorId")).put("bindingEpoch",m.getLong("bindingEpoch"));try{val signal=api.sensors("signal",fields).getJSONObject("signal");api.vault.write("signal-${m.getString("sensorId")}",signal.toString())}catch(e:NextApiException){if(e.status==403||e.status==404){revoked(m)}else throw e}};return true}
    fun signal(m:JSONObject):JSONObject?=runCatching{JSONObject(api.vault.read("signal-${m.getString("sensorId")}") ?: return null)}.getOrNull()
    private fun historyKey(m:JSONObject,date:LocalDate)="overview-${m.getString("sensorId")}-${m.getLong("bindingEpoch")}-$date"
    fun cachedOverview(m:JSONObject,date:LocalDate):JSONObject?=runCatching {JSONObject(api.vault.read(historyKey(m,date)) ?: return null).also {SensorPolicy.observation(it,date)}}.getOrNull()
    fun overview(m:JSONObject,date:LocalDate):JSONObject {try{val value=api.sensors("overview",JSONObject().put("sensorId",m.getString("sensorId")).put("bindingEpoch",m.getLong("bindingEpoch")).put("date",date.toString())).getJSONObject("overview");require(value.getString("date")==date.toString()&&value.getString("sensorId")==m.getString("sensorId")&&value.getLong("bindingEpoch")==m.getLong("bindingEpoch"));SensorPolicy.observation(value,date);api.vault.write(historyKey(m,date),value.toString());return value}catch(e:NextApiException){if(e.status in setOf(403,404))revoked(m);throw e}}
}
