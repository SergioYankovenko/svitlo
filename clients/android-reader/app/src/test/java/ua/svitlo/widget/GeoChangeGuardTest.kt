package ua.svitlo.widget

import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class GeoChangeGuardTest {
    private val start = Instant.parse("2026-10-22T09:00:00Z")
    private val anchor = GeoAnchor(49.0, 31.0)
    private val twoHours = 7_200L
    private fun fix(seconds: Long, latitude: Double = 49.2, longitude: Double = 31.0,
        accuracy: Double = 30.0) = GeoFix(latitude, longitude, accuracy, start.plusSeconds(seconds))
    private fun observe(guard: GeoChangeGuard, seconds: Long, latitude: Double = 49.2) =
        guard.observe(fix(seconds, latitude), start.plusSeconds(seconds))

    @Test fun aSingleJumpCannotChangeOrSuggestChangingTheSavedPlace() {
        val guard = GeoChangeGuard(anchor)
        assertNull(guard.observe(fix(0, 51.0, 34.0), start))
        assertEquals(1, guard.candidateFixCount)
        assertFalse(guard.hasSuggested)
        assertEquals(GeoAnchor(49.0, 31.0), anchor)
    }

    @Test fun threeFreshConsistentFixesAtTwoHourIntervalsProduceOnlyASuggestion() {
        val guard = GeoChangeGuard(anchor)
        assertNull(observe(guard, 0))
        assertNull(observe(guard, twoHours, 49.2005))
        val suggestion = observe(guard, twoHours * 2, 49.1995)
        assertNotNull(suggestion)
        assertEquals(49.2, suggestion!!.latitude, 0.0001)
        assertEquals(31.0, suggestion.longitude, 0.0001)
        assertTrue(suggestion.distanceMetres in 22_000.0..22_500.0)
        assertEquals(3, guard.candidateFixCount)
        assertTrue(guard.hasSuggested)
        assertEquals(49.0, anchor.latitude, 0.0)
        assertEquals(31.0, anchor.longitude, 0.0)
    }

    @Test fun secondsMinutesAndOneHourCannotSatisfyTheObservationInterval() {
        val guard = GeoChangeGuard(anchor)
        observe(guard, 0)
        for (seconds in listOf(20L, 45L, 60L, 3_600L, 7_199L)) assertNull(observe(guard, seconds))
        assertEquals(1, guard.candidateFixCount)
        assertNull(observe(guard, twoHours))
        assertEquals(2, guard.candidateFixCount)
        assertNull(observe(guard, twoHours * 2 - 1))
        assertNotNull(observe(guard, twoHours * 2))
    }

    @Test fun sourceTimestampSpacingAloneDoesNotReplaceTwoHoursOfActualObservation() {
        val guard = GeoChangeGuard(anchor)
        guard.observe(fix(-60), start)
        assertNull(guard.observe(fix(7_140), start.plusSeconds(7_140)))
        assertEquals(1, guard.candidateFixCount) // Source gap is 2h; arrival gap is only 119 min.
        assertNull(observe(guard, twoHours))
        assertNotNull(observe(guard, twoHours * 2))
    }

    @Test fun actualObservationSpacingAloneDoesNotAllowAnEarlySourceTimestamp() {
        val guard = GeoChangeGuard(anchor)
        observe(guard, 0)
        assertNull(guard.observe(fix(twoHours - 60), start.plusSeconds(twoHours)))
        assertEquals(1, guard.candidateFixCount)
        assertNull(observe(guard, twoHours))
        assertNotNull(observe(guard, twoHours * 2))
    }

    @Test fun duplicatesOutOfOrderAndRepeatedCallbacksDoNotCount() {
        val guard = GeoChangeGuard(anchor)
        observe(guard, 0)
        assertNull(guard.observe(fix(0), start.plusSeconds(20)))
        assertNull(guard.observe(fix(-1), start.plusSeconds(20)))
        assertEquals(1, guard.candidateFixCount)
        observe(guard, twoHours)
        assertNull(guard.observe(fix(twoHours - 1), start.plusSeconds(twoHours + 1)))
        assertNull(observe(guard, twoHours + 10))
        assertEquals(2, guard.candidateFixCount)
    }

    @Test fun returningNearTheAnchorClearsHistoryEvenBeforeTheNextTwoHourSlot() {
        val guard = GeoChangeGuard(anchor)
        observe(guard, 0)
        observe(guard, twoHours)
        assertNull(observe(guard, twoHours + 10, 49.0001))
        assertEquals(0, guard.candidateFixCount)
        assertNull(observe(guard, twoHours * 2))
        assertEquals(1, guard.candidateFixCount)
    }

    @Test fun aMoveUnder10KilometresNeverStartsACandidate() {
        val guard = GeoChangeGuard(anchor)
        for (seconds in listOf(0L, twoHours, twoHours * 2)) assertNull(observe(guard, seconds, 49.08))
        assertEquals(0, guard.candidateFixCount)
    }

    @Test fun anInconsistentFreshJumpRestartsTheClusterInsteadOfKeepingOldEvidence() {
        val guard = GeoChangeGuard(anchor)
        observe(guard, 0)
        observe(guard, twoHours, 49.2005)
        assertNull(observe(guard, twoHours + 10, 50.0))
        assertEquals(1, guard.candidateFixCount)
        assertNull(observe(guard, twoHours * 2, 49.2))
        assertEquals(1, guard.candidateFixCount)
    }

    @Test fun aChainOfShortJumpsCannotReplaceAPairwiseConsistentCluster() {
        val guard = GeoChangeGuard(anchor)
        observe(guard, 0, 49.2)
        observe(guard, twoHours, 49.207) // ~780 m from first.
        assertNull(observe(guard, twoHours * 2, 49.214)) // >1 km from first.
        assertEquals(1, guard.candidateFixCount)
    }

    @Test fun invalidCoordinatesAccuracyAndArrivalTimesNeverCount() {
        val guard = GeoChangeGuard(anchor)
        val invalid = listOf(
            fix(0, Double.NaN), fix(0, Double.POSITIVE_INFINITY), fix(0, 91.0),
            fix(0, longitude = -181.0), fix(0, longitude = Double.NEGATIVE_INFINITY),
            fix(0, accuracy = Double.NaN), fix(0, accuracy = Double.POSITIVE_INFINITY),
            fix(0, accuracy = -1.0), fix(0, accuracy = 251.0), fix(-91), fix(6)
        )
        invalid.forEach { assertNull(guard.observe(it, start)) }
        assertEquals(0, guard.candidateFixCount)
    }

    @Test fun freshAtArrivalHistorySurvivesNewInstancesAndCompletesAfterFourHours() {
        val first = GeoChangeGuard(anchor)
        observe(first, 0)
        observe(first, twoHours)
        val restored = GeoChangeGuard(anchor, history = first.observations)
        assertEquals(2, restored.candidateFixCount)
        val suggestion = observe(restored, twoHours * 2)
        assertNotNull(suggestion)
        assertTrue(restored.hasSuggested)
    }

    @Test fun observationsOlderThan12HoursAreExcludedBeforeCombiningNewEvidence() {
        val guard = GeoChangeGuard(anchor)
        observe(guard, 0)
        observe(guard, twoHours)
        assertNull(observe(guard, 43_201))
        assertEquals(2, guard.candidateFixCount)
        assertEquals(start.plusSeconds(twoHours), guard.observations.first().observedAt)
    }

    @Test fun clockRollbackClearsFutureHistoryAndStartsANewAttempt() {
        val original = GeoChangeGuard(anchor)
        observe(original, 0)
        observe(original, twoHours)
        val restored = GeoChangeGuard(anchor, original.observations)
        assertNull(observe(restored, 3_600))
        assertEquals(1, restored.candidateFixCount)
        assertEquals(start.plusSeconds(3_600), restored.observations.single().observedAt)
    }

    @Test fun corruptedOrInconsistentRestoredHistoryIsDiscarded() {
        val first = GeoObservation(fix(0), start)
        val validSecond = GeoObservation(fix(twoHours), start.plusSeconds(twoHours))
        val histories = listOf(
            listOf(validSecond, first),
            listOf(first, GeoObservation(fix(3_600), start.plusSeconds(3_600))),
            listOf(first, GeoObservation(fix(twoHours, 51.0), start.plusSeconds(twoHours))),
            listOf(GeoObservation(fix(0), start.plusSeconds(91))),
            listOf(first, GeoObservation(fix(twoHours, accuracy = 300.0), start.plusSeconds(twoHours)))
        )
        histories.forEach { history -> assertEquals(0, GeoChangeGuard(anchor, history).candidateFixCount) }
    }

    @Test fun restoredEvidenceNearANewAnchorIsNotReusedForAnotherSavedPlace() {
        val original = GeoChangeGuard(anchor)
        observe(original, 0)
        observe(original, twoHours)
        assertEquals(0, GeoChangeGuard(GeoAnchor(49.2, 31.0), original.observations).candidateFixCount)
    }

    @Test fun historyCopiesCannotBeMutatedByTheCaller() {
        val history = mutableListOf(GeoObservation(fix(0), start),
            GeoObservation(fix(twoHours), start.plusSeconds(twoHours)))
        val guard = GeoChangeGuard(anchor, history)
        history.clear()
        assertEquals(2, guard.candidateFixCount)
        (guard.observations as MutableList<GeoObservation>).clear()
        assertEquals(2, guard.candidateFixCount)
    }

    @Test fun theProposalIsOneShotUntilExplicitReset() {
        val guard = GeoChangeGuard(anchor)
        observe(guard, 0)
        observe(guard, twoHours)
        assertNotNull(observe(guard, twoHours * 2))
        assertNull(observe(guard, twoHours * 3))
        guard.reset()
        assertEquals(0, guard.candidateFixCount)
        assertFalse(guard.hasSuggested)
        assertNull(observe(guard, twoHours * 4))
        assertNull(observe(guard, twoHours * 5))
        assertNotNull(observe(guard, twoHours * 6))
    }

    @Test fun centerHandlesACloseClusterAcrossTheDateLine() {
        val guard = GeoChangeGuard(GeoAnchor(49.0, 170.0))
        guard.observe(fix(0, 49.2, 179.999), start)
        guard.observe(fix(twoHours, 49.2, -179.999), start.plusSeconds(twoHours))
        val suggestion = guard.observe(fix(twoHours * 2, 49.2, 180.0), start.plusSeconds(twoHours * 2))
        assertNotNull(suggestion)
        assertTrue(kotlin.math.abs(suggestion!!.longitude) > 179.99)
    }

    @Test fun invalidAnchorsNeverProduceAProposedChange() {
        for (invalid in listOf(GeoAnchor(Double.NaN, 31.0), GeoAnchor(49.0, 181.0))) {
            val guard = GeoChangeGuard(invalid)
            listOf(0L, twoHours, twoHours * 2).forEach { assertNull(observe(guard, it)) }
            assertEquals(0, guard.candidateFixCount)
        }
    }

    @Test fun restoredHistoryRetainsOnlyTheLatestThreeObservations() {
        val history = (0L..3L).map { GeoObservation(fix(it * twoHours), start.plusSeconds(it * twoHours)) }
        val guard = GeoChangeGuard(anchor, history)
        assertEquals(3, guard.observations.size)
        assertEquals(start.plusSeconds(twoHours), guard.observations.first().observedAt)
    }

    @Test fun thresholdEdgeClusterUsesTheLatestThreeWithoutGrowingStoredHistory() {
        val guard = GeoChangeGuard(GeoAnchor(0.0, 0.0))
        fun point(seconds: Long, eastMetres: Double) = GeoFix(Math.toDegrees(9_998.0 / 6_371_008.8),
            Math.toDegrees(eastMetres / 6_371_008.8), 30.0, start.plusSeconds(seconds))
        guard.observe(point(0, -400.0), start)
        guard.observe(point(twoHours, 400.0), start.plusSeconds(twoHours))
        // Each point is just beyond 10 km, but their center is slightly inside it.
        assertNull(guard.observe(point(twoHours * 2, 300.0), start.plusSeconds(twoHours * 2)))
        assertEquals(3, guard.observations.size)
        assertNotNull(guard.observe(point(twoHours * 3, 350.0), start.plusSeconds(twoHours * 3)))
        assertEquals(3, guard.observations.size)
    }
}
