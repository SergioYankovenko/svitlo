package ua.svitlo.widget.core

import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime

class HourlyScheduleTest {
    private val date=LocalDate.of(2026,10,23)
    private val now=date.atStartOfDay(KYIV_ZONE).toInstant()
    private fun at(clock:String)=date.atTime(LocalTime.parse(clock)).atZone(KYIV_ZONE).toInstant()
    private fun event(from:String,to:String,category:Category=Category.SCHEDULE)=Outage(category,at(from),at(to),false,"","ГПВ")
    private fun snapshot(events:List<Outage>)=Snapshot(Category.entries.associateWith{
        CategorySnapshot(it,now,now,events.filter{e->e.category==it},testQueue(it))
    })
    @Test fun ordinaryDayHasOneTileForEveryRealHour(){
        val tiles=HourlySchedule.tiles(date,snapshot(listOf(event("10:00","11:00"))),now)
        assertEquals(24,tiles.size);assertEquals("00:00",tiles.first().label);assertEquals("23:00",tiles.last().label)
    }
    @Test fun partialOutageStaysInTheMiddleOfTheHour(){
        val tile=HourlySchedule.tiles(date,snapshot(listOf(event("10:15","10:45"))),now)[10]
        val off=tile.segments.single{it.category!=null}
        assertEquals(at("10:15"),off.start);assertEquals(at("10:45"),off.end)
        assertEquals(3,tile.segments.size)
    }
    @Test fun separatedQuarterHoursDoNotBecomeOneLeftHalf(){
        val tile=HourlySchedule.tiles(date,snapshot(listOf(event("10:00","10:15"),event("10:45","11:00"))),now)[10]
        assertEquals(2,tile.segments.count{it.category!=null})
        assertEquals(at("10:45"),tile.segments.last().start)
    }
    @Test fun arbitraryMinutesAreNotRoundedToQuarterHours(){
        val data=snapshot(listOf(event("10:07","10:11")))
        assertEquals(4L,HourlySchedule.summary(date,data,now).outageMinutes)
        assertEquals(at("10:07"),HourlySchedule.tiles(date,data,now)[10].segments.first{it.category!=null}.start)
    }
    @Test fun overlappingCategoriesAreCountedOnlyOnce(){
        val data=snapshot(listOf(event("10:00","12:00"),event("10:30","11:30",Category.EMERGENCY)))
        assertEquals(120L,HourlySchedule.summary(date,data,now).outageMinutes)
        assertEquals(Category.EMERGENCY,HourlySchedule.tiles(date,data,now)[10].segments.last().category)
    }
    @Test fun successfullyCheckedEmptyTodayHasFullDayOfClearTiles(){
        val summary=HourlySchedule.summary(date,snapshot(emptyList()),now)
        assertEquals(1440L,summary.clearMinutes);assertEquals(0L,summary.unknownMinutes)
        assertTrue(HourlySchedule.tiles(date,snapshot(emptyList()),now).all{it.segments.all{segment->!segment.uncertain && segment.category==null}})
    }
    @Test fun checkedEmptyDoesNotApplyToTomorrowOrFailedMissingAndConflictingSources(){
        val checked=snapshot(emptyList())
        assertEquals(1440L,HourlySchedule.summary(date.plusDays(1),checked,now).unknownMinutes)
        for(data in listOf(checked.copy(failures=setOf(Category.EMERGENCY)),checked.copy(feedFailed=true),checked.copy(conflictDates=setOf(date)),Snapshot(emptyMap()))){
            assertEquals(1440L,HourlySchedule.summary(date,data,now).unknownMinutes)
        }
    }
    @Test fun checkedEmptyUsesActualCivilDayDurationAtBothDstTransitions(){
        for((day,hours) in listOf(LocalDate.of(2026,3,29) to 23L,LocalDate.of(2026,10,25) to 25L)){
            val at=day.atStartOfDay(KYIV_ZONE).toInstant()
            val checked=Snapshot(Category.entries.associateWith{CategorySnapshot(it,at,at,emptyList(),testQueue(it))})
            assertEquals(hours*60,HourlySchedule.summary(day,checked,at).clearMinutes)
        }
    }
    @Test fun freshAddressScheduleWithoutQueueLeavesUncoveredGapsUnknown(){
        val tomorrow=date.plusDays(1)
        val start=tomorrow.atTime(10,7).atZone(KYIV_ZONE).toInstant()
        val initial=snapshot(listOf(Outage(Category.SCHEDULE,start,start.plusSeconds(3600),false,"","ГПВ")))
        val data=initial.copy(categories=initial.categories.mapValues{(_,v)->v.copy(queueInfo=emptyList())})
        val summary=HourlySchedule.summary(tomorrow,data,now)
        assertEquals(60L,summary.outageMinutes);assertEquals(0L,summary.clearMinutes);assertEquals(1380L,summary.unknownMinutes)
        assertNull(data.queueLabel())
    }
    @Test fun autumnDayHas25TilesWithTwoDistinctRepeatedHours(){
        val date=LocalDate.of(2026,10,25)
        val tiles=HourlySchedule.tiles(date,Snapshot(emptyMap()),date.atStartOfDay(KYIV_ZONE).toInstant())
        assertEquals(25,tiles.size)
        val repeated=tiles.filter{it.label.startsWith("03:00")}
        assertEquals(2,repeated.size);assertNotEquals(repeated[0].label,repeated[1].label);assertNotEquals(repeated[0].start,repeated[1].start)
    }
    @Test fun springDayOmitsTheNonexistentHour(){
        val date=LocalDate.of(2026,3,29)
        val tiles=HourlySchedule.tiles(date,Snapshot(emptyMap()),date.atStartOfDay(KYIV_ZONE).toInstant())
        assertEquals(23,tiles.size);assertTrue(tiles.none{it.label.startsWith("03:00")})
    }
}
