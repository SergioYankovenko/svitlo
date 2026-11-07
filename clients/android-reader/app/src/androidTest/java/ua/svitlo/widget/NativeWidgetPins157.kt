package ua.svitlo.widget

import android.app.Instrumentation
import android.appwidget.AppWidgetHost
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Button
import org.json.JSONArray
import org.json.JSONObject

/** Uses an actual launcher confirmation and framework widget deletion, only in the QA package. */
object NativeWidgetPins157 {
    fun verify(test:Instrumentation,activity:MainActivity):JSONArray {
        val context=test.targetContext;check(context.packageName.endsWith(".qa"))
        val manager=AppWidgetManager.getInstance(context)
        val host=AppWidgetHost(context,157);host.deleteHost()
        fun main(action:()->Unit){var error:Throwable?=null;test.runOnMainSync{try{action()}catch(e:Throwable){error=e}};error?.let{throw it}}
        fun all(view:View):List<View> = listOf(view)+if(view is ViewGroup)(0 until view.childCount).flatMap{all(view.getChildAt(it))}else emptyList()
        fun nodes(node:AccessibilityNodeInfo?):List<AccessibilityNodeInfo> = if(node==null)emptyList()else listOf(node)+(0 until node.childCount).flatMap{nodes(node.getChild(it))}
        fun waitFor(label:String,predicate:()->Boolean){val end=SystemClock.uptimeMillis()+10_000;while(SystemClock.uptimeMillis()<end){test.waitForIdleSync();if(predicate())return;SystemClock.sleep(100)};error(label)}
        fun shell(command:String){ParcelFileDescriptor.AutoCloseInputStream(test.uiAutomation.executeShellCommand(command)).use{it.readBytes()}}
        fun settings(){
            shell("am start -f 603979776 -n ${context.packageName}/ua.svitlo.widget.MainActivity --es screen settings")
            waitFor("Settings did not regain focus"){
                var ready=false;main{ready=activity.hasWindowFocus() && all(activity.window.decorView).any{it.tag=="appearance"}};ready
            }
            waitFor("Cancelled/completed pin stayed pending"){!WidgetPins.hasPending()}
        }
        val labels=listOf("Додати автоматично","Додати на головний екран","Додати","Add automatically","Add to home screen","Add")
        fun confirmButton():AccessibilityNodeInfo?=nodes(test.uiAutomation.rootInActiveWindow).firstOrNull{node->
            node.isClickable && node.isEnabled && node.packageName?.toString()?.contains("launcher")==true &&
                labels.any{it.equals(node.text?.toString(),ignoreCase=true)}
        }
        fun appConfirmButton():AccessibilityNodeInfo?=nodes(test.uiAutomation.rootInActiveWindow).firstOrNull{node->
            node.isClickable && node.isEnabled && node.packageName?.toString()==context.packageName &&
                node.text?.toString() in listOf("Додати","Додати повторно")
        }
        fun clickPin(compact:Boolean){
            val provider=ComponentName(context,if(compact)CompactWidget::class.java else SvitloWidget::class.java)
            val before=manager.getAppWidgetIds(provider).toSet()
            main{
                val button=all(activity.window.decorView).filterIsInstance<Button>().single{it.text.toString().startsWith(if(compact)"Компактний ·"else"Детальний ·")}
                button.requestRectangleOnScreen(Rect(0,0,button.width,button.height),true)
                check(button.performClick())
            }
            waitFor("The app did not show its own pin confirmation"){appConfirmButton()!=null}
            main{
                val button=all(activity.window.decorView).filterIsInstance<Button>().single{it.text.toString().startsWith(if(compact)"Компактний ·"else"Детальний ·")}
                repeat(5){button.performClick()}
            }
            check(manager.getAppWidgetIds(provider).toSet()==before){"Opening the app confirmation created a widget"}
            val image=test.uiAutomation.takeScreenshot()
            java.io.File(context.cacheDir,"pins159-app-${if(compact)"compact"else"detailed"}.png").outputStream().use{image.compress(Bitmap.CompressFormat.PNG,100,it)}
            check(appConfirmButton()!!.performAction(AccessibilityNodeInfo.ACTION_CLICK))
            waitFor("Explicit pin did not reach the launcher confirmation"){confirmButton()!=null}
            var duplicate:WidgetPins.Result?=null;main{duplicate=WidgetPins.request(activity,compact)}
            // A launcher/focus callback can already have cleared the transient
            // gate; an existing binding must still block an ordinary request.
            check(duplicate in listOf(WidgetPins.Result.PENDING,WidgetPins.Result.EXISTS)){"Repeated click opened another request: $duplicate"}
        }
        fun capture(name:String){val image=test.uiAutomation.takeScreenshot();java.io.File(context.cacheDir,"pins157-$name.png").outputStream().use{image.compress(Bitmap.CompressFormat.PNG,100,it)}}
        val results=JSONArray()
        try {
            for(compact in listOf(true,false)){
                settings()
                val provider=ComponentName(context,if(compact)CompactWidget::class.java else SvitloWidget::class.java)
                var hidden=0;main{hidden=host.allocateAppWidgetId();check(manager.bindAppWidgetIdIfAllowed(hidden,provider))}
                check(hidden in manager.getAppWidgetIds(provider))
                val before=manager.getAppWidgetIds(provider).toSet()
                clickPin(compact);capture(if(compact)"compact-cancel"else"detailed-cancel")
                check(test.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK))
                settings()
                check(manager.getAppWidgetIds(provider).toSet()==before){"Cancellation created a widget"}
                // onDeleted is delivered by Android, not called directly by the test.
                main{check(WidgetPins.request(activity,compact,allowExisting=true)==WidgetPins.Result.REQUESTED)}
                waitFor("Second request was blocked"){confirmButton()!=null}
                main{host.deleteAppWidgetId(hidden)}
                waitFor("Framework did not delete the old widget"){hidden !in manager.getAppWidgetIds(provider)}
                SystemClock.sleep(300)
                check(WidgetPins.isPending(compact)){"Old deletion released a newer pin request"}
                check(test.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK))
                settings()
                clickPin(compact)
                check(confirmButton()!!.performAction(AccessibilityNodeInfo.ACTION_CLICK))
                waitFor("Launcher did not bind the confirmed widget"){manager.getAppWidgetIds(provider).any{it !in before}}
                val added=manager.getAppWidgetIds(provider).filter{it !in before}
                settings()
                main{check(all(activity.window.decorView).filterIsInstance<android.widget.TextView>()
                    .single{it.tag=="widget_pin_status"}.text.isNotBlank()){"No visible feedback after requesting a widget"}}
                // An ordinary tap cannot add another copy. Recovery still requires explicit app confirmation.
                main{check(WidgetPins.request(activity,compact)==WidgetPins.Result.EXISTS)}
                clickPin(compact)
                check(test.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK))
                settings()
                results.put(JSONObject().put("compact",compact).put("hidden_id_did_not_block",true).put("cancel_retry",true)
                    .put("double_click_guard",true).put("framework_deletion_did_not_release_new_pin",true).put("confirmed_widgets",added.size)
                    .put("ordinary_requests_blocked",true).put("app_confirmation",true).put("repeated_app_taps_no_widget",true)
                    .put("visible_feedback",true).put("explicit_request_with_existing_id",true))
            }
        }catch(error:Throwable){runCatching{capture("failure")};throw error}
        finally{main{host.deleteHost()};WidgetPins.launcherReturned()}
        return results
    }
}
