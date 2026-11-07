package ua.svitlo.widget

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import ua.svitlo.widget.core.*
import java.time.Instant
import java.time.LocalDate
import java.util.UUID

data class AddressProfile(val id:String,val name:String,val binding:ConfirmedBinding)
class AddressProfiles(context:Context){
    private val app=context.applicationContext
    private val prefs=app.getSharedPreferences("svitlo_profiles",Context.MODE_PRIVATE)
    private val repo=OutageRepository(app)
    internal data class Saved(val profile:AddressProfile,val data:PreparedData)
    fun profiles():List<AddressProfile> = synchronized(lock){captureCurrent();read().map{it.profile}}
    fun active():AddressProfile? = synchronized(lock){
        captureCurrent();val binding=repo.binding() ?: return@synchronized null
        read().firstOrNull{it.profile.binding==binding}?.profile
    }
    /** Called only by the positive official-address confirmation action. */
    fun confirm(account:String,address:String,prepared:PreparedData,city:String="",name:String?=null,add:Boolean=false,dictionary:DictionaryAddress?=null):Boolean=synchronized(lock){
        val normalized=AccountNumber.normalize(account)
        if(!ConfirmedBinding(normalized,address.trim(),city.trim(),dictionary).isValid() || prepared.account!=normalized || prepared.dictionary!=dictionary || (name!=null && cleanName(name)==null))return@synchronized false
        if(!captureCurrent())return@synchronized false
        val old=read();val binding=ConfirmedBinding(normalized,address.trim(),city.trim(),dictionary)
        val duplicate=old.firstOrNull{if(normalized.isNotEmpty())it.profile.binding.account==normalized else it.profile.binding.dictionary==dictionary}
        val current=old.firstOrNull{it.profile.binding==repo.binding()}
        val selected=duplicate ?: if(add)null else current
        if(selected==null && old.size>=MAX_PROFILES)return@synchronized false
        val profile=AddressProfile(selected?.profile?.id ?: UUID.randomUUID().toString(),
            name?.let(::cleanName) ?: selected?.profile?.name ?: "",binding)
        val updated=if(old.any{it.profile.id==profile.id})old.map{if(it.profile.id==profile.id)Saved(profile,prepared)else it}
            else old+Saved(profile,prepared)
        // Persist the confirmed profile first. Failed binding restores the prior profile set.
        if(!save(updated))return@synchronized false
        if(!repo.bindConfirmed(normalized,address,prepared,city,dictionary)){save(old);return@synchronized false}
        prefs.edit().putString("active",profile.id).commit();true
    }
    fun activate(id:String):Boolean=synchronized(lock){
        if(!captureCurrent())return@synchronized false
        val saved=read().firstOrNull{it.profile.id==id} ?: return@synchronized false
        if(saved.profile.binding==repo.binding())return@synchronized true
        // Clearing before the switch makes a failed storage operation leave the old binding intact.
        val weather=WeatherRepository(app)
        if(runCatching{weather.clear()}.isFailure)return@synchronized false
        val binding=saved.profile.binding
        if(!repo.bindConfirmed(binding.account,binding.address,saved.data,binding.city,binding.dictionary))return@synchronized false
        // Invalidate weather requests that started in the interval before the new binding committed.
        runCatching{weather.clear()}
        app.getSharedPreferences("svitlo_geo",Context.MODE_PRIVATE).edit().remove("history").remove("last_check").remove("snooze_until").commit()
        prefs.edit().putString("active",id).commit();true
    }
    fun rename(id:String,name:String):Boolean=synchronized(lock){
        val cleaned=cleanName(name) ?: return@synchronized false
        val records=read();if(records.none{it.profile.id==id})return@synchronized false
        save(records.map{if(it.profile.id==id)it.copy(profile=it.profile.copy(name=cleaned))else it})
    }
    fun remove(id:String):Boolean=synchronized(lock){
        val records=read();val target=records.firstOrNull{it.profile.id==id} ?: return@synchronized false
        if(target.profile.binding==repo.binding())return@synchronized false
        save(records.filterNot{it.profile.id==id})
    }
    /** Immutable per-profile views; never calls activate or clears weather. */
    internal fun saved():List<Saved> = synchronized(lock){captureCurrent();read()}
    fun snapshots(at:Instant=Instant.now()):List<Pair<AddressProfile,Snapshot>> {
        val current=OutageRepository(app,now={at});val bound=current.boundSnapshot()
        val records=synchronized(lock){
            var values=read()
            if(bound!=null && values.none{it.profile.binding==bound.binding}){captureCurrent();values=read()}
            values
        }
        return records.map{it.profile to if(it.profile.binding==bound?.binding)bound.snapshot else current.profileSnapshot(it.profile.binding,it.data)}
    }
    internal fun storeRefresh(expected:Saved,data:PreparedData,activeToken:String?):Boolean=synchronized(lock){
        val records=read();val existing=records.firstOrNull{it.profile.id==expected.profile.id} ?: return@synchronized false
        if(existing.profile.binding!=expected.profile.binding || data.account!=existing.profile.binding.account || data.dictionary!=existing.profile.binding.dictionary)return@synchronized false
        // Ignore late responses if this profile already received a newer successful category.
        if(data.categories.any{(category,value)->existing.data.categories[category]?.snapshot?.fetchedAt?.let{it>value.snapshot.fetchedAt}==true})return@synchronized false
        val merged=data.copy(categories=existing.data.categories+data.categories)
        if(!save(records.map{if(it.profile.id==expected.profile.id)it.copy(data=merged)else it}))return@synchronized false
        if(repo.binding()==existing.profile.binding)repo.storeProfileRefresh(existing.profile.binding,activeToken,merged)
        true
    }
    fun clear(){synchronized(lock){prefs.edit().clear().commit()}}
    private fun captureCurrent():Boolean {
        val state=repo.savedProfileData() ?: return true
        val records=read();val existing=records.firstOrNull{it.profile.binding==state.first}
        // A process can stop after staging replacement metadata but before binding commits.
        // The actual confirmed binding wins; recover its existing slot even at the limit.
        val recover=if(existing==null)records.firstOrNull{it.profile.id==prefs.getString("active",null)}else null
        val profile=existing?.profile ?: recover?.profile?.copy(binding=state.first) ?: AddressProfile(UUID.randomUUID().toString(),"Мій дім",state.first)
        if(existing==null && recover==null && records.size>=MAX_PROFILES)return false
        if(existing?.data==state.second){
            if(prefs.getString("active",null)!=profile.id)prefs.edit().putString("active",profile.id).commit()
            return true
        }
        val updated=if(records.any{it.profile.id==profile.id})records.map{if(it.profile.id==profile.id)Saved(profile,state.second)else it}
            else records+Saved(profile,state.second)
        if(!save(updated))return false
        prefs.edit().putString("active",profile.id).commit();return true
    }
    private fun read():List<Saved> {
        val raw=prefs.getString("profiles","[]").orEmpty()
        if(raw==cachedRaw)return cachedRecords
        val result=runCatching{
        val values=JSONArray(raw)
        (0 until minOf(values.length(),MAX_PROFILES)).mapNotNull{index->runCatching{
            val value=values.getJSONObject(index)
            val binding=ConfirmedBinding(value.getString("account"),value.getString("address"),value.optString("city"),DictionaryAddress.parse(value.optJSONObject("dictionary")))
            require(binding.isValid())
            val profile=AddressProfile(value.getString("id"),cleanName(value.getString("name")) ?: error("name"),binding)
            val categories=mutableMapOf<Category,PreparedCategory>();val failures=mutableSetOf<Category>()
            val cache=value.getJSONObject("cache")
            Category.entries.forEach{category->
                val data=cache.optJSONObject(category.selector.toString())
                if(data==null)failures+=category else{
                    val raw=data.getString("raw");val fetched=Instant.parse(data.getString("fetched"))
                    categories[category]=PreparedCategory(raw,OutageParser.parse(raw,category,fetched))
                    if(data.optBoolean("failed",true))failures+=category
                }
            }
            Saved(profile,PreparedData(binding.account,LocalDate.parse(value.getString("from")),LocalDate.parse(value.getString("to")),categories,failures,binding.dictionary))
        }.getOrNull()}
        }.getOrDefault(emptyList())
        cachedRaw=raw;cachedRecords=result
        return result
    }
    private fun save(records:List<Saved>):Boolean = runCatching{
        val values=JSONArray()
        records.take(MAX_PROFILES).forEach{saved->
            val p=saved.profile;val cache=JSONObject()
            saved.data.categories.forEach{(category,data)->
                // Unusually large responses stay out of the per-address cache and remain explicitly unavailable.
                if(data.raw.length<=65_536)cache.put(category.selector.toString(),JSONObject().put("raw",data.raw)
                    .put("fetched",data.snapshot.fetchedAt.toString()).put("failed",category in saved.data.failures))
            }
            values.put(JSONObject().put("id",p.id).put("name",p.name).put("account",p.binding.account).put("address",p.binding.address).put("city",p.binding.city).put("dictionary",p.binding.dictionary?.json())
                .put("from",saved.data.from.toString()).put("to",saved.data.to.toString()).put("cache",cache))
        }
        val raw=values.toString();require(raw.length<=4_194_304)
        val before=prefs.getString("profiles",null)
        if(before==raw)true else {
            val committed=prefs.edit().putString("profiles",raw).commit()
            // SharedPreferences mutates memory before reporting a disk failure.
            if(!committed)runCatching{prefs.edit().putString("profiles",before).commit()}
            committed
        }
    }.getOrDefault(false)
    private fun cleanName(name:String):String?=name.trim().replace(Regex("\\s+")," ").takeIf{it.length<=32}
    companion object{const val MAX_PROFILES=10;private val lock=Any();private var cachedRaw:String?=null;private var cachedRecords:List<Saved> = emptyList()}
}
