package ua.svitlo.widget

import android.content.Context
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.IOException
import java.time.Instant

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class OfficialFeedRepositoryTest {
    private lateinit var context: Context
    private var now = Instant.parse("2026-10-22T20:00:00Z")
    private class Feed(var articles: List<OfficialArticle> = listOf(officialArticle())) : OfficialFeedSource {
        var failing = false
        var onFetch: (() -> Unit)? = null
        override fun fetch(): List<OfficialArticle> {
            onFetch?.also { onFetch = null }?.invoke()
            if (failing) throw IOException("private raw response")
            return articles
        }
    }

    @Before fun setup() {
        context = RuntimeEnvironment.getApplication()
        OfficialScheduleRepository(context).clear()
    }

    @Test fun cacheIsIndependentPublicMetadataAndSurvivesReopening() {
        val repo = OfficialScheduleRepository(context, Feed()) { now }
        assertTrue(repo.refresh())
        val reopened = OfficialScheduleRepository(context)
        assertEquals(12, reopened.snapshot().days.size)
        assertEquals(now, reopened.snapshot().checkedAt)
        val serialized = context.getSharedPreferences("svitlo_official", Context.MODE_PRIVATE).all.toString()
        assertFalse(serialized.contains("account"))
        assertFalse(serialized.contains("address"))
    }

    @Test fun newestPublicationWinsPerQueueEvenWhenSourceOrderIsReversed() {
        val old = officialArticle()
        val update = officialArticle(title = "Оновлено графік погодинних відключень (ГПВ) на 23 жовтня",
            rows = "<p>3.2 09:15 - 11:30</p>", published = old.publishedAt.plusSeconds(3600))
        val repo = OfficialScheduleRepository(context, Feed(listOf(update, old))) { now }
        assertTrue(repo.refresh())
        val days = repo.snapshot().days
        assertEquals(12, days.size)
        assertEquals(Instant.parse("2026-10-23T06:15:00Z"), days.single { it.queue == "3.2" }.intervals.single().start)
        assertEquals(old.publishedAt, days.single { it.queue == "3.1" }.publishedAt)
    }

    @Test fun sameArticleEditedWithoutChangingPublicationTimeChangesSemanticRevision() {
        val feed = Feed()
        val repo = OfficialScheduleRepository(context, feed) { now }
        assertTrue(repo.refresh())
        val before = repo.snapshot().days.first().revision
        feed.articles = listOf(officialArticle(rows = allOfficialRows("10:15 - 12:30")))
        now = now.plusSeconds(600)
        assertTrue(repo.refresh())
        assertNotEquals(before, repo.snapshot().days.first().revision)
        assertEquals(24, repo.changes().size)
        assertEquals(12, repo.changes().count { it.kind == "updated" })
    }

    @Test fun failurePreservesScheduleAndCheckTimestampWithSanitizedIssue() {
        val feed = Feed()
        val repo = OfficialScheduleRepository(context, feed) { now }
        assertTrue(repo.refresh())
        val before = repo.snapshot()
        feed.failing = true
        now = now.plusSeconds(600)
        assertFalse(repo.refresh())
        val after = repo.snapshot()
        assertEquals(before.days, after.days)
        assertEquals(before.checkedAt, after.checkedAt)
        assertTrue(after.failed)
        assertFalse(after.issues.joinToString().contains("private raw"))
    }

    @Test fun malformedCorrectionRetainsIntervalsAndMarksAffectedQueueUncertain() {
        val feed = Feed()
        val repo = OfficialScheduleRepository(context, feed) { now }
        assertTrue(repo.refresh())
        val before = repo.snapshot().days.single { it.queue == "3.2" }
        feed.articles = listOf(officialArticle(title = "Оновлено графік погодинних відключень (ГПВ) на 23 жовтня",
            rows = "<p>3.2 09:90 - 10:00</p>", published = before.publishedAt.plusSeconds(3600)))
        assertFalse(repo.refresh())
        val after = repo.snapshot().days.single { it.queue == "3.2" }
        assertEquals(before.intervals, after.intervals)
        assertTrue(after.uncertain)
        assertTrue(repo.snapshot().failed)
        assertFalse(repo.snapshot().days.single { it.queue == "3.1" }.uncertain)
    }

    @Test fun disappearanceDoesNotCancelTheCachedSchedule() {
        val feed = Feed()
        val repo = OfficialScheduleRepository(context, feed) { now }
        assertTrue(repo.refresh())
        feed.articles = emptyList()
        assertTrue(repo.refresh())
        assertEquals(12, repo.snapshot().days.size)
        assertTrue(repo.snapshot().days.none { it.cancelled })
    }
    @Test fun sevenPastDatesRemainAvailableForCalendarAndInbox(){
        val feed=Feed();val repo=OfficialScheduleRepository(context,feed){now}
        assertTrue(repo.refresh());feed.articles=emptyList()
        now=Instant.parse("2026-10-28T09:00:00Z")
        assertTrue(repo.refresh());assertEquals(12,repo.snapshot().days.size)
        now=Instant.parse("2026-10-31T09:00:00Z")
        assertTrue(repo.refresh());assertTrue(repo.snapshot().days.isEmpty())
    }
    @Test fun afternoonRevisionKeepsCompletedMorningButDoesNotResurrectCancelledFutureWhenFetchedLate(){
        val feed=Feed(listOf(officialArticle(rows=allOfficialRows("08:00 - 10:00, 14:00 - 16:00, 20:00 - 22:00"))))
        val repo=OfficialScheduleRepository(context,feed){now};assertTrue(repo.refresh())
        val revisedAt=Instant.parse("2026-10-23T10:05:00Z")
        feed.articles=listOf(officialArticle(rows=allOfficialRows("20:00 - 22:00"),published=revisedAt))
        now=Instant.parse("2026-10-23T14:00:00Z") // fetched after the omitted 14–16 window, but published before it
        assertTrue(repo.refresh())
        val expected=listOf("08:00","20:00")
        assertEquals(expected,repo.snapshot().days.single{it.queue=="3.2"}.intervals.map{Presentation.time(it.start)})
        assertEquals(expected,OfficialScheduleRepository(context).snapshot().days.single{it.queue=="3.2"}.intervals.map{Presentation.time(it.start)})
        assertTrue(repo.refresh());assertEquals(expected,repo.snapshot().days.single{it.queue=="3.2"}.intervals.map{Presentation.time(it.start)})
    }

    @Test fun resetAcrossInstancesDiscardsInflightResponseAndLeavesNoCache() {
        val feed = Feed()
        val repo = OfficialScheduleRepository(context, feed) { now }
        feed.onFetch = { OfficialScheduleRepository(context).clear() }
        assertFalse(repo.refresh())
        assertTrue(repo.snapshot().days.isEmpty())
        assertTrue(repo.changes().isEmpty())
        assertTrue(context.getSharedPreferences("svitlo_official", Context.MODE_PRIVATE).all.isEmpty())
    }

    @Test fun readHistoryOperationsAreLocalAndScopedToQueue() {
        val repo = OfficialScheduleRepository(context, Feed()) { now }
        assertTrue(repo.refresh())
        val selected = repo.changes().single { it.queue == "3.2" }
        repo.markRead(selected.id)
        assertTrue(repo.changes().single { it.id == selected.id }.read)
        assertFalse(repo.changes().single { it.queue == "3.1" }.read)
        repo.markAllRead("3.1")
        repo.clearRead("3.2")
        assertFalse(repo.changes().any { it.queue == "3.2" })
        assertTrue(repo.changes().single { it.queue == "3.1" }.read)
    }

    @Test fun repeatedSuccessfulChecksDoNotCreateDuplicateHistory() {
        val repo = OfficialScheduleRepository(context, Feed()) { now }
        assertTrue(repo.refresh())
        now = now.plusSeconds(600)
        assertTrue(repo.refresh())
        assertEquals(12, repo.changes().size)
        assertEquals(now, repo.snapshot().days.first().fetchedAt)
    }

    @Test fun boundedHistoryCannotGrowIndefinitely() {
        val feed = Feed()
        val repo = OfficialScheduleRepository(context, feed) { now }
        repeat(12) { n ->
            feed.articles = listOf(officialArticle(rows = allOfficialRows("08:${n.toString().padStart(2, '0')} - 10:00")))
            assertTrue(repo.refresh())
        }
        assertTrue(repo.changes().size <= 100)
        val latestRevision = repo.snapshot().days.single { it.queue == "3.2" }.revision
        assertTrue(repo.changes().any { it.queue == "3.2" && it.revision == latestRevision })
    }

    @Test fun publicationWithUnrecognizedDateMarksPreservedFutureDaysUncertain() {
        val feed = Feed()
        val repo = OfficialScheduleRepository(context, feed) { now }
        assertTrue(repo.refresh())
        val before = repo.snapshot().days
        feed.articles = listOf(officialArticle(title = "Оновлено графік погодинних відключень (ГПВ)"))
        assertFalse(repo.refresh())
        assertEquals(before.map { it.intervals }, repo.snapshot().days.map { it.intervals })
        assertTrue(repo.snapshot().days.all { it.uncertain })
        assertTrue(repo.snapshot().issues.isNotEmpty())
    }

    @Test fun eachReversionToAPreviouslySeenScheduleCreatesANewLocalChange() {
        val feed = Feed()
        val repo = OfficialScheduleRepository(context, feed) { now }
        listOf("08:00 - 10:00", "09:00 - 11:00", "08:00 - 10:00", "09:00 - 11:00").forEach { times ->
            feed.articles = listOf(officialArticle(rows = allOfficialRows(times)))
            assertTrue(repo.refresh())
        }
        assertEquals(4, repo.changes().count { it.queue == "3.2" })
        assertEquals(48, repo.changes().map { it.id }.distinct().size)
    }

    @Test fun partialParsingFailureCommitsValidRowsButReportsAnIncompleteRefresh() {
        val feed = Feed()
        val repo = OfficialScheduleRepository(context, feed) { now }
        assertTrue(repo.refresh())
        now = now.plusSeconds(600)
        val rows = allOfficialRows("09:00 - 11:00").replace("3.2 09:00 - 11:00", "3.2 09:90 - 11:00")
        feed.articles = listOf(officialArticle(rows = rows))
        assertFalse(repo.refresh())
        assertTrue(repo.snapshot().failed)
        assertEquals(now, repo.snapshot().checkedAt)
        assertTrue(repo.snapshot().issues.isNotEmpty())
        assertEquals(Instant.parse("2026-10-23T06:00:00Z"), repo.snapshot().days.single { it.queue == "3.1" }.intervals.single().start)
        val uncertain = repo.snapshot().days.single { it.queue == "3.2" }
        assertTrue(uncertain.uncertain)
        assertEquals(Instant.parse("2026-10-23T05:00:00Z"), uncertain.intervals.single().start)
    }

    @Test fun bodyScopedCancellationPreservesAllOtherQueues() {
        val feed = Feed()
        val repo = OfficialScheduleRepository(context, feed) { now }
        assertTrue(repo.refresh())
        val before = repo.snapshot().days.single { it.queue == "3.1" }
        feed.articles = listOf(officialArticle(
            title = "Оновлено графік погодинних відключень (ГПВ) на 23 жовтня",
            rows = "<p>Для підчерги 3.2 ГПВ скасовано.</p>"))
        assertTrue(repo.refresh())
        assertTrue(repo.snapshot().days.single { it.queue == "3.2" }.cancelled)
        assertEquals(before, repo.snapshot().days.single { it.queue == "3.1" })
    }

    @Test fun oldUndatedExplanationDoesNotInvalidateCurrentDatedPublication() {
        val old = officialArticle(title = "Оновлено графік погодинних відключень (ГПВ)",
            published = now.minusSeconds(10 * 86_400L))
        val feed = Feed(listOf(officialArticle(), old))
        val repo = OfficialScheduleRepository(context, feed) { now }
        assertTrue(repo.refresh())
        assertTrue(repo.snapshot().days.none { it.uncertain })
        assertTrue(repo.snapshot().issues.isEmpty())
        assertFalse(repo.snapshot().failed)
        val before = repo.snapshot().days
        feed.articles = listOf(old)
        assertTrue(repo.refresh())
        assertEquals(before, repo.snapshot().days)
    }

    @Test fun unsupportedPartialDayCancellationRetainsTheKnownIntervals() {
        val feed = Feed()
        val repo = OfficialScheduleRepository(context, feed) { now }
        assertTrue(repo.refresh())
        val before = repo.snapshot().days
        feed.articles = listOf(officialArticle(
            title = "Графік погодинних відключень (ГПВ) на 23 жовтня скасовано з 14:00",
            rows = "<p>ГПВ скасовано з 14:00.</p>"))
        assertFalse(repo.refresh())
        assertEquals(before.map { it.intervals }, repo.snapshot().days.map { it.intervals })
        assertTrue(repo.snapshot().days.all { it.uncertain && !it.cancelled })
    }
    @Test fun irrelevantDatedExplanationOutsideCacheWindowCannotFailCurrentPublication(){
        val old=officialArticle(title="Графік погодинних відключень з 1 жовтня",rows="<p>Змінено правила застосування ГПВ.</p>",
            published=now.minusSeconds(21*86_400L))
        val repo=OfficialScheduleRepository(context,Feed(listOf(officialArticle(),old))){now}
        assertTrue(repo.refresh());assertFalse(repo.snapshot().failed);assertTrue(repo.snapshot().issues.isEmpty())
        assertEquals(12,repo.snapshot().days.size)
    }

    @Test fun lateDiscoveryOfOldScheduleSortsByPublicationNotDownloadTime(){
        now=Instant.parse("2026-10-23T13:00:00Z")
        val current=officialArticle(rows="<p>3.2 14:00 - 16:00</p>",
            title="Оновлено графік погодинних відключень на 23 жовтня",published=now.minusSeconds(3600),
            url="https://www.cherkasyoblenergo.com/media/current")
        val feed=Feed(listOf(current));val repo=OfficialScheduleRepository(context,feed){now}
        assertTrue(repo.refresh())
        val old=officialArticle(title="Оновлено графік погодинних відключень на 18 жовтня",rows="<p>3.2 08:00 - 10:00</p>",
            published=Instant.parse("2026-10-17T18:00:00Z"),url="https://www.cherkasyoblenergo.com/media/old")
        now=now.plusSeconds(3600);feed.articles=listOf(old,current);assertTrue(repo.refresh())
        val changes=repo.changes().filter{it.queue=="3.2"}
        assertEquals(listOf(current.publishedAt,old.publishedAt),changes.map{it.at})
        repo.markRead(changes.last().id)
        assertEquals(changes.map{it.id},repo.changes().filter{it.queue=="3.2"}.map{it.id})
    }

    @Test fun readingOfflinePrunesMessagesOlderThanSevenDaysButKeepsBoundary(){
        val article=officialArticle();val repo=OfficialScheduleRepository(context,Feed()){now}
        assertTrue(repo.refresh())
        now=article.publishedAt.plusSeconds(7*86400L)
        assertEquals(12,repo.changes().size)
        now=now.plusSeconds(1)
        assertTrue(repo.changes().isEmpty())
        assertEquals("[]",context.getSharedPreferences("svitlo_official",Context.MODE_PRIVATE).getString("history",null))
        assertEquals(12,repo.snapshot().days.size) // History expiry does not erase the schedule cache.
    }

    @Test fun existingPublishedMessagesRecoverSourceTimeOfflineAndKeepTheirIdsAndReadFlags(){
        now=Instant.parse("2026-10-23T13:00:00Z")
        val article=officialArticle(title="Оновлено графік погодинних відключень на 18 жовтня",rows="<p>3.2 08:00 - 10:00</p>",
            published=Instant.parse("2026-10-17T18:00:00Z"))
        val repo=OfficialScheduleRepository(context,Feed(listOf(article))){now};assertTrue(repo.refresh())
        val original=repo.changes().single()
        val prefs=context.getSharedPreferences("svitlo_official",Context.MODE_PRIVATE)
        val array=org.json.JSONArray(prefs.getString("history","[]"))
        array.getJSONObject(0).apply{put("at",now);put("read",true);remove("timeBasis")}
        prefs.edit().putString("history",array.toString()).commit()
        val migrated=OfficialScheduleRepository(context,Feed().apply{failing=true}){now}.changes().single()
        assertEquals(original.id,migrated.id);assertTrue(migrated.read)
        assertEquals(article.publishedAt,migrated.at)
        assertEquals("publication",org.json.JSONArray(prefs.getString("history","[]")).getJSONObject(0).getString("timeBasis"))
    }

    @Test fun inPlaceEditsUseDetectionTimeAndAreNotBackdatedOnReopen(){
        val feed=Feed();val repo=OfficialScheduleRepository(context,feed){now};assertTrue(repo.refresh())
        now=now.plusSeconds(1800)
        feed.articles=listOf(officialArticle(rows=allOfficialRows("09:00 - 11:00")))
        assertTrue(repo.refresh())
        val update=repo.changes().first{it.queue=="3.2" && it.kind=="updated"}
        assertEquals(now,update.at)
        assertEquals(now,OfficialScheduleRepository(context,feed){now}.changes().first{it.id==update.id}.at)
        assertTrue(repo.refresh());assertEquals(24,repo.changes().size)
    }

    @Test fun delayedDiscoveryOlderThanRetentionNeverCreatesAHistoryEntry(){
        now=Instant.parse("2026-10-23T13:00:00Z")
        val old=officialArticle(title="Оновлено графік погодинних відключень на 18 жовтня",rows="<p>3.2 08:00 - 10:00</p>",
            published=now.minusSeconds(8*86400L))
        val repo=OfficialScheduleRepository(context,Feed(listOf(old))){now};assertTrue(repo.refresh())
        assertEquals(1,repo.snapshot().days.size);assertTrue(repo.changes().isEmpty())
    }
}
