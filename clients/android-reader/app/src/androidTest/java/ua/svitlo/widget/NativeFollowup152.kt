package ua.svitlo.widget

import android.app.*
import android.appwidget.*
import android.content.*
import android.graphics.*
import android.os.*
import android.view.*
import android.widget.*
import org.json.*
import ua.svitlo.widget.core.*
import java.time.*
import java.time.format.DateTimeFormatter

/** Device-only tests. Fake provider responses and a local AppWidgetHost, never production data. */
object NativeFollowup152 {
    fun run(test:Instrumentation,args:Bundle):String {
        val context=test.targetContext;check(context.packageName.endsWith(".qa"))
        // Remove only this fixture's host; failed assertions can leave bound IDs behind.
        // Launcher hosts and the separate production package are not touched.
        AppWidgetHost(context,152).deleteHost()
        androidx.work.WorkManager.getInstance(context).cancelAllWork().result.get()
        val count=args.getString("count")?.toInt() ?: 3
        val now=Instant.now();val day=now.atZone(KYIV_ZONE).toLocalDate()
        // Use the repository lock: a launcher collection may already be reading this QA
        // package. Directly clearing svitlo_private bypasses the production write contract.
        OutageRepository(context).clear()
        listOf("svitlo_profiles","svitlo_official","svitlo_registry","svitlo_inbox","svitlo_weather").forEach{context.getSharedPreferences(it,0).edit().clear().commit()}
        val source=OutageSource{_,category,_,_->
            val events=JSONArray()
            if(category==Category.SCHEDULE)for(date in HomeSchedule.week(day)+day.plusDays(1))events.put(JSONObject()
                .put("DATE_START",date.atTime(8,1).format(DateTimeFormatter.ofPattern("HH:mm dd.MM.yyyy")))
                .put("DATE_STOP",date.atTime(10,2).format(DateTimeFormatter.ofPattern("HH:mm dd.MM.yyyy"))).put("DISCONN_TYPE","ГПВ").put("STATE_CHAR","Заплановано"))
            JSONObject().put("DATETIME",now.atZone(KYIV_ZONE).format(DateTimeFormatter.ofPattern("HH:mm dd.MM.yyyy")))
                .put("DISCONNECTIONS",events).put("DISCONN_QUEUQ",if(category==Category.SCHEDULE)JSONArray().put(JSONObject().put("QUEUE_INFO","Графік погодинних відключень: 3 черга 2 підчерга"))else JSONArray()).toString()
        }
        val repo=OutageRepository(context,source);val profiles=AddressProfiles(context)
        repeat(count){index->val account="123456789"+index.toString().padStart(2,'0')
            check(profiles.confirm(account,"м. Тестове, вул. Прикладна, ${index+1}",repo.prepare(account),"Тестове","Адреса ${index+1}",add=true))}
        check(OfficialScheduleRepository(context,OfficialFeedSource{emptyList()}).refresh())
        val runtime=context.getSharedPreferences("svitlo_runtime",0)
        runtime.edit().putLong("running",now.toEpochMilli()).putString("running_generation",repo.generationToken()).putLong("foreground_request",now.toEpochMilli())
            .putLong("weather_attempt",now.toEpochMilli()).putString("weather_attempt_generation",repo.generationToken()).commit()
        context.getSharedPreferences("svitlo_app_updates",0).edit().putLong("attempt",now.toEpochMilli()).commit()
        context.getSharedPreferences("svitlo_activity",0).edit().putLong("attempt",now.toEpochMilli()).commit()
        AppAppearance.setLight(context,args.getString("light")=="true")
        AppAppearance.setTwoRows(context,args.getString("rows")=="true")
        AppAppearance.setBulbs(context,args.getString("bulbs")=="true")
        fun main(action:()->Unit){var error:Throwable?=null;test.runOnMainSync{try{action()}catch(e:Throwable){error=e}};error?.let{throw it}}
        val activity=test.startActivitySync(Intent(context,MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        fun all(v:View):List<View> = listOf(v)+if(v is ViewGroup)(0 until v.childCount).flatMap{all(v.getChildAt(it))}else emptyList()
        fun views()=all(activity.window.decorView)
        fun capture(name:String){main{val root=activity.window.decorView;val bitmap=Bitmap.createBitmap(root.width,root.height,Bitmap.Config.ARGB_8888);root.draw(Canvas(bitmap));java.io.File(context.cacheDir,"followup152-$name.png").outputStream().use{bitmap.compress(Bitmap.CompressFormat.PNG,100,it)}}}
        val output=JSONObject().put("profiles",count).put("sdk",Build.VERSION.SDK_INT)
        test.waitForIdleSync();SystemClock.sleep(250)
        if(args.getString("launcher")=="true") {
            val manager=AppWidgetManager.getInstance(context)
            main{views().filterIsInstance<Button>().single{it.text=="Опції"}.performClick()}
            test.waitForIdleSync()
            main{val button=views().filterIsInstance<Button>().single{it.text.toString().startsWith("Детальний ·")}
                button.requestRectangleOnScreen(android.graphics.Rect(0,0,button.width,button.height),true)}
            test.waitForIdleSync();SystemClock.sleep(150)
            val position=IntArray(2);var hitX=0f;var hitY=0f
            main{val button=views().filterIsInstance<Button>().single{it.text.toString().startsWith("Детальний ·")};button.getLocationOnScreen(position);hitX=position[0]+button.width/2f;hitY=position[1]+button.height/2f}
            val touch=SystemClock.uptimeMillis()
            for(action in listOf(MotionEvent.ACTION_DOWN,MotionEvent.ACTION_UP)){
                val event=MotionEvent.obtain(touch,SystemClock.uptimeMillis(),action,hitX,hitY,0);event.source=android.view.InputDevice.SOURCE_TOUCHSCREEN
                check(test.uiAutomation.injectInputEvent(event,true));event.recycle()
            }
            test.waitForIdleSync();SystemClock.sleep(600)
            var accepted=false
            repeat(8){
                if(manager.getAppWidgetIds(ComponentName(context,SvitloWidget::class.java)).isEmpty()){
                    val root=test.uiAutomation.rootInActiveWindow
                    val candidates=listOf("Додати автоматично","ДОДАТИ АВТОМАТИЧНО","Додати на головний екран","ДОДАТИ НА ГОЛОВНИЙ ЕКРАН","Додати","ДОДАТИ","Add automatically","ADD AUTOMATICALLY","Add to home screen","ADD TO HOME SCREEN","Add","ADD")
                    for(label in candidates){
                        val nodes=root?.findAccessibilityNodeInfosByText(label).orEmpty()
                        val button=nodes.firstOrNull{it.isClickable && it.isEnabled && it.text?.toString()?.equals(label,ignoreCase=true)==true && it.packageName?.toString()?.contains("launcher")==true}
                        if(button!=null){accepted=button.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK) || accepted;break}
                    }
                    SystemClock.sleep(350)
                }
            }
            if(!accepted || manager.getAppWidgetIds(ComponentName(context,SvitloWidget::class.java)).isEmpty()){val image=test.uiAutomation.takeScreenshot();java.io.File(context.cacheDir,"followup152-pin-dialog.png").outputStream().use{image.compress(Bitmap.CompressFormat.PNG,100,it)}}
            check(accepted){"Pin confirmation action not found"}
            test.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_HOME)
            test.waitForIdleSync();SystemClock.sleep(1200)
            check(manager.getAppWidgetIds(ComponentName(context,SvitloWidget::class.java)).isNotEmpty())
            main{WidgetRenderer.updateAll(context)}
            SystemClock.sleep(1000)
            fun nodes(node:android.view.accessibility.AccessibilityNodeInfo?):List<android.view.accessibility.AccessibilityNodeInfo> =
                if(node==null)emptyList()else listOf(node)+(0 until node.childCount).flatMap{nodes(node.getChild(it))}
            val found=mutableSetOf<Int>();var descriptions=emptyList<String>()
            repeat(count+2){
                val visible=nodes(test.uiAutomation.rootInActiveWindow)
                descriptions=visible.map{it.contentDescription?.toString().orEmpty()+" "+it.text?.toString().orEmpty()}
                for(index in 1..count)if(descriptions.any{Regex("Адреса $index(?=\\D|$)").containsMatchIn(it)})found+=index
                if(found.size<count){
                    visible.firstOrNull{it.isScrollable && it.className?.toString()=="android.widget.ListView"}
                        ?.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)
                    SystemClock.sleep(300)
                }
            }
            check(found.size==count){"Launcher accessibility has ${found.size}/$count address rows: ${descriptions.joinToString().take(1500)}"}
            val image=test.uiAutomation.takeScreenshot();java.io.File(context.cacheDir,"followup152-launcher.png").outputStream().use{image.compress(Bitmap.CompressFormat.PNG,100,it)}
            output.put("launcher_addresses",found.size)
        } else if(args.getString("widgets")=="true") {
            val host=AppWidgetHost(activity,152);val manager=AppWidgetManager.getInstance(context);var id=0
            main{
                id=host.allocateAppWidgetId();val component=ComponentName(context,SvitloWidget::class.java)
                check(manager.bindAppWidgetIdIfAllowed(id,component)){"AppWidget bind grant required"}
                val padding=AppWidgetHostView.getDefaultPaddingForWidget(activity,component,null)
                val density=context.resources.displayMetrics.density
                val width=((context.resources.displayMetrics.widthPixels-padding.left-padding.right)/density).toInt()
                val height=args.getString("height")?.toInt() ?: 400
                manager.updateAppWidgetOptions(id,Bundle().apply{putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH,width);putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH,width);putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT,height);putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT,height)})
                val hostView=host.createView(activity,id,manager.getAppWidgetInfo(id))
                // The framework owns outer host padding (and can restore it asynchronously).
                // Options describe content; allocate that content PLUS the host's outer padding.
                activity.setContentView(FrameLayout(activity).apply{addView(hostView,FrameLayout.LayoutParams(-1,(height*density).toInt()+padding.top+padding.bottom))})
                host.startListening();manager.updateAppWidget(id,WidgetRenderer.render(context,id,false))
            }
            test.waitForIdleSync();SystemClock.sleep(1500)
            main{
                check(views().none{it is TextView && it.text.toString().startsWith("Error")})
                val list=views().filterIsInstance<ListView>().firstOrNull{it.id==R.id.detail_list && it.visibility==View.VISIBLE}
                if(list!=null){check(list.adapter?.count==count){"Collection count=${list.adapter?.count}, expected=$count"};list.setSelection(count-1);output.put("scrolling",true)}
                else{check(views().count{it.id==R.id.address_row}==count);output.put("scrolling",false)}
                val footer=views().single{it.id==R.id.detail_footer};check(footer.height>0)
                val root=views().single{it.id==R.id.widget_root}
                check(footer.bottom<=root.height-root.paddingBottom){"Footer outside widget"}
                output.put("heading_px",(views().single{it.id==R.id.detail_heading} as TextView).textSize)
                    .put("body_px",views().single{it.id==R.id.detail_body}.height)
                    .put("widget_height_dp",args.getString("height"))
                    .put("content_width_dp",root.width/context.resources.displayMetrics.density)
            }
            test.waitForIdleSync();SystemClock.sleep(400)
            capture("widget")
            main{views().filterIsInstance<ListView>().firstOrNull{it.id==R.id.detail_list && it.visibility==View.VISIBLE}?.let{list->
                val row=list.getChildAt(list.childCount-1);check(row!=null && row.height<=list.height){"Complete address cannot fit viewport: row=${row?.height}, viewport=${list.height}, geometry="+views().filter{it.id in listOf(R.id.widget_root,R.id.detail_header,R.id.detail_body,R.id.detail_axis,R.id.detail_footer)}.joinToString{context.resources.getResourceEntryName(it.id)+"=${it.width}x${it.height}, padding=${it.paddingTop}/${it.paddingBottom}"}}
            }}
            main{host.stopListening();host.deleteAppWidgetId(id)}
        } else {
            val times=mutableListOf<Double>()
            val root=activity.window.decorView
            val next=HomeSchedule.week(day).firstOrNull{it!=day && HomeSchedule.selectable(it,repo.snapshot(),day)}!!
            val switch=MainActivity::class.java.getDeclaredMethod("selectCalendarDay",java.time.LocalDate::class.java,Boolean::class.javaPrimitiveType,Boolean::class.javaPrimitiveType).apply{isAccessible=true}
            var firstFrameValid=false;var firstFrameDetail="callback not called"
            for(i in 0 until 12){val date=if(i%2==0)next else day
                main{val weather=views().single{it.tag=="home_weather"};val start=SystemClock.elapsedRealtimeNanos();switch.invoke(activity,date,date>day,true);times+=(SystemClock.elapsedRealtimeNanos()-start)/1e6
                    check(activity.window.decorView===root);check(views().single{it.tag=="home_weather"}===weather)
                    if(i==0){val frame=views().single{it.tag=="day_grid_frame"} as ViewGroup
                        frame.viewTreeObserver.addOnPreDrawListener(object:android.view.ViewTreeObserver.OnPreDrawListener{
                            override fun onPreDraw():Boolean {
                                frame.viewTreeObserver.removeOnPreDrawListener(this)
                                firstFrameDetail="children=${frame.childCount}, width=${frame.width}, x="+(if(frame.childCount>1)frame.getChildAt(1).translationX else null)
                                firstFrameValid=if(android.animation.ValueAnimator.areAnimatorsEnabled())frame.childCount==2 && kotlin.math.abs(frame.getChildAt(1).translationX)>=frame.width*.8f else frame.childCount==1
                                return true
                            }
                        })
                    }
                }
                test.waitForIdleSync();SystemClock.sleep(if(i<6)50 else 280)
            }
            check(firstFrameValid){"Incoming grid was not staged offscreen before its first draw: $firstFrameDetail"}
            capture("home")
            main{views().filterIsInstance<Button>().single{it.text=="Опції"}.performClick()}
            test.waitForIdleSync();SystemClock.sleep(150)
            main{
                val row=views().single{it.tag=="reminder_lead_row"};val field=views().single{it.tag=="reminder_lead"}
                check(field.right<=row.width);check(field.width>0 && field.height>=48*context.resources.displayMetrics.density-1)
                check(views().filterIsInstance<TextView>().none{it.text=="✓"})
            }
            capture("settings")
            output.put("day_switch_ms",JSONArray(times))
        }
        val renderTimes=mutableListOf<Double>()
        repeat(8){val start=SystemClock.elapsedRealtimeNanos();DetailedWidget.render(context,android.util.SizeF(360f,600f),1f,Instant.now());renderTimes+=(SystemClock.elapsedRealtimeNanos()-start)/1e6}
        output.put("widget_render_ms",JSONArray(renderTimes))
        java.io.File(context.cacheDir,"followup152-results.json").writeText(output.toString(2))
        main{activity.finish()};return output.toString()
    }
}
