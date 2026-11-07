package ua.svitlo.widget.core

import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import kotlin.math.roundToLong

enum class TimelineZoom(val label: String, val minutes: Long?) {
    DAY("Доба", null), SIX_HOURS("6 год", 360), HOUR("1 год", 60)
}

data class TimelineTick(val at: Instant, val label: String?, val major: Boolean)
data class TimelineSegment(val start: Instant, val end: Instant, val category: Category?, val uncertain: Boolean,
    val kind: OutageKind? = null)

/** All geometry uses elapsed time; a Kyiv civil day can contain 23, 24 or 25 hours. */
class TimelineViewport(
    val date: LocalDate,
    val zoom: TimelineZoom = TimelineZoom.DAY,
    windowStart: Instant? = null,
    selectedAt: Instant? = null
) {
    val dayStart: Instant = date.atStartOfDay(KYIV_ZONE).toInstant()
    val dayEnd: Instant = date.plusDays(1).atStartOfDay(KYIV_ZONE).toInstant()
    private val duration = minOf(Duration.between(dayStart, dayEnd), zoom.minutes?.let(Duration::ofMinutes) ?: Duration.between(dayStart, dayEnd))
    val start: Instant = (windowStart ?: dayStart).coerceIn(dayStart, dayEnd.minus(duration))
    val end: Instant = start.plus(duration)
    val selectedAt: Instant = (selectedAt ?: start).coerceIn(dayStart, dayEnd)

    fun fractionAt(at: Instant): Double = (Duration.between(start, at).toMillis().toDouble() / duration.toMillis()).coerceIn(0.0, 1.0)
    fun instantAt(fraction: Double): Instant = start.plusMillis((duration.toMillis() * fraction.coerceIn(0.0, 1.0)).roundToLong())

    fun zoomTo(next: TimelineZoom): TimelineViewport {
        val span = next.minutes?.let(Duration::ofMinutes) ?: Duration.between(dayStart, dayEnd)
        return TimelineViewport(date, next, selectedAt.minus(span.dividedBy(2)), selectedAt)
    }

    fun pan(windows: Double): TimelineViewport {
        val requested = start.plusMillis((duration.toMillis() * windows).roundToLong())
        val next = requested.coerceIn(dayStart, dayEnd.minus(duration))
        return TimelineViewport(date, zoom, next, selectedAt.plus(Duration.between(start, next)).coerceIn(next, next.plus(duration)))
    }

    fun select(at: Instant): TimelineViewport {
        val nextDate = if (at >= dayStart && at < dayEnd) date else at.atZone(KYIV_ZONE).toLocalDate()
        val nextStart = if (nextDate == date && at >= start && at < end) start else at.minus(duration.dividedBy(2))
        return TimelineViewport(nextDate, zoom, nextStart, at)
    }

    fun ticks(): List<TimelineTick> {
        val step = when (zoom) { TimelineZoom.DAY -> 60L; TimelineZoom.SIX_HOURS -> 15L; TimelineZoom.HOUR -> 5L }
        val stepMillis = step * 60_000
        val elapsed = Duration.between(dayStart, start).toMillis()
        var at = dayStart.plusMillis(((elapsed + stepMillis - 1) / stepMillis) * stepMillis)
        val result = mutableListOf<TimelineTick>()
        while (at <= end) {
            val local = at.atZone(KYIV_ZONE)
            val boundary = at == dayEnd
            val major = boundary || when (zoom) {
                TimelineZoom.DAY -> local.hour % 6 == 0
                TimelineZoom.SIX_HOURS -> local.minute == 0
                TimelineZoom.HOUR -> local.minute % 15 == 0
            }
            val label = if (!major) null else if (boundary) {
                if (zoom == TimelineZoom.DAY) "24" else "24:00"
            } else {
                val clock = local.format(DateTimeFormatter.ofPattern(if (zoom == TimelineZoom.DAY) "HH" else "HH:mm"))
                val offsets = KYIV_ZONE.rules.getValidOffsets(local.toLocalDateTime())
                clock + if (offsets.size > 1) if (local.offset == offsets.first()) "¹" else "²" else ""
            }
            result += TimelineTick(at, label, major)
            at = at.plusMillis(stepMillis)
        }
        return result
    }

    /** Split at original event endpoints, never round an outage to a display bin. */
    fun segments(snapshot: Snapshot, now: Instant): List<TimelineSegment> {
        val events = snapshot.allEvents().filter { it.overlaps(start, end) }
        val boundaries = (listOf(start, end, now) + snapshot.emergency.boundaries(start,end,snapshot.plans) + events.flatMap { listOfNotNull(it.start, it.end) })
            .filter { it >= start && it <= end }.distinct().sorted()
        val trustworthy = snapshot.isDayFresh(date,now)
        return boundaries.zipWithNext { from, until ->
            val openFuture=events.any{it.category==Category.EMERGENCY && it.end==null && it.start<until && until>now}
            val active = events.filter { it.overlaps(from, until) && !(it.category==Category.EMERGENCY && it.end==null && from>=now) }
            val event = active.maxByOrNull { it.category.priority }
            val category = event?.category
            val confirmedEmergency=active.any{it.category==Category.EMERGENCY && (it.end!=null || until<=now) &&
                it.sourceCategory !in snapshot.failures && snapshot.categories[it.sourceCategory]?.isFresh(now)==true}
            val uncertain = !confirmedEmergency && (openFuture || snapshot.emergency.uncertain(from,snapshot.plans,now) || !trustworthy || if (active.isEmpty()) {
                !snapshot.knownDay(date,now)
            } else active.any { it.end == null || it.plannedEnd })
            TimelineSegment(from, until, category, uncertain, event?.let(OutageKind::of))
        }
    }

    fun adjacentEvent(snapshot: Snapshot, forward: Boolean): Outage? {
        val events = snapshot.allEvents().sortedWith(compareBy<Outage> { it.start }.thenByDescending { it.category.priority })
        return if (forward) events.firstOrNull { it.start > selectedAt }
        else events.filter { it.start < selectedAt }.maxWithOrNull(compareBy<Outage> { it.start }.thenBy { it.category.priority })
    }

    companion object {
        fun eventsAt(snapshot: Snapshot, at: Instant): List<Outage> = snapshot.allEvents()
            .filter { it.start <= at && (it.end == null || it.end > at) }
            .sortedByDescending { it.category.priority }

        fun describeTime(at: Instant): String {
            val local = at.atZone(KYIV_ZONE)
            val ambiguous = KYIV_ZONE.rules.getValidOffsets(local.toLocalDateTime()).size > 1
            return local.format(DateTimeFormatter.ofPattern("dd.MM · HH:mm")) +
                if (ambiguous) " (UTC${local.offset.id})" else ""
        }
    }
}
