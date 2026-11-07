package ua.svitlo.widget.next
import org.junit.Test
import org.junit.Assert.*
import org.json.JSONArray
import org.json.JSONObject
class CanonicalHomesTest {
    private fun p(home:String,line:String)=NextProfile("$home-$line","",home,line,home,"","","","op")
    @Test fun thirtyTwoLinesUseOneHouse(){val old=(1..32).map{p("home",it.toString())};val next=CanonicalHomes.merge(old,listOf(p("other","1")),2);assertEquals(33,next.size);assertEquals(2,next.map{it.addressId}.distinct().size)}
    @Test fun groupIsAtomicAndExistingIdsRemain(){val old=listOf(p("h","1"));val next=CanonicalHomes.merge(old,listOf(p("h","1").copy(id="new"),p("h","2")),2);assertEquals("h-1",next[0].id);assertEquals(2,next.size)}
    @Test(expected=IllegalArgumentException::class) fun freeThirdHouseRejected(){CanonicalHomes.merge(listOf(p("h1","1"),p("h2","1")),listOf(p("h3","1")),2)}
    @Test fun freshIdentityDoesNotExpandFromOlderMultilineCache(){
        val id="11111111-1111-4111-8111-111111111111"
        val result=JSONObject().put("address",JSONObject().put("id","home")).put("resolution",JSONObject().put("state","resolved").put("complete",true).put("checkedAt",1000000).put("lines",JSONArray().put(JSONObject().put("id",id))))
        assertEquals(listOf(id),CanonicalHomes.confirmed(result,"home",1000010))
        assertNull(CanonicalHomes.confirmed(result,"other-home",1000010))
    }
    @Test fun retainedIdentityHasSeparateSevenDayClockAndExactSourceProof(){
        val id="11111111-1111-4111-8111-111111111111";val now=1000000000L;val checked=now-6*86400000L
        val line=JSONObject().put("id",id).put("key","GPV1.1").put("groupCode","1.1").put("provenance",JSONObject().put("source","dtek-address").put("partial",false))
        val saved=JSONObject().put("addressId","home").put("checkedAt",checked).put("lineKeys",JSONArray().put("GPV1.1"))
        val result=JSONObject().put("address",JSONObject().put("id","home")).put("resolution",JSONObject().put("state","unknown").put("complete",false).put("checkedAt",now).put("lines",JSONArray().put(line)).put("provenance",JSONObject().put("sourceUnavailable",true).put("source","dtek-address").put("retainedIdentity",saved)))
        assertEquals(listOf(id),CanonicalHomes.confirmed(result,"home",now))
        assertNull(CanonicalHomes.confirmed(result,"home",now+2*86400000L))
        saved.put("addressId","neighbor");assertNull(CanonicalHomes.confirmed(result,"home",now))
    }
}
