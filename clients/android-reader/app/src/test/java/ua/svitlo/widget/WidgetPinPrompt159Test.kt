package ua.svitlo.widget

import android.app.Activity
import android.app.AlertDialog
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProviderInfo
import android.content.ComponentName
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import android.widget.Button
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import org.robolectric.shadows.ShadowAlertDialog

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[28],qualifiers="w320dp-h780dp-mdpi")
@LooperMode(LooperMode.Mode.PAUSED)
class WidgetPinPrompt159Test {
    private lateinit var controller:ActivityController<Activity>
    private val activity get()=controller.get()
    private lateinit var prompt:WidgetPinPrompt
    private val feedback=mutableListOf<String>()
    private fun provider(compact:Boolean)=ComponentName(activity,if(compact)CompactWidget::class.java else SvitloWidget::class.java)
    private fun ids(compact:Boolean)=AppWidgetManager.getInstance(activity).getAppWidgetIds(provider(compact))
    private fun dialog()=ShadowAlertDialog.getLatestAlertDialog().also{assertTrue(it.isShowing)}
    private fun button(shown:AlertDialog,positive:Boolean):Button=shown.window!!.decorView.findViewWithTag(if(positive)"widget_pin_positive"else"widget_pin_negative")
    @Before fun prepare(){
        WidgetPins.launcherReturned()
        controller=Robolectric.buildActivity(Activity::class.java).setup()
        shadowOf(AppWidgetManager.getInstance(activity)).setRequestPinAppWidgetSupported(true)
        for(compact in listOf(true,false))shadowOf(AppWidgetManager.getInstance(activity))
            .addInstalledProvider(AppWidgetProviderInfo().apply{provider=provider(compact)})
        prompt=WidgetPinPrompt(activity){feedback+=it}
    }
    @After fun close(){prompt.close();controller.pause().stop().destroy();WidgetPins.launcherReturned();RuntimeEnvironment.setFontScale(1f)}
    @Test fun firstTapAlwaysShowsAppConfirmationAndCancellationCreatesNothing(){
        prompt.show(true);val shown=dialog()
        assertEquals(0,ids(true).size);assertFalse(WidgetPins.hasPending())
        repeat(10){prompt.show(true);assertSame(shown,dialog())}
        button(shown,false).performClick();shadowOf(Looper.getMainLooper()).idle()
        assertEquals(0,ids(true).size);assertFalse(WidgetPins.hasPending());assertTrue(feedback.isEmpty())
    }
    @Test fun automaticLauncherCanCreateOnlyOneWidgetUntilRecoveryIsExplicitlyConfirmed(){
        for(compact in listOf(true,false)){
            prompt.show(compact)
            val action=button(dialog(),true)
            action.performClick();action.performClick()
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals("compact=$compact",1,ids(compact).size)
            assertTrue(feedback.last().contains("Перевірте головні екрани"))
            repeat(10){
                WidgetPins.launcherReturned();prompt.show(compact)
                assertEquals("Додати повторно",button(dialog(),true).text.toString())
                button(dialog(),false).performClick();shadowOf(Looper.getMainLooper()).idle()
                assertEquals(1,ids(compact).size)
            }
        }
    }
    @Test fun invisibleBindingIsRecoverableWithoutTurningOrdinaryTapsIntoDuplicateWidgets(){
        shadowOf(AppWidgetManager.getInstance(activity)).addBoundWidget(159,AppWidgetProviderInfo().apply{provider=provider(true)})
        prompt.show(true)
        assertEquals(1,ids(true).size)
        val action=button(dialog(),true)
        assertEquals("Додати повторно",action.text.toString())
        action.performClick();action.performClick();shadowOf(Looper.getMainLooper()).idle()
        assertEquals(2,ids(true).size)
    }
    @Test fun unsupportedLauncherShowsManualInstructionsWithoutSendingPinRequest(){
        shadowOf(AppWidgetManager.getInstance(activity)).setRequestPinAppWidgetSupported(false)
        prompt.show(true)
        assertEquals("Зрозуміло",button(dialog(),true).text.toString())
        assertNull(dialog().window!!.decorView.findViewWithTag<View>("widget_pin_negative"))
        assertEquals(0,ids(true).size);assertFalse(WidgetPins.hasPending())
    }
    @Test fun bothThemesAndLargeFontsRetainSeparateExplicitActions(){
        fun all(view:View):List<View> = listOf(view)+if(view is ViewGroup)(0 until view.childCount).flatMap{all(view.getChildAt(it))}else emptyList()
        for(light in listOf(false,true))for(font in listOf(1f,1.5f,2f)){
            AppAppearance.setLight(activity,light);RuntimeEnvironment.setFontScale(font)
            prompt.show(false)
            assertEquals("Додати",button(dialog(),true).text.toString())
            assertEquals("Скасувати",button(dialog(),false).text.toString())
            val content=all(dialog().window!!.decorView)
            assertEquals("Додати детальний віджет?",(content.single{it.tag=="widget_pin_title"} as TextView).text.toString())
            assertTrue(androidx.core.view.ViewCompat.isAccessibilityHeading(content.single{it.tag=="widget_pin_title"}))
            assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_NO,content.single{it.tag=="widget_pin_divider"}.importantForAccessibility)
            assertTrue(content.any{it.tag=="widget_pin_body" && it is android.widget.ScrollView})
            button(dialog(),false).performClick();shadowOf(Looper.getMainLooper()).idle()
            assertEquals(0,ids(false).size)
        }
    }
}
