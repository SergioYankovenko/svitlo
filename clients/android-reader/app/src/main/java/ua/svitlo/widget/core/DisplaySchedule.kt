package ua.svitlo.widget.core

import java.time.Instant
import java.time.LocalDate
import java.time.format.DateTimeFormatter

/** A lossy, explicitly labelled visual projection. Never used by reminders or totals. */
object DisplaySchedule {
    fun rounded(at:Instant):Instant = Instant.ofEpochSecond(Math.floorDiv(at.epochSecond+900,1800)*1800)
    fun tiles(date:LocalDate,snapshot:Snapshot,now:Instant):List<HourTile> {
        val projected=snapshot.allEvents().mapNotNull { event ->
            val start=rounded(event.start);val end=event.end?.let(::rounded)
            if(end!=null && end<=start)null else event.copy(start=start,end=end)
        }
        val visual=snapshot.copy(effectiveEvents=projected)
        val raw=HourlySchedule.tiles(date,visual,now).map { hour ->
            val halves=(0..1).map { index ->
                val from=hour.start.plusSeconds(index*1800L);val to=minOf(from.plusSeconds(1800),hour.end)
                val parts=hour.segments.filter{it.start<to && it.end>from}
                val dominant=parts.filter{it.category!=null}.maxByOrNull{it.category!!.priority}
                TimelineSegment(from,to,dominant?.category,parts.isEmpty() || parts.any{it.uncertain},dominant?.kind)
            }
            hour.copy(label=clock(hour.start),segments=halves)
        }
        val result=mutableListOf<HourTile>();var index=0
        while(index<raw.size){
            val hour=raw[index];val next=raw.getOrNull(index+1)
            if(next!=null && hour.label==next.label){
                result+=hour.copy(end=next.end,segments=hour.segments+next.segments,clockChange=true);index+=2
            }else{result+=hour;index++}
        }
        return result
    }
    fun labels(hour:HourTile):Pair<String,String> {
        if(hour.clockChange)return hour.label to clock(hour.end)
        val outages=hour.segments.filter{it.category!=null}
        return if(outages.size==1)clock(outages.single().start) to clockEnd(outages.single().end,hour.start)
        else hour.label to clockEnd(hour.end,hour.start)
    }
    fun clock(at:Instant):String=at.atZone(KYIV_ZONE).format(DateTimeFormatter.ofPattern("HH:mm"))
    private fun clockEnd(at:Instant,start:Instant):String=
        if(at.atZone(KYIV_ZONE).toLocalDate()>start.atZone(KYIV_ZONE).toLocalDate() && clock(at)=="00:00")"24:00"else clock(at)
}
