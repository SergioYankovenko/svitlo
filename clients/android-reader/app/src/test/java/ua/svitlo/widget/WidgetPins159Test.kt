package ua.svitlo.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProviderInfo
import android.content.ComponentName
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[28])
class WidgetPins159Test {
    private val context get()=RuntimeEnvironment.getApplication()
    @Before fun reset(){WidgetPins.launcherReturned();shadowOf(AppWidgetManager.getInstance(context)).setRequestPinAppWidgetSupported(true)}
    @After fun clear(){WidgetPins.launcherReturned()}
    private fun bound(compact:Boolean){
        val provider=ComponentName(context,if(compact)CompactWidget::class.java else SvitloWidget::class.java)
        shadowOf(AppWidgetManager.getInstance(context)).addBoundWidget(if(compact)1591 else 1592,AppWidgetProviderInfo().apply{this.provider=provider})
    }
    @Test fun anAutomaticallyAcceptedCompactWidgetStopsTheNextOrdinaryRequest(){
        assertEquals("REQUESTED",WidgetPins.request(context,true).name)
        bound(true);WidgetPins.launcherReturned()
        repeat(10){assertEquals("EXISTS",WidgetPins.request(context,true).name)}
    }
    @Test fun anAutomaticallyAcceptedDetailedWidgetStopsTheNextOrdinaryRequest(){
        assertEquals("REQUESTED",WidgetPins.request(context,false).name)
        bound(false);WidgetPins.launcherReturned()
        repeat(10){assertEquals("EXISTS",WidgetPins.request(context,false).name)}
    }
    @Test fun onlyTheMatchingSuccessCallbackAnnouncesCompletionOnce(){
        val gate=WidgetPins::class.java.getDeclaredField("gate").apply{isAccessible=true}.get(WidgetPins) as WidgetPinGate
        val token=gate.begin(true,android.os.SystemClock.elapsedRealtime())!!
        val before=shadowOf(context).broadcastIntents.count{it.action==WidgetPins.ADDED}
        val callback=android.content.Intent().putExtra("compact",true).putExtra("requestToken",token)
        WidgetPinReceiver().onReceive(context,callback)
        WidgetPinReceiver().onReceive(context,callback)
        assertEquals(before+1,shadowOf(context).broadcastIntents.count{it.action==WidgetPins.ADDED})
        assertFalse(WidgetPins.hasPending())
    }
}
