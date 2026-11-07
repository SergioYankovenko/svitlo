package ua.svitlo.widget.core

import java.time.Instant

data class ScheduleReminder(val kind:String,val at:Instant,val transition:Instant)
object ReminderPlan {
    fun create(snapshot:Snapshot,now:Instant,beforeOff:Boolean,beforeOn:Boolean,leadMinutes:Int=30):List<ScheduleReminder> {
        require(leadMinutes in listOf(5,15,30,60))
        if(!snapshot.isCompleteAndFresh(now) || snapshot.openEmergency(now))return emptyList()
        val events=snapshot.allEvents().filter{it.end==null || it.end>now}.sortedBy{it.start}
        val merged=mutableListOf<Pair<Instant,Instant?>>()
        for(event in events){
            val previous=merged.lastOrNull()
            if(previous!=null && (previous.second==null || event.start<=previous.second)){
                merged[merged.lastIndex]=previous.first to if(previous.second==null || event.end==null)null else maxOf(previous.second!!,event.end)
            }else merged+=event.start to event.end
        }
        return merged.flatMap{(start,end)->buildList{
            val off=start.minusSeconds(leadMinutes*60L)
            if(beforeOff && off>now && !snapshot.emergency.uncertain(start,snapshot.plans,now))add(ScheduleReminder("before_off",off,start))
            val on=end?.minusSeconds(leadMinutes*60L)
            if(beforeOn && on!=null && on>now && !snapshot.emergency.uncertain(end,snapshot.plans,now))add(ScheduleReminder("before_on",on,end))
        }}.sortedBy{it.at}.take(64)
    }
}
