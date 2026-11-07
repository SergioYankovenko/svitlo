package ua.svitlo.widget

import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.json.JSONObject
import java.time.Instant

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[28])
class ActiveInstall150Test {
    private val c get()=RuntimeEnvironment.getApplication()
    private var at=Instant.parse("2026-10-25T08:00:00Z")
    private fun session()=JSONObject().put("access_token","a".repeat(40)).put("refresh_token","r".repeat(40)).put("expires_in",3600)
    @Before fun clear(){listOf("svitlo_activity","svitlo_registry_auth").forEach{c.getSharedPreferences(it,0).edit().clear().commit()}}
    @Test fun reportsOncePerDayAcrossRestartKeepsRandomIdAndExcludesQa(){
        val seen=mutableListOf<String>();val versions=mutableListOf<String>();val qa=mutableListOf<Boolean>()
        val source=HeartbeatSource{id,version,test->seen+=id;versions+=version;qa+=test;true}
        assertTrue(ActiveInstallRepository(c,source){at}.report())
        repeat(4){ActiveInstallRepository(c,source){at.plusSeconds(60)}.report()}
        assertEquals(1,seen.size);assertEquals(4,java.util.UUID.fromString(seen.single()).version())
        at=at.plusSeconds(86400);ActiveInstallRepository(c,source){at}.report()
        assertEquals(2,seen.size);assertEquals(seen[0],seen[1]);assertEquals(listOf(AppUpdateRepository.installedName(c),AppUpdateRepository.installedName(c)),versions)
        assertTrue(qa.all{it})
    }
    @Test fun failuresAreQuietAndDoNotGenerateNewIdsOrRepeatedDailyRequests(){
        var calls=0;val ids=mutableListOf<String>()
        val source=HeartbeatSource{id,_,_->calls++;ids+=id;throw java.io.IOException("network")}
        assertFalse(ActiveInstallRepository(c,source){at}.report())
        ActiveInstallRepository(c,source){at.plusSeconds(30)}.report();assertEquals(1,calls)
        ActiveInstallRepository(c,source){at.plusSeconds(86400)}.report();assertEquals(2,calls);assertEquals(ids[0],ids[1])
    }
    @Test fun activityPayloadContainsOnlyRandomIdVersionAndTestMarkerAndReusesRegistrySession(){
        val requests=mutableListOf<Triple<String,JSONObject,String?>>()
        val client=RegistryClient(c,SupabaseTransport{path,body,token->
            requests+=Triple(path,body,token)
            if(path=="/auth/v1/signup")session()else JSONObject().put("status","recorded")
        }){at.toEpochMilli()}
        val id=java.util.UUID.randomUUID().toString()
        client.heartbeat(id,"1.5.0",true);client.heartbeat(id,"1.5.0",true)
        assertEquals(1,requests.count{it.first=="/auth/v1/signup"})
        val payload=requests.last().second
        assertEquals(setOf("installationId","version","isTest"),payload.keys().asSequence().toSet())
        assertEquals(id,payload.getString("installationId"));assertNotNull(requests.last().third)
    }
    @Test fun unauthorizedRequestRefreshesOnceButNetworkFailureDoesNotCreateAnotherIdentity(){
        var signups=0;var renewals=0;var posts=0
        val client=RegistryClient(c,SupabaseTransport{path,_,_->when{
            path=="/auth/v1/signup"->{signups++;session()}
            path.startsWith("/auth/v1/token")-> {renewals++;session()}
            else->{posts++;if(posts==1)throw SupabaseHttpFailure(401);JSONObject().put("status","recorded")}
        }}){at.toEpochMilli()}
        client.heartbeat(java.util.UUID.randomUUID().toString(),"1.5.0",true)
        assertEquals(1,signups);assertEquals(1,renewals);assertEquals(2,posts)
        val offline=RegistryClient(c,SupabaseTransport{_,_,_->throw java.net.SocketTimeoutException()}){at.plusSeconds(7200).toEpochMilli()}
        assertTrue(runCatching{offline.heartbeat(java.util.UUID.randomUUID().toString(),"1.5.0",true)}.isFailure)
        assertNotNull(c.getSharedPreferences("svitlo_registry_auth",0).getString("refresh",null))
    }
}
