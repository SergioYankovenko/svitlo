package ua.svitlo.widget

import android.app.AlarmManager
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.time.Instant

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[28])
class ScheduleNotificationsTest {
    private lateinit var context:Context
    private val now=Instant.parse("2026-10-23T04:00:00Z")
    @Before fun setup(){context=RuntimeEnvironment.getApplication();listOf("svitlo_private","svitlo_notifications","svitlo_official").forEach{context.getSharedPreferences(it,0).edit().clear().commit()}}
    private fun bind(){
        val raw="""{"DATETIME":"07:00 23.10.2026","DISCONN_QUEUQ":[{"QUEUE_INFO":"Графік погодинних відключень: 3 черга 2 підчерга"}],"DISCONNECTIONS":[{"DATE_START":"09:00 23.10.2026","DATE_STOP":"11:00 23.10.2026","DISCONN_TYPE":"ГПВ","STATE_CHAR":"План"}]}"""
        val repo=OutageRepository(context,OutageSource{_,_,_,_->raw}){now}
        assertTrue(repo.bindConfirmed("12345678901","Тестова адреса",repo.prepare("12345678901")))
        assertTrue(OfficialScheduleRepository(context,OfficialFeedSource{emptyList()}){now}.refresh())
    }
    @Test fun notificationSwitchPersistsAcrossReads(){
        assertFalse(ScheduleNotifications.enabled(context,"before_off"))
        ScheduleNotifications.setEnabled(context,"before_off",true)
        assertTrue(ScheduleNotifications.enabled(context,"before_off"))
        ScheduleNotifications.setEnabled(context,"before_off",false)
        assertFalse(ScheduleNotifications.enabled(context,"before_off"))
    }
    @Test fun unboundOrDisabledSettingsCannotCreateAlarm(){
        ScheduleNotifications.setEnabled(context,"before_off",true);ScheduleNotifications.rebuild(context,now)
        assertTrue(shadowOf(context.getSystemService(AlarmManager::class.java)).scheduledAlarms.isEmpty())
    }
    @Test fun repeatedRebuildDoesNotDuplicateFutureAlarmsAndClearCancelsThem(){
        bind();ScheduleNotifications.setEnabled(context,"before_off",true)
        ScheduleNotifications.rebuild(context,now);ScheduleNotifications.rebuild(context,now)
        assertEquals(1,shadowOf(context.getSystemService(AlarmManager::class.java)).scheduledAlarms.size)
        ScheduleNotifications.cancel(context)
        assertTrue(shadowOf(context.getSystemService(AlarmManager::class.java)).scheduledAlarms.isEmpty())
    }
    private fun alarmIntent()=Intent(context,ScheduleAlarmReceiver::class.java).setAction(ScheduleNotifications.ALARM)
        .putExtra("token",context.getSharedPreferences("svitlo_notifications",0).getString("token",null))
        .putExtra("kind","before_off").putExtra("at",now.plusSeconds(5400).toEpochMilli()).putExtra("transition",now.plusSeconds(7200).toEpochMilli())
    @Test fun confirmedFreshAlarmProducesALocalNotification(){
        bind();ScheduleNotifications.setEnabled(context,"before_off",true);ScheduleNotifications.rebuild(context,now)
        ScheduleNotifications.deliver(context,alarmIntent(),now.plusSeconds(5400))
        assertEquals(1,shadowOf(context.getSystemService(NotificationManager::class.java)).size())
    }
    @Test fun oldAlarmCannotNotifyAfterSameAccountIsRebound(){
        bind();ScheduleNotifications.setEnabled(context,"before_off",true);ScheduleNotifications.rebuild(context,now)
        val old=alarmIntent();bind()
        ScheduleNotifications.deliver(context,old,now.plusSeconds(5400))
        assertEquals(0,shadowOf(context.getSystemService(NotificationManager::class.java)).size())
    }
}
