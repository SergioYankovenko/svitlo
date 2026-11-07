package ua.svitlo.widget

import android.app.AlertDialog
import android.app.Instrumentation
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.*
import org.json.JSONArray
import org.json.JSONObject
import ua.svitlo.widget.core.KYIV_ZONE
import java.time.Instant

/** Real Android layout/navigation, QA data only. Does not claim a TalkBack listening test. */
object NativeAppLayout159 {
    fun verify(test:Instrumentation,activity:MainActivity):JSONObject {
        val context=test.targetContext;check(context.packageName.endsWith(".qa"))
        fun main(action:()->Unit){var error:Throwable?=null;test.runOnMainSync{try{action()}catch(e:Throwable){error=e}};error?.let{throw it}}
        fun all(v:View):List<View> = listOf(v)+if(v is ViewGroup)(0 until v.childCount).flatMap{all(v.getChildAt(it))}else emptyList()
        fun views()=all(activity.window.decorView)
        fun settle(){test.waitForIdleSync();SystemClock.sleep(400);test.waitForIdleSync()}
        fun tag(value:String)=views().single{it.tag==value}
        fun tap(value:String){main{val v=tag(value);v.requestRectangleOnScreen(Rect(0,0,v.width,v.height),true);check(v.performClick())};settle()}
        fun capture(name:String){test.uiAutomation.takeScreenshot()?.let{image->java.io.File(context.cacheDir,"app159-$name.png").outputStream().use{image.compress(Bitmap.CompressFormat.PNG,100,it)}}}
        var checkedTexts=0
        fun geometry(root:View=activity.window.decorView){main{
            val viewport=Rect();activity.window.decorView.getWindowVisibleDisplayFrame(viewport)
            for(v in all(root).filter{it.isShown && it.width>0}){
                var parent=v.parent;var scrolling=false
                while(parent is View){if(parent is HorizontalScrollView)scrolling=true;parent=parent.parent}
                val at=IntArray(2);v.getLocationOnScreen(at)
                if(!scrolling)check(at[0]>=viewport.left-2 && at[0]+v.width<=viewport.right+2){"Horizontal overflow ${v.tag}: ${at[0]}+${v.width}, viewport=$viewport"}
                if(v is TextView && v.text.isNotBlank() && v.layout!=null && v.ellipsize==null){
                    val available=v.width-v.compoundPaddingLeft-v.compoundPaddingRight
                    // getLineWidth includes trailing wrap-space; getLineMax is
                    // the visible text extent, which must fit the native box.
                    for(line in 0 until v.layout.lineCount)check(v.layout.getLineMax(line)<=available+2){"Text width clipped ${v.tag}: ${v.text}, ${v.layout.getLineMax(line)}/$available at ${v.textSize}px"}
                    check(v.layout.height<=v.height-v.compoundPaddingTop-v.compoundPaddingBottom+2){"Text height clipped ${v.tag}: ${v.text}"}
                    checkedTexts++
                }
            }
            val buttons=views().filterIsInstance<Button>().filter{it.tag?.toString()?.startsWith("navigation:")==true}
            check(buttons.size==3)
            val rects=buttons.map{button->Rect().also{check(button.getGlobalVisibleRect(it));check(it.height()==button.height);check(it.top>=viewport.top && it.bottom<=viewport.bottom)}}
            check(rects.zipWithNext().all{(a,b)->a.right<=b.left+1}){"Navigation overlaps"}
        }}
        val now=Instant.now();val date=now.atZone(KYIV_ZONE).toLocalDate()
        val hours=JSONArray();val temps=JSONArray();val codes=JSONArray();val day=JSONArray()
        val weatherStart=now.atZone(java.time.ZoneOffset.UTC).toLocalDate().minusDays(1).atStartOfDay(java.time.ZoneOffset.UTC).toInstant()
        repeat(72){i->hours.put(weatherStart.plusSeconds(i*3600L).epochSecond);temps.put(9+i%4);codes.put(3);day.put(1)}
        val weather=WeatherRepository(context,object:WeatherSource{
            override fun search(city:String,region:String)="{}"
            override fun fetch(location:WeatherLocation)=JSONObject().put("current_units",JSONObject().put("time","unixtime").put("temperature_2m","°C"))
                .put("hourly_units",JSONObject().put("time","unixtime").put("temperature_2m","°C"))
                .put("current",JSONObject().put("time",now.epochSecond).put("temperature_2m",9).put("weather_code",3).put("is_day",1))
                .put("hourly",JSONObject().put("time",hours).put("temperature_2m",temps).put("weather_code",codes).put("is_day",day)).toString()
        })
        weather.bindLocation(WeatherLocation("Тестове","Черкаська область",49.0,31.0),addressBased=true);check(weather.refresh())
        main{MainActivity::class.java.getDeclaredMethod("dashboard").apply{isAccessible=true}.invoke(activity)};settle()
        val pages=JSONArray()
        try{
            geometry();capture("home");pages.put("home")
            main{val tiles=views().filterIsInstance<HourTileView>();check(tiles.size==24);check(tiles.all{!it.isClickable && it.contentDescription.isNotBlank()})}
            var otherDay:String?=null
            main{otherDay=views().filterIsInstance<Button>().firstOrNull{it.tag?.toString()?.startsWith("week_day:")==true && it.isEnabled && !it.isSelected}?.tag?.toString()}
            check(otherDay!=null);tap(otherDay!!);geometry();capture("another-day");pages.put("another_day")
            tap("navigation:settings");geometry();capture("settings")
            for(kind in listOf("time","icons")){tap("appearance:$kind:true");geometry();tap("appearance:$kind:false")}
            main{val button=tag("reminder_lead");check(button.height>=48*activity.resources.displayMetrics.density)}
            capture("settings-options");pages.put("settings")
            tap("navigation:home")
            lateinit var dialog:AlertDialog
            main{dialog=MainActivity::class.java.getDeclaredMethod("manageAddressProfiles").apply{isAccessible=true}.invoke(activity) as AlertDialog};settle()
            geometry(dialog.window!!.decorView);capture("addresses-dialog")
            main{check(dialog.window!!.decorView.findViewWithTag<View>("saved_addresses_divider").height>0);check(dialog.window!!.decorView.findViewWithTag<ListView>("saved_addresses_list").adapter.count==5);dialog.dismiss()};settle()
            val old=AddressProfiles(context).active()!!.id
            tap("active_profile_block")
            main{check(views().count{it.tag?.toString()?.startsWith("profile_choice:")==true}==5)};geometry();capture("addresses-expanded")
            val next=AddressProfiles(context).profiles().first{it.id!=old}
            tap("profile_choice:${next.id}")
            main{check(AddressProfiles(context).active()!!.id==next.id)};geometry();pages.put("address_switch")
            val change=JSONObject().put("id","layout159").put("date",date.toString()).put("queue","3.2").put("at",now.toString())
                .put("kind","updated").put("title","Оновлено графік").put("source","https://www.cherkasyoblenergo.com/off").put("revision","layout159").put("read",false)
            context.getSharedPreferences("svitlo_inbox",0).edit().putString("history",JSONArray().put(change).toString()).commit()
            tap("navigation:inbox");geometry();capture("inbox");pages.put("inbox")
            main{check(views().any{it.tag=="inbox_layout159"});activity.onBackPressed()};settle();geometry()
            check(tag("navigation:home").isSelected)
            ParcelFileDescriptor.AutoCloseInputStream(test.uiAutomation.executeShellCommand("input keyevent KEYCODE_HOME")).use{it.readBytes()}
            SystemClock.sleep(500)
            ParcelFileDescriptor.AutoCloseInputStream(test.uiAutomation.executeShellCommand("am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n ${context.packageName}/ua.svitlo.widget.MainActivity")).use{it.readBytes()}
            settle();geometry();capture("launcher-return");pages.put("launcher_intent_return")
        }catch(e:Throwable){capture("failure");throw e}
        return JSONObject().put("pages",pages).put("checkedTextLayouts",checkedTexts).put("theme",if(AppAppearance.light(context))"light"else"dark")
            .put("fontScale",activity.resources.configuration.fontScale).put("widthDp",activity.resources.configuration.screenWidthDp)
            .put("noHorizontalOverflow",true).put("navigationFullyVisible",true).put("fixtures",true)
    }
}
