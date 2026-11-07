package ua.svitlo.widget.core

import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.LocalDate

class DisplaySchedule150Test {
    private val day=LocalDate.of(2026,10,24)
    private val now=day.atTime(14,1).atZone(KYIV_ZONE).toInstant()
    private fun at(hour:Int,minute:Int)=day.atTime(hour,minute).atZone(KYIV_ZONE).toInstant()
    private fun data(events:List<Outage>,queue:Boolean=true)=Snapshot(Category.entries.associateWith{c->
        CategorySnapshot(c,now,now,events.filter{it.category==c},if(c==Category.SCHEDULE && queue)listOf("Графік погодинних відключень: 3 черга 2 підчерга")else emptyList())})
    @Test fun roundOnlyVisualProjectionKeepRawStatusAndTotals(){
        val outage=Outage(Category.SCHEDULE,at(12,1),at(14,2),false,"Завершено","ГПВ")
        val raw=data(listOf(outage));val before=HourlySchedule.summary(day,raw,now)
        val tiles=DisplaySchedule.tiles(day,raw,now)
        assertEquals(24,tiles.size)
        assertTrue(tiles[12].segments.all{it.category==Category.SCHEDULE})
        assertTrue(tiles[13].segments.all{it.category==Category.SCHEDULE})
        assertTrue(tiles[14].segments.all{it.category==null})
        assertEquals(outage,Timeline.nextOutage(raw,now))
        assertEquals(121L,before.outageMinutes)
        assertEquals(before,HourlySchedule.summary(day,raw,now))
        assertEquals(at(12,1),raw.allEvents().single().start)
    }
    @Test fun tiesRoundForwardAcrossDayBoundary(){
        for((minute,rounded) in listOf(0 to 0,14 to 0,15 to 30,16 to 30,29 to 30,30 to 30,44 to 30,45 to 60,46 to 60,59 to 60))
            assertEquals(at(12,0).plusSeconds(rounded*60L),DisplaySchedule.rounded(at(12,minute)))
        assertEquals(day.plusDays(1).atStartOfDay(KYIV_ZONE).toInstant(),DisplaySchedule.rounded(at(23,59)))
    }
    @Test fun shortIntervalsCollapseOnlyInTiles(){
        val event=Outage(Category.PLANNED,at(10,1),at(10,2),false,"","Планові")
        val raw=data(listOf(event));assertTrue(DisplaySchedule.tiles(day,raw,now)[10].segments.all{it.category==null})
        assertEquals(1L,HourlySchedule.summary(day,raw,now).outageMinutes);assertEquals(listOf(event),raw.allEvents())
    }
    @Test fun unknownQueueEmptyAndGapsStayUnknown(){
        val empty=data(emptyList(),false)
        assertFalse(empty.isCompleteAndFresh(now));assertFalse(empty.checkedEmptyToday(day,now))
        assertEquals(1440L,HourlySchedule.summary(day,empty,now).unknownMinutes)
        val partial=data(listOf(Outage(Category.SCHEDULE,at(12,0),at(14,0),false,"Завершено","")),false)
        assertFalse(partial.knownDay(day,now));assertTrue(HourlySchedule.summary(day,partial,now).unknownMinutes>0)
        assertTrue(DisplaySchedule.tiles(day,partial,now)[13].segments.all{it.category==Category.SCHEDULE})
    }
    @Test fun halfHourLabelsAndCategoryPriority(){
        val first=data(listOf(Outage(Category.SCHEDULE,at(14,0),at(14,30),false,"","")))
        assertEquals("14:00" to "14:30",DisplaySchedule.labels(DisplaySchedule.tiles(day,first,now)[14]))
        val second=data(listOf(Outage(Category.SCHEDULE,at(14,30),at(15,0),false,"","")))
        assertEquals("14:30" to "15:00",DisplaySchedule.labels(DisplaySchedule.tiles(day,second,now)[14]))
        val mixed=data(first.allEvents()+Outage(Category.EMERGENCY,at(14,30),at(15,0),false,"",""))
        val tile=DisplaySchedule.tiles(day,mixed,now)[14]
        assertEquals(listOf(Category.SCHEDULE,Category.EMERGENCY),tile.segments.map{it.category})
        assertEquals("14:00" to "15:00",DisplaySchedule.labels(tile))
    }
    @Test fun autumnGroupsFourRealHalvesWhileSpringOmitsMissingHour(){
        val fall=LocalDate.of(2026,10,25);val at=fall.atStartOfDay(KYIV_ZONE).toInstant()
        val source=Snapshot(emptyMap())
        val tiles=DisplaySchedule.tiles(fall,source,at)
        assertEquals(24,tiles.size);val changed=tiles.single{it.clockChange}
        assertEquals("03:00" to "04:00",DisplaySchedule.labels(changed))
        assertEquals(4,changed.segments.size)
        assertTrue(changed.segments.all{java.time.Duration.between(it.start,it.end).seconds==1800L})
        assertEquals(1500L,HourlySchedule.summary(fall,source,at).unknownMinutes)
        val spring=LocalDate.of(2026,3,29)
        assertEquals(23,DisplaySchedule.tiles(spring,source,spring.atStartOfDay(KYIV_ZONE).toInstant()).size)
        assertFalse(DisplaySchedule.tiles(spring,source,spring.atStartOfDay(KYIV_ZONE).toInstant()).any{it.clockChange})
    }
    @Test fun selectableReminderLeadChangesBothTransitions(){
        val events=data(listOf(Outage(Category.SCHEDULE,at(16,0),at(18,0),false,"","")))
        for(lead in listOf(5,15,30,60)){
            val reminders=ReminderPlan.create(events,now,true,true,lead)
            assertEquals(listOf(at(16,0).minusSeconds(lead*60L),at(18,0).minusSeconds(lead*60L)),reminders.map{it.at})
        }
        assertTrue(ReminderPlan.create(events.copy(registryQueue=null,categories=events.categories.mapValues{(_,v)->v.copy(queueInfo=emptyList())}),now,true,true).isEmpty())
    }
}
