package ua.svitlo.widget

import java.time.Instant
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

data class GeoFix(val latitude: Double, val longitude: Double, val accuracyMeters: Double, val time: Instant)
data class GeoAnchor(val latitude: Double, val longitude: Double)
data class GeoObservation(val fix: GeoFix, val observedAt: Instant)
data class GeoChangeSuggestion(val latitude: Double, val longitude: Double, val distanceMetres: Double)

/**
 * A proposal only: stable GPS spoofing can still pass. The saved weather place
 * must remain unchanged until explicit user confirmation. No network or Android
 * dependencies; the caller owns history storage, consent and prompt cooldown.
 *
 * Requires three coherent observations at least two hours apart, over at least
 * four hours. Freshness applies at receipt; evidence expires after twelve hours.
 * Intended for one foreground callback thread.
 */
class GeoChangeGuard(private val anchor: GeoAnchor, history: List<GeoObservation> = emptyList()) {
    private val candidates = mutableListOf<GeoObservation>()
    val observations: List<GeoObservation> get() = candidates.toList()
    val candidateFixCount: Int get() = candidates.size
    var hasSuggested: Boolean = false
        private set

    init {
        if (validHistory(history)) {
            val newest = history.lastOrNull()?.observedAt
            if (newest != null) candidates += history.filter { it.observedAt >= newest.minusSeconds(HISTORY_SECONDS) }.takeLast(3)
        }
    }

    fun observe(fix: GeoFix, now: Instant): GeoChangeSuggestion? {
        // Do not combine observations across a backwards wall-clock change.
        if (candidates.any { it.observedAt > now || it.fix.time > now.plusSeconds(5) }) candidates.clear()
        candidates.removeAll { it.observedAt < now.minusSeconds(HISTORY_SECONDS) }
        if (hasSuggested || !validCoordinates(anchor.latitude, anchor.longitude) || !validFix(fix, now)) return null

        if (fromAnchor(fix) < MINIMUM_DISTANCE_METRES) {
            candidates.clear()
            return null
        }

        val last = candidates.lastOrNull()
        if (last != null && fix.time <= last.fix.time) return null
        // A contradictory fresh position invalidates the old cluster, even when
        // this callback arrives before the next eligible two-hour observation.
        if (candidates.any { separation(it.fix, fix) > CLUSTER_METRES }) candidates.clear()
        val previous = candidates.lastOrNull()
        if (previous != null && (fix.time < previous.fix.time.plusSeconds(INTERVAL_SECONDS) ||
                now < previous.observedAt.plusSeconds(INTERVAL_SECONDS))) return null

        candidates += GeoObservation(fix, now)
        if (candidates.size > 3) candidates.removeAt(0)
        if (candidates.size < 3 || fix.time < candidates.first().fix.time.plusSeconds(SPAN_SECONDS) ||
            now < candidates.first().observedAt.plusSeconds(SPAN_SECONDS)) return null

        val center = center()
        val displacement = distance(anchor.latitude, anchor.longitude, center.first, center.second)
        if (displacement < MINIMUM_DISTANCE_METRES) return null
        hasSuggested = true
        return GeoChangeSuggestion(center.first, center.second, displacement)
    }

    /** Explicitly clears this attempt, without changing the saved anchor. */
    fun reset() {
        candidates.clear()
        hasSuggested = false
    }

    private fun validHistory(history: List<GeoObservation>): Boolean {
        if (!validCoordinates(anchor.latitude, anchor.longitude)) return false
        for ((index, observation) in history.withIndex()) {
            if (!validFix(observation.fix, observation.observedAt) || fromAnchor(observation.fix) < MINIMUM_DISTANCE_METRES) return false
            val previous = history.getOrNull(index - 1)
            if (previous != null && (observation.observedAt < previous.observedAt.plusSeconds(INTERVAL_SECONDS) ||
                    observation.fix.time < previous.fix.time.plusSeconds(INTERVAL_SECONDS))) return false
            if (history.take(index).any { separation(it.fix, observation.fix) > CLUSTER_METRES }) return false
        }
        return true
    }

    private fun validFix(fix: GeoFix, observedAt: Instant): Boolean =
        validCoordinates(fix.latitude, fix.longitude) && fix.accuracyMeters.isFinite() &&
            fix.accuracyMeters in 0.0..250.0 && fix.time >= observedAt.minusSeconds(90) &&
            fix.time <= observedAt.plusSeconds(5)

    private fun validCoordinates(latitude: Double, longitude: Double): Boolean =
        latitude.isFinite() && latitude in -90.0..90.0 && longitude.isFinite() && longitude in -180.0..180.0

    private fun fromAnchor(fix: GeoFix): Double = distance(anchor.latitude, anchor.longitude, fix.latitude, fix.longitude)
    private fun separation(first: GeoFix, second: GeoFix): Double =
        distance(first.latitude, first.longitude, second.latitude, second.longitude)

    private fun center(): Pair<Double, Double> {
        var x = 0.0
        var y = 0.0
        var z = 0.0
        for (observation in candidates) {
            val lat = Math.toRadians(observation.fix.latitude)
            val lon = Math.toRadians(observation.fix.longitude)
            x += cos(lat) * cos(lon)
            y += cos(lat) * sin(lon)
            z += sin(lat)
        }
        return Math.toDegrees(atan2(z, sqrt(x * x + y * y))) to Math.toDegrees(atan2(y, x))
    }

    private fun distance(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
        val first = Math.toRadians(lat1)
        val second = Math.toRadians(lat2)
        val halfLat = sin((second - first) / 2.0)
        val halfLon = sin(Math.toRadians(lon2 - lon1) / 2.0)
        val a = (halfLat * halfLat + cos(first) * cos(second) * halfLon * halfLon).coerceIn(0.0, 1.0)
        return 2.0 * 6_371_008.8 * atan2(sqrt(a), sqrt(1.0 - a))
    }

    companion object {
        private const val INTERVAL_SECONDS = 7_200L
        private const val SPAN_SECONDS = 14_400L
        private const val HISTORY_SECONDS = 43_200L
        private const val MINIMUM_DISTANCE_METRES = 10_000.0
        private const val CLUSTER_METRES = 1_000.0
    }
}
