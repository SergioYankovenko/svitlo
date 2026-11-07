package ua.svitlo.widget

import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import ua.svitlo.widget.core.*
import java.time.Instant
import java.time.LocalDate

/** Desired-behaviour regressions, distinct from the original defect characterization. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk=[28])
class CapturedData150Test {
    private val c get()=RuntimeEnvironment.getApplication()
    private val day=LocalDate.of(2026,10,24)
    private val at=Instant.parse("2026-10-24T12:03:00Z")
    private fun fixture(name:String)=javaClass.getResource("/regression150/$name.json")!!.readText()
    @Before fun clear(){listOf("svitlo_private","svitlo_official","svitlo_registry","svitlo_inbox").forEach{c.getSharedPreferences(it,0).edit().clear().commit()}}
    private fun feed()=OfficialScheduleRepository(c,OfficialFeedSource{
        listOf("oct24","oct23-gav").map{OfficialScheduleParser.article(fixture(it))}
    }){at}.also{assertTrue(it.refresh())}
    @Test fun capturedSychivkaEmptyResponseCannotConfirmPowerOrScheduleWithoutQueue(){
        val address=DictionaryAddress("18","830","с. Сичівка","11997","вул. Грушевського","1")
        val repo=OutageRepository(c,object:OutageSource{
            override fun fetch(account:String,category:Category,from:LocalDate,to:LocalDate)=error("No guessed account")
            override fun fetchAddress(a:DictionaryAddress,category:Category,from:LocalDate,to:LocalDate):String{
                assertEquals(address,a);return fixture("sychivka-filtered-${category.selector}")
            }
        }){at}
        assertTrue(repo.bindConfirmed("",address.label,repo.prepareAddress(address),address.city,address));feed()
        val data=repo.snapshot();assertNull(data.queueLabel());assertFalse(data.checkedEmptyToday(day,at))
        assertFalse(data.isCompleteAndFresh(at));assertEquals(1440L,HourlySchedule.summary(day,data,at).unknownMinutes)
        assertEquals(0L,HourlySchedule.summary(day,data,at).clearMinutes)
        assertEquals(Presentation.WidgetSignal.UNKNOWN,Presentation.widgetSignal(data,at))
        assertTrue(DisplaySchedule.tiles(day,data,at).flatMap{it.segments}.all{it.uncertain && it.category==null})
        assertTrue(ReminderPlan.create(data,at,true,true).isEmpty())
    }
    @Test fun capturedKhrystynivkaKeepsFullHouseExactMinutesAndUnknownUncoveredGaps(){
        val address=DictionaryAddress("18","801","м. Христинівка","11807","вул. Флорештська","10а/51")
        assertEquals(AddressResolution.Empty,AddressApi(OperatorTransport{p->assertEquals("10а/51",p["house"]);"[]"}).resolve(address.streetId,address.house))
        val repo=OutageRepository(c,OutageApi{p->fixture("khrystynivka-${p["disconn_selector"]}")}){at}
        assertTrue(repo.bindConfirmed("",address.label,repo.prepareAddress(address),address.city,address));feed()
        val data=repo.snapshot();assertNull(data.queueLabel());assertEquals(20,data.categories[Category.SCHEDULE]!!.events.size)
        val raw=data.categories[Category.SCHEDULE]!!.events.single{it.start.atZone(KYIV_ZONE).toLocalDate()==day}
        assertEquals("12:01",Presentation.time(raw.start));assertEquals("14:02",Presentation.time(raw.end))
        val summary=HourlySchedule.summary(day,data,at)
        assertEquals(121L,summary.outageMinutes);assertEquals(1319L,summary.unknownMinutes);assertEquals(0L,summary.clearMinutes)
        val projected=DisplaySchedule.tiles(day,data,at)
        assertEquals(listOf("12:00","13:00"),projected.filter{it.segments.any{p->p.category==Category.SCHEDULE}}.map{it.label})
        assertEquals("12:01",Presentation.time(raw.start));assertEquals("14:02",Presentation.time(raw.end))
        assertFalse(data.emergency.status(at,data.plans).confirmedActive)
    }
}
