package ua.svitlo.widget.core

import java.time.Instant
import java.time.LocalDate

data class OfficialInterval(val start: Instant, val end: Instant)

/** An official publication is independent of the address/account API. */
data class OfficialDay(
    val date: LocalDate,
    val queue: String,
    val intervals: List<OfficialInterval>,
    val publishedAt: Instant,
    val fetchedAt: Instant,
    val sourceUrl: String,
    val revision: String,
    val cancelled: Boolean = false,
    val uncertain: Boolean = false
)

data class OfficialFeedSnapshot(
    val days: List<OfficialDay> = emptyList(),
    val checkedAt: Instant? = null,
    val failed: Boolean = false,
    val issues: List<String> = emptyList(),
    val emergencies: List<EmergencyNotice> = emptyList()
)

data class OfficialChange(
    val id: String,
    val date: LocalDate,
    val queue: String,
    val at: Instant,
    val kind: String,
    val title: String,
    val sourceUrl: String,
    val revision: String,
    val read: Boolean = false,
    val timeBasis: String = "observed"
)
