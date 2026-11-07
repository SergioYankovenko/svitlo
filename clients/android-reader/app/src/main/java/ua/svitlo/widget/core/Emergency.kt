package ua.svitlo.widget.core

import java.time.Instant
import java.time.LocalDate

enum class HourlyValidity(val label:String) {
    ACTIVE("Погодинний графік: діє"), SUSPENDED("Погодинний графік: не діє"),
    UNKNOWN("Погодинний графік: не підтверджено")
}

/** Regional operational bulletin, never an observation of a household's power. */
data class EmergencyNotice(val id:String,val publishedAt:Instant,val effectiveAt:Instant,
    val active:Boolean?,val hourly:HourlyValidity?,val queues:Set<String> = emptySet(),
    val until:Instant?=null,val sourceUrl:String="")

/** active is the last known command, not proof of a current regional emergency.
 * Only confirmedActive may drive the live regional warning. */
data class EmergencyStatus(val active:Boolean=false,val hourly:HourlyValidity=HourlyValidity.ACTIVE,
    val since:Instant?=null,val sourceUrl:String="",val stale:Boolean=false,
    val confirmedActive:Boolean=false)

data class EmergencyPolicy(val notices:List<EmergencyNotice> = emptyList(),val queue:String?=null,
    val checkedAt:Instant?=null,val failed:Boolean=false) {
    private fun applicable()=notices.filter{it.queues.isEmpty() || queue in it.queues}
        .sortedWith(compareBy<EmergencyNotice>{it.effectiveAt}.thenBy{it.publishedAt}.thenBy{it.id})

    fun status(at:Instant,plans:List<PublishedPlan> = emptyList(),now:Instant=at):EmergencyStatus {
        var active=false;var hourly=HourlyValidity.ACTIVE;var since:Instant?=null;var source=""
        var activation:EmergencyNotice?=null
        var validityAt:Instant?=null
        for(notice in applicable().filter{it.effectiveAt<=at}) {
            if(notice.active!=null){
                activation=if(notice.active)notice else null
                active=notice.active && (notice.until==null || at<notice.until)
                since=notice.effectiveAt;source=notice.sourceUrl
                if(notice.active && hourly!=HourlyValidity.SUSPENDED){hourly=HourlyValidity.UNKNOWN;validityAt=notice.effectiveAt}
            }
            if(notice.hourly!=null && (notice.until==null || at<notice.until)){
                hourly=notice.hourly;validityAt=notice.effectiveAt;source=notice.sourceUrl
            }
        }
        // A newer explicit dated publication restores only its own day/queue. Ending an
        // emergency alone cannot restore a schedule which was explicitly suspended.
        val day=at.atZone(KYIV_ZONE).toLocalDate()
        val plan=plans.firstOrNull{it.date==day && (queue==null || it.queue==queue) && !it.cancelled && !it.uncertain}
        if(validityAt!=null && plan!=null && plan.publishedAt>validityAt && plan.publishedAt<=at)hourly=HourlyValidity.ACTIVE
        // Freshness belongs to the last source check, not to the calendar date of
        // the command. Crossing midnight does not issue or revoke a command.
        val stale=failed || checkedAt==null || checkedAt<now.minusSeconds(7200) || checkedAt>now.plusSeconds(300)
        // News is an event log, not a live status endpoint. Fetching an unchanged
        // article again must not extend its evidence window. Keep the last known
        // command for uncertainty/history, without claiming it is still active.
        val confirmationUntil=activation?.let{it.until ?: maxOf(it.publishedAt,it.effectiveAt).plusSeconds(7200)}
        val confirmed=active && !stale && activation!=null &&
            activation.publishedAt<=now.plusSeconds(300) && checkedAt!=null && checkedAt>=activation.publishedAt &&
            confirmationUntil!=null && at<confirmationUntil
        return EmergencyStatus(active,hourly,since,source,stale,confirmed)
    }

    fun uncertain(at:Instant,plans:List<PublishedPlan>,now:Instant=at):Boolean {
        val state=status(at,plans,now)
        // The snapshot handles stale source/address data separately. A failed check
        // must not erase an explicit hourly validity or a newer dated publication.
        return state.hourly==HourlyValidity.SUSPENDED || (state.active && state.hourly==HourlyValidity.UNKNOWN)
    }

    fun boundaries(from:Instant,to:Instant,plans:List<PublishedPlan>):List<Instant> {
        val midnights=generateSequence(from.atZone(KYIV_ZONE).toLocalDate().plusDays(1)){it.plusDays(1)}
            .map{it.atStartOfDay(KYIV_ZONE).toInstant()}.takeWhile{it<to}.toList()
        return (applicable().flatMap{listOfNotNull(it.effectiveAt,it.until)}+plans.map{it.publishedAt}+midnights)
            .filter{it>from && it<to}
    }

    /** Split at the actual command time, retaining the earlier portion of the day. */
    fun filterHourly(events:List<Outage>,plans:List<PublishedPlan>):List<Outage> = events.flatMap{event->
        if(event.category!=Category.SCHEDULE)listOf(event) else {
            val end=event.end ?: event.start.atZone(KYIV_ZONE).toLocalDate().plusDays(1).atStartOfDay(KYIV_ZONE).toInstant()
            (listOf(event.start,end)+boundaries(event.start,end,plans)).distinct().sorted().zipWithNext()
                .filter{(start,_)->status(start,plans).hourly!=HourlyValidity.SUSPENDED}
                .map{(start,until)->event.copy(start=start,end=if(event.end==null && until==end)null else until)}
        }
    }

    fun affects(date:LocalDate,plans:List<PublishedPlan>,now:Instant=Instant.now()):Boolean {
        val from=date.atStartOfDay(KYIV_ZONE).toInstant();val to=date.plusDays(1).atStartOfDay(KYIV_ZONE).toInstant()
        return (listOf(from)+boundaries(from,to,plans)).any{uncertain(it,plans,now)}
    }
}
