package ua.svitlo.widget.next

import org.json.JSONArray
import org.json.JSONObject
import java.time.*
import java.time.format.DateTimeFormatter

val NEXT_ZONE:ZoneId=runCatching{ZoneId.of("Europe/Kyiv")}.getOrElse{ZoneId.of("Europe/Kiev")}
/** PostgreSQL wire timestamps include offsets and microseconds. API26's
 * ISO_INSTANT parser is narrower than modern JDKs; parse the explicit offset. */
fun wireInstant(value:String):Instant {require(value.length in 20..64);return OffsetDateTime.parse(value,DateTimeFormatter.ISO_OFFSET_DATE_TIME).toInstant()}
enum class Kind(val wire:String,val title:String,val priority:Int){
    HOURLY("hourly","За графіком",1),PLANNED("planned","Планові роботи",2),UNPLANNED("unplanned","Позапланове відключення",2),EMERGENCY("emergency","Аварійне відключення",3);
    companion object {fun parse(value:String)=entries.singleOrNull{it.wire==value} ?: error("Невідомий тип графіка")}
}
enum class Publication {published,not_published,excluded,unknown,stale,suspended,unsupported}
data class Span(val start:Instant,val end:Instant?,val kind:Kind){fun overlaps(a:Instant,b:Instant)=start<b && (end==null || end>a)}
data class Part(val start:Instant,val end:Instant,val kind:Kind?,val unknown:Boolean)
data class DisplayHour(val start:Instant,val end:Instant,val parts:List<Part>,val repeated:Boolean=false){val label:String get()=start.atZone(NEXT_ZONE).format(DateTimeFormatter.ofPattern("HH:mm"))}
data class Totals(val off:Long,val on:Long,val unknown:Long)
data class DayPlan(val date:LocalDate,val events:List<Span>,val known:Boolean,val state:String,val fresh:Boolean,val publishedEvents:List<Span>?=null,val publicationAvailable:Boolean=known,val applicability:String=if(known)"reported"else"unconfirmed"){
    val timerAllowed:Boolean get()=publicationAvailable&&applicability=="reported"
    val planEvents:List<Span> get()=publishedEvents ?:events
    val start:Instant get()=date.atStartOfDay(NEXT_ZONE).toInstant()
    val end:Instant get()=date.plusDays(1).atStartOfDay(NEXT_ZONE).toInstant()
    fun parts(rounded:Boolean=false):List<Part>{
        val projected=planEvents.map{if(!rounded)it else it.copy(start=roundHalf(it.start),end=it.end?.let(::roundHalf))}.filter{it.end==null || it.start<it.end}
        val bounds=(listOf(start,end)+projected.flatMap{listOfNotNull(it.start,it.end)}).filter{it>=start && it<=end}.distinct().sorted()
        return bounds.zipWithNext{a,b->val active=projected.filter{it.overlaps(a,b)};Part(a,b,active.maxByOrNull{it.kind.priority}?.kind,!publicationAvailable || active.any{it.end==null})}
    }
    fun totals(rounded:Boolean=true):Totals {var off=0L;var on=0L;var unknown=0L
        if(!timerAllowed)return Totals(0,0,Duration.between(start,end).toMinutes())
        for(p in parts(rounded)){val n=Duration.between(p.start,p.end).toMillis();if(p.unknown)unknown+=n else if(p.kind!=null)off+=n else on+=n}
        return Totals(off/60000,on/60000,unknown/60000)
    }
    fun hours():List<DisplayHour>{
        val visual=parts(true);val raw=mutableListOf<DisplayHour>();var a=start
        while(a<end){val b=minOf(a.plusSeconds(3600),end);val pieces=(0..1).map{half->val x=a.plusSeconds(half*1800L);val y=minOf(x.plusSeconds(1800),b);val overlaps=visual.filter{it.start<y && it.end>x};Part(x,y,overlaps.filter{it.kind!=null}.maxByOrNull{it.kind!!.priority}?.kind,overlaps.isEmpty()||overlaps.any{it.unknown})};raw+=DisplayHour(a,b,pieces);a=b}
        val merged=mutableListOf<DisplayHour>();var i=0
        while(i<raw.size){val h=raw[i];val next=raw.getOrNull(i+1);if(next!=null && h.label==next.label){merged+=h.copy(end=next.end,parts=h.parts+next.parts,repeated=true);i+=2}else{merged+=h;i++}}
        return merged
    }
    fun eventAt(now:Instant)=events.takeIf{timerAllowed}?.filter{it.start<=now && (it.end==null || it.end>now)}?.maxByOrNull{it.kind.priority}
    fun next(now:Instant)=events.takeIf{timerAllowed}?.filter{it.start>now}?.minWithOrNull(compareBy<Span>{it.start}.thenByDescending{it.kind.priority})
    companion object {fun roundHalf(at:Instant)=Instant.ofEpochSecond(Math.floorDiv(at.epochSecond+900,1800)*1800)}
}
data class CatalogItem(val id:String,val label:String,val operatorId:String="",val city:String="",val street:String="",val house:String="",val district:String?=null,val synthetic:Boolean=false){
    companion object {fun parse(o:JSONObject):CatalogItem {val id=o.getString("id");require(UUID_RE.matches(id));val label=o.getString("label");require(label.isNotBlank()&&label.length<=300);val metadata=o.optJSONObject("district");val district=metadata?.takeIf{it.optBoolean("verified")&&it.optString("source").isNotBlank()}?.optString("name")?.takeIf{it.isNotBlank()&&it.length<=120};return CatalogItem(id,label,o.optString("operatorId"),o.optString("city"),o.optString("street"),o.optString("house"),district,o.optBoolean("synthetic"))}}
}
val UUID_RE=Regex("[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}")
data class Line(val id:String,val label:String,val group:String?,val categories:Map<Kind,JSONObject>)
class Universal private constructor(val json:JSONObject,val lines:List<Line>){
    val addressId:String=json.getString("addressId")
    val revision:String=json.getString("revision")
    val synthetic:Boolean=json.optBoolean("synthetic")
    fun line(id:String?):Line?=if(id!=null)lines.find{it.id==id}else lines.singleOrNull().takeIf{json.getJSONObject("resolution").getBoolean("complete")}
    fun day(date:LocalDate,lineId:String?,now:Instant=Instant.now()):DayPlan {
        val selected=line(lineId);val resolution=json.getJSONObject("resolution");val fresh=wireFresh(json,now)
        val mapping=selected!=null && resolution.getBoolean("complete") && (resolution.getString("state") in setOf("resolved","excluded") || resolution.getString("state")=="ambiguous" && lineId!=null)
        // Degraded applicability does not invalidate an independently verified
        // dated publication. Disabled/unsupported sources still fail closed.
        val referenceEligible=mapping&&fresh&&json.getString("supportState") in setOf("available","degraded")
        var known=mapping&&fresh&&json.getString("supportState")=="available"
        val events=mutableListOf<Span>();val states=mutableListOf<String>();val confirmedPositive=mutableListOf<Span>()
        var publication:JSONObject?=null;var application:JSONObject?=null;var hourlyFresh=false
        if(selected!=null)for((kind,c)in selected.categories){val d=c.getJSONArray("days").objects().find{it.getString("date")==date.toString()};val state=d?.getString("state") ?: "not_published";states+=state
            val categoryFresh=wireFresh(c,now)
            if(state !in setOf("published","excluded")||!categoryFresh||c.optString("evidenceMode")=="positive_only")known=false
            if(kind==Kind.HOURLY){publication=d?.optJSONObject("publication");application=d?.optJSONObject("applicability");hourlyFresh=categoryFresh}
            d?.getJSONArray("intervals")?.objects()?.forEach{e->val span=Span(Instant.ofEpochMilli(e.getLong("start")),if(e.isNull("end"))null else Instant.ofEpochMilli(e.getLong("end")),kind);if(span.overlaps(date.atStartOfDay(NEXT_ZONE).toInstant(),date.plusDays(1).atStartOfDay(NEXT_ZONE).toInstant())){events+=span;if(kind!=Kind.HOURLY&&state=="published"&&categoryFresh)confirmedPositive+=span}}
        }
        val pub=publication
        val published=pub!=null&&referenceEligible&&hourlyFresh&&pub.getString("state")=="published"&&wireFresh(pub,now)
        val reference=pub?.getJSONArray("intervals")?.objects()?.map{Span(Instant.ofEpochMilli(it.getLong("start")),Instant.ofEpochMilli(it.getLong("end")),Kind.HOURLY)}?.plus(confirmedPositive)
        val applicationState=application?.getString("state")
        // Only a matching effective table may drive timers. A contradictory
        // packet remains a reference, never a manufactured clear day.
        val hourly=selected?.categories?.get(Kind.HOURLY)?.getJSONArray("days")?.objects()?.find{it.getString("date")==date.toString()}
        val effectiveMatches=pub!=null&&hourly?.optString("state")=="published"&&intervalKey(pub.getJSONArray("intervals"))==intervalKey(hourly.getJSONArray("intervals"))
        val applicability=if(applicationState=="reported"&&!effectiveMatches)"unconfirmed"else applicationState ?:if(known)"reported"else"unconfirmed"
        val state=when{selected==null->"line_unknown";!fresh->"stale";"suspended" in states||published&&applicability=="suspended"->"suspended";published&&applicability!="reported"->applicability;known->"ready";published->"reference";json.getString("supportState")!="available"->"source_unavailable";"not_published" in states && states.none{it=="published"}->"not_published";else->"unknown"}
        // A positive-only feed never proves a clear whole day. Its uncertainty
        // is retained in known, independently of the published reference table.
        val effective=if(pub==null)events else events.filter{it.kind==Kind.HOURLY}+confirmedPositive
        return DayPlan(date,effective,known,state,fresh,reference,if(pub==null)known else published,applicability)
    }
    companion object {fun parse(input:JSONObject):Universal {
        require(input.toString().toByteArray().size<=2_000_000);require(strictLong(input,"schemaVersion")==1L && input.getString("timeZone")=="Europe/Kyiv")
        require(UUID_RE.matches(input.getString("addressId")));require(input.getString("revision").length in 1..128)
        require(input.getString("supportState") in setOf("available","degraded","disabled","unsupported"))
        val from=LocalDate.parse(input.getJSONObject("coverage").getString("fromDate"));val to=LocalDate.parse(input.getJSONObject("coverage").getString("toDate"));require(to>=from && Duration.between(from.atStartOfDay(),to.atStartOfDay()).toDays()<=13)
        val r=input.getJSONObject("resolution");require(r.getString("state") in setOf("resolved","excluded","ambiguous","unknown"));require(r.get("complete") is Boolean)
        for(k in listOf("checkedAt","freshUntil","refreshAfter"))require(strictLong(input,k)>=0)
        require(input.isNull("sourceUpdatedAt")||strictLong(input,"sourceUpdatedAt")>=0)
        val notices=input.getJSONArray("notices").objects();require(notices.size<=100 && notices.all{it.getString("kind") in setOf("regional_emergency","maintenance")})
        val rows=input.getJSONArray("lines").objects();require(rows.size<=32 && rows.map{it.getString("id")}.distinct().size==rows.size)
        val lines=rows.map{o->val ids=o.getJSONArray("supportedCategories").let{a->(0 until a.length()).map{Kind.parse(a.getString(it))}};require(ids.distinct().size==ids.size);val categories=ids.associateWith{k->o.getJSONObject("categories").getJSONObject(k.wire).also{c->
            if(c.has("evidenceMode"))require(c.getString("evidenceMode")==if(k==Kind.HOURLY)"daily_schedule"else"positive_only")
            require(strictLong(c,"checkedAt")>=0 && strictLong(c,"freshUntil")>=0);require(c.isNull("sourceUpdatedAt")||strictLong(c,"sourceUpdatedAt")>=0)
            val days=c.getJSONArray("days").objects();require(days.size<=14 && days.map{it.getString("date")}.distinct().size==days.size)
            days.forEach{d->val date=LocalDate.parse(d.getString("date"));require(date>=from && date<=to);Publication.valueOf(d.getString("state"));val intervals=d.getJSONArray("intervals").objects();require(intervals.size<=2000);intervals.forEach{e->require(strictLong(e,"start")>=0);require(e.isNull("end")||strictLong(e,"end")>strictLong(e,"start"))}
                if(d.has("publication")||d.has("applicability")){require(k==Kind.HOURLY);val p=d.getJSONObject("publication");val a=d.getJSONObject("applicability");require(p.getString("state") in setOf("published","not_published","unknown"));require(a.getString("state") in setOf("reported","suspended","conflict","unconfirmed"));require(a.isNull("reason")||a.getString("reason").length<=160);for(key in listOf("checkedAt","freshUntil"))require(strictLong(p,key)>=0);require(p.isNull("sourceUpdatedAt")||strictLong(p,"sourceUpdatedAt")>=0);val published=p.getJSONArray("intervals").objects();require(published.size<=2000);val begin=date.atStartOfDay(NEXT_ZONE).toInstant().toEpochMilli();val finish=date.plusDays(1).atStartOfDay(NEXT_ZONE).toInstant().toEpochMilli();published.forEach{e->require(strictLong(e,"start")>=0&&strictLong(e,"end")>strictLong(e,"start"));require(e.getLong("start")<finish&&e.getLong("end")>begin)};if(p.getString("state")!="published")require(published.isEmpty())}
            }
        }};val group=if(o.isNull("groupCode"))null else o.getString("groupCode").also{require(it.length<=80)};Line(o.getString("id"),o.getString("label"),group,categories)}
        return Universal(JSONObject(input.toString()),lines)
    }}
}
fun JSONArray.objects():List<JSONObject> =(0 until length()).map{getJSONObject(it)}
private fun intervalKey(rows:JSONArray)=rows.objects().map{it.getLong("start") to if(it.isNull("end"))null else it.getLong("end")}.sortedBy{it.first}
private fun wireFresh(value:JSONObject,now:Instant):Boolean {val checked=value.getLong("checkedAt");val until=value.getLong("freshUntil");val limit=now.plusSeconds(300).toEpochMilli();return until>now.toEpochMilli()&&until>=checked&&checked<=limit&&(value.isNull("sourceUpdatedAt")||value.getLong("sourceUpdatedAt")<=limit)}
fun strictLong(o:JSONObject,key:String):Long {val value=o.get(key);require(value is Number);val number=value.toDouble();require(number.isFinite()&&number==value.toLong().toDouble()&&kotlin.math.abs(number)<=9007199254740991.0);return value.toLong()}
fun durationText(minutes:Long):String {val h=minutes/60;val m=minutes%60;return listOfNotNull(if(h>0)"$h год"else null,if(m>0)"$m хв"else null).joinToString(" ").ifEmpty{"0 год"}}
fun clock(at:Instant)=at.atZone(NEXT_ZONE).format(DateTimeFormatter.ofPattern("HH:mm"))
