package ua.svitlo.widget.core

import java.time.Duration
import java.time.Instant
import java.time.LocalDate

data class TimeBin(
    val start: Instant,
    val end: Instant,
    val category: Category?,
    val uncertain: Boolean,
    val kind: OutageKind? = null
)

object Timeline {
    /**
     * Five-minute real-time bins: 276/288/300 bins on 23/24/25-hour days.
     * category == null means no published event, never a measurement of electricity supply.
     * Tomorrow's empty intervals always stay uncertain: a schedule may be published later.
     */
    fun bins(
        date: LocalDate,
        snapshot: Snapshot,
        now: Instant,
        stepMinutes: Int = 5
    ): List<TimeBin> {
        require(stepMinutes in 1..60) { "Крок шкали має бути від 1 до 60 хвилин" }
        val from = date.atStartOfDay(KYIV_ZONE).toInstant()
        val until = date.plusDays(1).atStartOfDay(KYIV_ZONE).toInstant()
        val segments=TimelineViewport(date).segments(snapshot,now)
        val result=ArrayList<TimeBin>()
        var cursor=from
        while(cursor<until){
            val next=minOf(cursor.plus(Duration.ofMinutes(stepMinutes.toLong())),until)
            val parts=segments.filter{it.start<next && it.end>cursor}
            val dominant=parts.filter{it.category!=null}.maxByOrNull{it.category!!.priority}
            result+=TimeBin(cursor,next,dominant?.category,parts.any{it.uncertain},dominant?.kind)
            cursor=next
        }
        return result
    }

    /** Active outages take precedence over future ones; emergency has the highest priority. */
    fun nextOutage(snapshot: Snapshot, now: Instant): Outage? {
        val relevant = snapshot.allEvents().filter { it.end == null || it.end > now }
        val active = relevant.filter { it.start <= now }
        return active.maxWithOrNull(compareBy<Outage> { it.category.priority }.thenByDescending { it.start })
            ?: relevant.minWithOrNull(compareBy<Outage> { it.start }.thenByDescending { it.category.priority })
    }
}
