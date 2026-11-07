package ua.svitlo.widget

import ua.svitlo.widget.core.Category
import ua.svitlo.widget.core.KYIV_ZONE
import ua.svitlo.widget.core.Outage
import ua.svitlo.widget.core.ScheduleLabels
import ua.svitlo.widget.core.Snapshot
import ua.svitlo.widget.core.Timeline
import java.time.Duration
import java.time.Instant
import java.time.format.DateTimeFormatter

object Presentation {
    enum class WidgetSignal { POWER, PLANNED, EMERGENCY, UNKNOWN }

    /** Actual-now countdown, separate from the timeline's selected time. */
    fun remainingTime(snapshot: Snapshot, now: Instant): String {
        if(snapshot.openEmergency(now))return "Час відновлення уточнюється"
        if(snapshot.emergency.uncertain(now,snapshot.plans))return "Час відновлення уточнюється"
        if (!snapshot.isCompleteAndFresh(now)) return "Оновіть графік — залишок часу невідомий"
        val restoration = connectedRestoration(snapshot.allEvents(), now)
        if (restoration != null) {
            val end = restoration.end ?: return "Час увімкнення невідомий"
            if(snapshot.emergency.uncertain(end,snapshot.plans,now))return "Час відновлення уточнюється"
            return "До ввімкнення залишилося ${if (restoration.approximate) "≈ " else ""}${countdown(Duration.between(now, end))}"
        }
        val next = Timeline.nextOutage(snapshot, now)
        return if (next != null) "До відключення залишилося ${countdown(Duration.between(now, next.start))}"
        else widgetStatus(snapshot, now)
    }

    private fun countdown(delay: Duration): String {
        val wholeMinutes = delay.toMinutes()
        val minutes = wholeMinutes + if (delay == Duration.ofMinutes(wholeMinutes)) 0 else 1
        return when {
            minutes < 60 -> "$minutes хв"
            minutes % 60 == 0L -> "${minutes / 60} год"
            else -> "${minutes / 60} год ${minutes % 60} хв"
        }
    }

    fun widgetStatus(snapshot: Snapshot, now: Instant): String {
        if(snapshot.openEmergency(now))return "Час відновлення уточнюється"
        if(snapshot.emergency.uncertain(now,snapshot.plans))return "Немає точних даних"
        if (snapshot.categories.isEmpty()) return "Графік недоступний"
        if (!snapshot.isCompleteAndFresh(now)) return "Оновіть графік"

        val restoration = connectedRestoration(snapshot.allEvents(), now)
        if (restoration != null) {
            val end = restoration.end ?: return "Час увімкнення невідомий"
            if(snapshot.emergency.uncertain(end,snapshot.plans,now))return "Час відновлення уточнюється"
            val approximate = if (restoration.approximate) "≈ " else ""
            return "До відновлення ${approximate}${countdown(Duration.between(now,end))}"
        }

        val next = Timeline.nextOutage(snapshot, now)
        if (next != null) {
            val delay = Duration.between(now, next.start)
            if (next.start.atZone(KYIV_ZONE).toLocalDate() == now.atZone(KYIV_ZONE).toLocalDate() &&
                delay <= Duration.ofHours(2)
            ) {
                return "Відключення через ${countdown(delay)}"
            }
            return "Відключення ${dayAndTime(next.start, now)}"
        }
        return if(snapshot.explicitHourlyExclusion() && snapshot.checkedEmptyToday(now.atZone(KYIV_ZONE).toLocalDate(),now)) ScheduleLabels.NO_OUTAGES
            else if (hasPublishedEventToday(snapshot, now)) "Є світло за графіком" else "Стан світла невідомий"
    }

    /** Color describes the active or next outage named by widgetStatus, never measured power. */
    fun widgetSignal(snapshot: Snapshot, now: Instant): WidgetSignal {
        if(snapshot.allEvents().any{it.category==Category.EMERGENCY && it.end==null && it.start<=now &&
            it.sourceCategory !in snapshot.failures && snapshot.categories[it.sourceCategory]?.isFresh(now)==true})return WidgetSignal.EMERGENCY
        if (!snapshot.isCompleteAndFresh(now)) return WidgetSignal.UNKNOWN
        val next = Timeline.nextOutage(snapshot, now)
        if (next != null) {
            return if (next.category == Category.EMERGENCY) WidgetSignal.EMERGENCY else WidgetSignal.PLANNED
        }
        return if (hasPublishedEventToday(snapshot, now) || (snapshot.explicitHourlyExclusion() && snapshot.checkedEmptyToday(now.atZone(KYIV_ZONE).toLocalDate(),now))) WidgetSignal.POWER else WidgetSignal.UNKNOWN
    }

    private data class Restoration(val end: Instant?, val approximate: Boolean)

    /** Events are sorted by start. Touching outages leave no published interval with power. */
    private fun connectedRestoration(events: List<Outage>, now: Instant): Restoration? {
        val active = events.filter { it.start <= now && (it.end == null || it.end > now) }
        if (active.isEmpty()) return null
        if (active.any { it.end == null }) return Restoration(null, false)
        var end = active.mapNotNull { it.end }.maxOrNull() ?: return Restoration(null, false)
        var approximate = active.any { it.plannedEnd }
        for (event in events) {
            if (event.start <= now) continue
            if (event.start > end) break
            val nextEnd = event.end ?: return Restoration(null, false)
            end = maxOf(end, nextEnd)
            approximate = approximate || event.plannedEnd
        }
        return Restoration(end, approximate)
    }

    private fun hasPublishedEventToday(snapshot: Snapshot, now: Instant): Boolean {
        val today = now.atZone(KYIV_ZONE).toLocalDate()
        val from = today.atStartOfDay(KYIV_ZONE).toInstant()
        val until = today.plusDays(1).atStartOfDay(KYIV_ZONE).toInstant()
        return snapshot.allEvents().any { it.overlaps(from, until) }
    }

    private fun dayAndTime(at: Instant, now: Instant): String {
        val day = at.atZone(KYIV_ZONE).toLocalDate()
        val today = now.atZone(KYIV_ZONE).toLocalDate()
        return when (day) {
            today -> "о ${time(at)}"
            today.plusDays(1) -> "завтра о ${time(at)}"
            else -> "${day.format(DateTimeFormatter.ofPattern("dd.MM"))} о ${time(at)}"
        }
    }

    private val clock = java.time.format.DateTimeFormatter.ofPattern("HH:mm").withZone(ua.svitlo.widget.core.KYIV_ZONE)
    fun time(at: Instant?): String = at?.let { clock.format(it) } ?: "—"
    fun headline(snapshot: Snapshot, now: Instant): String {
        val event = ua.svitlo.widget.core.Timeline.nextOutage(snapshot, now)
        val warning = if (snapshot.isCompleteAndFresh(now)) "" else "Дані неповні або застарілі · "
        return warning + when {
            event == null -> "Відключень у відповіді немає"
            event.start > now -> "Наступне відключення за даними оператора"
            event.end == null -> "Відключення: час завершення невідомий"
            event.plannedEnd -> "Відключення до ${time(event.end)} орієнтовно"
            else -> "Відключення до ${time(event.end)} за даними оператора"
        }
    }
    fun range(event: ua.svitlo.widget.core.Outage?, now: Instant): String {
        if (event == null) return "Немає опублікованого інтервалу"
        val day = event.start.atZone(ua.svitlo.widget.core.KYIV_ZONE).toLocalDate()
        val today = now.atZone(ua.svitlo.widget.core.KYIV_ZONE).toLocalDate()
        val prefix = if (day != today) day.format(java.time.format.DateTimeFormatter.ofPattern("dd.MM")) + " · " else ""
        val endDay = event.end?.atZone(ua.svitlo.widget.core.KYIV_ZONE)?.toLocalDate()
        val endLabel = if (endDay != null && endDay != day) "${time(event.end)} ${endDay.format(java.time.format.DateTimeFormatter.ofPattern("dd.MM"))}" else time(event.end)
        return "$prefix${time(event.start)} — $endLabel"
    }
    fun sourceTimes(snapshot: Snapshot): String = ua.svitlo.widget.core.Category.entries.joinToString(" · ") {
        val label = when(it) { ua.svitlo.widget.core.Category.PLANNED -> "Пл"; ua.svitlo.widget.core.Category.EMERGENCY -> "Ав"; else -> "ГПВ" }
        "$label ${time(snapshot.categories[it]?.sourceUpdatedAt)}" + if (it in snapshot.failures) " !" else ""
    }
}
