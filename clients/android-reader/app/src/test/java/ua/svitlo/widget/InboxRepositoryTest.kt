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

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[28])
class InboxRepositoryTest {
    private lateinit var context:Context
    private val now=Instant.parse("2026-10-23T04:00:00Z")
    private fun data(emergency:Boolean=false,failed:Boolean=false):Snapshot=Snapshot(Category.entries.associateWith{category->
        CategorySnapshot(category,now,now,if(category==Category.EMERGENCY && emergency)listOf(Outage(category,now,null,false,"Триває","Аварія"))else emptyList(),
            if(category==Category.SCHEDULE)listOf("Графік погодинних відключень - 3 черга 2 підчерга")else emptyList())},feedFailed=failed)
    private fun bind(){
        val raw="""{"DATETIME":"07:00 23.10.2026","DISCONNECTIONS":[],"DISCONN_QUEUQ":[]}"""
        val repo=OutageRepository(context,OutageSource{_,_,_,_->raw}){now}
        assertTrue(repo.bindConfirmed("12345678901","Тестова адреса",repo.prepare("12345678901")))
    }
    private fun InboxRepository.record(snapshot:Snapshot,now:Instant)=record(requireNotNull(OutageRepository(context).boundSnapshot()).copy(snapshot=snapshot),now)
    @Before fun setup(){context=RuntimeEnvironment.getApplication();InboxRepository(context){now}.clearLocal();OfficialScheduleRepository(context).clear();bind()}
    @Test fun emergencyIsPersistedOnceAndReadStateDoesNotRemoveSchedule(){
        val repo=InboxRepository(context){now};repo.record(data(true),now);repo.record(data(true),now.plusSeconds(60))
        assertEquals(1,InboxRepository(context){now}.changes().size)
        repo.markRead(repo.changes().single().id);assertTrue(repo.changes().single().read)
        repo.clearRead("3.2");assertTrue(repo.changes().isEmpty())
    }
    @Test fun prolongedFailureCreatesOneMessageForTheEpisode(){
        val repo=InboxRepository(context){now};repo.record(data(failed=true),now);repo.record(data(failed=true),now.plusSeconds(3600));assertTrue(repo.changes().isEmpty())
        repo.record(data(failed=true),now.plusSeconds(7200));repo.record(data(failed=true),now.plusSeconds(10800))
        assertEquals(1,repo.changes().size);assertEquals("unavailable",repo.changes().single().kind)
    }
    @Test fun successfulRecoveryStartsANewFailureEpisode(){
        val repo=InboxRepository(context){now};repo.record(data(failed=true),now);repo.record(data(failed=true),now.plusSeconds(7200));repo.record(data(),now.plusSeconds(7500))
        repo.record(data(failed=true),now.plusSeconds(8000));repo.record(data(failed=true),now.plusSeconds(15200));assertEquals(2,repo.changes().size)
    }
    @Test fun clearingBindingLocalHistoryDoesNotErasePublicPlans(){
        val repo=InboxRepository(context){now};repo.record(data(true),now);repo.clearLocal();assertTrue(repo.changes().isEmpty())
    }
    @Test fun clearingReadMessagesDoesNotMakeUnchangedEmergencyOrFailureReturnUnread(){
        val repo=InboxRepository(context){now};repo.record(data(true,true),now);repo.record(data(true,true),now.plusSeconds(7200))
        assertEquals(2,repo.changes().size);repo.markAllRead("3.2");repo.clearRead("3.2")
        repo.record(data(true,true),now.plusSeconds(7500));assertTrue(repo.changes().isEmpty())
    }
    @Test fun snapshotCapturedBeforeRebindCannotRepopulateNewHouseholdInbox(){
        val old=requireNotNull(OutageRepository(context).boundSnapshot()).copy(snapshot=data(true))
        bind()
        val repo=InboxRepository(context){now};repo.record(old,now)
        assertTrue(repo.changes().isEmpty())
    }

    @Test fun localEventsExpireAfterOneWeekWithoutNetworkOrReappearingAsNew(){
        var clock=now;val repo=InboxRepository(context){clock}
        repo.record(data(true),clock)
        clock=now.plusSeconds(7*86400L);assertEquals(1,repo.changes().size)
        clock=clock.plusSeconds(1);assertTrue(repo.changes().isEmpty())
        assertEquals("[]",context.getSharedPreferences("svitlo_inbox",Context.MODE_PRIVATE).getString("history",null))
        repo.record(data(true),clock);assertTrue(repo.changes().isEmpty())
    }

    @Test fun publicAndLocalUpdatesHaveOneDescendingTimeOrder(){
        val article=officialArticle(rows="<p>3.2 08:00 - 10:00</p>",
            title="Оновлено графік погодинних відключень на 23 жовтня",published=now.minusSeconds(3600))
        val official=OfficialScheduleRepository(context,OfficialFeedSource{listOf(article)}){now}
        assertTrue(official.refresh())
        val repo=InboxRepository(context){now};repo.record(data(true),now)
        assertEquals(listOf(now,article.publishedAt),repo.changes().map{it.at})
        val before=repo.changes().map{it.id};repo.markRead(before.last())
        assertEquals(before,repo.changes().map{it.id})
    }

    @Test fun publicHistoryCapacityDoesNotHideRecentLocalEmergencyForSelectedQueue(){
        val public=org.json.JSONArray()
        repeat(100){index->public.put(org.json.JSONObject()
            .put("id","public:$index").put("date","2026-10-23").put("queue","1.1")
            .put("at",now.minusSeconds(index.toLong())).put("kind","updated").put("title","Оновлено графік")
            .put("sourceUrl","https://www.cherkasyoblenergo.com/media/test")
            .put("revision","$index").put("timeBasis","publication"))}
        context.getSharedPreferences("svitlo_official",Context.MODE_PRIVATE).edit().putString("history",public.toString()).commit()
        val repo=InboxRepository(context){now};repo.record(data(true),now.minusSeconds(3600))
        assertEquals(101,repo.changes().size)
        val selected=repo.changes().filter{it.queue=="3.2"}
        assertEquals("emergency",selected.single().kind)
        assertEquals(now.minusSeconds(3600),selected.single().at)
    }
}
