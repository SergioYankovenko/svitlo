package ua.svitlo.widget.core

import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/** Ukrainian civil time, including daylight saving changes. */
val KYIV_ZONE: ZoneId = runCatching { ZoneId.of("Europe/Kyiv") }
    .getOrElse { ZoneId.of("Europe/Kiev") }

enum class Category(val selector: Int, val label: String, val priority: Int) {
    PLANNED(0, "Планові", 2),
    EMERGENCY(1, "Аварійні", 3),
    SCHEDULE(2, "Графіки", 1)
}

data class Outage(
    val category: Category,
    val start: Instant,
    val end: Instant?,
    val plannedEnd: Boolean,
    val status: String,
    val type: String,
    val sourceCategory: Category = category
) {
    fun overlaps(from: Instant, until: Instant): Boolean =
        start < until && (end == null || end > from)
}

data class CategorySnapshot(
    val category: Category,
    val sourceUpdatedAt: Instant?,
    val fetchedAt: Instant,
    val events: List<Outage>,
    val queueInfo: List<String>
) {
    /** A recent successful verification can confirm unchanged older source data. */
    fun isFresh(now: Instant, maxAge: Duration = Duration.ofHours(2)): Boolean =
        sourceUpdatedAt != null && sourceUpdatedAt <= now.plusSeconds(300) &&
            freshTimestamp(fetchedAt, now, maxAge)
}

data class Snapshot(
    val categories: Map<Category, CategorySnapshot>,
    val failures: Set<Category> = emptySet(),
    val plans: List<PublishedPlan> = emptyList(),
    val feedFailed: Boolean = false,
    val conflictDates: Set<LocalDate> = emptySet(),
    val effectiveEvents: List<Outage>? = null,
    val emergency: EmergencyPolicy = EmergencyPolicy(),
    val registryQueue: String? = null,
    val queueProvenance: String? = null,
    val hourlyExcluded: Boolean = false
) {
    fun isCompleteAndFresh(now: Instant): Boolean {
        if(feedFailed || conflictDates.isNotEmpty() || emergency.uncertain(now,plans))return false
        if(plans.isEmpty())return (queueLabel()!=null || explicitHourlyExclusion()) && failures.isEmpty() && Category.entries.all{categories[it]?.isFresh(now)==true}
        val individualFresh=Category.entries.filter{it!=Category.SCHEDULE}.all{it !in failures && categories[it]?.isFresh(now)==true}
        val today=now.atZone(KYIV_ZONE).toLocalDate()
        val verifiedDates=plans.filter{!it.cancelled && !it.uncertain && freshTimestamp(it.checkedAt,now,Duration.ofHours(2))}.map{it.date}.toSet()
        val publicCoversUsedIntervals=verifiedDates.any{it>=today} && allEvents().filter{
            it.category==Category.SCHEDULE && (it.end==null || it.end>now)
        }.all{event->
            val end=event.end ?: return@all false
            var date=maxOf(event.start,now).atZone(KYIV_ZONE).toLocalDate()
            val last=end.minusNanos(1).atZone(KYIV_ZONE).toLocalDate()
            var covered=true
            while(date<=last){if(date !in verifiedDates){covered=false;break};date=date.plusDays(1)}
            covered
        }
        val hourlyFresh=(Category.SCHEDULE !in failures && categories[Category.SCHEDULE]?.isFresh(now)==true) || publicCoversUsedIntervals
        val addressEventsFresh=allEvents().filter{it.category!=Category.SCHEDULE && (it.end==null || it.end>now)}
            .all{it.sourceCategory !in failures && categories[it.sourceCategory]?.isFresh(now)==true}
        return individualFresh && hourlyFresh && addressEventsFresh && plans.filter{it.date>=today}.none{it.uncertain || !freshTimestamp(it.checkedAt,now,Duration.ofHours(2))}
    }

    fun plan(date:LocalDate):PublishedPlan? = plans.firstOrNull{it.date==date}
    fun checkedEmptyToday(date:LocalDate,now:Instant):Boolean =
        date==now.atZone(KYIV_ZONE).toLocalDate() && plan(date)==null && isCompleteAndFresh(now) &&
            allEvents().none{it.overlaps(date.atStartOfDay(KYIV_ZONE).toInstant(),date.plusDays(1).atStartOfDay(KYIV_ZONE).toInstant())}
    fun addressScheduleDay(date:LocalDate,now:Instant):Boolean {
        if(queueLabel()==null || plan(date)!=null || !isCompleteAndFresh(now))return false
        val from=date.atStartOfDay(KYIV_ZONE).toInstant();val to=date.plusDays(1).atStartOfDay(KYIV_ZONE).toInstant()
        val events=categories[Category.SCHEDULE]?.events.orEmpty().filter{it.overlaps(from,to)}
        return events.isNotEmpty() && events.all{it.end!=null && !it.plannedEnd}
    }
    fun knownDay(date:LocalDate,now:Instant=Instant.now()):Boolean = !emergency.affects(date,plans,now) &&
        ((explicitHourlyExclusion() && date==now.atZone(KYIV_ZONE).toLocalDate() && isCompleteAndFresh(now)) || checkedEmptyToday(date,now) || addressScheduleDay(date,now) || plan(date)?.let{
        !it.cancelled && !it.uncertain && date !in conflictDates && freshTimestamp(it.checkedAt,now,Duration.ofHours(2))}==true)
    fun isDayFresh(date:LocalDate,now:Instant):Boolean = isCompleteAndFresh(now) && plan(date)?.let{
        !it.uncertain && freshTimestamp(it.checkedAt,now,Duration.ofHours(2))}!=false

    fun openEmergency(now:Instant):Boolean = allEvents().any{it.category==Category.EMERGENCY && it.end==null && it.start<=now}

    fun allEvents(): List<Outage> = (effectiveEvents ?: categories.values.flatMap { it.events })
        .distinct().sortedBy { it.start }

    /** A directory negative cannot overrule explicit or ambiguous address queue evidence. */
    fun explicitHourlyExclusion():Boolean = hourlyExcluded && registryQueue==null && addressQueues().isEmpty()

    /** Only a fresh explicit hourly statement counts; empty/missing/other-category queues do not. */
    fun apiHourlyExclusion(now:Instant):Boolean {
        val hourly=categories[Category.SCHEDULE] ?: return false
        if(Category.SCHEDULE in failures || !hourly.isFresh(now) || addressQueues().isNotEmpty())return false
        return hourly.queueInfo.any{raw->
            val text=raw.replace(Regex("<[^>]*>")," ").replace("&nbsp;"," ").replace("&#160;"," ")
            text.contains("погодин",ignoreCase=true) && Regex("(?:в|у)\\s+чергу\\s+не\\s+включено\\b",RegexOption.IGNORE_CASE).containsMatchIn(text)
        }
    }

    private fun addressQueues():List<String> {
        val queue=Regex("(\\d+)\\s*черга\\s*(\\d+)\\s*підчерга",RegexOption.IGNORE_CASE)
        return categories[Category.SCHEDULE]?.queueInfo.orEmpty().filter{it.contains("погодин",ignoreCase=true)}
            .flatMap{queue.findAll(it).toList()}.map{"${it.groupValues[1]}.${it.groupValues[2]}"}.distinct()
    }

    fun queueLabel(): String? {
        val info=categories[Category.SCHEDULE]?.queueInfo.orEmpty()
        val matches=addressQueues()
        return if(matches.isEmpty() && info.isEmpty())registryQueue else matches.singleOrNull()
    }
}

object AccountNumber {
    fun normalize(value: String): String = value.filterNot { it.isWhitespace() }
    fun isValid(value: String): Boolean = Regex("[0-9]{11}").matches(normalize(value))
    fun masked(value: String): String = "•••••••" + normalize(value).takeLast(4)
}

private fun freshTimestamp(value: Instant, now: Instant, maxAge: Duration): Boolean =
    value <= now.plusSeconds(300) && value >= now.minus(maxAge)
