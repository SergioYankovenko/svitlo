package ua.svitlo.widget

import android.text.Html
import org.json.JSONObject
import ua.svitlo.widget.core.KYIV_ZONE
import ua.svitlo.widget.core.OfficialDay
import ua.svitlo.widget.core.OfficialFeedSnapshot
import ua.svitlo.widget.core.OfficialInterval
import java.net.URI
import java.security.MessageDigest
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.temporal.ChronoUnit
import java.util.Locale

data class OfficialArticle(val id: String, val title: String, val content: String,
    val publishedAt: Instant, val sourceUrl: String)

/** Conservative parser: only explicit dated GPV rows can replace a known schedule. */
object OfficialScheduleParser {
    val queues: List<String> = (1..6).flatMap { q -> (1..2).map { "$q.$it" } }
    private val months = listOf("січня", "лютого", "березня", "квітня", "травня", "червня",
        "липня", "серпня", "вересня", "жовтня", "листопада", "грудня")
    private val wordDate = Regex("(?<!\\d)(\\d{1,2})\\s+(${months.joinToString("|")})(?:\\s+(20\\d{2})(?:\\s*р(?:оку|\\.)?)?)?", RegexOption.IGNORE_CASE)
    private val numberDate = Regex("(?<!\\d)(\\d{1,2})[.](\\d{1,2})[.](20\\d{2})(?!\\d)")
    private val row = Regex("(?m)^\\s*(?:(?:під)?черг[а-яіїєґ]*\\s*)?([1-6])\\s*[.]\\s*([12])\\s*[:–—-]?\\s*(.*?)\\s*$", RegexOption.IGNORE_CASE)
    private val range = Regex("(?<!\\d)(\\d{1,2})\\s*:\\s*(\\d{2})\\s*[-–—−]\\s*(\\d{1,2})\\s*:\\s*(\\d{2})(?!\\d)")
    private val cancellation = Regex("скасован[оіийа]*|не\\s+застосовуватимуться|не\\s+застосовуються|без\\s+відключень", RegexOption.IGNORE_CASE)
    private val correction = Regex("^\\s*(?:оновлено|оновлення|змінено|уточнено|уточнення|коригування|зміни\\s+до)\\b", RegexOption.IGNORE_CASE)
    private val queueMention = Regex("(?<!\\d)([1-6])[.]([12])(?!\\d)")
    private val cancellationTimeQualifier = Regex(
        "\\d{1,2}\\s*:\\s*\\d{2}|\\b(?:з|із|до|після|від)\\s+\\d{1,2}\\s*(?:[-–—]ї\\s*)?год|" +
            "\\bна\\s+(?:\\d{1,2}|одну|дві|три|чотири|п.?ять|шість|сім|вісім|дев.?ять|десять)\\s+год|" +
            "до\\s+кінця\\s+доби|тимчасов", RegexOption.IGNORE_CASE)

    fun isScheduleTitle(title: String): Boolean =
        Regex("гпв|погодинн[а-яіїєґ]*\\s+відключ", RegexOption.IGNORE_CASE).containsMatchIn(title) &&
            !Regex("\\bгоп\\b|обмеженн[а-яіїєґ]*\\s+потужност", RegexOption.IGNORE_CASE).containsMatchIn(title)

    fun article(raw: String): OfficialArticle {
        require(raw.length <= MAX_OFFICIAL_RESPONSE) { "Завелика публікація" }
        val envelope = JSONObject(raw)
        require(envelope.getBoolean("success")) { "Помилка офіційного джерела" }
        val value = envelope.getJSONObject("data")
        val slug = value.getString("slug")
        require(officialSlug(slug)) { "Некоректне посилання публікації" }
        val timestamp = value.getString("publishedAt")
        val published = runCatching { Instant.parse(timestamp) }.getOrElse {
            runCatching { OffsetDateTime.parse(timestamp).toInstant() }.getOrElse {
                val local = LocalDateTime.parse(timestamp)
                require(KYIV_ZONE.rules.getValidOffsets(local).size == 1) { "Неоднозначний час публікації" }
                local.atZone(KYIV_ZONE).toInstant()
            }
        }
        return OfficialArticle(value.optString("id"), value.getString("title"), value.getString("content"),
            published, "$OFFICIAL_ORIGIN/media/$slug")
    }

    fun parse(article: OfficialArticle, fetchedAt: Instant): OfficialFeedSnapshot {
        if (!isScheduleTitle(article.title)) return OfficialFeedSnapshot()
        require(officialUrl(article.sourceUrl)) { "Неофіційне джерело" }
        val title = plain(article.title)
        val body = joinQueueContinuations(plain(article.content))
        val publicationDate = article.publishedAt.atZone(KYIV_ZONE).toLocalDate()
        val titleDates = dates(title, publicationDate)
        val candidates = if (titleDates.isNotEmpty()) titleDates else dates(body, publicationDate)
        if (candidates.size != 1) return OfficialFeedSnapshot(issues = listOf("Не вдалося однозначно визначити дату офіційного графіка"))
        val date = candidates.single()
        val rows = row.findAll(body).groupBy { "${it.groupValues[1]}.${it.groupValues[2]}" }
        val titleQueues = queueMention.findAll(title)
            .map { "${it.groupValues[1]}.${it.groupValues[2]}" }.toSet()
        val bodyQueues = if (Regex("(?:під)?черг", RegexOption.IGNORE_CASE).containsMatchIn(body))
            queueMention.findAll(body).map { "${it.groupValues[1]}.${it.groupValues[2]}" }.toSet() else emptySet()
        val cancellationQueues = titleQueues + bodyQueues
        val cancellationProse = title + "\n" + body.lines().filterNot { row.matches(it) }.joinToString("\n")
        val negatedCancellation = cancellation.containsMatchIn(cancellationProse) &&
            Regex("\\b(?:не|ні|без)\\b", RegexOption.IGNORE_CASE).containsMatchIn(cancellationProse)
        val temporalCancellation = cancellation.containsMatchIn(cancellationProse) &&
            cancellationTimeQualifier.containsMatchIn(cancellationProse)
        val contradictoryCancellation = cancellation.containsMatchIn(title) && rows.values.flatten().any {
            !cancellation.matches(it.groupValues[3].trim().trimEnd('.', '!'))
        }
        val globalCancellation = !negatedCancellation && !temporalCancellation && ((cancellation.containsMatchIn(title) && !contradictoryCancellation) ||
            (rows.isEmpty() && cancellation.containsMatchIn(body) && !Regex("\\d{1,2}:\\d{2}").containsMatchIn(body)))
        val partialCorrection = correction.containsMatchIn(title) || Regex(
            "(?im)^(?:оновлено|змінено|уточнено|зміни|коригування|уточнення)\\s+(?:графік[а-яіїєґ]*|для\\s+(?:під)?черг|годин)")
            .containsMatchIn(body)
        val affected = when {
            globalCancellation -> cancellationQueues.ifEmpty { queues.toSet() }
            temporalCancellation && cancellationQueues.isNotEmpty() -> cancellationQueues
            rows.size == queues.size -> queues.toSet()
            rows.isNotEmpty() && partialCorrection -> rows.keys
            else -> queues.toSet()
        }
        val incomplete = negatedCancellation || temporalCancellation || contradictoryCancellation || (!globalCancellation && rows.size != queues.size &&
            !(rows.isNotEmpty() && partialCorrection))
        val issues = mutableListOf<String>()
        val days = affected.map { queue ->
            val matches = rows[queue].orEmpty()
            val text = matches.singleOrNull()?.groupValues?.get(3).orEmpty()
            val cancelled = globalCancellation || (matches.size == 1 && cancellation.matches(text.trim().trimEnd('.', '!')))
            val parsed = if (cancelled) emptyList() else parseIntervals(date, text)
            val uncertain = incomplete || (!cancelled && (matches.size != 1 || parsed == null))
            if (uncertain) issues += "Не вдалося перевірити графік на $date для підчерги $queue"
            val intervals = if (uncertain) emptyList() else parsed.orEmpty()
            val revision = officialHash("$date|$queue|$cancelled|$uncertain|" +
                if (uncertain) text else intervals.joinToString { "${it.start}/${it.end}" })
            OfficialDay(date, queue, intervals, article.publishedAt, fetchedAt, article.sourceUrl,
                revision, cancelled && !uncertain, uncertain)
        }
        return OfficialFeedSnapshot(days, fetchedAt, issues = issues)
    }

    internal fun dates(text: String, publication: LocalDate): Set<LocalDate> {
        val found = mutableSetOf<LocalDate>()
        numberDate.findAll(text).forEach { match ->
            runCatching { LocalDate.of(match.groupValues[3].toInt(), match.groupValues[2].toInt(), match.groupValues[1].toInt()) }
                .getOrNull()?.also(found::add)
        }
        wordDate.findAll(text).forEach { match ->
            val day = match.groupValues[1].toInt()
            val month = months.indexOf(match.groupValues[2].lowercase(Locale.ROOT)) + 1
            val year = match.groupValues[3].toIntOrNull()
            val options = (if (year != null) listOf(year) else listOf(publication.year - 1, publication.year, publication.year + 1))
                .mapNotNull { runCatching { LocalDate.of(it, month, day) }.getOrNull() }
            val nearest = options.minByOrNull { kotlin.math.abs(ChronoUnit.DAYS.between(publication, it)) }
            if (nearest != null && (year != null || kotlin.math.abs(ChronoUnit.DAYS.between(publication, nearest)) <= 183)) found += nearest
        }
        return found
    }

    private fun parseIntervals(date: LocalDate, text: String): List<OfficialInterval>? {
        val matches = range.findAll(text).toList()
        if (matches.isEmpty() || matches.size > 24) return null
        if (!range.replace(text, "").matches(Regex("[\\s,;.!]*"))) return null
        val spans = mutableListOf<Pair<Int, Int>>()
        for (match in matches) {
            val values = match.groupValues.drop(1).map(String::toInt)
            val (h1, m1, h2, m2) = values
            if (h1 !in 0..23 || m1 !in 0..59 || h2 !in 0..24 || m2 !in 0..59 || (h2 == 24 && m2 != 0)) return null
            val start = h1 * 60 + m1
            val end = h2 * 60 + m2
            if (end <= start) return null
            spans += start to end
        }
        val merged = mutableListOf<Pair<Int, Int>>()
        for (span in spans.sortedBy { it.first }) {
            val previous = merged.lastOrNull()
            if (previous != null && span.first < previous.second) return null
            if (previous != null && span.first == previous.second) merged[merged.lastIndex] = previous.first to span.second
            else merged += span
        }
        return merged.map { (start, end) ->
            val from = civilInstant(date, start) ?: return null
            val until = civilInstant(date, end) ?: return null
            if (from >= until) return null
            OfficialInterval(from, until)
        }
    }

    private fun civilInstant(date: LocalDate, minute: Int): Instant? {
        val local = date.atStartOfDay().plusMinutes(minute.toLong())
        if (KYIV_ZONE.rules.getValidOffsets(local).size != 1) return null
        return local.atZone(KYIV_ZONE).toInstant()
    }

    private fun joinQueueContinuations(text: String): String {
        val lines = mutableListOf<String>()
        text.lines().filter { it.isNotBlank() }.forEach { line ->
            if (Regex("^[,;]?\\s*\\d{1,2}\\s*[:–—-]").containsMatchIn(line) &&
                lines.lastOrNull()?.let { row.matches(it) } == true) {
                lines[lines.lastIndex] = lines.last().trimEnd(',', ';', ' ') + ", " + line.trimStart(',', ';', ' ')
            } else lines += line
        }
        return lines.joinToString("\n")
    }

    internal fun plain(html: String): String {
        val blocks = html.replace(Regex("(?is)<(script|style)\\b[^>]*>.*?</\\1>"), "")
            .replace(Regex("(?i)</?t[dh]\\b[^>]*>"), " ")
            .replace(Regex("(?i)</?tr\\b[^>]*>"), "<br>")
        return Html.fromHtml(blocks, Html.FROM_HTML_MODE_LEGACY).toString()
            .replace('\u00a0', ' ').replace('\u202f', ' ').replace('\r', '\n')
            .lines().joinToString("\n") { it.replace(Regex("[\\t ]+"), " ").trim() }.trim()
    }
}

internal const val OFFICIAL_ORIGIN = "https://www.cherkasyoblenergo.com"
internal const val MAX_OFFICIAL_RESPONSE = 1_048_576
internal fun officialSlug(value: String): Boolean = Regex("[a-zA-Z0-9][a-zA-Z0-9-]{0,199}").matches(value)
internal fun officialUrl(value: String): Boolean = runCatching {
    val uri = URI(value)
    uri.scheme == "https" && uri.host == "www.cherkasyoblenergo.com" && uri.userInfo == null && uri.port == -1
}.getOrDefault(false)
internal fun officialHash(value: String): String = MessageDigest.getInstance("SHA-256")
    .digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
