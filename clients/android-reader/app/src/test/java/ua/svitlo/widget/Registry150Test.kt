package ua.svitlo.widget

import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.json.JSONObject
import java.time.Instant

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[28])
class Registry150Test {
    private val now=Instant.parse("2026-10-25T08:00:00Z")
    private fun match(queue:String="3.2")=JSONObject().put("queue",queue).put("status","matched").put("source","official_registry")
        .put("scope","street_all").put("url","https://www.cherkasyoblenergo.com/cherkasyoblenergo/uploads/pages/files/test.pdf")
        .put("page",5).put("version","test-version").put("validUntil","2027-04-01").put("checkedAt",now.toEpochMilli())
    @Test fun cacheIsExactAddressScopedAndNetworkFailureDoesNotEraseEvidence(){
        val c=RuntimeEnvironment.getApplication();c.getSharedPreferences("svitlo_registry",0).edit().clear().commit()
        val a=DictionaryAddress("18","801","м. Христинівка","11807","вул. Флорештська","10а/51")
        val b=a.copy(house="10а/52")
        val good=QueueRegistryRepository(c,RegistrySource{JSONObject().put("resolution",match())}){now}
        assertTrue(good.refresh(a,true));assertEquals("3.2",good.cached(a)?.queue);assertNull(good.cached(b))
        val offline=QueueRegistryRepository(c,RegistrySource{throw java.net.SocketTimeoutException()}){now}
        assertFalse(offline.refresh(a,true));assertEquals("3.2",offline.cached(a)?.queue)
        val negative=QueueRegistryRepository(c,RegistrySource{JSONObject().put("resolution",JSONObject().put("queue",JSONObject.NULL).put("status","ambiguous"))}){now}
        assertTrue(negative.refresh(a,true));assertNull(negative.cached(a))
    }
    @Test fun invalidExpiredFutureOrStaleEvidenceIsRejected(){
        assertNotNull(RegistryQueue.parse(match(),now))
        for(bad in listOf(match().put("queue","7.8"),match().put("validUntil","2026-10-24"),match().put("url","https://evil.test/x.pdf"),match().put("checkedAt",now.plusSeconds(3600).toEpochMilli()),match().put("checkedAt",now.minusSeconds(16*86400L).toEpochMilli()))){
            assertTrue(runCatching{RegistryQueue.parse(bad,now)}.isFailure)
        }
    }
    @Test fun typedErrorsDoNotContainPrivateAccountOrURL(){
        assertEquals(SourceFailure.TIMEOUT,SourceFailure.of(java.net.SocketTimeoutException("https://private.test/?account=12345678901")))
        assertFalse(SourceException(SourceFailure.TIMEOUT).message!!.contains("12345678901"))
        assertEquals(SourceFailure.FORBIDDEN,SourceFailure.http(403));assertEquals(SourceFailure.RATE_LIMITED,SourceFailure.http(429));assertEquals(SourceFailure.SERVER,SourceFailure.http(503))
        assertEquals(SourceFailure.INVALID,SourceFailure.of(org.json.JSONException("private body")))
    }
}
