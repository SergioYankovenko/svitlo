package ua.svitlo.widget

import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.time.Instant

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[28])
class ServiceNotices150Test {
    private val now=Instant.parse("2026-10-24T09:00:00Z")
    private val article=OfficialArticle("test-maintenance","Технічні роботи",
        "24.10.2026 з 11:00 до 14:00 тимчасово недоступний особистий кабінет побутових споживачів",
        now.minusSeconds(3600),"https://www.cherkasyoblenergo.com/news/test")
    @Test fun requiresCurrentExplicitRelevantOfficialNotice(){
        assertEquals(Instant.parse("2026-10-24T11:00:00Z"),ServiceNotices.parse(article,now)?.until)
        for(other in listOf(
            article.copy(content="24.10.2026 з 11:00 до 14:00 кабінет непобутових споживачів"),
            article.copy(content="24.10.2026 з 11:00 до 14:00 планові роботи на лінії"),
            article.copy(content="Кабінет побутових споживачів тимчасово недоступний"),
            article.copy(content=article.content+". Роботи завершено"),
            article.copy(content=article.content.replace("24.10.2026","23.10.2026")),
            article.copy(content=article.content.replace("11:00","13:00")),
            article.copy(publishedAt=now.minusSeconds(86400)),
            article.copy(publishedAt=now.plusSeconds(60)),
            article.copy(sourceUrl="https://example.org/news/test")
        ))assertNull(other.content,ServiceNotices.parse(other,now))
    }
    @Test fun successfulCheckWithoutNoticeClearsOldCacheAndItNeverExtendsPastEnd(){
        val c=RuntimeEnvironment.getApplication()
        c.getSharedPreferences("svitlo_service_notices",0).edit().clear().commit()
        val notices=ServiceNotices(c)
        notices.update(listOf(article),now);assertNotNull(notices.current(now))
        assertNull(notices.current(now.plusSeconds(7201)))
        assertNull(notices.current(Instant.parse("2026-10-24T11:00:00Z")))
        notices.update(emptyList(),now.plusSeconds(60));assertNull(notices.current(now.plusSeconds(60)))
    }
    @Test fun ambiguousClockChangeTimesDoNotConfirmMaintenance(){
        val at=Instant.parse("2026-10-25T01:20:00Z")
        val ambiguous=article.copy(publishedAt=at.minusSeconds(300),content="25.10.2026 з 03:00 до 05:00 кабінет побутових споживачів")
        assertNull(ServiceNotices.parse(ambiguous,at))
    }
    @Test fun publicSourceKeepsLastSuccessAndTypedErrorWithoutInventingMaintenance(){
        val c=RuntimeEnvironment.getApplication();c.getSharedPreferences("svitlo_official",0).edit().clear().commit()
        assertTrue(OfficialScheduleRepository(c,OfficialFeedSource{emptyList()}){now}.refresh())
        val failing=OfficialScheduleRepository(c,OfficialFeedSource{throw SourceException(SourceFailure.FORBIDDEN)}){now.plusSeconds(60)}
        assertFalse(failing.refresh());assertEquals(now,failing.snapshot().checkedAt)
        assertEquals(SourceFailure.FORBIDDEN,failing.sourceFailure())
        assertTrue(OfficialScheduleRepository(c,OfficialFeedSource{emptyList()}){now.plusSeconds(120)}.refresh())
        assertNull(failing.sourceFailure())
    }
}
