package ua.svitlo.widget

import android.app.NotificationManager
import android.content.Context

internal object NotificationAccess {
    data class Status(val enabled:Boolean,val explanation:String){val label get()=if(enabled)"Сповіщення увімкнено"else"Сповіщення вимкнено"}
    fun read(context:Context):Status {
        val manager=context.getSystemService(NotificationManager::class.java)
        val permission=ScheduleNotifications.notificationPermission(context)
        val global=manager.areNotificationsEnabled()
        val blocked=manager.notificationChannels.filter{it.importance==NotificationManager.IMPORTANCE_NONE}.map{it.name.toString()}
        val enabled=permission && global
        val explanation=when{
            !permission->"Системний дозвіл на сповіщення не надано. Його можна надати в налаштуваннях Android."
            !global->"Android блокує сповіщення цього застосунку. Увімкніть їх у системних налаштуваннях."
            else->"Android дозволяє сповіщення застосунку. Потрібні типи можна вибрати нижче."
        }+(if(blocked.isNotEmpty())"\n\nВимкнені системні канали: ${blocked.joinToString(", ")}."else"")
        return Status(enabled,explanation)
    }
}
