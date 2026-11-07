package ua.svitlo.widget

import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.io.InterruptedIOException

class OfficialFeedSourceTest {
    @Test fun fetchUsesOnlyBoundedOfficialPublicEndpointsAndIgnoresIndustrialNews() {
        val requests = mutableListOf<String>()
        val source = CherkasyOfficialFeedSource { url ->
            requests += url
            if (url.contains("/category/")) officialFixture("news.json") else officialFixture("oct23.json")
        }
        val articles = source.fetch()
        assertTrue(articles.isNotEmpty())
        assertTrue(requests.all { it.startsWith("https://www.cherkasyoblenergo.com/api/v1/posts/") })
        assertTrue(requests.count { it.contains("/category/") } <= 4)
        assertTrue(requests.size <= 28)
        assertFalse(requests.any { it.contains("potuzhnosti") })
        assertFalse(requests.any { it.contains("account") || it.contains("address") })
    }

    @Test fun apiFailureEnvelopeCannotBecomeAnEmptySuccessfulFeed() {
        val source = CherkasyOfficialFeedSource { "{\"success\":false,\"data\":{}}" }
        assertThrows(Exception::class.java) { source.fetch() }
    }

    @Test fun untrustedSlugCannotTurnIntoAnExternalRequest() {
        val requests = mutableListOf<String>()
        val source = CherkasyOfficialFeedSource { url ->
            requests += url
            """{"success":true,"data":{"content":[{"title":"Графік погодинних відключень (ГПВ)","slug":"https://evil.test/x"}],"last":true}}"""
        }
        assertThrows(Exception::class.java) { source.fetch() }
        assertEquals(1, requests.size)
    }

    @Test fun oversizedResponseIsRejectedBeforeParsing() {
        val source = CherkasyOfficialFeedSource { " ".repeat(1_048_577) }
        assertThrows(IllegalArgumentException::class.java) { source.fetch() }
    }

    @Test fun sourceLinksRequireOfficialHttpsAndRejectUserInfoAndAlternatePorts() {
        listOf("http://www.cherkasyoblenergo.com/media/x", "https://evil.test/media/x",
            "https://evil.test@www.cherkasyoblenergo.com/media/x", "https://www.cherkasyoblenergo.com:444/media/x")
            .forEach { assertFalse(it, officialUrl(it)) }
    }

    @Test fun anInterruptedWorkerCannotStartAPublicRequest() {
        var calls = 0
        val source = CherkasyOfficialFeedSource { url ->
            calls++
            officialFixture(if (url.contains("/category/")) "news.json" else "oct23.json")
        }
        Thread.currentThread().interrupt()
        try {
            assertThrows(InterruptedIOException::class.java) { source.fetch() }
            assertEquals(0, calls)
        } finally { Thread.interrupted() }
    }

    @Test fun interruptionBetweenRequestsStopsTheRemainingPagination() {
        var calls = 0
        val source = CherkasyOfficialFeedSource { url ->
            calls++
            Thread.currentThread().interrupt()
            officialFixture(if (url.contains("/category/")) "news.json" else "oct23.json")
        }
        try {
            assertThrows(InterruptedIOException::class.java) { source.fetch() }
            assertEquals(1, calls)
        } finally { Thread.interrupted() }
    }

    @Test fun ninetySecondBudgetStopsNewRequestsEvenWhenMorePagesExist() {
        var elapsed = 0L
        var calls = 0
        val source = CherkasyOfficialFeedSource(nanoTime = { elapsed }) { url ->
            calls++
            elapsed += 91_000_000_000L
            officialFixture(if (url.contains("/category/")) "news.json" else "oct23.json")
        }
        assertThrows(IOException::class.java) { source.fetch() }
        assertEquals(1, calls)
    }
}
