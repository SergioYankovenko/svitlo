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
class DeviceAcceptance150:Instrumentation() {
    private lateinit var args:Bundle
    private var activity:Activity?=null
    override fun onCreate(arguments:Bundle?){super.onCreate(arguments);args=arguments ?: Bundle();start()}
    override fun onStart(){
        val result=Bundle()
        try {
            require(targetContext.packageName.endsWith(".qa")){"QA package required"}
            if(args.getString("mode")=="network")network(result)else ui(result)
            result.putString("result","PASS");finish(Activity.RESULT_OK,result)
        }catch(error:Throwable){result.putString("result","FAIL");result.putString("failure",error.javaClass.simpleName+": "+error.message);finish(Activity.RESULT_CANCELED,result)}
    }
    private fun network(out:Bundle){
        val address=DictionaryAddress("18","801","м. Христинівка","11807","вул. Флорештська","10а/51")
        val registry=QueueRegistryRepository(targetContext)
        check(registry.refresh(address,true)){"Registry request failed"}
        check(registry.cached(address)?.queue=="3.2"){"Exact official queue mismatch"}
        val other=DictionaryAddress("18","830","с. Сичівка","11997","вул. Грушевського","1")
        check(registry.refresh(other,true) && registry.cached(other)?.queue=="5.2"){"Sychivka official queue mismatch"}
        check(registry.cached(address)?.queue=="3.2"){"Registry cache mixed different addresses"}
        targetContext.getSharedPreferences("svitlo_activity",0).edit().remove("attempt").commit()
        check(ActiveInstallRepository(targetContext).report()){ "Activity acknowledgement missing" }
        val id=targetContext.getSharedPreferences("svitlo_activity",0).getString("installation",null)!!
        check(RegistryClient(targetContext).heartbeat(id,"1.5.0",true).getString("status")=="already_seen")
        val access=targetContext.getSharedPreferences("svitlo_registry_auth",0).getString("access",null)!!
        val connection=java.net.URL("https://ovcmluucwzsuflusebcc.supabase.co/rest/v1/svitlo_android_activity?select=*").openConnection() as javax.net.ssl.HttpsURLConnection
        try {
            connection.connectTimeout=15000;connection.readTimeout=15000
            connection.setRequestProperty("apikey","sb_publishable_X-NwBLBqPbCVs2SvJRf0Xw_N6IBsOwb")
            connection.setRequestProperty("Authorization","Bearer $access")
            check(connection.responseCode==403){"Authenticated client could read aggregate statistics"}
        }finally{connection.disconnect()}
        out.putString("network","Exact dictionary addresses -> official registry 3.2 and 5.2; isolated caches; QA activity deduplicated; client aggregate read denied")
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
        capture("home")
        checkedMain {
            val frame=views().single{it.tag=="day_grid_frame"}
            frame.requestRectangleOnScreen(android.graphics.Rect(0,0,frame.width,minOf(frame.height,(400*frame.resources.displayMetrics.density).toInt())),true)
        }
        waitForIdleSync();capture("grid")
        if(args.getString("mode")=="a11y"){
            val manager=targetContext.getSystemService(android.view.accessibility.AccessibilityManager::class.java)
            check(manager.isEnabled && manager.isTouchExplorationEnabled){"TalkBack touch exploration is not active"}
            var first=""
            checkedMain {
                val tiles=views().filterIsInstance<HourTileView>();val tile=tiles.firstOrNull{it.hour.clockChange} ?: tiles.first()
                check(tile.performAccessibilityAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS,null))
                first=tile.tag.toString();check(tile.isAccessibilityFocused)
                out.putString("initial_description",tile.contentDescription.toString())
            }
            sendStatus(0,Bundle().apply{putString("ready","TalkBack focus established; swipe right now")})
            java.io.File(targetContext.cacheDir,"acceptance-ready").writeText(args.getString("handshake").orEmpty())
            SystemClock.sleep(15000)
            checkedMain {
                val focused=views().filterIsInstance<HourTileView>().firstOrNull{it.isAccessibilityFocused}
                out.putString("window_focus",activity!!.window.decorView.hasWindowFocus().toString())
                out.putString("focused_view",views().firstOrNull{it.isAccessibilityFocused}?.let{it.tag.toString()+" "+it.contentDescription}.orEmpty())
                check(focused!=null && focused.tag.toString()!=first){"TalkBack next-item navigation did not move tile focus"}
                out.putString("next_description",focused!!.contentDescription.toString());activity?.finish()
            }
            out.putString("talkback","Real TalkBack service: touch exploration, full four-segment description and next-item gesture passed; audio not captured")
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
            check(views().filterIsInstance<TextView>().any{it.text=="Лампочки замість блискавок"})
            for(button in views().filterIsInstance<Button>()){
                val layout=button.layout ?: continue
                check((0 until layout.lineCount).none{layout.getEllipsisCount(it)>0}){"Button truncated: ${button.text}"}
            }
        }
        capture("settings")
        checkedMain { views().filterIsInstance<TextView>().single{it.text=="Нагадувати за"}.requestRectangleOnScreen(android.graphics.Rect(0,0,200,160),true) }
        waitForIdleSync();capture("reminder")
        out.putString("ui","Native views, tile accessibility, 24 visible tiles, clock segments, static address, rejected/accepted gestures and settings passed")
        out.putString("configuration","sdk=${android.os.Build.VERSION.SDK_INT}; density=${targetContext.resources.displayMetrics.density}; fontScale=${targetContext.resources.configuration.fontScale}; width=${targetContext.resources.configuration.screenWidthDp}")
        checkedMain{activity?.finish()}
    }
}
