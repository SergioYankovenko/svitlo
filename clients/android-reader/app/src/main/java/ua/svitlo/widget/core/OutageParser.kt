package ua.svitlo.widget.core

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.time.format.ResolverStyle
import java.util.Locale

/** Parses the same JSON used by the official /off page; fails closed on schema errors. */
object OutageParser {
    private val datePattern = Regex("\\d{2}:\\d{2}\\s+\\d{2}\\.\\d{2}\\.\\d{4}")
    private val formatter = DateTimeFormatter.ofPattern("HH:mm dd.MM.uuuu", Locale.ROOT)
        .withResolverStyle(ResolverStyle.STRICT)

    fun parse(json: String, category: Category, fetchedAt: Instant = Instant.now()): CategorySnapshot {
        try {
            val root = JSONObject(json)
            require(!root.has("error") || root.isNull("error") || root.optString("error").isBlank()) {
                "Сервер повернув помилку"
            }
            require(!root.has("ERROR") || root.isNull("ERROR") || root.optString("ERROR").isBlank()) {
                "Сервер повернув помилку"
            }
            require(root.has("DISCONNECTIONS")) { "У відповіді немає переліку відключень" }
            val sourceText = if (root.isNull("DATETIME")) "" else root.optString("DATETIME", "").trim()
            val sourceUpdatedAt = if (sourceText.isEmpty()) null else parseTime(sourceText)
            val events = objects(root.get("DISCONNECTIONS")).mapNotNull { item ->
                val status = item.optString("STATE_CHAR", "").trim()
                if (isCancelled(status)) return@mapNotNull null
                val start = parseTime(item.optString("DATE_START", ""))
                val stopText = item.optString("DATE_STOP", "").trim()
                val displayedStop = if (item.isNull("DATE_TIME")) "" else item.optString("DATE_TIME", "").trim()
                // The official page displays DATE_TIME when present, and only falls back
                // to DATE_STOP when absent. It may explicitly withdraw an older end time.
                val endText = stripHtml(displayedStop.ifBlank { stopText })
                val end = datePattern.find(endText)?.value?.let(::parseTime)
                require(end == null || end > start) { "Некоректний інтервал відключення" }
                val type=item.optString("DISCONN_TYPE",category.label).ifBlank{category.label}.trim()
                Outage(
                    category = if(category==Category.SCHEDULE && type.equals("ГАВ",ignoreCase=true))Category.EMERGENCY else category,
                    start = start,
                    end = end,
                    plannedEnd = endText.contains("план", ignoreCase = true),
                    status = status,
                    type = type,
                    sourceCategory = category
                )
            }.distinct().sortedBy { it.start }
            val queues = if (root.has("DISCONN_QUEUQ") && !root.isNull("DISCONN_QUEUQ")) {
                objects(root.get("DISCONN_QUEUQ")).map { it.optString("QUEUE_INFO", "").trim() }
                    .filter { it.isNotBlank() }.distinct()
            } else emptyList()
            return CategorySnapshot(category, sourceUpdatedAt, fetchedAt, events, queues)
        } catch (error: Exception) {
            if (error is IllegalArgumentException) throw error
            // Never include response bodies, URLs, or account numbers in errors shown to users.
            throw IllegalArgumentException("Не вдалося прочитати відповідь оператора", error)
        }
    }

    fun parseTime(value: String): Instant {
        val text = datePattern.find(stripHtml(value))?.value
            ?: throw IllegalArgumentException("Невідомий формат часу")
        val local = LocalDateTime.parse(text.replace(Regex("\\s+"), " "), formatter)
        // The API supplies wall-clock time without an offset. Neither a nonexistent
        // spring time nor an ambiguous repeated autumn hour can identify an instant.
        val offsets = KYIV_ZONE.rules.getValidOffsets(local)
        require(offsets.size == 1) { "Час неоднозначний через перехід годинника" }
        return local.atOffset(offsets.single()).toInstant()
    }

    private fun objects(value: Any): List<JSONObject> = when (value) {
        is JSONArray -> (0 until value.length()).map { index ->
            value.optJSONObject(index) ?: throw IllegalArgumentException("Некоректний запис відключення")
        }
        is JSONObject -> value.keys().asSequence().map { key ->
            value.optJSONObject(key) ?: throw IllegalArgumentException("Некоректний запис відключення")
        }.toList()
        else -> throw IllegalArgumentException("Некоректний перелік відключень")
    }

    private fun isCancelled(status: String): Boolean = listOf("скасован", "відмін", "cancelled", "canceled")
        .any { status.contains(it, ignoreCase = true) }

    private fun stripHtml(value: String): String = value.replace(Regex("<[^>]*>"), " ")
        .replace("&nbsp;", " ").replace("&#160;", " ").trim()
}
