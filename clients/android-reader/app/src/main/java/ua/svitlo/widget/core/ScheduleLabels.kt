package ua.svitlo.widget.core

import java.time.Instant
import java.time.LocalDate
import java.time.Duration
import java.time.format.DateTimeFormatter
import java.util.Locale

enum class OutageKind(val label:String,val category:Category) {
    HOURLY("За графіком",Category.SCHEDULE), PLANNED("Планові роботи",Category.PLANNED),
    UNPLANNED("Позапланове відключення",Category.PLANNED), EMERGENCY("Аварійне відключення",Category.EMERGENCY);
    companion object {
        fun of(event:Outage)=when {
            event.category==Category.EMERGENCY -> EMERGENCY
            event.type.contains("позаплан",ignoreCase=true) -> UNPLANNED
            event.category==Category.PLANNED -> PLANNED
            else -> HOURLY
        }
    }
}

object ScheduleLabels {
    private val months=listOf("січня","лютого","березня","квітня","травня","червня","липня","серпня","вересня","жовтня","листопада","грудня")
    const val INSTALL_URL="https://www.svitlo.guru"
    const val NO_OUTAGES="У вас відключень поки немає"
    fun day(date:LocalDate,capital:Boolean=false):String {
        val month=months[date.monthValue-1]
        return "${date.dayOfMonth} ${if(capital)month.replaceFirstChar{it.uppercaseChar()}else month}"
    }
    fun messageTitle(change:OfficialChange):String=when(change.kind){
        "published" -> "Графік на ${day(change.date)}"
        "updated" -> "Оновлено графік на ${day(change.date)}"
        else -> change.title.replace(change.date.toString(),day(change.date))
    }
    fun messageMeta(change:OfficialChange)="Оновлено · "+change.at.atZone(KYIV_ZONE).format(DateTimeFormatter.ofPattern("dd.MM, HH:mm",Locale.ROOT))
    fun queueLine(queue:String)=when{queue=="*"->"Для Черкаської області";queue.isBlank()->"";else->"Підчерга $queue"}

    /** Fresh event evidence only; an empty source or a regional warning is not an outage. */
    fun confirmedEvents(snapshot:Snapshot,now:Instant):List<Outage> = snapshot.allEvents().filter{event->
        val date=event.start.atZone(KYIV_ZONE).toLocalDate()
        (event.end==null || event.end>event.start) && date !in snapshot.conflictDates &&
            ((event.sourceCategory !in snapshot.failures && snapshot.categories[event.sourceCategory]?.isFresh(now)==true) ||
                (event.category==Category.SCHEDULE && !snapshot.feedFailed && snapshot.plans.any{plan->
                    !plan.cancelled && !plan.uncertain && Duration.between(plan.checkedAt,now) in Duration.ofSeconds(-300)..Duration.ofHours(2) && event in plan.events
                }))
    }
    private fun currentOrNext(events:List<Outage>,now:Instant):Outage? =
        events.filter{it.start<=now && (it.end==null || it.end>now)}
            .maxWithOrNull(compareBy<Outage>{it.category.priority}.thenByDescending{it.start})
            ?: events.filter{it.start>now}.minWithOrNull(compareBy<Outage>{it.start}.thenByDescending{it.category.priority})
    /** The widget supplies only its visible page; stale or unconfirmed events cannot select a color. */
    fun currentOrNextKind(snapshots:List<Snapshot>,now:Instant):OutageKind? =
        currentOrNext(snapshots.flatMap{confirmedEvents(it,now)},now)?.let(OutageKind::of)
    /** Today: active, then nearest future (including tomorrow). Other dates: first event. */
    fun contextKind(date:LocalDate,snapshot:Snapshot,now:Instant):OutageKind? {
        val candidates=confirmedEvents(snapshot,now)
        val selected=if(date==now.atZone(KYIV_ZONE).toLocalDate()) {
            currentOrNext(candidates,now)
        } else {
            val from=date.atStartOfDay(KYIV_ZONE).toInstant();val to=date.plusDays(1).atStartOfDay(KYIV_ZONE).toInstant()
            candidates.filter{it.overlaps(from,to)}.minWithOrNull(compareBy<Outage>{maxOf(it.start,from)}.thenByDescending{it.category.priority})
        }
        return selected?.let(OutageKind::of)
    }

    data class ShareInterval(val start:Instant,val end:Instant,val open:Boolean)
    fun shareIntervals(date:LocalDate,snapshot:Snapshot,now:Instant):List<ShareInterval> {
        val from=date.atStartOfDay(KYIV_ZONE).toInstant();val to=date.plusDays(1).atStartOfDay(KYIV_ZONE).toInstant()
        val intervals=snapshot.allEvents().mapNotNull{event->
            val start=maxOf(event.start,from);val end=minOf(event.end ?: now,to)
            if(start<end)ShareInterval(start,end,event.end==null)else null
        }.sortedBy{it.start}
        val merged=mutableListOf<ShareInterval>()
        for(span in intervals){
            val last=merged.lastOrNull()
            if(last!=null && span.start<=last.end)merged[merged.lastIndex]=ShareInterval(last.start,maxOf(last.end,span.end),last.open || span.open)
            else merged+=span
        }
        return merged
    }
    fun canShare(date:LocalDate,snapshot:Snapshot,now:Instant)=shareIntervals(date,snapshot,now).isNotEmpty()
    fun duration(minutes:Long):String=buildList{
        if(minutes>=60 || minutes==0L)add("${minutes/60} год")
        if(minutes%60!=0L)add("${minutes%60} хв")
    }.joinToString(" ")
    fun shareText(date:LocalDate,snapshot:Snapshot,now:Instant):String? {
        val intervals=shareIntervals(date,snapshot,now)
        if(intervals.isEmpty())return null
        val summary=HourlySchedule.summary(date,snapshot,now)
        val precise=summary.unknownMinutes==0L && !summary.unverifiedOutages && intervals.none{it.open}
        val title="Графік · ${day(date,true)}"+(snapshot.queueLabel()?.let{" · Черга $it"} ?: "")
        val ranges=intervals.joinToString(", "){span->
            DisplaySchedule.clock(span.start)+"–"+when{
                span.open->"час відновлення уточнюється"
                span.end==date.plusDays(1).atStartOfDay(KYIV_ZONE).toInstant()->"24:00"
                else->DisplaySchedule.clock(span.end)
            }
        }
        return "$title\nЗі світлом: ${if(precise)duration(summary.clearMinutes)else"Немає точних даних"}\n"+
            "Без світла: ${if(precise)duration(summary.outageMinutes)else"Немає точних даних"}\n$ranges\n-----------------\nВстановити собі\n$INSTALL_URL"
    }
}
