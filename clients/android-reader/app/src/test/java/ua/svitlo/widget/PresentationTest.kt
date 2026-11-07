package ua.svitlo.widget

import org.junit.Assert.*
import org.junit.Test
import ua.svitlo.widget.core.*
import java.time.Instant
import java.time.LocalDate

class PresentationTest {
    private val now = Instant.parse("2026-10-22T08:00:00Z")
    private fun snapshot(events: List<Outage> = emptyList(), at: Instant = now) = Snapshot(Category.entries.associateWith {
        CategorySnapshot(it, at, at, events.filter { event -> event.category == it }, testQueue(it))
    })
    private fun outage(
        start: Instant,
        end: Instant?,
        category: Category = Category.SCHEDULE,
        approximate: Boolean = false
    ) = Outage(category, start, end, approximate, "Застосовано", category.label)
    @Test fun emptyDataDoesNotClaimPowerIsOn() {
        assertEquals("Відключень у відповіді немає", Presentation.headline(snapshot(), now))
    }
    @Test fun missingCategoryNeverClaimsCompleteSchedule() {
        val partial = snapshot().copy(failures = setOf(Category.EMERGENCY))
        assertTrue(Presentation.headline(partial, now).contains("неповні"))
    }
    @Test fun expiredOutageIsNotReportedAsCurrent() {
        val event = Outage(Category.SCHEDULE, now.minusSeconds(7200), now.minusSeconds(60), true, "Застосовано", "ГПВ")
        assertEquals("Відключень у відповіді немає", Presentation.headline(snapshot(listOf(event)), now))
    }
    @Test fun plannedRestorationIsExplicitlyApproximate() {
        val event = Outage(Category.SCHEDULE, now.minusSeconds(3600), now.plusSeconds(3600), true, "Застосовано", "ГПВ")
        assertTrue(Presentation.headline(snapshot(listOf(event)), now).contains("орієнтовно"))
    }

    @Test fun unavailableOrUntrustedDataNeverClaimsPowerOrAConfidentTime() {
        val active = outage(now.minusSeconds(60), now.plusSeconds(3600))
        val complete = snapshot(listOf(active))
        val category = complete.categories.getValue(Category.SCHEDULE)
        val untrusted = listOf(
            complete.copy(categories = complete.categories - Category.EMERGENCY),
            complete.copy(failures = setOf(Category.PLANNED)),
            complete.copy(categories = complete.categories + (Category.SCHEDULE to category.copy(sourceUpdatedAt = null))),
            complete.copy(categories = complete.categories + (Category.SCHEDULE to category.copy(sourceUpdatedAt = now.plusSeconds(301)))),
            complete.copy(categories = complete.categories + (Category.SCHEDULE to category.copy(fetchedAt = now.minusSeconds(7201))))
        )
        assertEquals("Графік недоступний", Presentation.widgetStatus(Snapshot(emptyMap()), now))
        assertEquals(Presentation.WidgetSignal.UNKNOWN, Presentation.widgetSignal(Snapshot(emptyMap()), now))
        untrusted.forEach {
            assertEquals("Оновіть графік", Presentation.widgetStatus(it, now))
            assertEquals(Presentation.WidgetSignal.UNKNOWN, Presentation.widgetSignal(it, now))
        }
    }

    @Test fun knownAndApproximateActiveRestorationHaveShortHumanLabels() {
        val active = outage(now.minusSeconds(60), now.plusSeconds(3600))
        assertEquals("До відновлення 1 год", Presentation.widgetStatus(snapshot(listOf(active)), now))
        assertEquals("До відновлення ≈ 1 год", Presentation.widgetStatus(snapshot(listOf(active.copy(plannedEnd = true))), now))
    }
    @Test fun successfulRecentVerificationCanConfirmAnUnchangedOlderPublication(){
        val data=snapshot(listOf(outage(now.minusSeconds(60),now.plusSeconds(3600))))
        val verified=data.copy(categories=data.categories.mapValues{(_,value)->value.copy(sourceUpdatedAt=now.minusSeconds(10800))})
        assertEquals("До відновлення 1 год",Presentation.widgetStatus(verified,now))
    }

    @Test fun restorationFollowsConnectedUnionAcrossCategoriesAndStopsAtAGap() {
        val events = listOf(
            outage(now.minusSeconds(3600), now.plusSeconds(1800)),
            outage(now.minusSeconds(60), now.plusSeconds(3600), Category.PLANNED),
            outage(now.plusSeconds(3600), now.plusSeconds(5400), Category.EMERGENCY, approximate = true),
            outage(now.plusSeconds(5300), now.plusSeconds(7200)),
            outage(now.plusSeconds(7201), now.plusSeconds(10800), Category.EMERGENCY)
        )
        assertEquals("До відновлення ≈ 2 год", Presentation.widgetStatus(snapshot(events.reversed()), now))
        // The future emergency delays restoration, but it has not begun yet.
        assertEquals(Presentation.WidgetSignal.PLANNED, Presentation.widgetSignal(snapshot(events), now))
    }

    @Test fun openEndedOutageOnlyMakesItsConnectedRestorationUnknown() {
        val active = outage(now.minusSeconds(60), now.plusSeconds(3600))
        val connected = outage(now.plusSeconds(3600), null, Category.EMERGENCY)
        assertEquals("Час увімкнення невідомий", Presentation.widgetStatus(snapshot(listOf(active.copy(end = null))), now))
        assertEquals(Presentation.WidgetSignal.PLANNED, Presentation.widgetSignal(snapshot(listOf(active.copy(end = null))), now))
        assertEquals("Час увімкнення невідомий", Presentation.widgetStatus(snapshot(listOf(active, connected)), now))
        assertEquals("До відновлення 1 год", Presentation.widgetStatus(snapshot(listOf(active, connected.copy(start = now.plusSeconds(3601)))), now))
    }

    @Test fun exactStartIsActiveAndExactEndIsAlreadyRestored() {
        val ending = outage(now.minusSeconds(3600), now, Category.EMERGENCY)
        assertEquals("Є світло за графіком", Presentation.widgetStatus(snapshot(listOf(ending)), now))
        assertEquals(Presentation.WidgetSignal.POWER, Presentation.widgetSignal(snapshot(listOf(ending)), now))
        val starting = outage(now, now.plusSeconds(3600), Category.PLANNED)
        assertEquals("До відновлення 1 год", Presentation.widgetStatus(snapshot(listOf(ending, starting)), now))
        assertEquals(Presentation.WidgetSignal.PLANNED, Presentation.widgetSignal(snapshot(listOf(ending, starting)), now))
    }

    @Test fun nearFutureCountdownCeilsPositiveRealMinutesWithoutPrematureZero() {
        val cases = listOf(
            now.plusNanos(1) to "1 хв",
            now.plusSeconds(59) to "1 хв",
            now.plusSeconds(60) to "1 хв",
            now.plusSeconds(60).plusNanos(1) to "2 хв",
            now.plusSeconds(3599) to "1 год",
            now.plusSeconds(3600) to "1 год",
            now.plusSeconds(3661) to "1 год 2 хв",
            now.plusSeconds(7200) to "2 год"
        )
        cases.forEach { (start, label) ->
            val next = outage(start, start.plusSeconds(3600))
            assertEquals("start=$start", "Відключення через $label", Presentation.widgetStatus(snapshot(listOf(next)), now))
        }
        val later = outage(now.plusSeconds(7200).plusNanos(1), now.plusSeconds(10800))
        assertEquals("Відключення о 13:00", Presentation.widgetStatus(snapshot(listOf(later)), now))
    }

    @Test fun futureOutagesUseTodayTomorrowAndLaterDateLabels() {
        val labels = listOf(
            Instant.parse("2026-10-22T13:00:00Z") to "Відключення о 16:00",
            Instant.parse("2026-10-23T06:00:00Z") to "Відключення завтра о 09:00",
            Instant.parse("2026-10-24T06:00:00Z") to "Відключення 24.10 о 09:00"
        )
        labels.forEach { (start, label) ->
            assertEquals(label, Presentation.widgetStatus(snapshot(listOf(outage(start, start.plusSeconds(3600)))), now))
        }
    }

    @Test fun restorationDateIsExplicitWhenOutageContinuesPastMidnight() {
        val labels = listOf(
            Instant.parse("2026-10-23T06:00:00Z") to "До відновлення 22 год",
            Instant.parse("2026-10-24T06:00:00Z") to "До відновлення 46 год"
        )
        labels.forEach { (end, label) ->
            assertEquals(label, Presentation.widgetStatus(snapshot(listOf(outage(now.minusSeconds(60), end))), now))
        }
    }

    @Test fun midnightLabelsUseKyivDateEvenWhenUtcDateHasNotChanged() {
        val at = Instant.parse("2026-10-22T20:30:00Z") // 23:30 Kyiv
        val start = Instant.parse("2026-10-22T21:15:00Z") // 00:15 tomorrow Kyiv
        assertEquals("Відключення завтра о 00:15", Presentation.widgetStatus(snapshot(listOf(outage(start, start.plusSeconds(3600))), at), at))
        assertEquals("До відновлення 45 хв", Presentation.widgetStatus(snapshot(listOf(outage(at.minusSeconds(60), start)), at), at))
    }

    @Test fun countdownUsesElapsedTimeAcrossBothDstTransitions() {
        val transitions = listOf(
            Instant.parse("2026-03-29T00:30:00Z") to Instant.parse("2026-03-29T01:30:00Z"),
            Instant.parse("2026-10-25T00:30:00Z") to Instant.parse("2026-10-25T01:30:00Z")
        )
        transitions.forEach { (at, start) ->
            assertEquals("Відключення через 1 год", Presentation.widgetStatus(snapshot(listOf(outage(start, start.plusSeconds(3600))), at), at))
        }
    }

    @Test fun emptyDayIsUnknownButPublishedPastIntervalMakesTheCurrentGapKnown() {
        assertEquals("Стан світла невідомий", Presentation.widgetStatus(snapshot(), now))
        assertEquals(Presentation.WidgetSignal.UNKNOWN, Presentation.widgetSignal(snapshot(), now))
        val endedToday = outage(now.minusSeconds(3600), now.minusSeconds(60))
        assertEquals("Є світло за графіком", Presentation.widgetStatus(snapshot(listOf(endedToday)), now))
        assertEquals(Presentation.WidgetSignal.POWER, Presentation.widgetSignal(snapshot(listOf(endedToday)), now))
        val endedYesterday = outage(now.minusSeconds(86400), now.minusSeconds(82800))
        assertEquals("Стан світла невідомий", Presentation.widgetStatus(snapshot(listOf(endedYesterday)), now))
        assertEquals(Presentation.WidgetSignal.UNKNOWN, Presentation.widgetSignal(snapshot(listOf(endedYesterday)), now))
    }

    @Test fun dayEvidenceUsesHalfOpenKyivDayAcrossBothDstDays() {
        listOf(LocalDate.of(2026, 3, 29), LocalDate.of(2026, 10, 25)).forEach { day ->
            val midnight = day.atStartOfDay(KYIV_ZONE).toInstant()
            val at = midnight.plusSeconds(3600)
            val endsAtBoundary = outage(midnight.minusSeconds(3600), midnight)
            val crossesBoundary = endsAtBoundary.copy(end = midnight.plusSeconds(60))
            assertEquals("Стан світла невідомий", Presentation.widgetStatus(snapshot(listOf(endsAtBoundary), at), at))
            assertEquals(Presentation.WidgetSignal.UNKNOWN, Presentation.widgetSignal(snapshot(listOf(endsAtBoundary), at), at))
            assertEquals("Є світло за графіком", Presentation.widgetStatus(snapshot(listOf(crossesBoundary), at), at))
        }
    }

    @Test fun signalMatchesActivePriorityAndOtherwiseTheDisplayedNextOutage() {
        val planned = outage(now.minusSeconds(60), now.plusSeconds(3600), Category.PLANNED)
        val emergency = planned.copy(category = Category.EMERGENCY, end = null)
        assertEquals(Presentation.WidgetSignal.EMERGENCY, Presentation.widgetSignal(snapshot(listOf(planned, emergency)), now))
        assertEquals(Presentation.WidgetSignal.PLANNED, Presentation.widgetSignal(snapshot(listOf(planned)), now))
        assertEquals(Presentation.WidgetSignal.PLANNED, Presentation.widgetSignal(snapshot(listOf(planned.copy(category = Category.SCHEDULE))), now))
        val nextEmergency = outage(now.plusSeconds(3600), now.plusSeconds(7200), Category.EMERGENCY)
        assertEquals("Відключення через 1 год", Presentation.widgetStatus(snapshot(listOf(nextEmergency)), now))
        assertEquals(Presentation.WidgetSignal.EMERGENCY, Presentation.widgetSignal(snapshot(listOf(nextEmergency)), now))
        val nextPlanned = nextEmergency.copy(category = Category.PLANNED)
        assertEquals(Presentation.WidgetSignal.PLANNED, Presentation.widgetSignal(snapshot(listOf(nextPlanned)), now))
        // A next-day published event describes a future outage, never a green claim about today.
        assertEquals(Presentation.WidgetSignal.EMERGENCY, Presentation.widgetSignal(snapshot(listOf(nextEmergency.copy(start = now.plusSeconds(86400), end = null))), now))
    }
}
