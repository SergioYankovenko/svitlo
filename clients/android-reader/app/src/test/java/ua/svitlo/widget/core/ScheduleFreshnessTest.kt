package ua.svitlo.widget.core

import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class ScheduleFreshnessTest {
    private val now=Instant.parse("2026-10-23T06:00:00Z")
    @Test fun successfulCheckOfUnchangedSourceIsFreshWithoutRewritingSourceTimestamp() {
        val publication=now.minusSeconds(12*3600)
        val snapshot=CategorySnapshot(Category.SCHEDULE,publication,now,emptyList(),emptyList())
        assertTrue(snapshot.isFresh(now))
        assertEquals(publication,snapshot.sourceUpdatedAt)
    }
    @Test fun yesterdayFetchDoesNotBecomeFreshBecauseTheSourceTimestampLooksRecent() {
        assertFalse(CategorySnapshot(Category.SCHEDULE,now,now.minusSeconds(12*3600),emptyList(),emptyList()).isFresh(now))
    }
}
