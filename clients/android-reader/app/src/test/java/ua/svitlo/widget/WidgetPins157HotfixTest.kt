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
class WidgetPins157HotfixTest {
    private val context get()=RuntimeEnvironment.getApplication()
    @Before fun reset(){WidgetPins.launcherReturned();shadowOf(AppWidgetManager.getInstance(context)).setRequestPinAppWidgetSupported(true)}
    @After fun clear(){WidgetPins.launcherReturned()}
    private fun existingBinding(compact:Boolean) {
        val provider=ComponentName(context,if(compact)CompactWidget::class.java else SvitloWidget::class.java)
        val shadow=shadowOf(AppWidgetManager.getInstance(context))
        shadow.addBoundWidget(if(compact)1571 else 1572,AppWidgetProviderInfo().apply{this.provider=provider})
        assertTrue(AppWidgetManager.getInstance(context).getAppWidgetIds(provider).isNotEmpty())
        // A bound ID is not proof that a launcher currently displays its widget.
    }
    @Test fun compactBindingWithoutVisibleLauncherViewDoesNotBlockExplicitPinRequest(){
        existingBinding(true)
        assertEquals(WidgetPins.Result.EXISTS,WidgetPins.request(context,true))
        assertEquals(WidgetPins.Result.REQUESTED,WidgetPins.request(context,true,allowExisting=true))
    }
    @Test fun detailedBindingWithoutVisibleLauncherViewDoesNotBlockExplicitPinRequest(){
        existingBinding(false)
        assertEquals(WidgetPins.Result.EXISTS,WidgetPins.request(context,false))
        assertEquals(WidgetPins.Result.REQUESTED,WidgetPins.request(context,false,allowExisting=true))
    }
    @Test fun delayedCompactDeletionCannotReleaseANewerPinRequest(){
        val gate=WidgetPins::class.java.getDeclaredField("gate").apply{isAccessible=true}.get(WidgetPins) as WidgetPinGate
        val now=android.os.SystemClock.elapsedRealtime()
        assertNotNull(gate.begin(true,now));assertNotNull(gate.begin(false,now))
        CompactWidget().onDeleted(context,intArrayOf(1571))
        assertNull(gate.begin(true,now));assertNull(gate.begin(false,now))
        WidgetPins.launcherReturned();assertNotNull(gate.begin(true,now))
    }
    @Test fun delayedDetailedDeletionCannotReleaseANewerPinRequest(){
        val gate=WidgetPins::class.java.getDeclaredField("gate").apply{isAccessible=true}.get(WidgetPins) as WidgetPinGate
        val now=android.os.SystemClock.elapsedRealtime()
        assertNotNull(gate.begin(true,now));assertNotNull(gate.begin(false,now))
        SvitloWidget().onDeleted(context,intArrayOf(1572))
        assertNull(gate.begin(true,now));assertNull(gate.begin(false,now))
        WidgetPins.launcherReturned();assertNotNull(gate.begin(false,now))
    }
    @Test fun callbackFromAnOldAppVersionCannotReleaseANewConfirmation(){
        val gate=WidgetPins::class.java.getDeclaredField("gate").apply{isAccessible=true}.get(WidgetPins) as WidgetPinGate
        val now=android.os.SystemClock.elapsedRealtime();assertNotNull(gate.begin(true,now))
        WidgetPinReceiver().onReceive(context,android.content.Intent().putExtra("compact",true))
        assertEquals(WidgetPins.Result.PENDING,WidgetPins.request(context,true))
    }
}
