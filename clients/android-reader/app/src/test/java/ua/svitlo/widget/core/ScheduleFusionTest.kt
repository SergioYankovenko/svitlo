package ua.svitlo.widget.core

import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.LocalDate

class ScheduleFusionTest {
    private val now=Instant.parse("2026-10-22T20:40:00Z")
    private val day=LocalDate.of(2026,10,23)
    private fun at(clock:String)=if(clock=="24:00")day.plusDays(1).atStartOfDay(KYIV_ZONE).toInstant()
        else day.atTime(java.time.LocalTime.parse(clock)).atZone(KYIV_ZONE).toInstant()
    private fun event(from:String,to:String,category:Category=Category.SCHEDULE)=Outage(category,at(from),at(to),false,"Опубліковано","ГПВ")
    private fun address(events:List<Outage> = emptyList())=Snapshot(Category.entries.associateWith {
        CategorySnapshot(it,now,now,events.filter{e->e.category==it},if(it==Category.SCHEDULE)listOf("Графік погодинних відключень - 3 черга 2 підчерга")else emptyList())
    })
    private fun plan(events:List<Outage> = listOf(event("08:00","10:00"),event("14:00","16:00"),event("20:00","22:00")))=
        PublishedPlan(day,"3.2",events,now.minusSeconds(3600),now,"https://www.cherkasyoblenergo.com/media/example","revision")

    @Test fun publishedTomorrowFillsEmptyAddressResponseAndClearPeriods() {
        val merged=ScheduleFusion.merge(address(),listOf(plan()),now)
        assertEquals(3,merged.allEvents().size)
        val bins=Timeline.bins(day,merged,now)
        assertEquals(72,bins.count{it.category==Category.SCHEDULE})
        assertTrue(bins.none{it.uncertain})
    }
    @Test fun recentCheckKeepsAnOldUnchangedPublicationValid() {
        val merged=ScheduleFusion.merge(address(),listOf(plan().copy(publishedAt=now.minusSeconds(72_000))),now)
        assertTrue(merged.isCompleteAndFresh(now))
        assertTrue(Timeline.bins(day,merged,now).none{it.uncertain})
    }
    @Test fun failedFeedRetainsIntervalsButMarksThemUnverified() {
        val merged=ScheduleFusion.merge(address(),listOf(plan()),now,feedFailed=true)
        assertEquals(3,merged.allEvents().size)
        assertTrue(Timeline.bins(day,merged,now).all{it.uncertain})
    }
    @Test fun conflictingHourlySourcesDoNotInventAUnionOfAlternativePlans() {
        val raw=address(listOf(event("16:00","18:00")))
        val merged=ScheduleFusion.merge(raw,listOf(plan(listOf(event("14:00","16:00")))),now)
        assertEquals(setOf(day),merged.conflictDates)
        assertTrue(merged.allEvents().none{it.category==Category.SCHEDULE})
        assertEquals(1,merged.categories[Category.SCHEDULE]!!.events.size)
        assertEquals(1,merged.plans.single().events.size)
        assertTrue(Timeline.bins(day,merged,now).all{it.uncertain})
    }
    @Test fun identicalSourcesDoNotDuplicateOutages() {
        val events=plan().events
        val merged=ScheduleFusion.merge(address(events),listOf(plan(events)),now)
        assertTrue(merged.conflictDates.isEmpty())
        assertEquals(3,merged.allEvents().size)
    }
    @Test fun individualPlannedAndEmergencyEventsRemainAboveGeneralSchedule() {
        val raw=address(listOf(event("08:00","09:00",Category.PLANNED),event("08:30","08:45",Category.EMERGENCY)))
        val merged=ScheduleFusion.merge(raw,listOf(plan()),now)
        val bins=Timeline.bins(day,merged,now)
        assertEquals(Category.PLANNED,bins.first{it.start==at("08:00")}.category)
        assertEquals(Category.EMERGENCY,bins.first{it.start==at("08:30")}.category)
        assertEquals(Category.SCHEDULE,bins.first{it.start==at("09:00")}.category)
    }
    @Test fun explicitCancellationDoesNotClaimAnEntireDayOfPower() {
        val merged=ScheduleFusion.merge(address(),listOf(plan(emptyList()).copy(cancelled=true)),now)
        assertTrue(merged.allEvents().isEmpty())
        assertTrue(Timeline.bins(day,merged,now).all{it.uncertain})
    }
    @Test fun unparseableRevisionRetainsItsIntervalsAsUncertain() {
        val merged=ScheduleFusion.merge(address(),listOf(plan().copy(uncertain=true)),now)
        assertEquals(3,merged.allEvents().size)
        assertTrue(Timeline.bins(day,merged,now).all{it.uncertain})
    }
    @Test fun completedHistoricalActualTimesDoNotConflictWithFuturePublishedPlan() {
        val later=at("13:00")
        val actual=event("08:00","10:01").copy(status="Завершено")
        val raw=address(listOf(actual)).let{s->s.copy(categories=s.categories.mapValues{(_,v)->v.copy(sourceUpdatedAt=later,fetchedAt=later)})}
        val merged=ScheduleFusion.merge(raw,listOf(plan().copy(checkedAt=later)),later)
        assertTrue(merged.conflictDates.isEmpty())
        assertEquals(3,merged.allEvents().size)
    }
    @Test fun completedAddressIntervalSurvivesARevisionContainingOnlyLaterWindows(){
        val later=at("13:10")
        val actual=event("08:00","10:01").copy(status="Завершено")
        val raw=address(listOf(actual)).let{s->s.copy(categories=s.categories.mapValues{(_,v)->v.copy(sourceUpdatedAt=later,fetchedAt=later)})}
        val updated=plan(listOf(event("14:00","16:00"),event("20:00","22:00"))).copy(publishedAt=at("13:05"),checkedAt=later)
        val merged=ScheduleFusion.merge(raw,listOf(updated),later)
        assertEquals(listOf(actual)+updated.events,merged.allEvents())
        assertEquals(361L,HourlySchedule.summary(day,merged,later).outageMinutes)
    }
    @Test fun completedLookingAddressWindowCancelledBeforeItStartedDoesNotReappearAfterLateFetch(){
        val later=at("17:00")
        val cancelled=event("14:00","16:00")
        val raw=address(listOf(cancelled)).let{s->s.copy(categories=s.categories.mapValues{(_,v)->v.copy(sourceUpdatedAt=later,fetchedAt=later)})}
        val updated=plan(listOf(event("20:00","22:00"))).copy(publishedAt=at("13:05"),checkedAt=later)
        assertEquals(updated.events,ScheduleFusion.merge(raw,listOf(updated),later).allEvents())
    }
    @Test fun laterPublicRevisionCannotReviveAnOldPlannedWindowThatEarlierRevisionRemoved(){
        val cachedAt=at("12:00")
        val raw=address(listOf(event("14:00","16:00").copy(status="Заплановано"))).let{s->
            s.copy(categories=s.categories.mapValues{(_,value)->value.copy(sourceUpdatedAt=cachedAt,fetchedAt=cachedAt)})}
        val remaining=listOf(event("20:00","22:00"))
        val firstRevision=plan(remaining).copy(publishedAt=at("13:05"),checkedAt=at("13:10"))
        val laterRevision=plan(remaining).copy(publishedAt=at("17:05"),checkedAt=at("17:10"))
        assertTrue(ScheduleFusion.merge(raw,listOf(firstRevision),at("13:10")).allEvents().none{it.start==at("14:00")})
        assertEquals(remaining,ScheduleFusion.merge(raw,listOf(laterRevision),at("17:10")).allEvents())
    }
    @Test fun rawHistoryRequiresExplicitCompletionAndSourceTimesAfterTheIntervalEnd(){
        val later=at("17:10")
        val remaining=listOf(event("20:00","22:00"))
        val revised=plan(remaining).copy(publishedAt=at("17:05"),checkedAt=later)
        for((status,updated,fetched) in listOf(
            Triple("Заплановано",later,later),Triple("Не завершено",later,later),
            Triple("Завершено",at("12:00"),later),Triple("Завершено",later,at("12:00")))){
            val raw=address(listOf(event("14:00","16:00").copy(status=status))).let{s->
                s.copy(categories=s.categories.mapValues{(_,value)->value.copy(sourceUpdatedAt=updated,fetchedAt=fetched)})}
            assertEquals(remaining,ScheduleFusion.merge(raw,listOf(revised),later).allEvents())
        }
    }
    @Test fun recentOfficialVerificationCoversStaleAddressHourlyChannel(){
        val raw=address().let{s->s.copy(categories=s.categories.mapValues{(key,value)->
            if(key==Category.SCHEDULE)value.copy(fetchedAt=now.minusSeconds(10800))else value})}
        val merged=ScheduleFusion.merge(raw,listOf(plan()),now)
        assertTrue(merged.isCompleteAndFresh(now))
        assertTrue(Timeline.bins(day,merged,now).none{it.uncertain})
    }
    @Test fun unrelatedNewPublicationCannotRevalidateAnUnseenCachedDay(){
        val stale=plan().copy(checkedAt=now.minusSeconds(10800))
        val other=plan().copy(date=day.plusDays(1),events=emptyList())
        val merged=ScheduleFusion.merge(address(),listOf(stale,other),now)
        assertFalse(merged.isCompleteAndFresh(now))
        assertTrue(Timeline.bins(day,merged,now).all{it.uncertain})
        assertTrue(ReminderPlan.create(merged,now,true,true).isEmpty())
    }
    @Test fun equivalentAdjacentAddressSegmentsDoNotConflictWithOnePublicationRange(){
        val merged=ScheduleFusion.merge(address(listOf(event("08:00","09:00"),event("09:00","10:00"))),listOf(plan()),now)
        assertTrue(merged.conflictDates.isEmpty())
        assertEquals(3,merged.allEvents().size)
    }
    @Test fun ambiguousHourlyQueuesNeverChooseTheFirstOne(){
        val snapshot=address().let{s->s.copy(categories=s.categories.mapValues{(key,value)->if(key==Category.SCHEDULE)value.copy(queueInfo=listOf(
            "Графік погодинних відключень - 3 черга 2 підчерга","Графік погодинних відключень - 2 черга 1 підчерга"))else value})}
        assertNull(snapshot.queueLabel())
    }
    @Test fun equivalentSegmentationRemainsEqualAfterFirstPartHasFinished(){
        val later=at("09:30")
        val raw=address(listOf(event("08:00","09:00"),event("09:00","10:00")))
            .let{s->s.copy(categories=s.categories.mapValues{(_,value)->value.copy(sourceUpdatedAt=later,fetchedAt=later)})}
        val merged=ScheduleFusion.merge(raw,listOf(plan().copy(checkedAt=later)),later)
        assertTrue(merged.conflictDates.isEmpty())
    }
    @Test fun FreshPublicationForAnotherDayCannotConfirmUncoveredStaleAddressIntervals(){
        val raw=address(listOf(event("08:00","10:00"))).let{s->s.copy(categories=s.categories.mapValues{(key,value)->
            if(key==Category.SCHEDULE)value.copy(fetchedAt=now.minusSeconds(10800))else value},failures=setOf(Category.SCHEDULE))}
        val other=plan().copy(date=day.plusDays(1),events=emptyList())
        val merged=ScheduleFusion.merge(raw,listOf(other),now)
        assertFalse(merged.isCompleteAndFresh(now));assertTrue(ReminderPlan.create(merged,now,true,true).isEmpty())
    }
}
