package ua.svitlo.widget.core

import org.junit.Assert.*
import org.junit.Test
import java.time.*

class ScheduleLabels151Test {
    private val day=LocalDate.of(2026,10,27)
    private val now=day.atTime(12,0).atZone(KYIV_ZONE).toInstant()
    private fun at(hour:Int,minute:Int=0)=day.atTime(hour,minute).atZone(KYIV_ZONE).toInstant()
    private fun event(start:Instant,end:Instant?,category:Category=Category.SCHEDULE,type:String="ГПВ")=Outage(category,start,end,false,"Заплановано",type)
    private fun data(events:List<Outage>,at:Instant=now,queue:Boolean=true)=Snapshot(Category.entries.associateWith{c->
        CategorySnapshot(c,at,at,events.filter{it.sourceCategory==c},if(queue && c==Category.SCHEDULE)listOf("Графік погодинних відключень: 3 черга 2 підчерга")else emptyList())
    })
    @Test fun exactApprovedTextUsesSelectedDayQueueRawTotalsAndNewDomain(){
        val events=listOf(event(at(16),at(18)),event(at(20),at(22)))
        assertEquals("Графік · 27 Жовтня · Черга 3.2\nЗі світлом: 20 год\nБез світла: 4 год\n16:00–18:00, 20:00–22:00\n-----------------\nВстановити собі\nhttps://www.svitlo.guru",ScheduleLabels.shareText(day,data(events),now))
    }
    @Test fun emptyAndUnknownDaysDoNotShareButUnknownQueueDoesNotHideKnownAddressEvent(){
        assertFalse(ScheduleLabels.canShare(day,data(emptyList()),now))
        assertFalse(ScheduleLabels.canShare(day,Snapshot(emptyMap()),now))
        val value=ScheduleLabels.shareText(day,data(listOf(event(at(16),at(18),Category.PLANNED,"Позапланові")),queue=false),now)!!
        assertTrue(value.startsWith("Графік · 27 Жовтня\n"));assertFalse(value.contains("Черга"));assertTrue(value.contains("Немає точних даних"))
        assertFalse(value.contains("Тестова"));assertTrue(value.endsWith(ScheduleLabels.INSTALL_URL))
    }
    @Test fun eligibilityUsesNonzeroRawDurationRatherThanMinutesOrVisualSlots(){
        val short=event(at(12,1),at(12,2))
        assertTrue(ScheduleLabels.canShare(day,data(listOf(short)),now))
        assertTrue(DisplaySchedule.tiles(day,data(listOf(short)),now).all{it.segments.all{p->p.category==null}})
        assertFalse(ScheduleLabels.canShare(day,data(listOf(short.copy(end=short.start))),now))
        assertTrue(ScheduleLabels.canShare(day,data(listOf(short.copy(end=short.start.plusNanos(1)))),now))
    }
    @Test fun halfOpenDayClipsIntervalsAndDoesNotInventAnOpenEnd(){
        val start=day.atStartOfDay(KYIV_ZONE).toInstant();val end=day.plusDays(1).atStartOfDay(KYIV_ZONE).toInstant()
        assertFalse(ScheduleLabels.canShare(day,data(listOf(event(start.minusSeconds(10),start))),now))
        assertFalse(ScheduleLabels.canShare(day,data(listOf(event(end,end.plusSeconds(10)))),now))
        val cross=ScheduleLabels.shareText(day,data(listOf(event(end.minusSeconds(600),end.plusSeconds(600)))),now)!!
        assertTrue(cross.contains("23:50–24:00"))
        val open=event(now.minusSeconds(600),null,Category.EMERGENCY,"Аварійні")
        val value=ScheduleLabels.shareText(day,data(listOf(open)),now)!!
        assertTrue(value.contains("11:50–час відновлення уточнюється"));assertTrue(value.contains("Немає точних даних"))
        assertEquals(now,ScheduleLabels.shareIntervals(day,data(listOf(open)),now).single().end)
        assertFalse(ScheduleLabels.canShare(day,data(listOf(open.copy(start=now.plusSeconds(1)))),now))
    }
    @Test fun selectedDateAndCurrentMomentChooseDifferentContexts(){
        val planned=event(at(8),at(10),Category.PLANNED,"Планові")
        val emergency=event(at(11),at(13),Category.EMERGENCY,"Аварійні")
        val data=data(listOf(planned,emergency))
        assertEquals(OutageKind.EMERGENCY,ScheduleLabels.contextKind(day,data,now))
        assertEquals(OutageKind.EMERGENCY,ScheduleLabels.contextKind(day,data(listOf(planned,emergency),at(10,30)),at(10,30)))
        assertNull(ScheduleLabels.contextKind(day,data(listOf(planned,emergency),at(14)),at(14)))
        assertEquals(OutageKind.PLANNED,ScheduleLabels.contextKind(day,data.copy(categories=data.categories.mapValues{(_,c)->c.copy(sourceUpdatedAt=now.plusSeconds(86400),fetchedAt=now.plusSeconds(86400))}),now.plusSeconds(86400)))
    }
    @Test fun futureDayUsesFirstEventInsteadOfWholeDayEmergencyPriority(){
        val future=day.plusDays(1);val first=future.atTime(8,0).atZone(KYIV_ZONE).toInstant()
        val events=listOf(event(first,first.plusSeconds(3600),Category.PLANNED,"Позапланові"),event(first.plusSeconds(7200),first.plusSeconds(10800),Category.EMERGENCY,"Аварійні"))
        assertEquals(OutageKind.UNPLANNED,ScheduleLabels.contextKind(future,data(events),now))
        assertNull(ScheduleLabels.contextKind(future,data(events).copy(failures=setOf(Category.PLANNED,Category.EMERGENCY)),now))
    }
    @Test fun activePriorityAndExpiredSourcesRemainConservative(){
        val planned=event(at(11),at(13),Category.PLANNED,"Планові")
        val emergency=event(at(11),at(13),Category.EMERGENCY,"Аварійні")
        assertEquals(OutageKind.EMERGENCY,ScheduleLabels.contextKind(day,data(listOf(planned,emergency)),now))
        assertNull(ScheduleLabels.contextKind(day,data(listOf(planned,emergency),now.minusSeconds(7201)),now))
    }
    @Test fun sharingPreservesRealDstHoursWhileFallDisplayHasOneMergedTile(){
        for((date,hours) in listOf(LocalDate.of(2026,3,29) to 23,LocalDate.of(2026,10,25) to 25)){
            val start=date.atStartOfDay(KYIV_ZONE).toInstant();val end=date.plusDays(1).atStartOfDay(KYIV_ZONE).toInstant()
            val snapshot=data(listOf(event(start,end)),start)
            assertTrue(ScheduleLabels.shareText(date,snapshot,start)!!.contains("Без світла: $hours год"))
            assertTrue(ScheduleLabels.shareText(date,snapshot,start)!!.contains("Зі світлом: 0 год"))
            assertEquals(hours.toLong()*60,HourlySchedule.summary(date,snapshot,start).outageMinutes)
            if(hours==25){val tiles=DisplaySchedule.tiles(date,snapshot,start);assertEquals(24,tiles.size);assertEquals(4,tiles.single{it.clockChange}.segments.size)}
        }
    }
    @Test fun messagesLocalizeDatesWithoutChangingSpecialEventsOrTimestamps(){
        val change=OfficialChange("id",day,"3.2",now,"published","Опубліковано графік на 2026-10-27","https://www.cherkasyoblenergo.com/off","r1")
        assertEquals("Графік на 27 жовтня",ScheduleLabels.messageTitle(change))
        assertEquals("Оновлено графік на 27 жовтня",ScheduleLabels.messageTitle(change.copy(kind="updated")))
        assertEquals("ГПВ на 27 жовтня скасовано",ScheduleLabels.messageTitle(change.copy(kind="cancelled",title="ГПВ на 2026-10-27 скасовано")))
        assertEquals("Оновлено · 27.10, 12:00",ScheduleLabels.messageMeta(change))
        assertEquals("Для Черкаської області",ScheduleLabels.queueLine("*"));assertEquals("",ScheduleLabels.queueLine(""))
        assertEquals(now,change.at);assertEquals(day,change.date)
    }
}
