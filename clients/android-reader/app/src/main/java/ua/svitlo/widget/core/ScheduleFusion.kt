package ua.svitlo.widget.core

import java.time.Instant
import java.time.LocalDate

data class PublishedPlan(val date:LocalDate,val queue:String,val events:List<Outage>,
    val publishedAt:Instant,val checkedAt:Instant,val sourceUrl:String,val revision:String,
    val cancelled:Boolean=false,val uncertain:Boolean=false)

object ScheduleFusion {
    fun merge(address:Snapshot,plans:List<PublishedPlan>,now:Instant,feedFailed:Boolean=false):Snapshot {
        if(plans.isEmpty())return address.copy(feedFailed=feedFailed)
        val selected=plans.groupBy{it.date}.mapValues{(_,values)->values.maxBy{it.publishedAt}}.values.toList()
        // GAV is returned in selector 2 too; only GPV may be replaced by a GPV publication.
        val hourly=address.categories[Category.SCHEDULE]?.events.orEmpty().filter{it.category==Category.SCHEDULE}
        val conflicts=selected.filter{plan->
            if(plan.cancelled || plan.uncertain)return@filter false
            val from=plan.date.atStartOfDay(KYIV_ZONE).toInstant()
            val until=plan.date.plusDays(1).atStartOfDay(KYIV_ZONE).toInstant()
            val compareFrom=maxOf(from,now)
            if(compareFrom>=until)return@filter false
            val expected=ranges(plan.events,compareFrom,until)
            // An address API may contain only a subset of future GPV events.
            // Historical actual end minutes are not an alternative future plan.
            val relevant=hourly.filter{it.overlaps(compareFrom,until)}
            relevant.any{it.end==null} || ranges(relevant,compareFrom,until).any{it !in expected}
        }.map{it.date}.toSet()
        var remaining=hourly
        for(plan in selected){
            val from=plan.date.atStartOfDay(KYIV_ZONE).toInstant()
            val until=plan.date.plusDays(1).atStartOfDay(KYIV_ZONE).toInstant()
            remaining=remaining.flatMap{event->
                val source=address.categories[Category.SCHEDULE]
                // A formerly planned interval can disappear in a correction, then look past
                // by the time a later revision arrives. Only a source that explicitly observed
                // its completion may supplement the publication with historical actual times.
                val completedBeforeRevision=event.end?.let{end->
                    end<=plan.publishedAt && end<=now && event.status.equals("Завершено",ignoreCase=true) &&
                        source?.sourceUpdatedAt?.let{it>=end && it<=now.plusSeconds(300)}==true &&
                        source.fetchedAt>=end && source.fetchedAt<=now.plusSeconds(300)
                }==true &&
                    plan.events.none{it.overlaps(event.start,event.end!!)}
                if(!event.overlaps(from,until) || completedBeforeRevision)listOf(event) else buildList{
                    if(event.start<from)add(event.copy(end=from))
                    if(event.end==null || event.end>until)add(event.copy(start=until))
                }
            }
        }
        val published=selected.flatMap{plan->
            if(!plan.cancelled && plan.date !in conflicts)plan.events
            else plan.events.filter{it.end?.let{end->end<=plan.publishedAt && end<=now}==true}
        }
        val individual=address.categories.values.flatMap{it.events}.filter{it.category!=Category.SCHEDULE}
        return address.copy(plans=selected,feedFailed=feedFailed,conflictDates=conflicts,
            effectiveEvents=(individual+remaining+published).distinct().sortedBy{it.start})
    }

    private fun ranges(events:List<Outage>,from:Instant,until:Instant):List<Pair<Instant,Instant>> {
        // Normalize comparison only; keep all original event times for the effective plan.
        val sorted=events.filter{it.end!=null}
            .map{maxOf(DisplaySchedule.rounded(it.start),from) to minOf(DisplaySchedule.rounded(it.end!!),until)}
            .filter{it.first<it.second}.sortedBy{it.first}
        val result=mutableListOf<Pair<Instant,Instant>>()
        for(range in sorted){
            val last=result.lastOrNull()
            if(last!=null && range.first<=last.second)result[result.lastIndex]=last.first to maxOf(last.second,range.second)
            else result+=range
        }
        return result
    }
}
