package ua.svitlo.widget

import android.app.Instrumentation
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Intent
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

/** Actual selected HOME application. No mock launcher, host, or pin-success callback. */
object NativeLauncherMatrix159 {
    fun verify(test:Instrumentation,activity:MainActivity,expectedHome:String):JSONObject {
        val context=test.targetContext;check(context.packageName.endsWith(".qa"))
        // This runner uses dummy accounts. Keep network off for widget-driven
        // address changes too; the external lab driver restores it after teardown.
        for(command in listOf("svc wifi disable","svc data disable")){
            ParcelFileDescriptor.AutoCloseInputStream(test.uiAutomation.executeShellCommand(command)).use{it.readBytes()}
        }
        val manager=AppWidgetManager.getInstance(context)
        val announced=java.util.concurrent.ConcurrentHashMap<Boolean,Int>()
        val receipt=object:android.content.BroadcastReceiver(){override fun onReceive(c:android.content.Context,i:Intent){
            val compact=i.getBooleanExtra("compact",false);announced[compact]=(announced[compact]?:0)+1
        }}
        val filter=android.content.IntentFilter(WidgetPins.ADDED)
        if(android.os.Build.VERSION.SDK_INT>=33)context.registerReceiver(receipt,filter,android.content.Context.RECEIVER_NOT_EXPORTED)
        else context.registerReceiver(receipt,filter)
        // Target-app package visibility can hide third-party HOME handlers. The test
        // shell reads the same selected handler that the matrix driver configured.
        val home=ParcelFileDescriptor.AutoCloseInputStream(test.uiAutomation.executeShellCommand(
            "cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME")).use{it.readBytes().toString(Charsets.UTF_8)}
            .lineSequence().firstOrNull{it.contains('/') && !it.contains(' ')}?.substringBefore('/')?.trim()
        check(home==expectedHome){"Expected HOME $expectedHome; actual $home"}
        val notices=java.util.Collections.synchronizedList(mutableListOf<String>())
        test.uiAutomation.setOnAccessibilityEventListener{event->
            if(event.eventType==android.view.accessibility.AccessibilityEvent.TYPE_NOTIFICATION_STATE_CHANGED && event.packageName?.toString()==home){
                event.text.map{it.toString()}.filter{it.isNotBlank()}.forEach{notices.add(it)}
            }
        }
        fun launcherNotices()=JSONArray(synchronized(notices){notices.toList()})
        fun main(action:()->Unit){var error:Throwable?=null;test.runOnMainSync{try{action()}catch(e:Throwable){error=e}};error?.let{throw it}}
        fun all(view:View):List<View> = listOf(view)+if(view is ViewGroup)(0 until view.childCount).flatMap{all(view.getChildAt(it))}else emptyList()
        fun nodes(node:AccessibilityNodeInfo?):List<AccessibilityNodeInfo> = if(node==null)emptyList()else listOf(node)+(0 until node.childCount).flatMap{nodes(node.getChild(it))}
        fun active()=nodes(test.uiAutomation.rootInActiveWindow)
        fun shell(command:String){ParcelFileDescriptor.AutoCloseInputStream(test.uiAutomation.executeShellCommand(command)).use{it.readBytes()}}
        fun waitFor(label:String,predicate:()->Boolean){val end=SystemClock.uptimeMillis()+15_000;while(SystemClock.uptimeMillis()<end){test.waitForIdleSync();if(predicate())return;SystemClock.sleep(120)};error(label)}
        fun capture(name:String){test.uiAutomation.takeScreenshot()?.let{image->java.io.File(context.cacheDir,"matrix159-$name.png").outputStream().use{image.compress(Bitmap.CompressFormat.PNG,100,it)}}}
        fun settings(){
            shell("am start -f 603979776 -n ${context.packageName}/ua.svitlo.widget.MainActivity --es screen settings")
            waitFor("Settings did not regain focus"){var ready=false;main{ready=activity.hasWindowFocus() && all(activity.window.decorView).any{it.tag=="appearance"}};ready}
            WidgetPins.launcherReturned()
        }
        fun appButton(vararg labels:String)=active().firstOrNull{it.packageName?.toString()==context.packageName && it.isClickable && it.isEnabled && it.text?.toString() in labels}
        fun pinButton(compact:Boolean){main{
            val button=all(activity.window.decorView).filterIsInstance<Button>().single{it.text.toString().startsWith(if(compact)"Компактний ·"else"Детальний ·")}
            button.requestRectangleOnScreen(Rect(0,0,button.width,button.height),true);check(button.performClick())
        }}
        val externalLabels=listOf("Add","Add widget","Add automatically","Add to home screen","Create","Додати","Додати віджет","Додати автоматично","Додати на головний екран","Створити","Дозволити","Allow","Так","Yes")
        val handlers=mutableSetOf<String>()
        fun externalButton()=active().firstOrNull{it.packageName?.toString()!=context.packageName && it.isClickable && it.isEnabled && externalLabels.any{label->label.equals(it.text?.toString(),true)}}?.also{button->
            val source=button.packageName.toString()
            // Android's fallback confirmation is hosted by Settings and names the
            // selected launcher (observed with Nova); it is a real system window.
            check(source in listOf(home,"android","com.android.settings","com.android.systemui","com.android.permissioncontroller","com.google.android.permissioncontroller")){"Pin confirmation came from a different HOME: $source instead of $home"}
            handlers+=source
        }
        val cases=JSONArray();val output=JSONObject().put("home",home).put("supportsPin",manager.isRequestPinAppWidgetSupported).put("cases",cases)
        try {
            for(compact in listOf(true,false)){
                val record=JSONObject().put("compact",compact).put("result","started")
                cases.put(record)
                settings()
                val provider=ComponentName(context,if(compact)CompactWidget::class.java else SvitloWidget::class.java)
                fun ids()=manager.getAppWidgetIds(provider).toSet()
                val before=ids();check(before.isEmpty()){"Matrix requires a clean QA widget provider"}
                pinButton(compact)
                if(!manager.isRequestPinAppWidgetSupported){
                    waitFor("Manual instructions missing"){appButton("Зрозуміло")!=null}
                    capture("manual-$compact");check(ids()==before)
                    check(appButton("Зрозуміло")!!.performAction(AccessibilityNodeInfo.ACTION_CLICK));settings()
                    record.put("result","manual_instructions").put("created",0);continue
                }
                waitFor("App confirmation missing"){appButton("Додати")!=null}
                check(ids()==before);capture("confirmation-$compact")
                check(appButton("Скасувати")!!.performAction(AccessibilityNodeInfo.ACTION_CLICK));settings();check(ids()==before)
                pinButton(compact);waitFor("App confirmation missing on retry"){appButton("Додати")!=null}
                check(appButton("Додати")!!.performAction(AccessibilityNodeInfo.ACTION_CLICK))
                // Some launchers allocate/bind IDs before the user confirms.
                // Allow the real confirmation window to settle, then require
                // actual visibility and deletion later, rather than IDs alone.
                SystemClock.sleep(1200)
                waitFor("Launcher neither added the widget nor showed its confirmation"){ids()!=before || externalButton()!=null}
                var cancelled=false
                if(externalButton()!=null){
                    capture("launcher-$compact")
                    check(test.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK));settings()
                    waitFor("Cancelled launcher request left a bound widget"){ids()==before};cancelled=true
                    pinButton(compact);waitFor("App confirmation missing after launcher cancellation"){appButton("Додати")!=null}
                    check(appButton("Додати")!!.performAction(AccessibilityNodeInfo.ACTION_CLICK))
                }
                val clickedWindows=mutableSetOf<String>()
                fun acceptExternalOnce(){externalButton()?.let{button->
                    val key="${button.windowId}:${button.text}"
                    if(key !in clickedWindows && button.performAction(AccessibilityNodeInfo.ACTION_CLICK))clickedWindows+=key
                }}
                waitFor("Launcher did not create the first widget"){
                    acceptExternalOnce();ids()!=before
                }
                check(ids().size==1){"One confirmation created multiple widgets"}
                record.put("firstConfirmationCreated",1)
                SystemClock.sleep(1200)
                settings()
                main{check(all(activity.window.decorView).filterIsInstance<android.widget.TextView>().single{it.tag=="widget_pin_status"}.text.isNotBlank())}
                pinButton(compact);waitFor("Existing widget did not show recovery confirmation"){appButton("Додати повторно")!=null}
                repeat(10){pinButton(compact)};check(ids().size==1){"Repeated ordinary taps created duplicates"}
                record.put("ordinaryTapsCreateNoDuplicates",true)
                capture("existing-$compact")
                check(appButton("Закрити")!!.performAction(AccessibilityNodeInfo.ACTION_CLICK));settings();check(ids().size==1)
                pinButton(compact);waitFor("Recovery action missing"){appButton("Додати повторно")!=null}
                check(appButton("Додати повторно")!!.performAction(AccessibilityNodeInfo.ACTION_CLICK))
                clickedWindows.clear()
                waitFor("Explicit recovery did not create one additional widget"){
                    acceptExternalOnce();ids().size>1
                }
                check(ids().size==2){"One explicit recovery created multiple copies"}
                record.put("explicitRecoveryAddsOne",true)
                SystemClock.sleep(1200)
                shell("input keyevent KEYCODE_HOME")
                waitFor("HOME did not regain focus"){test.uiAutomation.rootInActiveWindow?.packageName?.toString()==home}
                SystemClock.sleep(1200);capture("home-$compact")
                fun widgetNode()=active().firstOrNull{node->node.packageName?.toString()==context.packageName && node.isVisibleToUser &&
                    (node.viewIdResourceName==context.packageName+(if(compact)":id/widget_title"else":id/detail_heading") ||
                        node.text?.toString()?.startsWith(if(compact)"ϟ "else"Мої адреси")==true)}
                fun widgetVisible()=widgetNode()!=null
                if(!widgetVisible()){
                    val display=android.graphics.Point();activity.windowManager.defaultDisplay.getRealSize(display)
                    for(direction in listOf(1,-1))for(page in 0 until 12){
                        if(widgetVisible())break
                        val from=if(direction==1)display.x*4/5 else display.x/5
                        val to=if(direction==1)display.x/5 else display.x*4/5
                        shell("input swipe $from ${display.y/2} $to ${display.y/2} 350");SystemClock.sleep(300)
                    }
                    // Feed-style launchers place widgets below the initial viewport.
                    for(page in 0 until 12){
                        if(widgetVisible())break
                        val from=display.y*3/4
                        val to=display.y/3
                        shell("input swipe ${display.x/2} $from ${display.x/2} $to 350");SystemClock.sleep(250)
                        if(test.uiAutomation.rootInActiveWindow?.packageName?.toString()!=home){
                            test.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
                            SystemClock.sleep(300);break
                        }
                    }
                }
                val visible=widgetVisible();capture("visible-$compact")
                check(visible){"Pin IDs exist but no QA widget was visible on the launcher pages"}
                val chart=active().firstOrNull{it.packageName?.toString()==context.packageName && it.isClickable &&
                    it.viewIdResourceName==context.packageName+(if(compact)":id/widget_chart"else":id/address_row")}
                var openNode=chart ?: widgetNode()
                repeat(8){if(openNode!=null && openNode?.isClickable!=true)openNode=openNode?.parent}
                check(openNode?.isClickable==true){"No widget click target"}
                val expectedName=if(compact)AddressProfiles(context).active()?.name else Regex("Адреса \\d+").find(openNode?.contentDescription?.toString().orEmpty())?.value
                check(openNode!!.performAction(AccessibilityNodeInfo.ACTION_CLICK))
                waitFor("Widget did not open the application graph"){
                    var ready=false;main{ready=activity.hasWindowFocus() && all(activity.window.decorView).any{it is HourTileView}};ready
                }
                expectedName?.let{check(AddressProfiles(context).active()?.name==it){"Widget opened a different address"}}
                record.put("widgetOpenedAppGraph",true).put("addressVerified",expectedName!=null)
                capture("opened-$compact")
                shell("input keyevent KEYCODE_HOME")
                waitFor("HOME did not return after widget tap"){test.uiAutomation.rootInActiveWindow?.packageName?.toString()==home}
                SystemClock.sleep(800)
                val removeLabels=listOf("Remove","Видалити","Вилучити","Прибрати")
                val ancestors=mutableListOf<AccessibilityNodeInfo>()
                var ancestor=widgetNode()
                repeat(8){ancestor?.let{node->ancestors+=node;ancestor=node.parent}}
                val removable=ancestors.firstOrNull{node->node.actionList.any{action->removeLabels.any{action.label?.toString()?.startsWith(it,true)==true}}}
                var deleted=false
                if(removable!=null){
                    val action=removable.actionList.first{action->removeLabels.any{action.label?.toString()?.startsWith(it,true)==true}}
                    removable.performAction(action.id)
                }else{
                    val moves=listOf("Move","Перемістити")
                    val movable=ancestors.firstOrNull{node->node.actionList.any{action->moves.any{action.label?.toString()?.startsWith(it,true)==true}}}
                    movable?.actionList?.firstOrNull{action->moves.any{action.label?.toString()?.startsWith(it,true)==true}}?.let{action->movable.performAction(action.id)}
                }
                val deleteDeadline=SystemClock.uptimeMillis()+5_000;var clickedRemove=false
                while(SystemClock.uptimeMillis()<deleteDeadline && ids().size==2){
                    val target=active().firstOrNull{node->node.packageName?.toString()==home && node.isClickable && node.isEnabled &&
                        removeLabels.any{node.text?.toString()?.startsWith(it,true)==true || node.contentDescription?.toString()?.startsWith(it,true)==true}}
                    if(!clickedRemove && target!=null)clickedRemove=target.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                    SystemClock.sleep(150)
                }
                deleted=ids().size==1
                if(!deleted)test.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
                record.put("result","pin_pass").put("systemConfirmationCancelled",cancelled)
                    .put("successFeedbackCallbacksObserved",announced[compact]?:0)
                    .put("noSystemConfirmation",!cancelled).put("appCancellationCreatesNothing",true).put("ordinaryTapsCreateNoDuplicates",true)
                    .put("explicitRecoveryAddsOne",true).put("visibleFeedback",true).put("launcherWidgetVisible",visible).put("launcherDeletionVerified",deleted)
                    .put("hostActions",JSONArray(ancestors.flatMap{it.actionList}.mapNotNull{it.label?.toString()}))
            }
        }catch(e:Throwable){
            capture("failure")
            java.io.File(context.cacheDir,"matrix159-partial.json").writeText(output.put("confirmationPackages",JSONArray(handlers.toList())).put("launcherNotices",launcherNotices()).put("failure",e.message).toString(2))
            ParcelFileDescriptor.AutoCloseInputStream(test.uiAutomation.executeShellCommand("dumpsys appwidget")).use{input->
                java.io.File(context.cacheDir,"matrix159-widget-hosts.txt").writeBytes(input.readBytes())}
            throw e
        }finally{context.unregisterReceiver(receipt);test.uiAutomation.setOnAccessibilityEventListener(null)}
        return output.put("confirmationPackages",JSONArray(handlers.toList())).put("launcherNotices",launcherNotices())
    }
}
