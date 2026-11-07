package ua.svitlo.widget

import ua.svitlo.widget.core.Snapshot
import java.time.LocalDate

object HomeSchedule {
    fun canMoveDay(from:LocalDate,to:LocalDate,snapshot:Snapshot,today:LocalDate,explicitHistory:Boolean=false):Boolean {
        if(kotlin.math.abs(java.time.temporal.ChronoUnit.DAYS.between(from,to))!=1L || !selectable(to,snapshot,today))return false
        val current=week(today).first();val target=week(to).first()
        if(target<current && !explicitHistory)return false
        if(target>current && (target!=current.plusWeeks(1) || !published(current.plusWeeks(1),snapshot)))return false
        return true
    }
    fun week(date:LocalDate):List<LocalDate> {
        val monday=date.minusDays(date.dayOfWeek.value-1L)
        return (0L..6L).map(monday::plusDays)
    }
    fun swipe(date:LocalDate,forward:Boolean,snapshot:Snapshot,today:LocalDate):LocalDate? {
        val current=week(today).first();val shown=week(date).first()
        return if(forward && shown==current && published(current.plusWeeks(1),snapshot))current.plusWeeks(1)
            else if(!forward && shown==current.plusWeeks(1))today else null
    }
    fun normalize(date:LocalDate,today:LocalDate,explicitDate:Boolean):LocalDate =
        if(!explicitDate && week(date).first()<week(today).first())today else date
    /** Publication existence is distinct from freshness and from an empty outage list. */
    fun selectable(date:LocalDate,snapshot:Snapshot,today:LocalDate=LocalDate.now(ua.svitlo.widget.core.KYIV_ZONE)):Boolean =
        date==today || published(date,snapshot)
    fun published(date:LocalDate,snapshot:Snapshot):Boolean = snapshot.plan(date)!=null || snapshot.allEvents().any{
        it.category==ua.svitlo.widget.core.Category.SCHEDULE && (it.end!=null || it.start.atZone(ua.svitlo.widget.core.KYIV_ZONE).toLocalDate()==date) && it.overlaps(date.atStartOfDay(ua.svitlo.widget.core.KYIV_ZONE).toInstant(),date.plusDays(1).atStartOfDay(ua.svitlo.widget.core.KYIV_ZONE).toInstant())
    }
}
