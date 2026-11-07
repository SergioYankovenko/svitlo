package ua.svitlo.widget

import android.content.Context
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

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[28])
class FeedIntegrationTest {
    private lateinit var context:Context
    private val now=Instant.parse("2026-10-22T20:40:00Z")
    private val account="12345678901"
    private val day=LocalDate.of(2026,10,23)
    private fun raw(queue:String="3 черга 2 підчерга",events:String="[]")="""{"DATETIME":"23:40 22.10.2026","DISCONN_QUEUQ":[{"QUEUE_INFO":"Графік погодинних відключень - $queue"}],"DISCONNECTIONS":$events}"""
    private fun repository(queue:String="3 черга 2 підчерга",events:String="[]")=OutageRepository(context,OutageSource{_,_,_,_->raw(queue,events)}){now}
    private fun publish():OfficialScheduleRepository {
        val rows=(1..6).flatMap{q->(1..2).map{p->"<p>$q.$p 08:00 - 10:00, 14:00 - 16:00, 20:00 - 22:00</p>"}}.joinToString("")
        return OfficialScheduleRepository(context,OfficialFeedSource{listOf(OfficialArticle("example","Графік погодинних відключень (ГПВ) на 23 жовтня",rows,
            now.minusSeconds(3600),"https://www.cherkasyoblenergo.com/media/example"))}){now}.also{assertTrue(it.refresh())}
    }
    @Before fun setup(){context=RuntimeEnvironment.getApplication();context.getSharedPreferences("svitlo_private",0).edit().clear().commit();OfficialScheduleRepository(context).clear()}
    private fun bind(repo:OutageRepository){assertTrue(repo.bindConfirmed(account,"м. Приклад, тестова адреса",repo.prepare(account),"м. Приклад"))}

    @Test fun realRepositoryUsesOfficialTomorrowWhenAddressResponseIsEmpty(){
        val repo=repository();bind(repo);publish()
        assertEquals(3,repo.snapshot().allEvents().size)
        assertEquals("3.2",repo.snapshot().plans.single().queue)
        assertTrue(Timeline.bins(day,repo.snapshot(),now).none{it.uncertain})
    }
    @Test fun emptySuccessfulAccountRefreshCannotEraseOfficialPublication(){
        val repo=repository();bind(repo);publish();assertEquals(RefreshResult.SUCCESS,repo.refresh())
        assertEquals(3,repo.snapshot().allEvents().size)
    }
    @Test fun freshKnownQueueEmptyAddressResponseNeedsARecentSuccessfulPublicCheck(){
        val repo=repository();bind(repo)
        val today=now.atZone(KYIV_ZONE).toLocalDate()
        fun assertUnavailable(){
            val state=repo.snapshot()
            assertFalse(state.checkedEmptyToday(today,now))
            assertFalse(state.isCompleteAndFresh(now))
            assertEquals(0L,HourlySchedule.summary(today,state,now).clearMinutes)
            assertEquals(1440L,HourlySchedule.summary(today,state,now).unknownMinutes)
        }
        assertUnavailable() // First confirmation has checked only the address API.
        for(checked in listOf(now.minusSeconds(7201),now.plusSeconds(301))){
            assertTrue(OfficialScheduleRepository(context,OfficialFeedSource{emptyList()}){checked}.refresh())
            assertUnavailable()
        }
        assertTrue(OfficialScheduleRepository(context,OfficialFeedSource{emptyList()}){now}.refresh())
        assertTrue(repo.snapshot().checkedEmptyToday(today,now))
        assertEquals(1440L,HourlySchedule.summary(today,repo.snapshot(),now).clearMinutes)
        assertFalse(OfficialScheduleRepository(context,OfficialFeedSource{throw java.io.IOException("offline")}){now}.refresh())
        assertUnavailable()
    }
    @Test fun newRepositoryRetainsSourceUrlAndRevision(){
        val repo=repository();bind(repo);publish()
        val plan=repository().snapshot().plans.single()
        assertTrue(plan.sourceUrl.startsWith("https://www.cherkasyoblenergo.com/media/"))
        assertTrue(plan.revision.isNotBlank())
    }
    @Test fun switchingAddressesAndReopeningKeepsCompletedMorningAfterAfternoonPublication(){
        var clock=Instant.parse("2026-10-23T10:10:00Z")
        val empty="""{"DATETIME":"13:10 23.10.2026","DISCONN_QUEUQ":[{"QUEUE_INFO":"Графік погодинних відключень - 3 черга 2 підчерга"}],"DISCONNECTIONS":[]}"""
        val repo=OutageRepository(context,OutageSource{_,_,_,_->empty}){clock}
        val profiles=AddressProfiles(context)
        assertTrue(profiles.confirm(account,"Перша синтетична адреса",repo.prepare(account),"м. Приклад","Дім",true))
        val first=profiles.active()!!
        var articles=listOf(officialArticle(rows=allOfficialRows("08:00 - 10:00, 14:00 - 16:00, 20:00 - 22:00")))
        val feed=OfficialScheduleRepository(context,OfficialFeedSource{articles}){clock};assertTrue(feed.refresh())
        assertTrue(profiles.confirm("12345678902","Друга синтетична адреса",repo.prepare("12345678902"),"м. Інше","Робота",true))
        articles=listOf(officialArticle(rows=allOfficialRows("14:00 - 16:00, 20:00 - 22:00"),published=Instant.parse("2026-10-23T10:05:00Z")))
        assertTrue(feed.refresh());assertTrue(profiles.activate(first.id))
        val reopened=OutageRepository(context,OutageSource{_,_,_,_->empty}){clock}
        assertEquals(listOf("08:00","14:00","20:00"),reopened.snapshot().allEvents().map{Presentation.time(it.start)})
        assertEquals(360L,HourlySchedule.summary(day,reopened.snapshot(),clock).outageMinutes)
        assertEquals(Category.SCHEDULE,HourlySchedule.tiles(day,reopened.snapshot(),clock)[8].segments.single().category)
    }
    @Test fun changingAddressUsesNewQueueAndNotPreviousHouseholdEvents(){
        val repo=repository();bind(repo);publish()
        val other=repository("2 черга 1 підчерга")
        assertTrue(other.bindConfirmed("12345678902","Друга тестова адреса",other.prepare("12345678902")))
        assertEquals("2.1",other.snapshot().plans.single().queue)
    }
    @Test fun clearingPrivateDataAlsoClearsPublicCacheAndHistory(){
        val repo=repository();bind(repo);val official=publish();repo.clear()
        assertTrue(official.snapshot().days.isEmpty());assertTrue(official.changes().isEmpty())
    }
    @Test fun unboundSnapshotCannotExposeLastHouseholdSchedule(){
        publish();assertTrue(repository().snapshot().allEvents().isEmpty())
    }
}
