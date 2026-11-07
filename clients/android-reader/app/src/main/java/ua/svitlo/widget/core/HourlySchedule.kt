package ua.svitlo.widget.core

import java.time.Instant
import java.time.LocalDate
import java.time.Duration
import java.time.format.DateTimeFormatter

data class HourTile(val start:Instant,val end:Instant,val label:String,val segments:List<TimelineSegment>,val clockChange:Boolean=false)
data class DaySummary(val outageMinutes:Long,val clearMinutes:Long,val unknownMinutes:Long,val unverifiedOutages:Boolean=false)
object HourlySchedule {
    fun tiles(date:LocalDate,snapshot:Snapshot,now:Instant):List<HourTile> {
        val viewport=TimelineViewport(date)
        val segments=viewport.segments(snapshot,now)
        val result=mutableListOf<HourTile>()
        var start=viewport.dayStart
        while(start<viewport.dayEnd){
            val end=minOf(start.plusSeconds(3600),viewport.dayEnd)
            val local=start.atZone(KYIV_ZONE)
            val offsets=KYIV_ZONE.rules.getValidOffsets(local.toLocalDateTime())
            val suffix=if(offsets.size>1)if(local.offset==offsets.first())"¹"else"²"else""
            result+=HourTile(start,end,local.format(DateTimeFormatter.ofPattern("HH:mm"))+suffix,
                segments.filter{it.start<end && it.end>start}.map{it.copy(start=maxOf(start,it.start),end=minOf(end,it.end))})
            start=end
        }
        return result
    }
    fun summary(date:LocalDate,snapshot:Snapshot,now:Instant):DaySummary {
        val segments=TimelineViewport(date).segments(snapshot,now)
        // The current instant splits a continuous interval at subsecond precision.
        // Sum exact durations before rounding, or a whole day can lose one minute.
        fun minutes(predicate:(TimelineSegment)->Boolean)=segments.filter(predicate)
            .fold(Duration.ZERO){total,segment->total.plus(Duration.between(segment.start,segment.end))}.toMinutes()
        return DaySummary(minutes{it.category!=null},minutes{it.category==null && !it.uncertain},
            minutes{it.category==null && it.uncertain},segments.any{it.category!=null && it.uncertain})
    }
}
