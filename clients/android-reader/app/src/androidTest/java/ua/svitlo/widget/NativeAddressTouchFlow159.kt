package ua.svitlo.widget

import android.app.Instrumentation
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentLinkedQueue

/** The real onboarding chain; fake transport is confined to this QA process. */
object NativeAddressTouchFlow159 {
    fun verify(test:Instrumentation,activity:MainActivity):JSONObject {
        val context=test.targetContext;check(context.packageName.endsWith(".qa"))
        fun main(action:()->Unit){var error:Throwable?=null;test.runOnMainSync{try{action()}catch(e:Throwable){error=e}};error?.let{throw it}}
        val apiField=MainActivity::class.java.getDeclaredField("addressApi").apply{isAccessible=true}
        val original=apiField.get(activity)
        val binding=OutageRepository(context).binding();val profiles=AddressProfiles(context).profiles()
        val requests=ConcurrentLinkedQueue<Map<String,String>>()
        val api=AddressApi(OperatorTransport{p->
            requests.add(p.toMap());SystemClock.sleep(70)
            when(p["op"]){
                "department_list"->"""[{"ID":"2","NAME":"Городищенська філія"},{"ID":"18","NAME":"Христинівська філія"}]"""
                "city_list"->{check(p["dept_id"]=="18");"""[{"ID":"800","NAME":"с. Вербувата"},{"ID":"801","NAME":"м. Христинівка"}]"""}
                "street_list"->{check(p["city_id"]=="801");"""[{"ID":"11950","NAME":"вул. Європейська"},{"ID":"11951","NAME":"вул. І. Богуна"}]"""}
                "house_list"->{check(p["street_id"]=="11951");"""[{"HOUSE":"8"},{"HOUSE":"8/а"}]"""}
                "ls_list_by_addr"->{check(p["street_id"]=="11951" && p["house"]=="8/а");"""[{"LS":"12345678999","ADDRESS":"м. Христинівка, вул. І. Богуна, 8/а"}]"""}
                else->error("Unexpected fixture operation: ${p["op"]}")
            }
        })
        fun node(label:String):AccessibilityNodeInfo?=test.uiAutomation.rootInActiveWindow
            ?.findAccessibilityNodeInfosByText(label)?.firstOrNull{
                it.packageName?.toString()==context.packageName &&
                    (it.text?.toString()==label || it.contentDescription?.toString()==label)
            }
        fun await(label:String):AccessibilityNodeInfo {
            val end=SystemClock.uptimeMillis()+10_000
            while(SystemClock.uptimeMillis()<end){node(label)?.let{return it};SystemClock.sleep(60)}
            error("Onboarding did not reach '$label' after real touch")
        }
        fun tap(label:String,xFraction:Float=.5f,yFraction:Float=.5f){
            var target=await(label)
            target.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id)
            test.waitForIdleSync();SystemClock.sleep(100)
            target=await(label);val r=Rect();target.getBoundsInScreen(r)
            check(target.isVisibleToUser && !r.isEmpty){"'$label' is not a visible touch target: $r"}
            val down=SystemClock.uptimeMillis()
            for(action in listOf(MotionEvent.ACTION_DOWN,MotionEvent.ACTION_UP)){
                val event=MotionEvent.obtain(down,SystemClock.uptimeMillis(),action,r.left+r.width()*xFraction,r.top+r.height()*yFraction,0)
                event.source=InputDevice.SOURCE_TOUCHSCREEN
                check(test.uiAutomation.injectInputEvent(event,true));event.recycle()
                if(action==MotionEvent.ACTION_DOWN)SystemClock.sleep(80)
            }
            test.waitForIdleSync()
        }
        fun capture(stage:String){test.uiAutomation.takeScreenshot()?.let{image->java.io.File(context.cacheDir,"unified159-flow-$stage.png").outputStream().use{image.compress(Bitmap.CompressFormat.PNG,100,it)}}}
        val patterns=listOf("text-left" to (.12f to .5f),"center" to (.5f to .5f),"right" to (.88f to .5f),"top" to (.5f to .2f),"bottom" to (.5f to .8f))
        val cases=JSONArray()
        try{
            main{apiField.set(activity,api)}
            for((name,point)in patterns){
                val before=requests.size
                tap("Додати адресу");tap("1. Обрати філію")
                for((label,next)in listOf("Христинівська філія" to "Населений пункт","м. Христинівка" to "Вулиця","вул. І. Богуна" to "Будинок","8/а" to "Це ваша адреса?")){
                    await(label);if(name=="text-left")capture("step-${requests.size-before}")
                    tap(label,point.first,point.second)
                    await(next)
                }
                tap("Ні");await("Додати адресу")
                check(OutageRepository(context).binding()==binding && AddressProfiles(context).profiles()==profiles)
                check(requests.drop(before).map{it["op"]}==listOf("department_list","city_list","street_list","house_list","ls_list_by_addr"))
                cases.put(JSONObject().put("point",name).put("all_four_steps_advanced",true).put("binding_unchanged",true))
            }
            return JSONObject().put("cases",cases).put("request_count",requests.size).put("real_touch_only",true).put("full_flow",true)
        }catch(e:Throwable){capture("failure");throw e}
        finally{main{apiField.set(activity,original)}}
    }
}
