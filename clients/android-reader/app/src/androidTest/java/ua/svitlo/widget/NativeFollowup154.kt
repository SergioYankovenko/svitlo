package ua.svitlo.widget

import android.app.Instrumentation
import android.os.SystemClock
import android.content.Intent
import android.view.View
import android.view.ViewGroup
import android.widget.*
import org.json.*
import ua.svitlo.widget.core.*
import java.time.Instant

/** Frame/identity checks run only from the separate QA instrumentation APK. */
object NativeFollowup154 {
    fun verify(test:Instrumentation,activity:MainActivity):JSONObject {
        fun main(action:()->Unit){var error:Throwable?=null;test.runOnMainSync{try{action()}catch(e:Throwable){error=e}};error?.let{throw it}}
        fun all(v:View):List<View> = listOf(v)+if(v is ViewGroup)(0 until v.childCount).flatMap{all(v.getChildAt(it))}else emptyList()
        fun find(tag:String)=all(activity.window.decorView).single{it.tag==tag}
        val tags=listOf("bottom_navigation","address_profiles","home_schedule","day_summary","home_weather")
        val before=tags.associateWith{find(it)}
        var frames=0;var replacements=0;var emptyFrames=0
        val listener=android.view.ViewTreeObserver.OnPreDrawListener{
            frames++;if(tags.any{find(it)!==before[it]})replacements++
            if(all(activity.window.decorView).none{it is HourTileView})emptyFrames++
            true
        }
        main{activity.window.decorView.viewTreeObserver.addOnPreDrawListener(listener)}
        val context=test.targetContext;val now=Instant.now()
        val location=WeatherLocation("Тестове","Черкаська область",49.0,31.0)
        var temperature=10.0
        val source=object:WeatherSource {
            override fun search(city:String,region:String)="{}"
            override fun fetch(location:WeatherLocation):String{
                val times=JSONArray();val values=JSONArray();val codes=JSONArray();val daylight=JSONArray()
                val start=now.atZone(java.time.ZoneOffset.UTC).toLocalDate().minusDays(1).atStartOfDay(java.time.ZoneOffset.UTC).toInstant()
                repeat(72){i->times.put(start.plusSeconds(i*3600L).epochSecond);values.put(temperature);codes.put(3);daylight.put(1)}
                val units=JSONObject().put("time","unixtime").put("temperature_2m","°C")
                return JSONObject().put("current_units",units).put("hourly_units",units)
                    .put("current",JSONObject().put("time",now.epochSecond).put("temperature_2m",temperature).put("weather_code",3).put("is_day",1))
                    .put("hourly",JSONObject().put("time",times).put("temperature_2m",values).put("weather_code",codes).put("is_day",daylight)).toString()
            }
        }
        val weather=WeatherRepository(context,source);weather.bindLocation(location,true)
        val redraw=MainActivity::class.java.getDeclaredMethod("redraw").apply{isAccessible=true}
        try {
            repeat(4){
                temperature+=1;check(weather.refresh())
                context.sendBroadcast(Intent(RefreshWorker.UPDATED).setPackage(context.packageName))
                test.waitForIdleSync();SystemClock.sleep(90)
                main{tags.forEach{tag->check(find(tag)===before[tag]){"Weather replaced $tag"}}}
            }
            val forecast=find("weather_hours") as HorizontalScrollView
            val first=(forecast.getChildAt(0) as ViewGroup).getChildAt(0)
            main{forecast.scrollTo(70,0);(find("page_scroll") as ScrollView).scrollTo(0,80)}
            val x=forecast.scrollX;val y=(find("page_scroll") as ScrollView).scrollY
            repeat(3){
                main{redraw.invoke(activity)};test.waitForIdleSync();SystemClock.sleep(50)
                main{check(forecast.scrollX==x);check((find("page_scroll") as ScrollView).scrollY==y);check((forecast.getChildAt(0) as ViewGroup).getChildAt(0)===first)}
            }
            // Invoke the actual RemoteViews click responses used by each widget.
            main{WidgetRenderer.render(activity,0,true).apply(activity,FrameLayout(activity)).findViewById<View>(R.id.widget_chart).performClick()}
            test.waitForIdleSync();SystemClock.sleep(250)
            val nowAt=Instant.now();val row=DetailedWidget.rows(context,nowAt).last()
            main{DetailedWidget.row(activity,row,700,150,1f,nowAt,true,true,false).apply(activity,FrameLayout(activity)).performClick()}
            test.waitForIdleSync();SystemClock.sleep(250)
            main{
                tags.forEach{tag->check(find(tag)===before[tag]){"Widget route replaced $tag"}}
                check(all(activity.window.decorView).filterIsInstance<TextView>().none{it.text.startsWith("На ")})
                check(frames>0 && replacements==0 && emptyFrames==0){"frames=$frames replaced=$replacements empty=$emptyFrames"}
            }
            return JSONObject().put("frames",frames).put("replaced_frames",replacements).put("empty_graph_frames",emptyFrames)
                .put("weather_results",4).put("widget_routes",2).put("scroll_preserved",true)
        } finally {main{activity.window.decorView.viewTreeObserver.removeOnPreDrawListener(listener)}}
    }
}
