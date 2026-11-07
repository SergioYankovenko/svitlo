package ua.svitlo.widget

import android.app.Application
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityManager
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.*
import androidx.work.Configuration
import androidx.work.WorkManager
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import org.robolectric.annotation.GraphicsMode
import org.robolectric.android.controller.ActivityController
import org.robolectric.shadows.ShadowAlertDialog
import ua.svitlo.widget.core.*
import java.time.Instant
import java.time.LocalDate
import java.util.concurrent.Executor

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[28])
@LooperMode(LooperMode.Mode.PAUSED)
class MainNavigationTest {
    private lateinit var context:Context
    private var controller:ActivityController<MainActivity>?=null
    @Before fun household(){
        context=RuntimeEnvironment.getApplication()
        shadowOf(context as Application).grantPermissions(context.packageName+".DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION")
        listOf("svitlo_private","svitlo_weather","svitlo_runtime","svitlo_geo","svitlo_official","svitlo_inbox","svitlo_ui","svitlo_notifications","svitlo_profiles","svitlo_app_updates").forEach{
            context.getSharedPreferences(it,Context.MODE_PRIVATE).edit().clear().commit()
        }
        if(runCatching{WorkManager.getInstance(context)}.isFailure){
            val pending=java.util.ArrayDeque<Runnable>();val held=Executor{pending.add(it)}
            WorkManager.initialize(context,Configuration.Builder().setExecutor(held).setTaskExecutor(held).build())
        }
        val raw="""{"DATETIME":"09:30 22.10.2026","DISCONNECTIONS":[],"DISCONN_QUEUQ":[{"QUEUE_INFO":"Графік погодинних відключень: 3 черга 2 підчерга"}]}"""
        val repo=OutageRepository(context,OutageSource{_,_,_,_->raw})
        assertTrue(repo.bindConfirmed("12345678901","м. Тестове, вул. Прикладна, 1",repo.prepare("12345678901"),"Тестове"))
        WeatherRepository(context).bindLocation(WeatherLocation("Тестове","Тестова область",49.0,30.0),addressBased=true)
    }
    @After fun close(){ShadowAlertDialog.getLatestAlertDialog()?.dismiss();controller?.pause()?.stop()?.destroy();WidgetPins.launcherReturned()}
    private fun open(intent:Intent=Intent()):MainActivity{
        controller=Robolectric.buildActivity(MainActivity::class.java,intent).create().start().resume().visible()
        return controller!!.get()
    }
    @Test fun versionAnnouncementOpensOnlyOfficialDownloadAndLeavesAddressUntouched(){
        val name="1.4.3";val url=AppUpdateRepository.SITE+"downloads/Svitlo-$name.apk"
        val raw=JSONObject().put("schema",1).put("packageId","ua.svitlo.widget").put("versionCode",AppUpdateRepository.installedCode(context)+1).put("versionName",name)
            .put("minSdk",26).put("publishedAt",Instant.now().minusSeconds(60).toString()).put("apkUrl",url).put("sha256","a".repeat(64)).toString()
        AppUpdateRepository(context,{raw}).refresh(true)
        val before=OutageRepository(context).binding()
        val activity=open(Intent().putExtra("screen","inbox"))
        assertNotNull(find<View>(activity.window.decorView){it.tag=="app_update_card"})
        find<Button>(activity.window.decorView){it.text=="Завантажити"}!!.performClick()
        assertEquals(url,shadowOf(activity).nextStartedActivity.dataString)
        assertEquals(before,OutageRepository(context).binding())
    }
    @Test fun homeUsesOneAddressDropdownCurrentQueueAndCompactSummary(){
        val activity=open();val views=all(activity.window.decorView)
        assertEquals("Світло",find<TextView>(activity.window.decorView){it.tag=="app_title"}?.text.toString())
        assertNotNull(find<TextView>(activity.window.decorView){it.tag=="current_countdown"})
        val address=find<TextView>(activity.window.decorView){it.tag=="active_profile_name"}!!
        assertFalse(address.text.endsWith(" ▾"));assertFalse(address.isClickable)
        assertNull(find<Button>(activity.window.decorView){it.text=="Перемкнути адресу"})
        assertNull(find<View>(activity.window.decorView){it.tag=="week_range"})
        assertEquals(7,views.count{it.tag?.toString()?.startsWith("week_day:")==true})
        assertNotNull(find<View>(activity.window.decorView){it.tag=="day_summary"})
        assertNull(find<View>(activity.window.decorView){it.tag=="home_hero"})
        assertTrue(texts(activity.window.decorView).contains("Зі світлом"))
        assertTrue(texts(activity.window.decorView).contains("Без світла"))
    }
    @Test fun firstKnownQueueConfirmationDoesNotShowClearTodayBeforePublicCheck(){
        val now=Instant.now()
        val timestamp=now.atZone(KYIV_ZONE).format(java.time.format.DateTimeFormatter.ofPattern("HH:mm dd.MM.yyyy"))
        val raw="""{"DATETIME":"$timestamp","DISCONNECTIONS":[],"DISCONN_QUEUQ":[{"QUEUE_INFO":"Графік погодинних відключень: 3 черга 2 підчерга"}]}"""
        val repo=OutageRepository(context,OutageSource{_,_,_,_->raw})
        assertTrue(repo.bindConfirmed("12345678901","м. Тестове, вул. Прикладна, 1",repo.prepare("12345678901"),"Тестове"))
        OfficialScheduleRepository(context).clear()
        val activity=open();val root=activity.window.decorView
        assertNotEquals("Не заплановано",find<TextView>(root){it.tag=="current_countdown"}!!.text.toString())
        assertTrue(all(root).filterIsInstance<HourTileView>().all{it.hour.segments.all{segment->segment.uncertain}})
        assertTrue(texts(root).contains("Невідомо:"))
    }
    @Test fun weatherRemainsVisibleWithLegacyDisabledPreferenceAndOptionsHaveOneRefreshRow(){
        context.getSharedPreferences("svitlo_ui",Context.MODE_PRIVATE).edit().putBoolean("show_weather",false).commit()
        val activity=open()
        assertNotNull(find<View>(activity.window.decorView){it.tag=="home_weather"})
        assertTrue(texts(activity.window.decorView).contains("СЬОГОДНІ"))
        click(activity,"Опції")
        assertNull(find<Switch>(activity.window.decorView){it.tag=="show_weather"})
        assertFalse(texts(activity.window.decorView).contains("Оновлення (раз на 60 хв)"))
        assertNull(find<Button>(activity.window.decorView){it.text=="Змінити інтервал"})
        assertNull(find<Button>(activity.window.decorView){it.text=="↻ Оновити"})
        assertEquals(60,OutageRepository(context).intervalMinutes())
    }

    @Test fun failedWeatherShowsUnavailableInsteadOfPermanentLoading(){
        context.getSharedPreferences("svitlo_weather",Context.MODE_PRIVATE).edit()
            .putString("error","Не вдалося оновити погоду").commit()
        val activity=open()
        val box=find<View>(activity.window.decorView){it.tag=="home_weather"}!!
        assertTrue(texts(box).contains("Погода недоступна"))
        assertFalse(texts(box).contains("Дані ще завантажуються"))
    }
    @Test fun bottomNavigationStaysOutsideScrollingContentAndHomeHasNoRawEvents(){
        val activity=open();val root=activity.window.decorView
        for(label in listOf("Головна","Повідомлення","Опції"))assertNotNull(find<Button>(root){it.text==label})
        val nav=find<View>(root){it.tag=="bottom_navigation"}!!
        assertFalse(nav.parent is ScrollView)
        assertFalse(texts(root).contains("Усі опубліковані відключення"))
        assertNotNull(find<GridLayout>(root){it.tag=="hour_grid"})
        assertNull(find<Button>(root){it.text=="Графік"})
        click(activity,"Опції");assertNull(find<Button>(activity.window.decorView){it.text=="Змінити адресу"})
        activity.onBackPressed();assertNotNull(find<View>(activity.window.decorView){it.tag=="day_summary"})
    }
    @Test fun homeOffersNamedAddressesAndNewAddressStillNeedsOfficialSetup(){
        val activity=open()
        assertNotNull(find<View>(activity.window.decorView){it.tag=="address_profiles"})
        click(activity,"Додати адресу")
        assertNotNull(find<Button>(activity.window.decorView){it.text=="1. Обрати філію"})
        assertNull(find<EditText>(activity.window.decorView){true})
        assertNull(find<Button>(activity.window.decorView){it.text=="2. Населений пункт"})
        assertEquals("м. Тестове, вул. Прикладна, 1",OutageRepository(context).binding()!!.address)
        click(activity,"Скасувати зміну")
        assertNotNull(find<View>(activity.window.decorView){it.tag=="day_summary"})
    }
    @Test fun savedAddressSwitchRestoresItsBindingAndRenamingChangesHomeLabel(){
        val profiles=AddressProfiles(context);val home=profiles.active()!!
        val raw="""{"DATETIME":"09:30 22.10.2026","DISCONNECTIONS":[],"DISCONN_QUEUQ":[{"QUEUE_INFO":"Графік погодинних відключень: 2 черга 1 підчерга"}]}"""
        val repo=OutageRepository(context,OutageSource{_,_,_,_->raw})
        assertTrue(profiles.confirm("12345678902","Інша підтверджена адреса",repo.prepare("12345678902"),"Тестове","Робота",true))
        val activity=open();assertTrue(texts(activity.window.decorView).contains("Робота"))
        find<View>(activity.window.decorView){it.tag=="active_profile_block"}!!.performClick()
        find<View>(activity.window.decorView){it.tag=="profile_choice:${home.id}"}!!.performClick()
        var dialog:AlertDialog
        assertEquals("12345678901",OutageRepository(context).binding()!!.account)
        assertEquals("3.2",OutageRepository(context).snapshot().queueLabel())
        assertEquals(2,profiles.profiles().size)
        click(activity,"Керувати адресами")
        dialog=ShadowAlertDialog.getLatestAlertDialog()
        find<ListView>(dialog.window!!.decorView){it.tag=="saved_addresses_list"}!!.performItemClick(null,profiles.profiles().indexOfFirst{it.id==home.id},0)
        dialog=ShadowAlertDialog.getLatestAlertDialog()
        find<Button>(dialog.window!!.decorView){it.tag=="profile_action_rename"}!!.performClick()
        dialog=ShadowAlertDialog.getLatestAlertDialog()
        find<EditText>(dialog.window!!.decorView){it.hint=="Назва адреси"}!!.setText("Батьки")
        find<Button>(dialog.window!!.decorView){it.tag=="profile_rename_save"}!!.performClick()
        assertEquals("Батьки",profiles.active()!!.name)
        assertTrue(texts(activity.window.decorView).contains("Батьки"))
        assertEquals("12345678901",OutageRepository(context).binding()!!.account)
    }
    @Test fun exactHourDialogListsAllOverlappingOriginalCategoriesAndApproximateEnd(){
        val date=LocalDate.now(KYIV_ZONE)
        val formatted=date.format(java.time.format.DateTimeFormatter.ofPattern("dd.MM.yyyy"))
        val raw="""{"DATETIME":"09:30 $formatted","DISCONN_QUEUQ":[{"QUEUE_INFO":"Графік погодинних відключень: 3 черга 2 підчерга"}],"DISCONNECTIONS":[{"DATE_START":"10:07 $formatted","DATE_STOP":"12:01 $formatted (план)","DISCONN_TYPE":"Точний оригінал","STATE_CHAR":"План"}]}"""
        val repo=OutageRepository(context,OutageSource{_,_,_,_->raw})
        assertTrue(repo.bindConfirmed("12345678901","м. Тестове, вул. Прикладна, 1",repo.prepare("12345678901"),"Тестове"))
        val activity=open(Intent().putExtra("screen","graph").putExtra("date",date.toString()))
        val tile=all(activity.window.decorView).filterIsInstance<HourTileView>().first{it.hour.label=="10:00"}
        assertFalse(tile.isClickable)
        assertTrue(tile.contentDescription.toString().contains("округлено до 30"))
    }
    @Test fun widgetDeepLinkSelectsDayOnHomeWithAllRealHoursAndNoTileDialog(){
        val date=LocalDate.of(2026,10,25)
        val activity=open(Intent().putExtra("screen","graph").putExtra("date",date.toString()))
        val root=activity.window.decorView
        assertTrue(find<Button>(root){it.tag=="navigation:home"}!!.isSelected)
        val tiles=all(root).filterIsInstance<HourTileView>()
        assertEquals(24,tiles.size)
        assertEquals(1,tiles.count{it.hour.clockChange});assertTrue(tiles.single{it.hour.clockChange}.contentDescription.toString().contains("Частина 4 з 4"))
        assertTrue(tiles.none{it.isClickable})
        assertEquals(date,tiles.first().hour.start.atZone(KYIV_ZONE).toLocalDate())
        assertEquals(HomeSchedule.week(date).map{"week_day:$it"},
            all(root).filterIsInstance<Button>().filter{it.tag?.toString()?.startsWith("week_day:")==true}.map{it.tag.toString()})
    }
    @Test fun ordinaryHomeReturnsToTodayAndRecreationKeepsIt(){
        val date=LocalDate.of(2026,10,25)
        open(Intent().putExtra("screen","graph").putExtra("date",date.toString()))
        click(controller!!.get(),"Повідомлення");click(controller!!.get(),"Головна")
        val state=Bundle();controller!!.saveInstanceState(state).pause().stop().destroy()
        controller=Robolectric.buildActivity(MainActivity::class.java,Intent()).create(state).start().resume().visible()
        val tiles=all(controller!!.get().window.decorView).filterIsInstance<HourTileView>()
        assertEquals(LocalDate.now(KYIV_ZONE),tiles.first().hour.start.atZone(KYIV_ZONE).toLocalDate())
    }
    @Test fun appDialogClosingFocusCannotCancelANewPinRequest(){
        val activity=open()
        activity.onWindowFocusChanged(false)
        val gate=WidgetPins::class.java.getDeclaredField("gate").apply{isAccessible=true}.get(WidgetPins) as WidgetPinGate
        assertNotNull(gate.begin(true,android.os.SystemClock.elapsedRealtime()))
        activity.onWindowFocusChanged(true)
        assertTrue(WidgetPins.hasPending())
    }
    @Test fun queuedDialogFocusWhilePausedCannotCancelTheNewPinRequest(){
        val activity=open()
        val gate=WidgetPins::class.java.getDeclaredField("gate").apply{isAccessible=true}.get(WidgetPins) as WidgetPinGate
        assertNotNull(gate.begin(true,android.os.SystemClock.elapsedRealtime()))
        controller!!.pause()
        activity.onWindowFocusChanged(true)
        assertTrue(WidgetPins.hasPending())
        controller!!.resume();activity.onWindowFocusChanged(true)
        assertTrue(WidgetPins.hasPending())
        activity.onWindowFocusChanged(false);activity.onWindowFocusChanged(true)
        assertFalse(WidgetPins.hasPending())
    }
    @Test fun resumedActivityBehindLauncherKeepsPendingPinUntilFocusReturns(){
        val activity=open()
        val gate=WidgetPins::class.java.getDeclaredField("gate").apply{isAccessible=true}.get(WidgetPins) as WidgetPinGate
        assertNotNull(gate.begin(false,android.os.SystemClock.elapsedRealtime()))
        activity.onWindowFocusChanged(false)
        controller!!.pause().resume()
        assertTrue("Resume alone does not mean the launcher prompt was cancelled",WidgetPins.hasPending())
        activity.onWindowFocusChanged(true)
        assertFalse(WidgetPins.hasPending())
        assertNotNull(gate.begin(false,android.os.SystemClock.elapsedRealtime()))
    }
    @Test fun recreatedActivityBehindLauncherKeepsPendingPinAndCanRecoverAfterCancel(){
        val activity=open()
        val gate=WidgetPins::class.java.getDeclaredField("gate").apply{isAccessible=true}.get(WidgetPins) as WidgetPinGate
        assertNotNull(gate.begin(true,android.os.SystemClock.elapsedRealtime()))
        activity.onWindowFocusChanged(false)
        val state=Bundle();controller!!.saveInstanceState(state).pause().stop().destroy()
        controller=Robolectric.buildActivity(MainActivity::class.java).create(state).start().resume()
        assertTrue(WidgetPins.hasPending())
        controller!!.get().onWindowFocusChanged(true)
        assertFalse(WidgetPins.hasPending())
    }
    @Test fun legacySavedGraphScreenRestoresHomeAndItsDate(){
        val date=LocalDate.of(2026,10,25)
        val state=Bundle().apply{putString("screen","graph");putString("selected_date",date.toString())}
        controller=Robolectric.buildActivity(MainActivity::class.java).create(state).start().resume().visible()
        val root=controller!!.get().window.decorView
        assertTrue(find<Button>(root){it.tag=="navigation:home"}!!.isSelected)
        assertEquals(date,all(root).filterIsInstance<HourTileView>().first().hour.start.atZone(KYIV_ZONE).toLocalDate())
    }
    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE) @Config(qualifiers="w320dp-h640dp-mdpi",fontScale=2f)
    fun longAddressKeepsOneLineAndFullAccessibleValueOnHomeAndConfirmation(){
        val address="м. Тестове поселення, вулиця Незалежності України, будинок 123-А"
        val repo=OutageRepository(context,OutageSource{_,_,_,_->"""{"DATETIME":"09:30 22.10.2026","DISCONNECTIONS":[],"DISCONN_QUEUQ":[]}"""})
        assertTrue(repo.bindConfirmed("12345678901",address,repo.prepare("12345678901"),"Тестове"))
        val activity=open()
        fun assertFits(tag:String){
            layoutActivity(activity)
            val label=find<TextView>(activity.window.decorView){it.tag==tag}!!
            val available=label.width-label.compoundPaddingLeft-label.compoundPaddingRight
            assertEquals(1,label.maxLines)
            assertEquals(android.text.TextUtils.TruncateAt.END,label.ellipsize)
            assertTrue("Address must retain the agreed body font",label.textSize>=14*activity.resources.displayMetrics.scaledDensity-1)
            assertEquals(address,label.tooltipText.toString())
            assertTrue(label.text.toString().contains(address))
        }
        layoutActivity(activity)
        val selectedAddress=find<TextView>(activity.window.decorView){it.tag=="active_profile_address"}!!
        assertEquals(1,selectedAddress.maxLines)
        assertEquals(android.text.TextUtils.TruncateAt.END,selectedAddress.ellipsize)
        assertTrue(selectedAddress.layout.getEllipsisCount(0)>0)
        assertTrue(find<View>(activity.window.decorView){it.tag=="active_profile_block"}!!.contentDescription.contains(address))
        MainActivity::class.java.getDeclaredMethod("confirmAddress",String::class.java,String::class.java,String::class.java)
            .apply{isAccessible=true}.invoke(activity,"12345678902",address,"Тестове")
        assertFits("confirmed_address")
    }
    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE) @Config(qualifiers="w360dp-h640dp-mdpi",fontScale=2f)
    fun narrowLargeFontKeepsHeaderAndCountdownComplete(){
        val activity=open();layoutActivity(activity)
        assertCompleteLabel(find<TextView>(activity.window.decorView){it.tag=="app_title"}!!,1)
        assertCompleteLabel(find<TextView>(activity.window.decorView){it.tag=="current_countdown"}!!,1)
    }
    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE) @Config(qualifiers="w320dp-h568dp-360dpi",fontScale=2f)
    fun smallestLargeFontHeaderKeepsEveryCountdownWordWhole(){
        val activity=open()
        val countdown=find<TextView>(activity.window.decorView){it.tag=="current_countdown"}!!
        for(label in listOf("Не заплановано","Дані недоступні","До відновлення 12 год 59 хв","До вимкнення 12 год 59 хв")){
            countdown.text=label;layoutActivity(activity)
            assertCompleteLabel(countdown,1)
            val available=countdown.width-countdown.compoundPaddingLeft-countdown.compoundPaddingRight
            assertTrue("A countdown word must fit intact: $label",label.split(' ').all{countdown.paint.measureText(it)<=available+1})
            for(line in 0 until countdown.layout.lineCount-1){
                val end=countdown.layout.getLineEnd(line)
                assertTrue("Countdown must wrap between words: $label",label[end-1].isWhitespace() || label[end].isWhitespace())
            }
        }
    }
    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE) @Config(qualifiers="w320dp-h568dp-360dpi",fontScale=2f)
    fun smallestLargeFontShowsSevenSingleLineWeekdaysWithAccessibleDates(){
        val activity=open();layoutActivity(activity)
        val days=all(activity.window.decorView).filterIsInstance<Button>().filter{it.tag?.toString()?.startsWith("week_day:")==true}
        assertEquals(7,days.size)
        for(day in days){
            assertCompleteLabel(day,1)
            val date=LocalDate.parse(day.tag.toString().substringAfter(':'))
            assertEquals(listOf("Пн","Вт","Ср","Чт","Пт","Сб","Нд")[date.dayOfWeek.value-1],day.text.toString())
            assertTrue(day.contentDescription.toString().contains(date.format(java.time.format.DateTimeFormatter.ofPattern("dd.MM.yyyy"))))
            assertEquals(HomeSchedule.selectable(date,OutageRepository(context).snapshot(),LocalDate.now(KYIV_ZONE)),day.isEnabled)
        }
    }
    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE) @Config(qualifiers="w320dp-h568dp-360dpi",fontScale=2f)
    fun smallestLargeFontKeepsEveryActionOnOneCompleteLine(){
        val entry=JSONObject().put("id","local:paired").put("date",LocalDate.now(KYIV_ZONE).toString()).put("queue","3.2")
            .put("at",Instant.now().toString()).put("kind","emergency").put("title","Тестова подія")
            .put("source","https://www.cherkasyoblenergo.com/off").put("revision","paired").put("read",false)
        context.getSharedPreferences("svitlo_inbox",Context.MODE_PRIVATE).edit().putString("history",JSONArray().put(entry).toString()).commit()
        val activity=open()
        fun assertActions(labels:List<String>){
            layoutActivity(activity)
            for(label in labels){
                val button=find<Button>(activity.window.decorView){(it.text.toString()==label || label=="Відкрити графік" && it.text.startsWith("Графік на "))}!!
                assertTrue("Actions retain native clickable Button semantics",button.isClickable)
                assertCompleteLabel(button,1)
                assertTrue("Buttons keep a 48dp touch target",button.height>=48*activity.resources.displayMetrics.density-1)
                val available=button.width-button.compoundPaddingLeft-button.compoundPaddingRight
                assertTrue("Action font must remain readable",button.textSize>=12*activity.resources.displayMetrics.density-1)
                for(line in 0 until button.layout.lineCount-1){
                    val end=button.layout.getLineEnd(line)
                    val actualLabel=button.text.toString()
                    assertTrue("No split inside a button word: $actualLabel",end>0 &&
                        (actualLabel[end-1].isWhitespace() || actualLabel.getOrNull(end)?.isWhitespace()==true))
                }
            }
        }
        assertActions(listOf("Додати адресу","Керувати адресами","Джерело","↻ Оновити","Головна","Повідомлення","Опції"))
        click(activity,"Опції");assertActions(listOf("Детальний · 4×4","Компактний · 4×2"))
        click(activity,"Повідомлення");assertActions(listOf("Переглянути графік","Джерело"))
        click(activity,"Головна");click(activity,"Додати адресу");assertActions(listOf("1. Обрати філію","Скасувати зміну"))
    }
    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE) @Config(qualifiers="w320dp-h568dp-360dpi",fontScale=2f)
    fun smallestLargeFontKeepsWeatherAndSummaryLabelsOnOneCompleteLine(){
        val now=Instant.now()
        context.getSharedPreferences("svitlo_weather",Context.MODE_PRIVATE).edit()
            .putString("forecast",weatherFixture(now)).putLong("fetched_at",now.toEpochMilli()).commit()
        val activity=open();layoutActivity(activity)
        val root=activity.window.decorView
        val weather=find<View>(root){it.tag=="home_weather"}!!
        assertCompleteLabel(find<TextView>(root){it.tag=="selected_day_state"}!!,1)
        val hours=find<HorizontalScrollView>(weather){it.tag=="weather_hours"}!!
        val cells=(hours.getChildAt(0) as ViewGroup)
        assertEquals(24,cells.childCount)
        for(label in all(hours).filterIsInstance<TextView>())assertCompleteLabel(label,1)
        for(value in listOf("СЬОГОДНІ","Тестове","+9°"))assertCompleteLabel(find<TextView>(weather){it.text==value}!!,1)
        assertCompleteLabel(find<TextView>(weather){it.text.toString().contains("Мінлива хмарність")}!!,1)
        val summary=find<View>(root){it.tag=="day_summary"}!!
        val captions=all(summary).filterIsInstance<TextView>().filter{it.text.toString() in listOf("Зі світлом","Без світла")}
        assertEquals(2,captions.size)
        captions.forEach{caption->all(caption.parent as View).filterIsInstance<TextView>().forEach{assertCompleteLabel(it,1)}}
    }
    @Test fun summaryPreservesPreciseMinutesUnknownStatesAndActualDstDayLengths(){
        val activity=open()
        val date=LocalDate.of(2026,10,23);val now=date.atStartOfDay(KYIV_ZONE).toInstant()
        val event=Outage(Category.SCHEDULE,now.plusSeconds(3600),now.plusSeconds(7*3600+30*60),false,"","ГПВ")
        val snapshot=Snapshot(Category.entries.associateWith{CategorySnapshot(it,now,now,if(it==Category.SCHEDULE)listOf(event)else emptyList(),testQueue(it))})
        fun render(day:LocalDate,data:Snapshot,at:Instant):LinearLayout=LinearLayout(activity).apply{
            MainActivity::class.java.getDeclaredMethod("addSummary",LinearLayout::class.java,LocalDate::class.java,Snapshot::class.java,Instant::class.java)
                .apply{isAccessible=true}.invoke(activity,this,day,data,at)
        }
        val precise=render(date,snapshot,now)
        assertEquals("17 год 30 хв",find<TextView>(precise){it.tag=="summary_clear_duration"}!!.text.toString().replace('\u00a0',' '))
        assertEquals("6 год 30 хв",find<TextView>(precise){it.tag=="summary_outage_duration"}!!.text.toString().replace('\u00a0',' '))
        val unknown=render(date,Snapshot(emptyMap()),now)
        assertEquals("—",find<TextView>(unknown){it.tag=="summary_clear_duration"}!!.text.toString())
        assertEquals("—",find<TextView>(unknown){it.tag=="summary_outage_duration"}!!.text.toString())
        assertTrue(texts(unknown).contains("Невідомо: 24 год"))
        val stale=render(date,snapshot.copy(failures=setOf(Category.SCHEDULE)),now)
        assertEquals("6 год 30 хв",find<TextView>(stale){it.tag=="summary_outage_duration"}!!.text.toString().replace('\u00a0',' '))
        assertTrue(texts(stale).contains("Збережені інтервали · потребують перевірки"))
        for((day,hours) in listOf(LocalDate.of(2026,3,29) to 23,LocalDate.of(2026,10,25) to 25)){
            val at=day.atStartOfDay(KYIV_ZONE).toInstant()
            val empty=Snapshot(Category.entries.associateWith{CategorySnapshot(it,at,at,emptyList(),testQueue(it))})
            val summary=render(day,empty,at)
            assertEquals("$hours год",find<TextView>(summary){it.tag=="summary_clear_duration"}!!.text.toString().replace('\u00a0',' '))
            assertEquals("0 год",find<TextView>(summary){it.tag=="summary_outage_duration"}!!.text.toString().replace('\u00a0',' '))
        }
    }
    @Test fun distantDeepLinkSelectsItsWeekWithoutADuplicateVisibleDate(){
        val date=LocalDate.now(KYIV_ZONE).plusDays(20)
        val activity=open(Intent().putExtra("screen","graph").putExtra("date",date.toString()))
        val root=activity.window.decorView
        val formatted=date.format(java.time.format.DateTimeFormatter.ofPattern("dd.MM.yyyy"))
        assertEquals(0,all(root).filterIsInstance<TextView>().count{it.text.toString().contains(formatted)})
        assertNull(find<View>(root){it.tag=="selected_calendar_date"})
        val selected=find<DayTab>(root){it.isSelected}!!
        assertEquals("week_day:$date",selected.tag)
        assertTrue(selected.contentDescription.contains(formatted))
        assertEquals(HomeSchedule.week(date).map{"week_day:$it"},all(root).filterIsInstance<DayTab>().map{it.tag})
    }
    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE) @Config(qualifiers="w320dp-h640dp-mdpi",fontScale=1f)
    fun compactRowsAndCardsFitAtDefaultFont(){assertCompactRowsAndCards()}
    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE) @Config(qualifiers="w320dp-h640dp-mdpi",fontScale=1.5f)
    fun compactRowsAndCardsFitAtOneAndHalfFont(){assertCompactRowsAndCards()}
    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE) @Config(qualifiers="w320dp-h640dp-mdpi",fontScale=2f)
    fun compactRowsAndCardsFitAtDoubleFont(){assertCompactRowsAndCards()}
    private fun assertCompactRowsAndCards(){
        val entry=JSONObject().put("id","local:spacing").put("date",LocalDate.now(KYIV_ZONE).toString()).put("queue","3.2")
            .put("at",Instant.now().toString()).put("kind","emergency").put("title","Довгий опис зміни графіка має залишатися читабельним і переноситися між рядками")
            .put("source","https://www.cherkasyoblenergo.com/off").put("revision","spacing").put("read",false)
        context.getSharedPreferences("svitlo_inbox",Context.MODE_PRIVATE).edit().putString("history",JSONArray().put(entry).toString()).commit()
        val activity=open()
        fun pair(first:String,second:String){
            layoutActivity(activity)
            val left=find<Button>(activity.window.decorView){(it.text==first || first=="Відкрити графік" && it.text.startsWith("Графік на "))}!!
            val right=find<Button>(activity.window.decorView){it.text==second}!!
            assertSame(left.parent,right.parent)
            assertEquals(left.height,right.height)
            assertTrue(kotlin.math.abs(left.width-right.width)<=1)
            assertEquals(left.textSize,right.textSize,0.01f)
            if((left.parent as LinearLayout).orientation==LinearLayout.HORIZONTAL){
                assertEquals(left.top,right.top);assertTrue(right.left-left.right>=8*activity.resources.displayMetrics.density-1)
            }else{assertTrue(right.top-left.bottom>=8*activity.resources.displayMetrics.density-1)}
            assertCompleteLabel(left,1);assertCompleteLabel(right,1)
            val row=left.parent as ViewGroup;val box=row.parent as ViewGroup
            val previous=box.getChildAt(box.indexOfChild(row)-1)
            assertTrue("Actions need room after the preceding content",row.top-previous.bottom>=16*activity.resources.displayMetrics.density-1)
        }
        pair("Додати адресу","Керувати адресами");pair("Джерело","↻ Оновити")
        val root=activity.window.decorView
        val left=find<View>(root){it.tag=="summary_clear"}!!;val right=find<View>(root){it.tag=="summary_outage"}!!
        assertSame(left.parent,right.parent);assertNotNull(left.background);assertNotNull(right.background)
        if((left.parent as LinearLayout).orientation==LinearLayout.HORIZONTAL){
            assertEquals(left.top,right.top);assertEquals(left.height,right.height);assertTrue(kotlin.math.abs(left.width-right.width)<=1);assertTrue(right.left>left.right)
        }else{assertTrue(right.top>=left.bottom);assertEquals(left.width,right.width)}
        val leftText=all(left).filterIsInstance<TextView>();val rightText=all(right).filterIsInstance<TextView>()
        leftText.zip(rightText).forEach{(a,b)->assertEquals(a.textSize,b.textSize,0.01f);assertCompleteLabel(a,1);assertCompleteLabel(b,1)}
        // Exercise longer, differing exact durations through the same measured cards.
        find<TextView>(root){it.tag=="summary_clear_duration"}!!.text="17 год 30 хв"
        find<TextView>(root){it.tag=="summary_outage_duration"}!!.text="6 год 30 хв"
        layoutActivity(activity)
        leftText.zip(rightText).forEach{(a,b)->assertEquals(a.textSize,b.textSize,0.01f);assertCompleteLabel(a,1);assertCompleteLabel(b,1)}
        assertTrue("The duration must remain more prominent than its caption",leftText[1].textSize>leftText[2].textSize)
        click(activity,"Опції");pair("Детальний · 4×4","Компактний · 4×2")
        assertNull(find<Button>(activity.window.decorView){it.text=="Змінити інтервал"})
        click(activity,"Повідомлення");pair("Переглянути графік","Джерело")
        val description=find<TextView>(activity.window.decorView){it.text.toString().startsWith("Довгий опис")}!!
        if(activity.resources.configuration.fontScale>=1.5f){
            assertEquals(1,description.lineCount);assertTrue(description.layout.getEllipsisCount(0)>0);assertEquals(description.text.toString(),description.tooltipText.toString())
        }else assertTrue("Descriptive text must retain natural wrapping",description.lineCount>1)
    }
    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE) @Config(qualifiers="w360dp-h640dp-mdpi",fontScale=2f)
    fun narrowLargeFontKeepsAddressActionsOnOneCompleteLine(){
        val activity=open();layoutActivity(activity)
        for(label in listOf("Додати адресу","Керувати адресами")){
            val button=find<Button>(activity.window.decorView){it.text==label}!!
            assertCompleteLabel(button,1)
            for(line in 0 until button.layout.lineCount-1){
                val end=button.layout.getLineEnd(line)
                assertTrue("Action label must wrap between words: $label",end>0 &&
                    (label[end-1].isWhitespace() || label.getOrNull(end)?.isWhitespace()==true))
            }
            assertEquals(label,button.text.toString())
        }
    }
    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE) @Config(qualifiers="w320dp-h640dp-mdpi",fontScale=2f)
    fun narrowLargeFontKeepsNavigationLabelsOnOneCompleteLine(){
        val activity=open();layoutActivity(activity)
        val sharedSize=find<Button>(activity.window.decorView){it.tag=="navigation:home"}!!.textSize
        for((key,label) in listOf("home" to "Головна","inbox" to "Повідомлення","settings" to "Опції")){
            val button=find<Button>(activity.window.decorView){it.tag=="navigation:$key"}!!
            assertCompleteLabel(button,1)
            assertEquals("Navigation must not split words",1,button.lineCount)
            assertTrue(button.textSize>=12*activity.resources.displayMetrics.density-1)
            assertEquals("Navigation labels must keep a consistent visual size",sharedSize,button.textSize,0.01f)
            assertEquals(label,button.text.toString())
            assertTrue(button.contentDescription.toString().startsWith(label))
        }
    }
    private fun assertCompleteLabel(view:TextView,maxLines:Int){
        val layout=view.layout
        assertNotNull(layout)
        assertTrue("Too many lines for ${view.text}: ${layout.lineCount}; textSize=${view.textSize}, width=${view.width}, measuredWidth=${view.measuredWidth}, textWidth=${view.paint.measureText(view.text.toString())}, layoutWidth=${layout.width}",layout.lineCount in 1..(if(view is DayTab)1 else maxOf(maxLines,12)))
        assertEquals("Complete label must remain visible",view.text.length,layout.getLineEnd(layout.lineCount-1))
        assertTrue("Label exceeds its button height",layout.height<=view.height-view.compoundPaddingTop-view.compoundPaddingBottom)
        for(line in 0 until layout.lineCount){
            assertEquals(0,layout.getEllipsisCount(line))
            // LineMax excludes the invisible trailing space retained by native word wrapping.
            assertTrue("Label '${view.text}' line $line exceeds its available width: ${layout.getLineMax(line)} > ${view.width-view.compoundPaddingLeft-view.compoundPaddingRight}",layout.getLineMax(line)<=view.width-view.compoundPaddingLeft-view.compoundPaddingRight+1)
        }
    }
    @Test fun redrawKeepsSettingsControlsAndFocusInPlace(){
        val activity=open();click(activity,"Опції")
        val toggle=find<Switch>(activity.window.decorView){true}!!
        toggle.isFocusableInTouchMode=true;toggle.requestFocus()
        MainActivity::class.java.getDeclaredMethod("redraw").apply{isAccessible=true}.invoke(activity)
        assertSame(toggle,find<Switch>(activity.window.decorView){it.tag==toggle.tag})
        assertTrue(toggle.hasFocus())
    }
    @Test fun redrawKeepsKeyboardFocusOnTheSameMiddleHour(){
        assertHourFocusSurvivesUpdate(false)
    }
    @Test fun refreshBroadcastKeepsKeyboardFocusOnTheSameMiddleHour(){
        assertHourFocusSurvivesUpdate(true)
    }
    @Test fun burstRedrawsKeepKeyboardFocusOnTheSameMiddleHour(){
        assertHourFocusSurvivesUpdate(false,2)
    }
    @Test fun redrawKeepsAccessibilityFocusOnTheSameMiddleHour(){
        val manager=context.getSystemService(AccessibilityManager::class.java)
        shadowOf(manager).setEnabled(true);shadowOf(manager).setTouchExplorationEnabled(true)
        val activity=open(Intent().putExtra("screen","graph"))
        shadowOf(Looper.getMainLooper()).idle()
        layoutActivity(activity)
        val hour=all(activity.window.decorView).filterIsInstance<HourTileView>().single{it.hour.label=="12:00"}
        val key=hour.tag
        hour.requestRectangleOnScreen(android.graphics.Rect(0,0,hour.width,hour.height),true)
        assertTrue(hour.performAccessibilityAction(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS,null))
        assertTrue(hour.isAccessibilityFocused)
        MainActivity::class.java.getDeclaredMethod("redraw").apply{isAccessible=true}.invoke(activity)
        layoutActivity(activity)
        val updated=all(activity.window.decorView).single{it.tag==key}
        assertSame("An unchanged graph retains its accessible hour views",hour,updated)
        assertTrue("TalkBack focus must return to the same civil hour; focused=${all(activity.window.decorView).filter{it.isAccessibilityFocused}.map{it.tag}}; shown=${updated.isShown}; attached=${updated.isAttachedToWindow}",updated.isAccessibilityFocused)
    }
    private fun assertHourFocusSurvivesUpdate(broadcast:Boolean,count:Int=1){
        val activity=open(Intent().putExtra("screen","graph"))
        shadowOf(Looper.getMainLooper()).idle()
        layoutActivity(activity)
        val hour=all(activity.window.decorView).filterIsInstance<HourTileView>().single{it.hour.label=="12:00"}
        val key=hour.tag
        hour.isFocusableInTouchMode=true;assertTrue(hour.requestFocus())
        // ShadowActivity.currentFocus is an independent stub; the attached native tree owns focus.
        assertEquals(key,activity.window.decorView.findFocus()?.tag)
        repeat(count){index->
            if(broadcast)context.sendBroadcast(Intent(RefreshWorker.UPDATED).setPackage(context.packageName))
            else MainActivity::class.java.getDeclaredMethod("redraw").apply{isAccessible=true}.invoke(activity)
            if(index<count-1 && !hour.isAttachedToWindow){
                // Android may assign default focus while the old hour's restoration is queued.
                layoutActivity(activity,false)
                find<ScrollView>(activity.window.decorView){it.tag=="page_scroll"}!!.apply{
                    isFocusableInTouchMode=true;requestFocus()
                }
            }
        }
        shadowOf(Looper.getMainLooper()).idle()
        layoutActivity(activity)
        val updated=all(activity.window.decorView).single{it.tag==key}
        assertSame("An unchanged graph must keep the current presentation",hour,updated)
        assertEquals("Keyboard focus must stay on the same civil hour",key,activity.window.decorView.findFocus()?.tag)
        assertTrue(updated.hasFocus())
    }
    private fun layoutActivity(activity:MainActivity,drain:Boolean=true){
        activity.window.decorView.apply{
            val viewportWidth=width.takeIf{it>0} ?: resources.displayMetrics.widthPixels
            val viewportHeight=height.takeIf{it>0} ?: resources.displayMetrics.heightPixels
            measure(View.MeasureSpec.makeMeasureSpec(viewportWidth,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(viewportHeight,View.MeasureSpec.EXACTLY))
            layout(0,0,viewportWidth,viewportHeight)
        }
        if(drain){shadowOf(Looper.getMainLooper()).idle();shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(32))}
    }
    @Test fun inboxMarksCurrentQueueReadAndOpensItsDayWithoutDeletingSchedule(){
        val date=LocalDate.now(KYIV_ZONE)
        val entry=JSONObject().put("id","local:test").put("date",date.toString()).put("queue","3.2")
            .put("at",Instant.now().toString()).put("kind","emergency").put("title","Тестова аварійна подія")
            .put("source","https://www.cherkasyoblenergo.com/off").put("revision","test").put("read",false)
        context.getSharedPreferences("svitlo_inbox",Context.MODE_PRIVATE).edit().putString("history",JSONArray().put(entry).toString()).commit()
        val before=OutageRepository(context).snapshot()
        val activity=open();click(activity,"Повідомлення")
        find<View>(activity.window.decorView){it.tag=="inbox_local:test"}!!.performClick()
        assertTrue(InboxRepository(context).changes().single().read)
        assertEquals(before,OutageRepository(context).snapshot())
        assertEquals(date,all(activity.window.decorView).filterIsInstance<HourTileView>().first().hour.start.atZone(KYIV_ZONE).toLocalDate())
    }

    @Test fun inboxShowsOnlyUpdateTimeWithoutReadStatus(){
        val entries=JSONArray()
        for(read in listOf(false,true))entries.put(JSONObject().put("id","local:status-$read")
            .put("date",LocalDate.now(KYIV_ZONE)).put("queue","3.2").put("at",Instant.now())
            .put("kind","emergency").put("title","Тестова подія").put("source","https://www.cherkasyoblenergo.com/off")
            .put("revision","test-$read").put("read",read))
        context.getSharedPreferences("svitlo_inbox",Context.MODE_PRIVATE).edit().putString("history",entries.toString()).commit()
        val activity=open(Intent().putExtra("screen","inbox"));val root=activity.window.decorView
        val labels=all(root).filterIsInstance<TextView>().map{it.text.toString()}
        assertFalse(labels.any{it.contains("Прочитано") || it.contains("Нове")})
        assertEquals(2,labels.count{it.startsWith("Оновлено · ")})
        assertFalse(all(root).any{it.contentDescription?.toString()?.contains("Прочитано")==true})
    }
    @Test @Config(qualifiers="w320dp-h640dp-port",fontScale=2f)
    fun largeFontUsesThreeColumnsAndContentCanScrollAboveNavigation(){
        val activity=open(Intent().putExtra("screen","graph"))
        val root=activity.window.decorView
        root.measure(View.MeasureSpec.makeMeasureSpec(320,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(640,View.MeasureSpec.EXACTLY));root.layout(0,0,320,640)
        val grid=find<GridLayout>(root){it.tag=="hour_grid"}!!
        assertTrue(grid.columnCount in 2..4)
        val scroll=find<ScrollView>(root){it.tag=="page_scroll"}!!
        val nav=find<View>(root){it.tag=="bottom_navigation"}!!
        assertTrue(scroll.height>0);assertTrue(nav.height>0);assertTrue(scroll.bottom<=nav.top)
        scroll.fullScroll(View.FOCUS_DOWN)
        assertNull(find<Button>(root){it.text=="Поділитися"});assertNotNull(find<Button>(root){it.text=="Джерело"})
    }
    @Test fun appearanceDefaultsDarkAndLightPreferenceSurvivesActivityRestart(){
        assertFalse(AppAppearance.light(context))
        val widget=Palette.of(context.applicationContext)
        AppAppearance.setLight(context,true)
        val activity=open(Intent().putExtra("screen","settings"))
        val toggle=find<View>(activity.window.decorView){it.tag=="appearance:theme:true"}!!
        assertTrue(toggle.isSelected)
        assertNotEquals(Palette.app().background,Palette.app(activity).background)
        assertEquals(widget,Palette.of(activity.applicationContext))
        for(button in all(activity.window.decorView).filterIsInstance<Button>().filter{it.tag?.toString()?.startsWith("navigation:")==true}){
            assertEquals(0f,button.elevation,0f);assertEquals(0f,button.translationZ,0f);assertNull(button.stateListAnimator)
        }
        assertEquals(android.content.res.Configuration.UI_MODE_NIGHT_NO,
            activity.resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK)
        val dialog=AppDialogs.builder(activity).setTitle("Перевірка").setMessage("Текст").setPositiveButton("Гаразд",null).show()
        AppDialogs.style(dialog)
        assertEquals(Palette.app(activity).accent,dialog.getButton(AlertDialog.BUTTON_POSITIVE).currentTextColor)
        dialog.dismiss()
        controller!!.pause().stop().destroy();controller=null
        assertTrue(AppAppearance.light(context));open()
        assertEquals(Palette.app(context).background,Palette.app(controller!!.get()).background)
    }
    @Test fun settingsHasNoVersionCardOrManualCheckEvenAfterFailedCheck(){
        context.getSharedPreferences("svitlo_app_updates",0).edit().putBoolean("failed",true).commit()
        val activity=open(Intent().putExtra("screen","settings"))
        val labels=texts(activity.window.decorView)
        assertFalse(labels.contains("Перевірити версію"));assertFalse(labels.contains("Перевірка версії недоступна"))
        assertFalse(labels.contains("Версія 1.4.2"));assertTrue(labels.contains("Нові версії застосунку"))
    }
    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE) @Config(qualifiers="w320dp-h640dp-mdpi",fontScale=2f)
    fun donationActionOpensRequestedJarAndKeepsLargeLabelReadableInBothThemes(){
        for(light in listOf(false,true)){
            AppAppearance.setLight(context,light)
            val activity=open();layoutActivity(activity)
            val button=find<Button>(activity.window.decorView){it.tag=="donate_button"}!!
            assertEquals("♡ Подякувати за додаток",button.text.toString());assertCompleteLabel(button,12)
            button.performClick()
            val intent=shadowOf(activity).nextStartedActivity
            assertEquals(Intent.ACTION_VIEW,intent.action)
            assertEquals("https://send.monobank.ua/jar/5cWs9Zt1qa",intent.dataString)
            controller!!.pause().stop().destroy();controller=null
        }
    }
    @Test @Config(sdk=[26,35]) fun lightActionsAndDialogRemainFlatWhenPressed()=assertFlatActionsAndDialog(true)
    @Test @Config(sdk=[26,35]) fun darkActionsAndDialogRemainFlatWhenPressed()=assertFlatActionsAndDialog(false)
    private fun assertFlatActionsAndDialog(light:Boolean){
        AppAppearance.setLight(context,light)
        val activity=open(Intent().putExtra("screen","settings"))
        val actions=all(activity.window.decorView).filterIsInstance<Button>()
        assertTrue(actions.size>5)
        for(button in actions){
            button.isPressed=true
            assertEquals(button.text.toString(),0f,button.elevation,0f)
            assertEquals(0f,button.translationZ,0f);assertNull(button.stateListAnimator)
            button.isPressed=false
        }
        val toggle=find<Switch>(activity.window.decorView){it.tag=="notification_before_off"}!!
        if(light)assertTrue(toggle.thumbDrawable is android.graphics.drawable.GradientDrawable)
        val dialog=AppDialogs.builder(activity).setTitle("Перевірка").setPositiveButton("Гаразд",null).show()
        AppDialogs.style(dialog)
        val button=dialog.getButton(AlertDialog.BUTTON_POSITIVE)
        button.isPressed=true;assertEquals(0f,button.elevation,0f);assertNull(button.stateListAnimator)
        assertEquals(0f,dialog.window!!.decorView.elevation,0f)
        dialog.dismiss()
    }
    @Test fun recentEmergencyKeepsHourlyStatusAndBannerHasOnlyTwoLines(){
        val now=Instant.now();val today=now.atZone(KYIV_ZONE).toLocalDate()
        val started=now.minusSeconds(600)
        val notice=JSONObject().put("id","previous-day").put("publishedAt",started.toString()).put("effectiveAt",started.toString())
            .put("active",true).put("hourly","ACTIVE").put("queues",JSONArray()).put("sourceUrl","https://www.cherkasyoblenergo.com/media/test").put("until","")
        val state=JSONObject().put("days",JSONArray()).put("checkedAt",now.toString()).put("failed",false)
            .put("issues",JSONArray()).put("emergencies",JSONArray().put(notice))
        context.getSharedPreferences("svitlo_official",0).edit().putString("state",state.toString()).commit()
        val activity=open()
        val banner=find<ViewGroup>(activity.window.decorView){it.tag=="emergency_warning"}!!
        assertEquals(2,banner.childCount)
        assertTrue(texts(banner).contains("Аварійні відключення в області"))
        assertTrue(texts(banner).contains("Погодинний графік: діє"))
        assertFalse(texts(banner).contains("потрібне уточнення"))
    }
    @Test fun legacyCachedEmergencyWithFreshCheckDoesNotShowLiveBannerInEitherTheme(){
        val now=Instant.now();val started=now.minusSeconds(14400)
        val notice=JSONObject().put("id","legacy-141").put("publishedAt",started.toString()).put("effectiveAt",started.toString())
            .put("active",true).put("hourly","ACTIVE").put("queues",JSONArray()).put("sourceUrl","https://www.cherkasyoblenergo.com/media/test").put("until","")
        val state=JSONObject().put("days",JSONArray()).put("checkedAt",now.toString()).put("failed",false)
            .put("issues",JSONArray()).put("emergencies",JSONArray().put(notice))
        context.getSharedPreferences("svitlo_official",0).edit().putString("state",state.toString()).commit()
        for(light in listOf(false,true)){
            AppAppearance.setLight(context,light)
            val activity=open()
            assertNull(find<View>(activity.window.decorView){it.tag=="emergency_warning"})
            assertFalse(texts(activity.window.decorView).contains("Аварійні відключення в області"))
            assertTrue(OfficialScheduleRepository(context).snapshot().emergencies.isNotEmpty())
            controller!!.pause().stop().destroy();controller=null
        }
    }
    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE) @Config(qualifiers="w320dp-h640dp-mdpi",fontScale=2f)
    fun lightThemeAlsoKeepsLargeLabelsReadableAndComplete(){
        AppAppearance.setLight(context,true)
        val activity=open();layoutActivity(activity)
        for(view in all(activity.window.decorView).filterIsInstance<TextView>().filter{it !is HourTileView}){
            if(view.text.isNotBlank()){
                if(view.tag in listOf("active_profile_name","active_profile_address","header_kind")){
                    assertEquals(1,view.maxLines);assertEquals(view.text.toString(),view.tooltipText.toString())
                }else assertCompleteLabel(view,12)
            }
        }
        for(button in all(activity.window.decorView).filterIsInstance<Button>().filter{it.tag?.toString()?.startsWith("navigation:")==true})
            {assertTrue(button.textSize>=12*activity.resources.displayMetrics.density-1);assertEquals(1,button.lineCount)}
    }
    private fun click(activity:MainActivity,label:String){find<Button>(activity.window.decorView){it.text==label}!!.performClick()}
    private fun texts(root:View)=all(root).filterIsInstance<TextView>().joinToString("\n"){it.text.toString()}
    private fun all(root:View):List<View> = listOf(root)+if(root is ViewGroup)(0 until root.childCount).flatMap{all(root.getChildAt(it))}else emptyList()
    private inline fun <reified T:View> find(root:View,predicate:(T)->Boolean):T?=all(root).filterIsInstance<T>().firstOrNull(predicate)
}
