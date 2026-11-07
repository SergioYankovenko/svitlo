package ua.svitlo.widget.next

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.LocalDate

/** Sanitized public source fields at an explicit synthetic replay clock.
 * These tests assert desired Android behavior, not the old failure result. */
class KyivPublication170Test {
    private val date=LocalDate.of(2026,11,4)
    private val now=Instant.ofEpochMilli(1793806200000L)
    private fun fixture(name:String)=JSONObject(requireNotNull(javaClass.getResourceAsStream("/kyiv03/$name.json")).bufferedReader().use{it.readText()})
    private fun hourly(o:JSONObject)=o.getJSONArray("lines").getJSONObject(0).getJSONObject("categories").getJSONObject("hourly")
    private fun today(o:JSONObject)=hourly(o).getJSONArray("days").getJSONObject(0)
    private fun day(o:JSONObject)=Universal.parse(o).day(date,null,now)

    @Test fun allFiveWireFixturesAreParsedAndGroupsAreNotGuessed(){
        val groups=mapOf("deg25-emergency" to "22.1","deg25-applies-control" to "22.1","deg25-missing-control" to "22.1","deg25a-emergency" to "14.1","mrii15b-emergency" to "21.1")
        for((name,group)in groups){val parsed=Universal.parse(fixture(name));assertTrue(parsed.synthetic);assertEquals(name,group,parsed.line(null)?.group)}
    }
    @Test fun suspendedPublicationRemainsVisibleWithoutTimersOrCertainTotals(){
        for(name in listOf("deg25-emergency","deg25a-emergency","mrii15b-emergency")){
            val plan=day(fixture(name));assertTrue(name,plan.publicationAvailable);assertFalse(plan.known);assertFalse(plan.timerAllowed)
            assertTrue(plan.parts().any{it.kind==Kind.HOURLY});assertNull(plan.eventAt(now));assertNull(plan.next(now))
            assertEquals(Totals(0,0,1440),plan.totals());assertFalse(plan.events.any{it.kind==Kind.EMERGENCY})
        }
    }
    @Test fun publishedOriginalIntervalsAndPositiveOnlyUncertaintyRemainSeparate(){
        val a=day(fixture("deg25a-emergency"));assertEquals(listOf("10:00–16:00","19:00–00:00"),a.planEvents.map{clock(it.start)+"–"+clock(it.end!!)})
        val b=day(fixture("mrii15b-emergency"));assertEquals(listOf("10:00–11:30","14:00–22:30"),b.planEvents.map{clock(it.start)+"–"+clock(it.end!!)})
        assertFalse(a.known);assertFalse(b.known)
    }
    @Test fun reportedMatchingPlanCanDrivePlanTimerDespiteUnknownPositiveOnlyFeeds(){
        val p=day(fixture("deg25-applies-control"));assertTrue(p.publicationAvailable);assertTrue(p.timerAllowed);assertFalse(p.known)
        assertEquals(Kind.HOURLY,p.eventAt(now)?.kind);assertEquals("23:00",clock(p.eventAt(now)!!.end!!));assertEquals(1440,p.totals().on+p.totals().off)
    }
    @Test fun missingDatedPublicationDoesNotBecomeAnAllClearDay(){
        val p=day(fixture("deg25-missing-control"));assertFalse(p.publicationAvailable);assertFalse(p.timerAllowed);assertTrue(p.hours().all{h->h.parts.all{it.unknown}});assertEquals(1440,p.totals().unknown)
    }
    @Test fun degradedConflictOrUnconfirmedRetainsIndependentFreshReference(){
        for(state in listOf("conflict","unconfirmed")){
            val f=fixture("deg25-emergency").put("supportState","degraded");today(f).getJSONObject("applicability").put("state",state)
            val p=day(f);assertTrue(state,p.publicationAvailable);assertFalse(p.timerAllowed);assertNull(p.eventAt(now));assertEquals(1440,p.totals().unknown)
        }
    }
    @Test fun disabledUnsupportedIncompleteAndUnselectedAmbiguousNeverBorrowThePlan(){
        for(state in listOf("disabled","unsupported")){assertFalse(day(fixture("deg25-emergency").put("supportState",state)).publicationAvailable)}
        val incomplete=fixture("deg25-emergency");incomplete.getJSONObject("resolution").put("complete",false);assertFalse(day(incomplete).publicationAvailable)
        val unknown=fixture("deg25-emergency");unknown.getJSONObject("resolution").put("state","unknown");assertFalse(day(unknown).publicationAvailable)
        val ambiguous=fixture("deg25-emergency");ambiguous.getJSONObject("resolution").put("state","ambiguous");val lines=ambiguous.getJSONArray("lines");lines.put(JSONObject(lines.getJSONObject(0).toString()).put("id","second-line"));assertFalse(day(ambiguous).publicationAvailable)
    }
    @Test fun allThreeFreshnessLayersAndSourceClockAreRequired(){
        for(layer in listOf("root","category","publication")){
            val f=fixture("deg25-emergency");val target=when(layer){"root"->f;"category"->hourly(f);else->today(f).getJSONObject("publication")}
            target.put("freshUntil",now.toEpochMilli());assertFalse(layer,day(f).publicationAvailable)
        }
        for(layer in listOf("root","category","publication")){
            val f=fixture("deg25-emergency");val target=when(layer){"root"->f;"category"->hourly(f);else->today(f).getJSONObject("publication")}
            target.put("sourceUpdatedAt",now.plusSeconds(301).toEpochMilli());assertFalse(layer,day(f).publicationAvailable)
        }
    }
    @Test fun expiryIsReevaluatedLocallyEvenWithoutANewRevision(){
        val f=Universal.parse(fixture("deg25-emergency"));assertTrue(f.day(date,null,now).publicationAvailable);val later=f.day(date,null,now.plusSeconds(121));assertFalse(later.publicationAvailable);assertTrue(later.hours().all{h->h.parts.all{it.unknown}})
    }
    @Test fun contradictoryReportedEffectiveTableDoesNotManufactureTimerOrAllClear(){
        val f=fixture("deg25-applies-control");today(f).put("intervals",JSONArray());val p=day(f)
        assertTrue(p.publicationAvailable);assertFalse(p.timerAllowed);assertEquals("unconfirmed",p.applicability);assertEquals(1440,p.totals().unknown)
    }
    @Test fun partialMetadataOrInvalidPublishedTimesAreRejected(){
        val partial=fixture("deg25-emergency");today(partial).remove("applicability");reject(partial)
        val reversed=fixture("deg25-emergency");val span=today(reversed).getJSONObject("publication").getJSONArray("intervals").getJSONObject(0);span.put("end",span.getLong("start"));reject(reversed)
        val wrongDay=fixture("deg25-emergency");val old=today(wrongDay).getJSONObject("publication").getJSONArray("intervals").getJSONObject(0);old.put("start",now.minusSeconds(172800).toEpochMilli()).put("end",now.minusSeconds(169200).toEpochMilli());reject(wrongDay)
    }
    @Test fun positiveOnlyPublicationCannotProveWholeDayAbsence(){
        val f=fixture("deg25-applies-control");val c=f.getJSONArray("lines").getJSONObject(0).getJSONObject("categories")
        for(k in listOf("planned","unplanned","emergency"))c.getJSONObject(k).getJSONArray("days").getJSONObject(0).put("state","published").put("intervals",JSONArray())
        val p=day(f);assertTrue(p.timerAllowed);assertFalse(p.known)
    }
    private fun reject(o:JSONObject){try{Universal.parse(o);fail("Expected malformed publication rejection")}catch(e:Exception){assertTrue(e is IllegalArgumentException||e is org.json.JSONException)}}
}
