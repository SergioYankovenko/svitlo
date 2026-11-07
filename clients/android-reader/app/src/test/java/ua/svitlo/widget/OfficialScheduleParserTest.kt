package ua.svitlo.widget

import org.junit.Test
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.Instant
import java.time.LocalDate

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class OfficialScheduleParserTest {
    private val fetched = Instant.parse("2026-10-22T20:00:00Z")

    @Test fun officialScheduleParserIsAvailable() {
        // This first contract test starts red before the isolated module exists.
        assertNotNull(Class.forName("ua.svitlo.widget.OfficialScheduleParser"))
    }

    @Test fun realOfficialHtmlParsesAllQueuesAndKyivPublicationTime() {
        val article = OfficialScheduleParser.article(officialFixture("oct23.json"))
        val result = OfficialScheduleParser.parse(article, fetched)
        assertEquals(12, result.days.size)
        assertTrue(result.issues.isEmpty())
        val day = result.days.single { it.queue == "3.2" }
        assertEquals(LocalDate.of(2026, 10, 23), day.date)
        assertEquals(Instant.parse("2026-10-22T18:55:00Z"), day.publishedAt)
        assertEquals(listOf("05:00", "11:00", "17:00"), day.intervals.map { it.start.toString().substring(11, 16) })
        assertEquals(fetched, day.fetchedAt)
        assertFalse(day.uncertain)
        assertTrue(day.sourceUrl.contains("/media/hrafik-pohodynnykh"))
    }

    @Test fun midnight24IsTheFollowingKyivMidnight() {
        val result = OfficialScheduleParser.parse(officialArticle(rows = allOfficialRows("22:15 - 24:00")), fetched)
        assertEquals(Instant.parse("2026-10-23T21:00:00Z"), result.days.first().intervals.single().end)
    }

    @Test fun titleDateTakesPrecedenceOverStaleSlug() {
        val article = officialArticle(title = "Оновлено графік погодинних відключень (ГПВ) на 21 жовтня",
            rows = allOfficialRows(), url = "https://www.cherkasyoblenergo.com/media/na-19-zhovtnya")
        assertEquals(LocalDate.of(2026, 10, 21), OfficialScheduleParser.parse(article, fetched).days.first().date)
    }

    @Test fun explicitPartialCorrectionChangesOnlyMentionedQueue() {
        val result = OfficialScheduleParser.parse(officialArticle(
            title = "Уточнення графіка погодинних відключень (ГПВ) на 23 жовтня для підчерги 3.2",
            rows = "<p>3.2 08:15 – 10:45, 14:10 — 16:20</p>"), fetched)
        assertEquals(listOf("3.2"), result.days.map { it.queue })
        assertFalse(result.days.single().uncertain)
        assertEquals(Instant.parse("2026-10-23T05:15:00Z"), result.days.single().intervals.first().start)
    }

    @Test fun incompleteOrdinaryBulletinNeverLooksLikeACompleteFreeDay() {
        val result = OfficialScheduleParser.parse(officialArticle(rows = "<p>3.2 08:00 - 10:00</p>"), fetched)
        assertTrue(result.days.all { it.uncertain })
        assertEquals(12, result.days.size)
        assertTrue(result.issues.isNotEmpty())
    }

    @Test fun malformedTimesAreUncertainInsteadOfBeingRoundedOrDropped() {
        listOf("08:75 - 10:00", "25:00 - 26:00", "10:00 - 08:00", "08:00 - 08:00",
            "08:00 - 10:00, 09:00 - 11:00", "08:00 - 10:00, 14:00 -", "8-10").forEach { times ->
            val result = OfficialScheduleParser.parse(officialArticle(rows = allOfficialRows(times)), fetched)
            assertTrue(times, result.days.all { it.uncertain && it.intervals.isEmpty() })
            assertTrue(times, result.issues.isNotEmpty())
        }
    }

    @Test fun touchingIntervalsAreNormalizedWithoutLosingMinutes() {
        val result = OfficialScheduleParser.parse(officialArticle(rows = allOfficialRows("08:15-09:30,09:30-10:45")), fetched)
        val day = result.days.first()
        assertFalse(day.uncertain)
        assertEquals(1, day.intervals.size)
        assertEquals(Instant.parse("2026-10-23T07:45:00Z"), day.intervals.single().end)
    }

    @Test fun industrialPowerLimitNewsIsNotAnHourlyHouseholdSchedule() {
        val result = OfficialScheduleParser.parse(officialArticle(
            title = "Для промисловості та бізнесу 23 жовтня діятимуть графіки обмеження потужності (ГОП)",
            rows = allOfficialRows()), fetched)
        assertTrue(result.days.isEmpty())
    }

    @Test fun explicitCancellationIsDistinctFromAnEmptySchedule() {
        val result = OfficialScheduleParser.parse(officialArticle(
            title = "Графік погодинних відключень (ГПВ) на 23 жовтня скасовано",
            rows = "<p>ГПВ на 23 жовтня скасовано.</p>"), fetched)
        assertEquals(12, result.days.size)
        assertTrue(result.days.all { it.cancelled && !it.uncertain && it.intervals.isEmpty() })
    }

    @Test fun ambiguousDateProducesAnIssueAndNoGuessedDay() {
        val result = OfficialScheduleParser.parse(officialArticle(
            title = "Графік погодинних відключень (ГПВ)", rows = allOfficialRows()), fetched)
        assertTrue(result.days.isEmpty())
        assertTrue(result.issues.isNotEmpty())
    }

    @Test fun repeatedDstHourIsFlaggedInsteadOfSilentlyChoosingAnOffset() {
        val result = OfficialScheduleParser.parse(officialArticle(
            title = "Графік погодинних відключень (ГПВ) на 25 жовтня", rows = allOfficialRows("03:15-03:45")), fetched)
        assertTrue(result.days.all { it.uncertain })
    }

    @Test fun cosmeticHtmlChangesDoNotChangeScheduleRevision() {
        val first = officialArticle(rows = allOfficialRows("08:15 - 10:45"))
        val second = first.copy(content = first.content.replace("08:15", "<span>08</span>:15").replace(" - ", "&nbsp;–&nbsp;"))
        assertEquals(OfficialScheduleParser.parse(first, fetched).days.map { it.revision },
            OfficialScheduleParser.parse(second, fetched.plusSeconds(100)).days.map { it.revision })
    }

    @Test fun genericChangeDisclaimerDoesNotAuthorizePartialReplacement() {
        val result = OfficialScheduleParser.parse(officialArticle(rows =
            "<p>3.2 08:00 - 10:00</p><p>У графіках можливі зміни протягом доби.</p>"), fetched)
        assertEquals(12, result.days.size)
        assertTrue(result.days.all { it.uncertain })
    }

    @Test fun cancellationHeadingWithConflictingIntervalRowsIsUncertain() {
        val result = OfficialScheduleParser.parse(officialArticle(
            title = "Графік погодинних відключень (ГПВ) на 23 жовтня скасовано", rows = allOfficialRows()), fetched)
        assertTrue(result.days.all { it.uncertain && !it.cancelled })
    }

    @Test fun tableCellsAndBreaksPreserveQueueBoundaries() {
        val table = "<table>" + (1..6).flatMap { q -> (1..2).map { s ->
            "<tr><td>$q.$s</td><td>08:15 - 10:30</td></tr>"
        } }.joinToString("") + "</table>"
        val result = OfficialScheduleParser.parse(officialArticle(rows = table), fetched)
        assertEquals(12, result.days.size)
        assertTrue(result.days.none { it.uncertain })
    }

    @Test fun lineBreakInsideQueueTimesDoesNotDropTheLaterInterval() {
        val result = OfficialScheduleParser.parse(officialArticle(rows =
            allOfficialRows("08:15 - 10:30<br>14:10 - 16:20")), fetched)
        assertTrue(result.days.none { it.uncertain })
        assertTrue(result.days.all { it.intervals.size == 2 })
        assertEquals(Instant.parse("2026-10-23T11:10:00Z"), result.days.first().intervals.last().start)
    }

    @Test fun negatedCancellationNeverBecomesAnAffirmativeCancellation() {
        listOf("не скасовано", "скасований не буде").forEach { wording ->
            val result = OfficialScheduleParser.parse(officialArticle(
                title = "Графік погодинних відключень (ГПВ) на 23 жовтня $wording",
                rows = "<p>Інформація офіційного джерела.</p>"), fetched)
            assertTrue(wording, result.days.none { it.cancelled })
            assertTrue(wording, result.days.all { it.uncertain })
            assertTrue(wording, result.issues.isNotEmpty())
        }
    }

    @Test fun cancellationMentionedOnlyInBodyIsLimitedToExplicitlyNamedQueue() {
        val result = OfficialScheduleParser.parse(officialArticle(
            title = "Оновлено графік погодинних відключень (ГПВ) на 23 жовтня",
            rows = "<p>Для підчерги 3.2 ГПВ скасовано.</p>"), fetched)
        assertEquals(listOf("3.2"), result.days.map { it.queue })
        assertTrue(result.days.single().cancelled)
    }

    @Test fun disclaimerAndNoChangeTitlesDoNotAuthorizePartialReplacement() {
        listOf("можливі зміни", "без змін", "не оновлено").forEach { suffix ->
            val result = OfficialScheduleParser.parse(officialArticle(
                title = "Графік погодинних відключень (ГПВ) на 23 жовтня — $suffix",
                rows = "<p>3.2 09:00 - 11:00</p>"), fetched)
            assertEquals(suffix, 12, result.days.size)
            assertTrue(suffix, result.days.all { it.uncertain })
        }
    }

    @Test fun timeAndDurationQualifiedCancellationIsNeverAnAllDayCancellation() {
        val cases = listOf(
            officialArticle(title = "Графік погодинних відключень (ГПВ) на 23 жовтня скасовано з 14:00",
                rows = "<p>ГПВ скасовано з 14:00.</p>"),
            officialArticle(rows = "<p>ГПВ скасовано на 3 години.</p>"),
            officialArticle(rows = "<p>Для підчерги 3.2 ГПВ скасовано з 14 години.</p>")
        )
        cases.forEach { article ->
            val result = OfficialScheduleParser.parse(article, fetched)
            assertTrue(result.days.isNotEmpty())
            assertTrue(result.days.all { it.uncertain && !it.cancelled })
            assertTrue(result.issues.isNotEmpty())
        }
        val scoped = OfficialScheduleParser.parse(cases.last(), fetched)
        assertEquals(listOf("3.2"), scoped.days.map { it.queue })
    }

    @Test fun clocksInOtherQueuesDoNotQualifyAnExplicitQueueCancellation() {
        val cases = listOf(
            officialArticle(rows = allOfficialRows().replace("3.2 08:00 - 10:00", "3.2 скасовано")),
            officialArticle(title = "Оновлено графік погодинних відключень (ГПВ) на 23 жовтня",
                rows = "<p>3.1 08:00 - 10:00</p><p>3.2 скасовано</p>")
        )
        cases.forEach { article ->
            val result = OfficialScheduleParser.parse(article, fetched)
            assertTrue(result.issues.isEmpty())
            assertTrue(result.days.none { it.uncertain })
            assertTrue(result.days.single { it.queue == "3.2" }.cancelled)
            assertEquals(1, result.days.single { it.queue == "3.1" }.intervals.size)
        }
    }
}

internal fun officialFixture(name: String): String = requireNotNull(
    OfficialScheduleParserTest::class.java.getResourceAsStream("/official-feed/$name")).bufferedReader().use { it.readText() }

internal fun allOfficialRows(times: String = "08:00 - 10:00"): String =
    (1..6).flatMap { queue -> (1..2).map { sub -> "<p>$queue.$sub $times</p>" } }.joinToString("")

internal fun officialArticle(title: String = "Графік погодинних відключень (ГПВ) на 23 жовтня",
    rows: String = allOfficialRows(), published: Instant = Instant.parse("2026-10-22T18:55:00Z"),
    url: String = "https://www.cherkasyoblenergo.com/media/test-schedule") =
    OfficialArticle("test", title, rows, published, url)
