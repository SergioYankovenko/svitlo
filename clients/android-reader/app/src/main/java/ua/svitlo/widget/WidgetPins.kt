package ua.svitlo.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import android.net.Uri

object WidgetPins {
    const val ADDED="ua.svitlo.widget.WIDGET_PIN_ADDED"
    private val gate=WidgetPinGate()
    enum class Result { REQUESTED, PENDING, EXISTS, UNSUPPORTED, FAILED }
    fun hasPending()=gate.hasPending()
    fun isPending(compact:Boolean)=gate.isPending(compact,SystemClock.elapsedRealtime())
    fun launcherReturned()=gate.launcherReturned()
    fun exists(context:Context,compact:Boolean):Boolean = AppWidgetManager.getInstance(context)
        .getAppWidgetIds(ComponentName(context,if(compact)CompactWidget::class.java else SvitloWidget::class.java)).isNotEmpty()
    fun addedMessage(compact:Boolean)="${if(compact)"Компактний"else"Детальний"} віджет додано. Перевірте головні екрани."
    fun confirmed(context:Context,compact:Boolean,token:String?){
        if(token!=null && gate.finish(compact,token))context.sendBroadcast(Intent(ADDED).setPackage(context.packageName).putExtra("compact",compact))
    }
    fun request(context:Context,compact:Boolean,allowExisting:Boolean=false):Result {
        val manager=AppWidgetManager.getInstance(context)
        if(!manager.isRequestPinAppWidgetSupported)return Result.UNSUPPORTED
        if(isPending(compact))return Result.PENDING
        // Existing bindings stop ordinary taps. A missing/invisible widget can still
        // be recovered through the app's explicit "Додати повторно" confirmation.
        if(!allowExisting && exists(context,compact))return Result.EXISTS
        val provider=ComponentName(context,if(compact)CompactWidget::class.java else SvitloWidget::class.java)
        val token=gate.begin(compact,SystemClock.elapsedRealtime()) ?: return Result.PENDING
        val callback=PendingIntent.getBroadcast(context,if(compact)1 else 0,
            Intent(context,WidgetPinReceiver::class.java).setData(Uri.parse("svitlo://widget-pin/$compact/$token"))
                .putExtra("compact",compact).putExtra("requestToken",token),
            PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_IMMUTABLE)
        return try{
            if(manager.requestPinAppWidget(provider,null,callback))Result.REQUESTED
            else {gate.finish(compact,token);Result.FAILED}
        }catch(_:RuntimeException){gate.finish(compact,token);Result.FAILED}
    }
}

class WidgetPinReceiver:BroadcastReceiver(){
    override fun onReceive(context:Context,intent:Intent){WidgetPins.confirmed(context,intent.getBooleanExtra("compact",false),intent.getStringExtra("requestToken"))}
}
