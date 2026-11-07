package ua.svitlo.widget

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.*
import androidx.work.Configuration
import androidx.work.WorkManager
import org.json.JSONArray
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.*
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.*
import org.robolectric.android.controller.ActivityController
import org.robolectric.shadows.ShadowAlertDialog
import ua.svitlo.widget.core.*
import java.time.*
import java.time.format.DateTimeFormatter
import java.util.concurrent.Executor

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[28])
@LooperMode(LooperMode.Mode.PAUSED)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class NextPatchUiTest {
    private val context:Application get()=RuntimeEnvironment.getApplication()
    private var controller:ActivityController<MainActivity>?=null
    private val now get()=Instant.now()
    private val today get()=now.atZone(KYIV_ZONE).toLocalDate()
    private val address=DictionaryAddress("18","801","м. Тестове","11807","вул. Прикладна","7")
    @Before fun prepare(){
        shadowOf(context).grantPermissions(context.packageName+".DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION")
        for(name in listOf("svitlo_private","svitlo_registry","svitlo_profiles","svitlo_ui","svitlo_runtime","svitlo_official","svitlo_weather","svitlo_notifications","svitlo_app_updates","svitlo_inbox"))context.getSharedPreferences(name,0).edit().clear().commit()
        if(runCatching{WorkManager.getInstance(context)}.isFailure){val held=Executor{};WorkManager.initialize(context,Configuration.Builder().setExecutor(held).setTaskExecutor(held).build())}
        seed()
    }
    @After fun close(){
        ShadowAlertDialog.getLatestAlertDialog()?.dismiss();controller?.pause()?.stop()?.destroy();controller=null
        RuntimeEnvironment.setFontScale(1f);RuntimeEnvironment.setQualifiers("w320dp-h780dp-mdpi")
    }
    private fun raw(category:Category,events:List<Outage>,queue:Boolean):String=JSONObject()
        .put("DATETIME",now.atZone(KYIV_ZONE).format(DateTimeFormatter.ofPattern("HH:mm dd.MM.yyyy")))
        .put("DISCONNECTIONS",JSONArray().apply{events.filter{it.sourceCategory==category}.forEach{e->put(JSONObject()
            .put("DATE_START",e.start.atZone(KYIV_ZONE).format(DateTimeFormatter.ofPattern("HH:mm dd.MM.yyyy")))
            .put("DATE_STOP",e.end?.atZone(KYIV_ZONE)?.format(DateTimeFormatter.ofPattern("HH:mm dd.MM.yyyy")) ?: "")
            .put("STATE_CHAR","Заплановано").put("DISCONN_TYPE",e.type))}})
        .put("DISCONN_QUEUQ",JSONArray().apply{if(queue && category==Category.SCHEDULE)put(JSONObject().put("QUEUE_INFO","Графік погодинних відключень: 3 черга 2 підчерга"))}).toString()
    private fun seed(events:List<Outage> = emptyList(),excluded:Boolean=false){
        val repo=OutageRepository(context,OutageSource{_,category,_,_->raw(category,events,!excluded)})
        val prepared=repo.prepare("12345678901")
        if(excluded){
            check(repo.bindConfirmed("",address.label,prepared.copy(account="",dictionary=address),address.city,address))
            check(QueueRegistryRepository(context,RegistrySource{JSONObject().put("resolution",JSONObject().put("status","not_found").put("queue",JSONObject.NULL).put("inclusion","not_in_queue"))}).refresh(address,true))
        }else check(repo.bindConfirmed("12345678901","м. Тестове, вул. Прикладна, 7",prepared,"м. Тестове"))
        check(OfficialScheduleRepository(context,OfficialFeedSource{emptyList()}).refresh())
        context.getSharedPreferences("svitlo_runtime",0).edit().putLong("running",now.toEpochMilli()).commit()
    }
    private fun all(v:View):List<View> = listOf(v)+if(v is ViewGroup)(0 until v.childCount).flatMap{all(v.getChildAt(it))}else emptyList()
    private fun root()=controller!!.get().window.decorView
    private fun tagged(tag:String)=all(root()).firstOrNull{it.tag==tag}
    private fun open(screen:String="home",date:LocalDate?=null):MainActivity {
        val intent=Intent().putExtra("screen",screen);date?.let{intent.putExtra("date",it.toString())}
        controller=Robolectric.buildActivity(MainActivity::class.java,intent).create().start().resume().visible()
        return controller!!.get().also{layout()}
    }
    private fun layout(){
        shadowOf(Looper.getMainLooper()).idle()
        val d=controller!!.get().resources.displayMetrics.density
        root().measure(View.MeasureSpec.makeMeasureSpec((controller!!.get().resources.configuration.screenWidthDp*d).toInt(),View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec((780*d).toInt(),View.MeasureSpec.EXACTLY))
        root().layout(0,0,root().measuredWidth,root().measuredHeight)
        shadowOf(Looper.getMainLooper()).idle()
    }
    private fun click(label:String){all(root()).filterIsInstance<Button>().first{it.text==label}.performClick();layout()}
    @Test fun explicitExclusionShowsOneStatusNoShareAndKeepsFutureUnknown(){
        seed(excluded=true);open()
        assertEquals(1,all(root()).filterIsInstance<TextView>().count{it.text==ScheduleLabels.NO_OUTAGES})
        assertNull(tagged("selected_day_state"));assertNull(tagged("share_schedule"));assertNotNull(tagged("donate_button"))
        assertEquals("",(tagged("header_queue") as TextView).text.toString())
        assertTrue(all(root()).filterIsInstance<HourTileView>().all{it.hour.segments.all{p->p.category==null && !p.uncertain}})
        controller!!.pause().stop().destroy();controller=null
        open(date=today.plusDays(1))
        assertNotNull(tagged("selected_day_state"))
        assertTrue(all(root()).filterIsInstance<HourTileView>().all{it.hour.segments.all{p->p.uncertain}})
    }
    @Test fun shortExactIntervalCanShareAndOldHandlerRechecksCurrentSnapshot(){
        val from=today.atTime(12,1).atZone(KYIV_ZONE).toInstant()
        val event=Outage(Category.SCHEDULE,from,from.plusSeconds(60),false,"","ГПВ")
        seed(listOf(event));val activity=open()
        val share=tagged("share_schedule") as Button
        assertEquals("Поділитись графіком",share.contentDescription.toString())
        val label=share.text as android.text.Spanned
        assertEquals(1,label.getSpans(0,label.length,android.text.style.ImageSpan::class.java).size)
        share.performClick()
        val chooser=shadowOf(activity).nextStartedActivity
        assertEquals(Intent.ACTION_CHOOSER,chooser.action)
        @Suppress("DEPRECATION") val payload=chooser.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)!!
        assertEquals("text/plain",payload.type);assertTrue(payload.getStringExtra(Intent.EXTRA_TEXT)!!.endsWith("https://www.svitlo.guru"))
        assertTrue(payload.getStringExtra(Intent.EXTRA_TEXT)!!.contains("12:01–12:02"))
        seed();share.performClick()
        assertNull(shadowOf(activity).nextStartedActivity);assertNull(tagged("share_schedule"));assertNotNull(tagged("donate_button"))
    }
    @Test fun profileListIsInlineBackClosesAndSelectionReallyChangesBinding(){
        val profiles=AddressProfiles(context);val first=profiles.active()!!
        val repo=OutageRepository(context,OutageSource{_,c,_,_->raw(c,emptyList(),true)})
        check(profiles.confirm("12345678902","м. Інше, вул. Друга, 8",repo.prepare("12345678902"),"м. Інше","Робота",true))
        val activity=open()
        tagged("active_profile_block")!!.performClick();layout()
        assertEquals(2,all(root()).count{it.tag?.toString()?.startsWith("profile_choice:")==true})
        assertNull(ShadowAlertDialog.getLatestAlertDialog())
        activity.onBackPressed();layout();assertFalse(all(root()).any{it.tag?.toString()?.startsWith("profile_choice:")==true})
        assertEquals("12345678902",OutageRepository(context).binding()!!.account)
        tagged("active_profile_block")!!.performClick();layout();tagged("profile_choice:${first.id}")!!.performClick();layout()
        assertEquals("12345678901",OutageRepository(context).binding()!!.account)
        assertFalse(all(root()).any{it.tag?.toString()?.startsWith("profile_choice:")==true})
    }
    @Test fun reminderAndBellFollowIndependentStatesAndAttributionHasDirectLinks(){
        open();val attribution=tagged("weather_attribution") as TextView
        val spans=(attribution.text as android.text.Spanned).getSpans(0,attribution.text.length,android.text.style.URLSpan::class.java)
        assertEquals(3,spans.size)
        assertTrue(spans.any{it.url=="https://www.geonames.org/"})
        click("Опції")
        assertFalse(tagged("reminder_lead")!!.isEnabled)
        (tagged("notification_before_on") as Switch).isChecked=true;layout()
        assertTrue(tagged("reminder_lead")!!.isEnabled)
        ScheduleNotifications.setLead(context,15)
        (tagged("notification_before_on") as Switch).isChecked=false;layout()
        assertFalse(tagged("reminder_lead")!!.isEnabled);assertEquals(15,ScheduleNotifications.lead(context))
        val enabled=NotificationAccess.read(context).enabled
        (tagged("notification_app_versions") as Switch).isChecked=false;layout()
        assertEquals(enabled,NotificationAccess.read(context).enabled)
        tagged("notification_status")!!.performClick()
        assertNotNull(ShadowAlertDialog.getLatestAlertDialog())
        assertFalse(all(root()).filterIsInstance<TextView>().any{it.text.toString().startsWith("Дозвіл системи")})
    }
    @Test fun notificationChannelsAndGlobalBlockAreNotConfused(){
        val manager=context.getSystemService(NotificationManager::class.java)
        shadowOf(manager).setNotificationsEnabled(true)
        manager.createNotificationChannel(NotificationChannel("muted","Тестовий канал",NotificationManager.IMPORTANCE_NONE))
        assertTrue(NotificationAccess.read(context).enabled);assertTrue(NotificationAccess.read(context).explanation.contains("Тестовий канал"))
        shadowOf(manager).setNotificationsEnabled(false)
        assertFalse(NotificationAccess.read(context).enabled);assertTrue(NotificationAccess.read(context).explanation.contains("Android блокує"))
    }
    @Test @Config(sdk=[26]) fun headingsKeepTheirAccessibilitySemanticsOnOldAndroid(){
        open("settings")
        assertTrue(androidx.core.view.ViewCompat.isAccessibilityHeading(tagged("notification_heading")!!))
        assertTrue(androidx.core.view.ViewCompat.isAccessibilityHeading(tagged("full_legend_title")!!))
    }
    @Test fun appearancePairsSelectExactlyOneAndPreserveExistingKeys(){
        open("settings")
        for(kind in listOf("time","icons")){
            tagged("appearance:$kind:true")!!.performClick();layout()
            assertTrue(tagged("appearance:$kind:true")!!.isSelected);assertFalse(tagged("appearance:$kind:false")!!.isSelected)
            tagged("appearance:$kind:true")!!.performClick();layout();assertTrue(tagged("appearance:$kind:true")!!.isSelected)
        }
        assertTrue(AppAppearance.twoRows(context));assertTrue(AppAppearance.bulbs(context))
        assertEquals(3,all(root()).filter{it.tag?.toString()?.startsWith("appearance:")==true}.count{it.isSelected})
    }
    @Test fun nativeLayoutMatrixKeepsFullActionGroupsLegendGapsAndBellBounds(){
        var cases=0
        for(width in listOf(320,360,414))for(scale in listOf(1f,1.5f,2f))for(light in listOf(false,true))for(bulbs in listOf(false,true)){
            RuntimeEnvironment.setQualifiers("w${width}dp-h780dp-mdpi");RuntimeEnvironment.setFontScale(scale)
            AppAppearance.setLight(context,light);AppAppearance.setBulbs(context,bulbs)
            open();val legend=tagged("schedule_legend") as ViewGroup;val d=legend.resources.displayMetrics.density
            assertEquals(3,legend.childCount)
            for(i in 0 until 3){val group=legend.getChildAt(i);assertTrue(group.right<=legend.width);assertTrue(group.bottom<=legend.height)
                if(i>0){val previous=legend.getChildAt(i-1);if(previous.top==group.top)assertTrue(group.left-previous.right>=16*d-1)else assertTrue(group.top-previous.bottom>=10*d-1)}
            }
            val actions=listOf("Додати адресу","Керувати адресами").map{label->all(root()).filterIsInstance<Button>().single{it.text==label}}
            assertEquals(actions[0].textSize,actions[1].textSize,.01f)
            actions.forEach{assertTrue(it.height>=48*d-1);assertEquals("$width/$scale ${it.text} font=${it.textSize} width=${it.width}",1,it.lineCount);assertTrue("$width/$scale ${it.text} font=${it.textSize} max=${it.layout.getLineMax(0)} width=${it.width}",it.layout.getLineMax(0)<=it.width-it.compoundPaddingLeft-it.compoundPaddingRight+1)}
            click("Опції");val bell=tagged("notification_status")!!;val parent=bell.parent as View
            assertTrue(bell.width>=48*d-1 && bell.height>=48*d-1);assertTrue(bell.right<=parent.width);assertTrue(bell.bottom<=parent.height)
            assertEquals(6,all(root()).filterIsInstance<Switch>().size)
            assertEquals(6,all(root()).count{it.tag?.toString()?.startsWith("appearance:")==true})
            controller!!.pause().stop().destroy();controller=null;cases++
        }
        assertEquals(36,cases)
    }
    @Test fun widgetPinReturnKeepsSameSettingsViewsWhenPreferencesAndPermissionsUnchanged(){
        val activity=open("settings");val appearance=tagged("appearance")!!;val notification=tagged("notifications")!!
        val before=(tagged("reminder_hint") as TextView).text.toString()
        val method=MainActivity::class.java.getDeclaredMethod("refreshSettings",Boolean::class.javaPrimitiveType).apply{isAccessible=true}
        repeat(4){method.invoke(activity,true);layout();assertSame(appearance,tagged("appearance"));assertSame(notification,tagged("notifications"))}
        assertEquals(before,(tagged("reminder_hint") as TextView).text.toString())
    }
    @Test fun reminderHintAlwaysExistsAndChangesOnlyWithTheTwoReminderTypes(){
        ScheduleNotifications.setEnabled(context,"before_off",false);ScheduleNotifications.setEnabled(context,"before_on",false)
        val activity=open("settings")
        assertEquals("Увімкніть нагадування, щоб вибрати час",(tagged("reminder_hint") as TextView).text.toString())
        val method=MainActivity::class.java.getDeclaredMethod("refreshSettings",Boolean::class.javaPrimitiveType).apply{isAccessible=true}
        for(key in listOf("before_off","before_on")){
            ScheduleNotifications.setEnabled(context,key,true);method.invoke(activity,true);layout()
            assertEquals("Оберіть час нагадування",(tagged("reminder_hint") as TextView).text.toString());assertTrue(tagged("reminder_lead")!!.isEnabled)
            ScheduleNotifications.setLead(context,15);ScheduleNotifications.setEnabled(context,key,false);method.invoke(activity,true);layout()
            assertEquals("Увімкніть нагадування, щоб вибрати час",(tagged("reminder_hint") as TextView).text.toString());assertFalse(tagged("reminder_lead")!!.isEnabled)
            assertEquals(15,ScheduleNotifications.lead(context))
        }
    }
    private fun weatherResult(temperature:Double=9.25){
        val source=object:WeatherSource{
            override fun search(city:String,region:String)="{}"
            override fun fetch(location:WeatherLocation)=JSONObject(weatherFixture(now)).apply{getJSONObject("current").put("temperature_2m",temperature)}.toString()
        }
        val repository=WeatherRepository(context,source)
        if(repository.location()==null)repository.bindLocation(WeatherLocation("Тестове","Черкаська область",49.0,31.0),true)
        assertTrue(repository.refresh())
    }
    private fun updated(){context.sendBroadcast(Intent(RefreshWorker.UPDATED).setPackage(context.packageName));layout()}
    @Test fun weatherOnlyResultsKeepShellGridSummaryScrollAndOverlappingHours(){
        weatherResult();open()
        val tags=listOf("bottom_navigation","address_profiles","home_schedule","day_summary","home_weather","weather_hours")
        val before=tags.associateWith{tagged(it)}
        val scroll=tagged("page_scroll") as ScrollView;scroll.scrollTo(0,100)
        val hours=tagged("weather_hours") as HorizontalScrollView;hours.scrollTo(80,0)
        val first=(hours.getChildAt(0) as ViewGroup).getChildAt(0)
        val y=scroll.scrollY;val x=hours.scrollX
        weatherResult(12.0);repeat(3){updated()}
        context.getSharedPreferences("svitlo_runtime",0).edit().remove("running").commit();updated()
        before.forEach{(tag,view)->assertSame(tag,view,tagged(tag))}
        assertSame(first,(hours.getChildAt(0) as ViewGroup).getChildAt(0))
        assertEquals(y,scroll.scrollY);assertEquals(x,hours.scrollX)
        assertEquals("+12°",(tagged("weather_temperature") as TextView).text.toString())
        assertTrue(all(root()).filterIsInstance<TextView>().none{it.text.startsWith("На ")})
        assertEquals(View.GONE,tagged("weather_notice")!!.visibility)
    }
    @Test fun warmWidgetRouteAndResumeReuseHomeAndRespectRequestedDate(){
        val from=today.atTime(8,0).atZone(KYIV_ZONE).toInstant()
        seed(listOf(Outage(Category.SCHEDULE,from,from.plusSeconds(3600),false,"","ГПВ")))
        val activity=open();val shell=tagged("bottom_navigation");val address=tagged("address_profiles");val weather=tagged("home_weather")
        val route=MainActivity::class.java.getDeclaredMethod("onNewIntent",Intent::class.java).apply{isAccessible=true}
        repeat(2){route.invoke(activity,Intent().putExtra("screen","graph").putExtra("date",today.toString()));layout()}
        controller!!.pause().resume();layout()
        assertSame(shell,tagged("bottom_navigation"));assertSame(address,tagged("address_profiles"));assertSame(weather,tagged("home_weather"))
        route.invoke(activity,Intent().putExtra("screen","graph").putExtra("date",today.plusDays(1).toString()));layout()
        assertSame(shell,tagged("bottom_navigation"));assertSame(weather,tagged("home_weather"))
        assertTrue(tagged("week_day:${today.plusDays(1)}")!!.isSelected)
    }
    @Test fun realScheduleChangeUpdatesTilesWithoutReplacingWeatherOrNavigation(){
        open();val weather=tagged("home_weather");val nav=tagged("bottom_navigation");val grid=tagged("home_schedule")
        val from=today.atTime(12,0).atZone(KYIV_ZONE).toInstant()
        seed(listOf(Outage(Category.SCHEDULE,from,from.plusSeconds(3600),false,"","ГПВ")));updated()
        assertSame(weather,tagged("home_weather"));assertSame(nav,tagged("bottom_navigation"));assertNotSame(grid,tagged("home_schedule"))
        assertTrue(all(root()).filterIsInstance<HourTileView>().any{it.hour.segments.any{segment->segment.category==Category.SCHEDULE}})
    }
    @Test fun weatherErrorAndStaleCacheStayVisibleWithoutMeasurementClock(){
        weatherResult();open();val card=tagged("home_weather")
        context.getSharedPreferences("svitlo_weather",0).edit().putString("error","Не вдалося оновити погоду").commit();updated()
        assertSame(card,tagged("home_weather"));val notice=tagged("weather_notice") as TextView
        assertEquals(View.VISIBLE,notice.visibility);assertTrue(notice.text.contains("оновлення недоступне"))
        assertTrue(notice.text.contains("застарів"));assertTrue(all(root()).filterIsInstance<TextView>().none{it.text.startsWith("На ")})
    }
    @Test fun daySwitchDoesNotConsumePendingProfileUpdate(){
        val from=today.atTime(8,0).atZone(KYIV_ZONE).toInstant()
        seed(listOf(Outage(Category.SCHEDULE,from,from.plusSeconds(3600),false,"","ГПВ"),
            Outage(Category.SCHEDULE,from.plusSeconds(86400),from.plusSeconds(90000),false,"","ГПВ")))
        val activity=open();val profiles=AddressProfiles(context)
        assertTrue(profiles.rename(profiles.active()!!.id,"Нова назва"))
        MainActivity::class.java.getDeclaredMethod("selectCalendarDay",LocalDate::class.java,Boolean::class.javaPrimitiveType,Boolean::class.javaPrimitiveType)
            .apply{isAccessible=true}.invoke(activity,today.plusDays(1),true,true)
        updated();assertEquals("Нова назва",(tagged("active_profile_name") as TextView).text.toString())
    }
}
