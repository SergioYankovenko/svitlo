package ua.svitlo.widget

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import ua.svitlo.widget.core.KYIV_ZONE
import ua.svitlo.widget.core.OfficialChange
import ua.svitlo.widget.core.OfficialDay
import ua.svitlo.widget.core.OfficialFeedSnapshot
import ua.svitlo.widget.core.OfficialInterval
import ua.svitlo.widget.core.InboxHistory
import ua.svitlo.widget.core.EmergencyNotice
import ua.svitlo.widget.core.HourlyValidity
import java.io.IOException
import java.io.InterruptedIOException
import java.net.URL
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.time.LocalDate
import java.util.UUID
import javax.net.ssl.HttpsURLConnection

/** Carries public news only; the source never receives an account, address or queue. */
fun interface OfficialFeedSource { fun fetch(): List<OfficialArticle> }

class CherkasyOfficialFeedSource(private val nanoTime: () -> Long = { System.nanoTime() },
    private val request: (String) -> String = ::officialHttpsGet) : OfficialFeedSource {
    override fun fetch(): List<OfficialArticle> {
        val startedAt = nanoTime()
        fun boundedGet(url: String): String {
            if (Thread.currentThread().isInterrupted) throw InterruptedIOException("Перевірку офіційного джерела скасовано")
            if (nanoTime() - startedAt >= 90_000_000_000L) throw IOException("Перевищено час перевірки офіційного джерела")
            return get(url)
        }
        val slugs = linkedSetOf<String>()
        for (page in 0 until 4) {
            val raw = boundedGet("$OFFICIAL_ORIGIN/api/v1/posts/category/news?lang=uk&page=$page&size=10")
            val envelope = JSONObject(raw)
            require(envelope.getBoolean("success")) { "Помилка офіційного джерела" }
            val data = envelope.getJSONObject("data")
            val content = data.getJSONArray("content")
            require(content.length() <= 50) { "Завелика стрічка новин" }
            for (index in 0 until content.length()) {
                val post = content.getJSONObject(index)
                if (!OfficialScheduleParser.isScheduleTitle(post.getString("title")) && !EmergencyParser.isCandidate(post.getString("title")) && !ServiceNotices.candidate(post.getString("title"))) continue
                val slug = post.getString("slug")
                require(officialSlug(slug)) { "Некоректне посилання публікації" }
                if (slugs.size < 24) slugs += slug
            }
            if (data.optBoolean("last", false) || content.length() == 0) break
        }
        return slugs.map { slug ->
            OfficialScheduleParser.article(boundedGet("$OFFICIAL_ORIGIN/api/v1/posts/$slug?lang=uk"))
        }.distinctBy { it.sourceUrl }
    }

    private fun get(url: String): String {
        require(officialUrl(url)) { "Неофіційне джерело" }
        val body = request(url)
        require(body.length <= MAX_OFFICIAL_RESPONSE) { "Завелика відповідь офіційного джерела" }
        return body
    }
}

/** Separate public cache. Clearing invalidates even requests made by another repository instance. */
class OfficialScheduleRepository(context: Context,
    private val source: OfficialFeedSource = CherkasyOfficialFeedSource(),
    private val now: () -> Instant = { Instant.now() }) {
    private val serviceNotices = ServiceNotices(context)
    private val prefs = context.applicationContext.getSharedPreferences("svitlo_official", Context.MODE_PRIVATE)

    fun snapshot(): OfficialFeedSnapshot = synchronized(stateLock) { readSnapshot() }
    fun changes(): List<OfficialChange> = synchronized(stateLock) { readChanges() }
    fun sourceFailure():SourceFailure? = synchronized(stateLock){
        runCatching{SourceFailure.valueOf(prefs.getString("failure_reason",null).orEmpty())}.getOrNull()
    }

    fun refresh(): Boolean = synchronized(refreshLock) refresh@{
        val requestEpoch = synchronized(stateLock) { epoch }
        try {
            val articles = source.fetch()
            require(articles.size <= 24) { "Завелика стрічка новин" }
            val checkedAt = now()
            val today = checkedAt.atZone(KYIV_ZONE).toLocalDate()
            val results = articles.sortedBy { it.publishedAt }.mapNotNull { article ->
                if(ServiceNotices.candidate(article.title))return@mapNotNull null
                val controls=EmergencyParser.parse(article)
                val parsed = if(controls.isNotEmpty() && !Regex("(?m)^\\s*[1-6]\\.[12]").containsMatchIn(OfficialScheduleParser.plain(article.content)))
                    OfficialFeedSnapshot() else OfficialScheduleParser.parse(article, checkedAt)
                // An old explainer with no interpretable date cannot revise today's cached plan.
                val oldUndated = parsed.days.isEmpty() && parsed.issues.isNotEmpty() &&
                    article.publishedAt.atZone(KYIV_ZONE).toLocalDate() < today.minusDays(2)
                val outsideWindow=parsed.days.isNotEmpty() && parsed.days.none{inWindow(it.date,today)}
                if (oldUndated || outsideWindow) null else parsed.copy(days=parsed.days.filter{inWindow(it.date,today)})
            }
            synchronized(stateLock) {
                if (epoch != requestEpoch) return@refresh false
                val before = readSnapshot()
                val merged = before.days.filter { inWindow(it.date, today) }.associateBy { it.date to it.queue }.toMutableMap()
                val issues = results.flatMap { it.issues }.distinct().take(24)
                for (result in results) {
                    if (result.days.isEmpty() && result.issues.isNotEmpty()) {
                        merged.replaceAll { _, day -> if (day.date >= today) day.copy(uncertain = true) else day }
                    }
                    for (incoming in result.days.filter { inWindow(it.date, today) }) {
                        val key = incoming.date to incoming.queue
                        val old = merged[key]
                        if (old != null && old.publishedAt > incoming.publishedAt) continue
                        merged[key] = if (incoming.uncertain && old != null)
                            incoming.copy(intervals = old.intervals, cancelled = old.cancelled)
                        else if(old!=null)preserveCompleted(old,incoming)else incoming
                    }
                }
                val days = merged.values.sortedWith(compareBy<OfficialDay> { it.date }.thenBy { it.queue }).takeLast(168)
                val history = repairLegacyTimes(readChanges(), results.flatMap { it.days } + before.days).toMutableList()
                val previous = before.days.associateBy { it.date to it.queue }
                for (day in days) {
                    val old = previous[day.date to day.queue]
                    if (old != null && old.revision == day.revision && old.uncertain == day.uncertain && old.cancelled == day.cancelled) continue
                    val kind = when {
                        day.uncertain -> "uncertain"
                        day.cancelled -> "cancelled"
                        old == null -> "published"
                        else -> "updated"
                    }
                    val id = UUID.randomUUID().toString()
                    // A first discovery or new bulletin keeps its source time, even if fetched days later.
                    // For an in-place edit with no newer publication time, only detection time is known.
                    val sourceTime = old == null || day.publishedAt > old.publishedAt
                    history.add(0, OfficialChange(id, day.date, day.queue, if(sourceTime)day.publishedAt else checkedAt,
                        kind, changeTitle(kind, day), day.sourceUrl, day.revision,
                        timeBasis = if(sourceTime)"publication" else "observed"))
                }
                // First discovery of an old bulletin cannot activate today's emergency regime.
                // Once observed, retain commands through outages until an explicit newer command.
                val incoming=articles.flatMap(EmergencyParser::parse).filter{
                    it.publishedAt<=checkedAt.plusSeconds(300) && (it.effectiveAt>=checkedAt.minusSeconds(172800) || before.emergencies.any{old->old.id==it.id})}
                val notices=(before.emergencies+incoming).groupBy{it.id}.map{(_,values)->values.sortedBy{it.publishedAt}.last()}
                    .sortedWith(compareBy<EmergencyNotice>{it.effectiveAt}.thenBy{it.publishedAt}).takeLast(96)
                for((url,commands) in incoming.groupBy{it.sourceUrl}){
                    val old=before.emergencies.filter{it.sourceUrl==url}
                    if(commands.toSet()==old.toSet())continue
                    val active=commands.lastOrNull{it.active!=null}?.active
                    val validity=commands.lastOrNull{it.hourly!=null}?.hourly
                    val title=when(active){
                        true->"Аварійні відключення"+(validity?.let{" · ${it.label}"} ?: "")
                        false->"Режим аварійних відключень завершено"
                        null->validity?.label ?: continue
                    }
                    val at=commands.maxOf{it.publishedAt}
                    val revision=officialHash(commands.joinToString())
                    history+=OfficialChange("regime:$revision",commands.maxOf{it.effectiveAt}.atZone(KYIV_ZONE).toLocalDate(),"*",
                        if(old.isEmpty() || at>old.maxOf{it.publishedAt})at else checkedAt,"regime",title,url,revision,
                        timeBasis=if(old.isEmpty())"publication"else"observed")
                }
                val state = OfficialFeedSnapshot(days, checkedAt, failed = issues.isNotEmpty(), issues = issues, emergencies=notices)
                serviceNotices.update(articles,checkedAt)
                persist(state, history)
                prefs.edit().apply{if(state.failed)putString("failure_reason",SourceFailure.INVALID.name)else remove("failure_reason")}.commit()
                !state.failed
            }
        } catch (failure: Exception) {
            synchronized(stateLock) {
                if (epoch == requestEpoch) {
                    val old = readSnapshot()
                    prefs.edit().putString("failure_reason",SourceFailure.of(failure).name).commit()
                    runCatching { persist(old.copy(failed = true,
                        issues = listOf("Не вдалося оновити офіційні публікації. Збережено останній перевірений графік.")), readChanges()) }
                }
            }
            false
        }
    }

    fun markRead(id: String) = synchronized(stateLock) {
        persist(readSnapshot(), readChanges().map { if (it.id == id) it.copy(read = true) else it })
    }

    fun markAllRead(queue: String) = synchronized(stateLock) {
        persist(readSnapshot(), readChanges().map { if (it.queue == queue) it.copy(read = true) else it })
    }

    fun clearRead(queue: String) = synchronized(stateLock) {
        persist(readSnapshot(), readChanges().filterNot { it.queue == queue && it.read })
    }

    fun clear() = synchronized(stateLock) {
        epoch++
        check(prefs.edit().clear().commit()) { "Не вдалося видалити офіційний кеш" }
    }

    private fun readSnapshot(): OfficialFeedSnapshot {
        val raw = prefs.getString("state", null) ?: return OfficialFeedSnapshot()
        return runCatching {
            require(raw.length <= MAX_CACHE)
            val json = JSONObject(raw)
            val list = json.getJSONArray("days")
            require(list.length() <= 168)
            val days = (0 until list.length()).map { i ->
                val day = list.getJSONObject(i)
                val intervals = day.getJSONArray("intervals")
                require(intervals.length() <= 96)
                val queue = day.getString("queue")
                val url = day.getString("sourceUrl")
                require(queue in OfficialScheduleParser.queues && officialUrl(url))
                OfficialDay(LocalDate.parse(day.getString("date")), queue,
                    (0 until intervals.length()).map { n ->
                        val span = intervals.getJSONObject(n)
                        val start = Instant.parse(span.getString("start"))
                        val end = Instant.parse(span.getString("end"))
                        require(start < end)
                        OfficialInterval(start, end)
                    }, Instant.parse(day.getString("publishedAt")), Instant.parse(day.getString("fetchedAt")),
                    url, day.getString("revision"), day.optBoolean("cancelled"), day.optBoolean("uncertain"))
            }
            val issueArray = json.optJSONArray("issues") ?: JSONArray()
            OfficialFeedSnapshot(days, json.optString("checkedAt").takeIf(String::isNotBlank)?.let(Instant::parse),
                json.optBoolean("failed"), (0 until minOf(issueArray.length(), 24)).map { issueArray.getString(it).take(300) },
                readEmergencies(json.optJSONArray("emergencies") ?: JSONArray()))
        }.getOrElse { OfficialFeedSnapshot(failed = true, issues = listOf("Не вдалося прочитати збережений офіційний графік")) }
    }

    private fun readEmergencies(array:JSONArray):List<EmergencyNotice> {
        require(array.length()<=96)
        return (0 until array.length()).map{index->
            val v=array.getJSONObject(index);val url=v.getString("sourceUrl");require(officialUrl(url))
            val scopes=v.getJSONArray("queues");val queues=(0 until scopes.length()).map{scopes.getString(it)}.toSet()
            require(queues.all{it in OfficialScheduleParser.queues})
            EmergencyNotice(v.getString("id"),Instant.parse(v.getString("publishedAt")),Instant.parse(v.getString("effectiveAt")),
                if(v.isNull("active"))null else v.getBoolean("active"),
                v.optString("hourly").takeIf{it.isNotBlank()}?.let(HourlyValidity::valueOf),queues,
                v.optString("until").takeIf{it.isNotBlank()}?.let(Instant::parse),url)
        }
    }

    private fun readChanges(): List<OfficialChange> {
        val stored = runCatching {
        val raw = prefs.getString("history", null) ?: return@runCatching emptyList()
        require(raw.length <= MAX_CACHE)
        val array = JSONArray(raw)
        require(array.length() <= 100)
        (0 until array.length()).map { index ->
            val value = array.getJSONObject(index)
            val queue = value.getString("queue")
            val url = value.getString("sourceUrl")
            require((queue in OfficialScheduleParser.queues || queue=="*") && officialUrl(url))
            OfficialChange(value.getString("id"), LocalDate.parse(value.getString("date")), queue,
                Instant.parse(value.getString("at")), value.getString("kind"), value.getString("title"),
                url, value.getString("revision"), value.optBoolean("read"), value.optString("timeBasis", "legacy"))
        }
        }.getOrDefault(emptyList())
        val recent = InboxHistory.recent(repairLegacyTimes(stored, readSnapshot().days), now())
        // Also prune on offline reads; no successful network refresh is needed to expire the history.
        if(recent != stored) prefs.edit().putString("history", historyJson(recent).toString()).commit()
        return recent
    }

    private fun repairLegacyTimes(history: List<OfficialChange>, days: List<OfficialDay>): List<OfficialChange> =
        history.map { change ->
            if(change.timeBasis != "legacy" || change.kind != "published") return@map change
            val day = days.firstOrNull { it.date == change.date && it.queue == change.queue &&
                it.sourceUrl == change.sourceUrl && it.revision == change.revision }
            // An unmatched old edit has no recoverable source time. Keep its observed time, not a guess.
            if(day == null) change else change.copy(at = day.publishedAt, timeBasis = "publication")
        }

    private fun persist(snapshot: OfficialFeedSnapshot, history: List<OfficialChange>): Boolean {
        val days = JSONArray()
        snapshot.days.forEach { day ->
            val spans = JSONArray()
            day.intervals.forEach { spans.put(JSONObject().put("start", it.start.toString()).put("end", it.end.toString())) }
            days.put(JSONObject().put("date", day.date.toString()).put("queue", day.queue).put("intervals", spans)
                .put("publishedAt", day.publishedAt.toString()).put("fetchedAt", day.fetchedAt.toString())
                .put("sourceUrl", day.sourceUrl).put("revision", day.revision)
                .put("cancelled", day.cancelled).put("uncertain", day.uncertain))
        }
        val emergencies=JSONArray()
        snapshot.emergencies.forEach{n->emergencies.put(JSONObject().put("id",n.id).put("publishedAt",n.publishedAt.toString())
            .put("effectiveAt",n.effectiveAt.toString()).put("active",n.active ?: JSONObject.NULL)
            .put("hourly",n.hourly?.name.orEmpty()).put("queues",JSONArray(n.queues.toList()))
            .put("until",n.until?.toString().orEmpty()).put("sourceUrl",n.sourceUrl))}
        val state = JSONObject().put("emergencies",emergencies).put("days", days).put("checkedAt", snapshot.checkedAt?.toString().orEmpty())
            .put("failed", snapshot.failed).put("issues", JSONArray(snapshot.issues.take(24))).toString()
        val changes = historyJson(InboxHistory.recent(history, now()))
        require(state.length <= MAX_CACHE && changes.toString().length <= MAX_CACHE)
        check(prefs.edit().putString("state", state).putString("history", changes.toString()).commit()) {
            "Не вдалося зберегти офіційний графік"
        }
        return true
    }

    private fun historyJson(history: List<OfficialChange>): JSONArray = JSONArray().also { changes ->
        history.forEach { change ->
            changes.put(JSONObject().put("id", change.id).put("date", change.date.toString()).put("queue", change.queue)
                .put("at", change.at.toString()).put("kind", change.kind).put("title", change.title)
                .put("sourceUrl", change.sourceUrl).put("revision", change.revision).put("read", change.read)
                .put("timeBasis", change.timeBasis))
        }
    }

    private fun preserveCompleted(old:OfficialDay,incoming:OfficialDay):OfficialDay {
        // An afternoon bulletin commonly lists only the remaining windows. Its publication
        // time, not our fetch time, separates history from windows it can still cancel.
        val history=old.intervals.filter{previous->previous.end<=incoming.publishedAt &&
            incoming.intervals.none{it.start<previous.end && it.end>previous.start}}
        if(history.isEmpty())return incoming
        val intervals=(history+incoming.intervals).distinct().sortedBy{it.start}
        val revision=officialHash("${incoming.date}|${incoming.queue}|${incoming.cancelled}|${incoming.uncertain}|"+
            intervals.joinToString{"${it.start}/${it.end}"})
        return incoming.copy(intervals=intervals,revision=revision)
    }

    private fun inWindow(date: LocalDate, today: LocalDate): Boolean = date >= today.minusDays(7) && date <= today.plusDays(7)

    private fun changeTitle(kind: String, day: OfficialDay): String = when (kind) {
        "cancelled" -> "ГПВ на ${day.date} скасовано"
        "uncertain" -> "Графік на ${day.date} потребує перевірки"
        "updated" -> "Оновлено графік на ${day.date}"
        else -> "Опубліковано графік на ${day.date}"
    }

    companion object {
        private val stateLock = Any()
        private val refreshLock = Any()
        private var epoch = 0L
        private const val MAX_CACHE = 524_288
    }
}

/** Platform trust, hostname verification and no redirects; no account-specific TLS overrides. */
private fun officialHttpsGet(address: String): String {
    require(officialUrl(address)) { "Неофіційне джерело" }
    if (Thread.currentThread().isInterrupted) throw InterruptedIOException("Перевірку офіційного джерела скасовано")
    val startedAt = System.nanoTime()
    val connection = URL(address).openConnection() as HttpsURLConnection
    connection.connectTimeout = 12_000
    connection.readTimeout = 15_000
    connection.instanceFollowRedirects = false
    connection.setRequestProperty("Accept", "application/json")
    connection.setRequestProperty("User-Agent", "SvitloWidget/1.1 (public schedule reader)")
    try {
        if (connection.responseCode != 200) throw SourceException(SourceFailure.http(connection.responseCode))
        return connection.inputStream.bufferedReader(StandardCharsets.UTF_8).use { reader ->
            val buffer = CharArray(4096)
            val body = StringBuilder()
            while (true) {
                if (Thread.currentThread().isInterrupted) throw InterruptedIOException("Перевірку офіційного джерела скасовано")
                if (System.nanoTime() - startedAt >= 30_000_000_000L) throw IOException("Перевищено час читання публікації")
                val count = reader.read(buffer)
                if (count < 0) break
                if (body.length + count > MAX_OFFICIAL_RESPONSE) throw IOException("Завелика відповідь офіційного джерела")
                body.append(buffer, 0, count)
            }
            body.toString()
        }
    } finally { connection.disconnect() }
}
