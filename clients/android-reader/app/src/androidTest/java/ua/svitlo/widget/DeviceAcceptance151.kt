package ua.svitlo.widget

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Bundle
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import ua.svitlo.widget.core.*
import java.time.Instant
import java.time.LocalDate
import java.time.format.DateTimeFormatter

/** Standalone test APK runner. Not compiled into the deliverable application. */
class DeviceAcceptance151:Instrumentation() {
    private lateinit var args:Bundle
    private var activity:Activity?=null
    override fun onCreate(arguments:Bundle?){super.onCreate(arguments);args=arguments ?: Bundle();start()}
    override fun onStart(){
        val result=Bundle()
        try {
            require(targetContext.packageName.endsWith(".qa")){"QA package required"}
            if(args.getString("mode")=="messages160")result.putString("messages",NativeMessages160.run(this,args))
            else if(args.getString("mode")=="followup153")result.putString("followup",NativeFollowup153.run(this,args))
            else if(args.getString("mode")=="followup152")result.putString("followup",NativeFollowup152.run(this,args))else ui(result)
            result.putString("result","PASS");finish(Activity.RESULT_OK,result)
        }catch(error:Throwable){result.putString("result","FAIL");result.putString("failure",error.javaClass.simpleName+": "+error.message+" "+error.stackTrace.filter{it.className.startsWith("ua.svitlo")}.take(5).joinToString());finish(Activity.RESULT_CANCELED,result)}
    }
    private fun seed(){
        val context=targetContext;val now=Instant.now();val today=now.atZone(KYIV_ZONE).toLocalDate()
        listOf("svitlo_private","svitlo_official","svitlo_inbox","svitlo_profiles","svitlo_weather","svitlo_service_notices").forEach{context.getSharedPreferences(it,0).edit().clear().commit()}
        val events=JSONArray()
        for(day in HomeSchedule.week(today)+listOf(today.plusDays(1))){
            events.put(JSONObject().put("DATE_START",day.atTime(8,1).format(DateTimeFormatter.ofPattern("HH:mm dd.MM.yyyy")))
                .put("DATE_STOP",day.atTime(10,2).format(DateTimeFormatter.ofPattern("HH:mm dd.MM.yyyy")))
                .put("DISCONN_TYPE","ГПВ").put("STATE_CHAR","Заплановано"))
        }
        val repo=OutageRepository(context,OutageSource{_,category,_,_->JSONObject()
            .put("DATETIME",now.atZone(KYIV_ZONE).format(DateTimeFormatter.ofPattern("HH:mm dd.MM.yyyy")))
            .put("DISCONNECTIONS",if(category==Category.SCHEDULE)events else JSONArray())
            .put("DISCONN_QUEUQ",if(category==Category.SCHEDULE)JSONArray().put(JSONObject().put("QUEUE_INFO","Графік погодинних відключень: 3 черга 2 підчерга"))else JSONArray()).toString()})
        check(repo.bindConfirmed("12345678901","м. Тестове, вул. Прикладна, 1",repo.prepare("12345678901"),"Тестове"))
        check(OfficialScheduleRepository(context,OfficialFeedSource{emptyList()}).refresh())
        context.getSharedPreferences("svitlo_runtime",0).edit().putLong("foreground_request",now.toEpochMilli()).putLong("running",now.toEpochMilli()).commit()
        context.getSharedPreferences("svitlo_activity",0).edit().putLong("attempt",now.toEpochMilli()).commit()
        AppAppearance.setLight(context,args.getString("light")=="true")
        AppAppearance.setTwoRows(context,args.getString("rows")=="true")
        AppAppearance.setBulbs(context,args.getString("bulbs")=="true")
    }
    private fun checkedMain(action:()->Unit){
        var error:Throwable?=null
        runOnMainSync{try{action()}catch(failure:Throwable){error=failure}}
        error?.let{throw it}
    }
    private fun all(view:View):List<View> = listOf(view)+(if(view is ViewGroup)(0 until view.childCount).flatMap{all(view.getChildAt(it))}else emptyList())
    private fun views()=all(activity!!.window.decorView)
    private fun selected()=views().single{it.tag?.toString()?.startsWith("week_day:")==true && it.isSelected}.tag.toString()
    private fun capture(name:String){
        checkedMain {
            val root=activity!!.window.decorView;val bitmap=Bitmap.createBitmap(root.width,root.height,Bitmap.Config.ARGB_8888)
            root.draw(Canvas(bitmap));java.io.File(targetContext.cacheDir,"acceptance-$name.png").outputStream().use{bitmap.compress(Bitmap.CompressFormat.PNG,100,it)}
        }
    }
    private fun gesture(dx:Float,dy:Float,cancel:Boolean=false,settle:Boolean=true){
        checkedMain {
            val frame=views().single{it.tag=="day_grid_frame"};val d=frame.resources.displayMetrics.density
            val x=frame.width*.65f;val y=30*d;val t=SystemClock.uptimeMillis()
            for((index,action) in listOf(MotionEvent.ACTION_DOWN,MotionEvent.ACTION_MOVE,if(cancel)MotionEvent.ACTION_CANCEL else MotionEvent.ACTION_UP).withIndex()){
                val e=MotionEvent.obtain(t,t+index*40,action,if(index==0)x else x+dx*d,if(index==0)y else y+dy*d,0)
                frame.dispatchTouchEvent(e);e.recycle()
            }
        }
        waitForIdleSync();if(settle)SystemClock.sleep(300)
    }
    private fun ui(out:Bundle){
        seed();activity=startActivitySync(Intent(targetContext,MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        waitForIdleSync();SystemClock.sleep(350)
        checkedMain {
            val tiles=views().filterIsInstance<HourTileView>()
            check(tiles.size==24){"Expected 24 display tiles, got ${tiles.size}"}
            check(tiles.all{!it.isClickable && !it.isLongClickable})
            check(tiles.all{!it.createAccessibilityNodeInfo().isClickable})
            val address=views().single{it.tag=="active_profile_name"};check(!address.isClickable)
            val repeat=tiles.filter{it.hour.clockChange}
            if(LocalDate.now(KYIV_ZONE)==LocalDate.of(2026,10,25)){
                check(repeat.size==1 && repeat.single().hour.segments.size==4)
                check(repeat.single().contentDescription.contains("Частина 4 з 4"))
            }
            check(views().filterIsInstance<TextView>().none{it.text.toString().contains("Аварійні відключення")})
        }
        checkedMain {
            val legend=views().single{it.tag=="schedule_legend"} as ViewGroup
            val d=legend.resources.displayMetrics.density
            check(legend.childCount==3)
            val groups=(0 until 3).map{legend.getChildAt(it)}
            for(i in 1..2){
                val previous=groups[i-1];val next=groups[i]
                if(previous.top==next.top)check(next.left-previous.right>=16*d-1){"Legend horizontal gap collapsed"}
                else check(next.top-previous.bottom>=10*d-1){"Legend row gap collapsed"}
            }
            check(views().filterIsInstance<TextView>().none{it.text=="Плитки округлено до 30 хв"})
            check(views().any{it.tag=="share_schedule"})
            check(views().any{it.tag=="donate_button"})
        }
        capture("home")
        checkedMain {
            val frame=views().single{it.tag=="day_grid_frame"}
            frame.requestRectangleOnScreen(android.graphics.Rect(0,0,frame.width,minOf(frame.height,(400*frame.resources.displayMetrics.density).toInt())),true)
        }
        waitForIdleSync();capture("grid")
        if(args.getString("mode")=="interactions"){
            checkedMain{views().single{it.tag=="navigation:settings"}.performClick()};waitForIdleSync()
            for((kind,current) in listOf("time" to AppAppearance.twoRows(targetContext),"icons" to AppAppearance.bulbs(targetContext))){
                val tag="appearance:$kind:${!current}"
                checkedMain{views().single{it.tag==tag}.apply{isFocusableInTouchMode=true;requestFocus();performClick()}}
                waitForIdleSync();SystemClock.sleep(200)
                checkedMain{
                    val choice=views().single{it.tag==tag};check(choice.isSelected && choice.createAccessibilityNodeInfo().isChecked)
                    check(activity!!.window.decorView.findFocus()?.tag==tag){"Choice focus lost after redraw"}
                }
            }
            val initialTheme=AppAppearance.light(targetContext);val tag="appearance:theme:${!initialTheme}"
            val monitor=addMonitor(MainActivity::class.java.name,null,false)
            checkedMain{views().single{it.tag==tag}.apply{isFocusableInTouchMode=true;requestFocus();performClick()}}
            activity=waitForMonitorWithTimeout(monitor,5000) ?: error("Theme recreation did not start")
            removeMonitor(monitor);waitForIdleSync();SystemClock.sleep(350)
            checkedMain{
                check(AppAppearance.light(targetContext)!=initialTheme)
                check(views().single{it.tag==tag}.isSelected)
                check(activity!!.window.decorView.findFocus()?.tag==tag){"Choice focus lost after recreation"}
            }
            capture("recreated-theme");checkedMain{activity?.finish()}
            out.putString("interactions","Appearance clicks, persistence, redraw focus and native theme recreation passed")
            return
        }
        if(args.getString("mode")=="a11y"){
            val focusTag=args.getString("focus_tag")
            if(focusTag?.let{it.startsWith("appearance:") || it=="notification_status"}==true){
                checkedMain{views().filterIsInstance<Button>().single{it.text=="Опції"}.performClick()};waitForIdleSync();SystemClock.sleep(250)
            }
            // Let TalkBack finish its initial window-focus selection before assigning the test target.
            SystemClock.sleep(2000);waitForIdleSync()
            val manager=targetContext.getSystemService(android.view.accessibility.AccessibilityManager::class.java)
            check(manager.isEnabled && manager.isTouchExplorationEnabled){"TalkBack touch exploration is not active"}
            var first=""
            checkedMain {
                val tiles=views().filterIsInstance<HourTileView>()
                val target=if(focusTag!=null)views().single{it.tag==focusTag}else tiles.firstOrNull{it.hour.clockChange} ?: tiles.first()
                target.requestRectangleOnScreen(android.graphics.Rect(0,0,target.width,target.height),true)
                check(target.performAccessibilityAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS,null))
                first=target.tag.toString();check(target.isAccessibilityFocused)
                out.putString("initial_description",target.contentDescription.toString())
                val position=IntArray(2);target.getLocationOnScreen(position)
                java.io.File(targetContext.cacheDir,"acceptance-target.json").writeText(JSONObject()
                    .put("x",position[0]+target.width/2).put("y",position[1]+target.height/2).toString())
            }
            sendStatus(0,Bundle().apply{putString("ready","TalkBack focus established; swipe right now")})
            java.io.File(targetContext.cacheDir,"acceptance-ready").writeText(args.getString("handshake").orEmpty())
            SystemClock.sleep(15000)
            checkedMain {
                val focused=if(focusTag!=null)views().firstOrNull{it.isAccessibilityFocused}else views().filterIsInstance<HourTileView>().firstOrNull{it.isAccessibilityFocused}
                out.putString("window_focus",activity!!.window.decorView.hasWindowFocus().toString())
                out.putString("focused_view",views().firstOrNull{it.isAccessibilityFocused}?.let{it.tag.toString()+" "+it.contentDescription}.orEmpty())
                check(focused!=null && focused.tag.toString()!=first){"TalkBack next-item navigation did not move focus"}
                out.putString("next_description",focused!!.contentDescription.toString());activity?.finish()
            }
            out.putString("talkback","Real TalkBack service: touch exploration, accessible description and next-item navigation passed; audio not captured")
            return
        }
        var initial="";checkedMain{initial=selected()}
        gesture(-10f,0f);gesture(-70f,90f);gesture(-100f,0f,true)
        checkedMain{check(initial==selected()){"Rejected gesture changed day"}}
        val today=LocalDate.now(KYIV_ZONE)
        if(today.dayOfWeek.value>1){
            gesture(130f,0f)
            checkedMain{check(selected()=="week_day:${today.minusDays(1)}"){"Adjacent previous day not selected"}}
            gesture(-130f,0f)
            checkedMain{check(selected()==initial)}
        }
        // Rapid accepted gestures, then menu navigation must not leave outgoing grids alive.
        if(today.dayOfWeek.value>1){repeat(3){gesture(130f,0f,settle=false);gesture(-130f,0f,settle=false)}}
        checkedMain { views().filterIsInstance<Button>().single{it.text=="Опції"}.performClick() }
        waitForIdleSync();SystemClock.sleep(300)
        checkedMain {
            check(views().none{it is HourTileView})
            check(views().filterIsInstance<TextView>().any{it.text=="Нагадувати за"})
            check(views().count{it.tag?.toString()?.startsWith("appearance:")==true}==6)
            check(views().filter{it.tag?.toString()?.startsWith("appearance:")==true}.count{it.isSelected}==3)
            check(views().count{it is android.widget.Switch}==6)
            check(views().any{it.tag=="notification_status"})
            check(views().filterIsInstance<TextView>().none{it.text.toString().contains("Дозвіл системи надано") || it.text.toString().startsWith("Оновлення (раз")})
            val bell=views().single{it.tag=="notification_status"};val d=bell.resources.displayMetrics.density
            check(bell.width>=48*d-1 && bell.height>=48*d-1)
            for(group in views().filter{it.tag?.toString()?.startsWith("appearance:")==true}){
                check(group.width>=48*d-1 && group.height>=48*d-1)
                check(group.createAccessibilityNodeInfo().isCheckable)
            }
            for(button in views().filterIsInstance<Button>()){
                val layout=button.layout ?: continue
                check((0 until layout.lineCount).none{layout.getEllipsisCount(it)>0}){"Button truncated: ${button.text}"}
                val oneLine=button.parent is CompactActionRow || button.tag?.toString()?.let{it.startsWith("navigation:") || it.startsWith("week_day:")}==true
                if(oneLine)check(layout.lineCount==1){"Paired action wrapped: ${button.text}"}
                check(layout.getLineEnd(layout.lineCount-1)==button.text.length && (0 until layout.lineCount).all{layout.getLineMax(it)<=button.width-button.compoundPaddingLeft-button.compoundPaddingRight+1}){"Button clipped: ${button.text}"}
            }
        }
        capture("settings")
        checkedMain {views().single{it.tag=="notification_status"}.requestRectangleOnScreen(android.graphics.Rect(0,0,48,48),true)}
        waitForIdleSync();capture("bell")
        checkedMain { views().filterIsInstance<TextView>().single{it.text=="Нагадувати за"}.requestRectangleOnScreen(android.graphics.Rect(0,0,200,160),true) }
        waitForIdleSync();capture("reminder")
        checkedMain {views().single{it.tag=="full_legend_title"}.requestRectangleOnScreen(android.graphics.Rect(0,0,200,(500*targetContext.resources.displayMetrics.density).toInt()),true)}
        waitForIdleSync();capture("legend-options")
        out.putString("ui","Native views, tile accessibility, gestures, share/donation visibility, 16/10dp legend spacing, six appearance choices, six independent switches and 48dp bell passed")
        out.putString("configuration","sdk=${android.os.Build.VERSION.SDK_INT}; density=${targetContext.resources.displayMetrics.density}; fontScale=${targetContext.resources.configuration.fontScale}; width=${targetContext.resources.configuration.screenWidthDp}")
        checkedMain{activity?.finish()}
    }
}
