package ua.svitlo.widget.core

import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.LocalDate

class InboxHistoryTest {
    private val now=Instant.parse("2026-10-23T14:00:00Z")
    private fun item(id:String,at:Instant=now,date:String="2026-10-23",read:Boolean=false)=
        OfficialChange(id,LocalDate.parse(date),"3.2",at,"published","Графік","https://www.cherkasyoblenergo.com/media/test",id,read)

    @Test fun sourceTimeWinsOverScheduleDateAndReadStatus(){
        val older=item("older",now.minusSeconds(60),"2026-10-24")
        val newer=item("newer",now,"2026-10-23",true)
        assertEquals(listOf("newer","older"),InboxHistory.recent(listOf(older,newer),now).map{it.id})
    }

    @Test fun equalPublicationTimeUsesNewestScheduleDateAndKeepsStableRevisionOrder(){
        val first=item("first",date="2026-10-23")
        val second=item("second",date="2026-10-23")
        val olderDay=item("older-day",date="2026-10-18")
        assertEquals(listOf("first","second","older-day"),InboxHistory.recent(listOf(olderDay,first,second),now).map{it.id})
    }

    @Test fun exactRollingWeekAndFutureScheduleDateAreRetainedButOldUpdatesExpire(){
        val boundary=item("boundary",now.minusSeconds(7*86400L))
        val expired=item("expired",boundary.at.minusSeconds(1))
        val tomorrow=item("tomorrow",now,"2026-10-24")
        assertEquals(listOf("tomorrow","boundary"),InboxHistory.recent(listOf(expired,boundary,tomorrow),now).map{it.id})
    }
}
