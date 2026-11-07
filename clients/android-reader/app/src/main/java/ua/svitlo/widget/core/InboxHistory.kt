package ua.svitlo.widget.core

import java.time.Duration
import java.time.Instant

/** One rolling week of updates, independent of their schedule date or read state. */
object InboxHistory {
    val newestFirst: Comparator<OfficialChange> =
        compareByDescending<OfficialChange> { it.at }.thenByDescending { it.date }

    fun recent(values: List<OfficialChange>, now: Instant): List<OfficialChange> = values
        .filter { it.at >= now.minus(Duration.ofDays(7)) }
        .distinctBy { it.id }
        .sortedWith(newestFirst)
        .take(100)
}
