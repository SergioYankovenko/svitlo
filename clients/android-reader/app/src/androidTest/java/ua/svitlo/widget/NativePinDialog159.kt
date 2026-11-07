package ua.svitlo.widget

import android.app.AlertDialog
import android.app.Instrumentation
import android.appwidget.AppWidgetHost
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject

/** Dialog geometry on real Android; fixture IDs never leave the QA package. */
object NativePinDialog159 {
    fun verify(test:Instrumentation,activity:MainActivity):JSONObject {
        val context=test.targetContext;check(context.packageName.endsWith(".qa"))
        val host=AppWidgetHost(context,1599);host.deleteHost()
        val prompt=WidgetPinPrompt(activity){error("Layout inspection must not submit a pin request")}
        var shown:AlertDialog?=null
        fun main(action:()->Unit){var error:Throwable?=null;test.runOnMainSync{try{action()}catch(e:Throwable){error=e}};error?.let{throw it}}
        fun all(v:View):List<View> = listOf(v)+if(v is ViewGroup)(0 until v.childCount).flatMap{all(v.getChildAt(it))}else emptyList()
        fun bounds(view:View):Rect {val p=IntArray(2);view.getLocationOnScreen(p);return Rect(p[0],p[1],p[0]+view.width,p[1]+view.height)}
        val result=JSONObject()
        try{
            main{
                WidgetPins.launcherReturned()
                val id=host.allocateAppWidgetId()
                check(AppWidgetManager.getInstance(context).bindAppWidgetIdIfAllowed(id,ComponentName(context,CompactWidget::class.java)))
                prompt.show(true)
                shown=WidgetPinPrompt::class.java.getDeclaredField("dialog").apply{isAccessible=true}.get(prompt) as AlertDialog
            }
            test.waitForIdleSync();SystemClock.sleep(200)
            main{
                val dialog=shown!!;val root=dialog.window!!.decorView;val views=all(root)
                val title=views.single{it.tag=="widget_pin_title"} as TextView
                val divider=views.single{it.tag=="widget_pin_divider"}
                val body=views.single{it.tag=="widget_pin_message"} as TextView
                val scroll=views.single{it.tag=="widget_pin_body"} as ScrollView
                val actions=listOf("widget_pin_negative","widget_pin_positive").map{tag->views.single{it.tag==tag} as Button}
                check(title.text.toString()=="Перевірте головні екрани")
                check(androidx.core.view.ViewCompat.isAccessibilityHeading(title))
                check(divider.height>0 && bounds(title).bottom<bounds(divider).top)
                check(bounds(divider).bottom<bounds(body).top+body.paddingTop)
                for(label in listOf(title,body)+actions){
                    val layout=label.layout ?: error("No text layout")
                    val available=label.width-label.compoundPaddingLeft-label.compoundPaddingRight
                    check((0 until layout.lineCount).all{layout.getLineMax(it)<=available+1}){"Clipped label: ${label.text}"}
                    check(layout.height<=label.height-label.compoundPaddingTop-label.compoundPaddingBottom+1){"Clipped text height: ${label.text}"}
                }
                val window=bounds(root)
                for(action in actions){
                    check(action.lineCount==1){"Action label wrapped: ${action.text}"}
                    val visible=Rect();check(action.getGlobalVisibleRect(visible))
                    check(visible.width()==action.width && visible.height()==action.height && window.contains(bounds(action))){"Clipped action: ${action.text}; visible=$visible; screen=${bounds(action)}; window=$window"}
                    check(action.height/context.resources.displayMetrics.density>=47.9f)
                }
                check(!Rect.intersects(bounds(actions[0]),bounds(actions[1])))
                check(bounds(scroll).bottom<=actions.minOf{bounds(it).top})
                scroll.scrollTo(0,body.height)
                check(scroll.scrollY+scroll.height>=body.height)
                scroll.scrollTo(0,0)
                result.put("fontScale",context.resources.configuration.fontScale).put("light",AppAppearance.light(context))
                    .put("header_divider",true).put("full_labels",true).put("actions_visible",true)
                    .put("body_scrollable_if_needed",true).put("widthDp",root.width/context.resources.displayMetrics.density)
            }
            test.waitForIdleSync()
            val image=test.uiAutomation.takeScreenshot()
            java.io.File(context.cacheDir,"dialog159.png").outputStream().use{image.compress(Bitmap.CompressFormat.PNG,100,it)}
            val hit=Rect()
            main{
                val button=shown!!.window!!.decorView.findViewWithTag<Button>("widget_pin_negative")
                check(button.getLocalVisibleRect(hit))
                val screen=IntArray(2);button.getLocationOnScreen(screen);hit.offset(screen[0],screen[1])
            }
            val down=SystemClock.uptimeMillis()
            for(action in listOf(android.view.MotionEvent.ACTION_DOWN,android.view.MotionEvent.ACTION_UP)){
                val event=android.view.MotionEvent.obtain(down,SystemClock.uptimeMillis(),action,hit.exactCenterX(),hit.exactCenterY(),0)
                event.source=android.view.InputDevice.SOURCE_TOUCHSCREEN
                check(test.uiAutomation.injectInputEvent(event,true));event.recycle()
                if(action==android.view.MotionEvent.ACTION_DOWN)SystemClock.sleep(60)
            }
            test.waitForIdleSync();check(!shown!!.isShowing){"A real touch must close the pin dialog without requesting another widget"}
            result.put("cancel_by_real_touch",true)
            return result
        }catch(error:Throwable){
            test.uiAutomation.takeScreenshot()?.let{image->java.io.File(context.cacheDir,"dialog159.png").outputStream().use{image.compress(Bitmap.CompressFormat.PNG,100,it)}}
            throw error
        }finally{main{prompt.close();host.deleteHost();WidgetPins.launcherReturned()}}
    }
}
