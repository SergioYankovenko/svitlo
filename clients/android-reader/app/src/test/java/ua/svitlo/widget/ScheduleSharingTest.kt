package ua.svitlo.widget

import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import ua.svitlo.widget.core.*
import java.time.*

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[28])
class ScheduleSharingTest {
    private val date=LocalDate.of(2026,10,23)
    @Test fun exportedCaptionContainsQueueDatePublicationAndOfficialSource(){
        val at=Instant.parse("2026-10-22T18:55:00Z")
        val snapshot=Snapshot(emptyMap(),plans=listOf(PublishedPlan(date,"3.2",emptyList(),at,at,"https://www.cherkasyoblenergo.com/media/example","rev")))
        val text=ScheduleSharing.caption(date,snapshot,"3.2")
        assertTrue(text.contains("3.2"));assertTrue(text.contains("23.10.2026"));assertTrue(text.contains("22.10 21:55"))
        assertTrue(text.contains("https://www.cherkasyoblenergo.com/media/example"))
    }
    @Test fun unknownScheduleExportIsExplicitAndLargeEnoughForTiles(){
        assertTrue(ScheduleSharing.caption(date,Snapshot(emptyMap()),"3.2").contains("не опубліковано"))
        val bitmap=ScheduleSharing.render(date,Snapshot(emptyMap()),date.atStartOfDay(KYIV_ZONE).toInstant(),"3.2")
        assertEquals(1080,bitmap.width);assertTrue(bitmap.height>1000)
    }
}
