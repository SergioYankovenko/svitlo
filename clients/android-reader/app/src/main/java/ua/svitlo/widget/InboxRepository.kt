package ua.svitlo.widget

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import ua.svitlo.widget.core.*
import java.time.Instant
import java.time.Duration
import java.security.MessageDigest

/** Address events stay on this phone and are cleared when the confirmed binding changes. */
class InboxRepository(context:Context,private val now:()->Instant={Instant.now()}){
    private val app=context.applicationContext
    private val prefs=app.getSharedPreferences("svitlo_inbox",Context.MODE_PRIVATE)
    private val official=OfficialScheduleRepository(app,now=now)
    // Each store applies retention/capacity; public traffic must not displace local address events.
    fun changes():List<OfficialChange> = synchronized(lock){(official.changes()+read()).sortedWith(InboxHistory.newestFirst)}
    fun markRead(id:String){synchronized(lock){official.markRead(id);save(read().map{if(it.id==id)it.copy(read=true)else it})}}
    fun markAllRead(queue:String){synchronized(lock){official.markAllRead(queue);save(read().map{if(it.queue==queue)it.copy(read=true)else it})}}
    fun clearRead(queue:String){synchronized(lock){official.clearRead(queue);save(read().filterNot{it.queue==queue && it.read})}}
    fun clearLocal(){synchronized(lock){prefs.edit().clear().commit()}}
    fun record(state:BoundSnapshot,now:Instant=this.now()){
        // Lock order is always binding -> local history, including confirmed replacement/clear.
        OutageRepository(app).withCurrentBinding(state.generation){recordLegacy(state.snapshot,now)}
    }
    private fun recordLegacy(snapshot:Snapshot,now:Instant){synchronized(lock){
        val queue=snapshot.queueLabel().orEmpty()
        val today=now.atZone(KYIV_ZONE).toLocalDate()
        val history=read().toMutableList()
        val observed=prefs.getStringSet("observed",emptySet()).orEmpty().toMutableSet()
        snapshot.allEvents().filter{it.category==Category.EMERGENCY && (it.end==null || it.end>now)}.forEach{event->
            val revision="${event.start}:${event.end}:${event.status}:${event.plannedEnd}"
            val id="local:"+hash(revision)
            if(id !in observed)history+=OfficialChange(id,event.start.atZone(KYIV_ZONE).toLocalDate(),queue,now,"emergency",
                "Аварійне відключення · ${Presentation.time(event.start)}"+(event.end?.let{"–${Presentation.time(it)}"} ?: " · завершення уточнюється"),
                "https://www.cherkasyoblenergo.com/off",revision)
            observed+=id
        }
        val failed=snapshot.feedFailed || snapshot.failures.isNotEmpty()
        if(failed){
            val since=prefs.getLong("failed_since",0)
            if(since==0L)prefs.edit().putLong("failed_since",now.toEpochMilli()).commit()
            else if(Duration.between(Instant.ofEpochMilli(since),now)>=Duration.ofHours(2)){
                val id="unavailable:$since"
                if(id !in observed)history+=OfficialChange(id,today,queue,now,"unavailable","Оновлення даних тривалий час недоступне. Спробуємо пізніше.",
                    "https://www.cherkasyoblenergo.com/off",id)
                observed+=id
            }
        }else prefs.edit().remove("failed_since").commit()
        prefs.edit().putStringSet("observed",observed.toList().takeLast(300).toSet()).commit()
        save(history)
    }}
    private fun read():List<OfficialChange> {
        val stored=runCatching{
        val array=JSONArray(prefs.getString("history","[]"))
        (0 until minOf(array.length(),100)).map{index->val v=array.getJSONObject(index)
            OfficialChange(v.getString("id"),java.time.LocalDate.parse(v.getString("date")),v.getString("queue"),Instant.parse(v.getString("at")),
                v.getString("kind"),v.getString("title"),v.getString("source"),v.getString("revision"),v.optBoolean("read"))}
        }.getOrDefault(emptyList())
        val recent=InboxHistory.recent(stored,now())
        if(recent!=stored)save(recent)
        return recent
    }
    private fun save(values:List<OfficialChange>){
        val array=JSONArray();InboxHistory.recent(values,now()).forEach{v->array.put(JSONObject().put("id",v.id).put("date",v.date).put("queue",v.queue)
            .put("at",v.at).put("kind",v.kind).put("title",v.title).put("source",v.sourceUrl).put("revision",v.revision).put("read",v.read))}
        prefs.edit().putString("history",array.toString()).commit()
    }
    private fun hash(value:String)=MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString(""){"%02x".format(it)}
    companion object{private val lock=Any()}
}
