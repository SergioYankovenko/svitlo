package ua.svitlo.widget

import android.app.Application
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.widget.*
import org.json.*
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.*
import org.robolectric.annotation.*
import org.robolectric.Shadows.shadowOf
import ua.svitlo.widget.core.*
import java.time.*
import java.time.format.DateTimeFormatter
import java.util.concurrent.*

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[28],qualifiers="mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@LooperMode(LooperMode.Mode.PAUSED)
class DetailedWidget152Test {
    private lateinit var context:Application
    private val now=Instant.parse("2026-10-28T12:00:00Z")
    private fun all(v:View):List<View> = listOf(v)+if(v is ViewGroup)(0 until v.childCount).flatMap{all(v.getChildAt(it))}else emptyList()
    @Before fun clear(){context=RuntimeEnvironment.getApplication();listOf("svitlo_private","svitlo_profiles","svitlo_official","svitlo_registry","svitlo_ui","svitlo_runtime","svitlo_widget_pages").forEach{context.getSharedPreferences(it,0).edit().clear().commit()}}
    private fun seed(count:Int,queues:List<String?>?=null):List<AddressProfile> {
        val source=OutageSource{account,category,_,_->
            val queue=if(queues==null)"3.2"else queues.getOrNull(account.takeLast(2).toInt())
            JSONObject().put("DATETIME",now.atZone(KYIV_ZONE).format(DateTimeFormatter.ofPattern("HH:mm dd.MM.yyyy")))
            .put("DISCONNECTIONS",JSONArray()).put("DISCONN_QUEUQ",if(category==Category.SCHEDULE && queue!=null)JSONArray().put(JSONObject().put("QUEUE_INFO","Графік погодинних відключень: ${queue.substringBefore('.')} черга ${queue.substringAfter('.')} підчерга"))else JSONArray()).toString()}
        val repo=OutageRepository(context,source,now={now});val profiles=AddressProfiles(context)
        repeat(count){val account="123456789"+it.toString().padStart(2,'0');assertTrue(profiles.confirm(account,"Адреса $it",repo.prepare(account),"Місто","Назва $it",add=true))}
        return profiles.profiles()
    }
    private fun render(count:Int,width:Int,height:Int,font:Float=1f):ViewGroup {
        seed(count);RuntimeEnvironment.setFontScale(font)
        val rv=DetailedWidget.render(context,android.util.SizeF(width.toFloat(),height.toFloat()),1f,now)
        val root=rv.apply(context,FrameLayout(context)) as ViewGroup
        root.measure(View.MeasureSpec.makeMeasureSpec(width,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(height,View.MeasureSpec.EXACTLY));root.layout(0,0,width,height)
        root.draw(Canvas(Bitmap.createBitmap(width,height,Bitmap.Config.ARGB_8888)))
        return root
    }
    @Test fun allAddressesHaveOwnRowsAndRoutesWithoutChangingActive(){
        val root=render(3,414,420);val profiles=AddressProfiles(context).profiles();val active=AddressProfiles(context).active()!!.id
        val rows=all(root).filter{it.id==R.id.address_row};assertEquals(3,rows.size)
        rows.forEachIndexed{i,row->assertTrue(row.contentDescription.contains("Адреса $i"));assertTrue(row.height>=48);row.performClick()
            val intent=shadowOf(context).nextStartedActivity;assertEquals(profiles[i].id,intent.getStringExtra("profile_id"));assertEquals("2026-10-28",intent.getStringExtra("date"))}
        assertEquals(active,AddressProfiles(context).active()!!.id)
        assertNull(root.findViewById<View>(R.id.widget_tomorrow))
    }
    @Test fun resizingNeverReintroducesVerticalScrollOrLosesProfiles(){
        val large=render(10,414,900);assertEquals(View.GONE,large.findViewById<View>(R.id.detail_list).visibility);assertEquals(4,all(large).count{it.id==R.id.address_row})
        val small=DetailedWidget.render(context,android.util.SizeF(320f,250f),1f,now).apply(context,FrameLayout(context))
        assertEquals(View.GONE,small.findViewById<View>(R.id.detail_list).visibility)
        assertEquals(View.VISIBLE,small.findViewById<View>(R.id.detail_empty).visibility)
        assertTrue(small.findViewById<TextView>(R.id.detail_empty).text.startsWith("Збільште"))
        assertEquals(10,AddressProfiles(context).profiles().size)
    }
    @Test fun unknownAndVerifiedNoOutagesRemainDifferent(){
        val unknown=Snapshot(emptyMap());assertEquals("Стан невідомий",DetailedWidget.header(unknown,now));assertEquals("Стан невідомий",DetailedWidget.status(unknown,now))
        val empty=Snapshot(Category.entries.associateWith{CategorySnapshot(it,now,now,emptyList(),emptyList())},hourlyExcluded=true)
        assertEquals("Без відключень",DetailedWidget.header(empty,now));assertEquals("Без відключень до кінця дня",DetailedWidget.status(empty,now))
        assertEquals("Стан невідомий",DetailedWidget.header(empty.copy(hourlyExcluded=false),now))
    }
    @Test fun restorationUnionsTouchingEventsAndPreservesOpenEmergency(){
        val a=Outage(Category.PLANNED,now.minusSeconds(60),now.plusSeconds(600),true,"","Планові")
        val b=Outage(Category.EMERGENCY,now.plusSeconds(600),now.plusSeconds(1200),false,"","Аварійні")
        fun data(events:List<Outage>)=Snapshot(Category.entries.associateWith{c->CategorySnapshot(c,now,now,events.filter{it.category==c},if(c==Category.SCHEDULE)listOf("Графік погодинних відключень: 3 черга 2 підчерга")else emptyList())})
        assertEquals("Увімкнуть світло ≈ о 14:20",DetailedWidget.status(data(listOf(a,b)),now))
        assertEquals("Час відновлення уточнюється",DetailedWidget.status(data(listOf(a,b.copy(end=null))),now))
    }
    @Test fun stableOrderAndLateDeletedOrReplacedResults(){
        val profiles=seed(3);val manager=AddressProfiles(context);val firstOrder=manager.profiles().map{it.id}
        assertTrue(manager.activate(profiles[0].id));assertEquals(firstOrder,manager.profiles().map{it.id})
        val target=manager.saved().first{it.profile.id==profiles[1].id};assertTrue(manager.remove(profiles[1].id))
        assertFalse(manager.storeRefresh(target,target.data,null));assertEquals(2,manager.profiles().size)
    }
    @Test fun transportDeduplicatesExactParametersAndDoesNotReuseAcrossCycles(){
        var calls=0;val transport=CycleOperatorTransport(OperatorTransport{calls++;"ok"})
        val executor=Executors.newFixedThreadPool(3)
        try{val requests=(1..8).map{executor.submit<String>{transport.request(mapOf("op" to "dept","department" to "1","category" to "2"))}}
            requests.forEach{assertEquals("ok",it.get())};assertEquals(1,calls)
            transport.request(mapOf("op" to "dept","department" to "1","category" to "1"));assertEquals(2,calls)
        }finally{executor.shutdownNow()}
    }
    @Test fun themesAndFontMatrixKeepsFooterAndRowsInside(){
        try{for(width in listOf(320,360,414))for(font in listOf(1f,1.5f,2f)){
            clear();val root=render(1,width,400,font)
            val footer=root.findViewById<View>(R.id.detail_footer);assertTrue("$width/$font footer",footer.bottom<=400-root.paddingBottom)
            val rows=all(root).filter{it.id==R.id.address_row};assertEquals(1,rows.size)
            assertTrue(rows.single().height>=48)
            all(root).filterIsInstance<TextView>().filter{it.visibility==View.VISIBLE && it.width>0}.forEach{assertTrue("$width/$font ${it.text}",it.height>0)}
        }}finally{RuntimeEnvironment.setFontScale(1f)}
    }
    @Test fun refreshUpdatesInactiveProfilesWithoutActivationAndIsolatesPartialFailure(){
        val original=seed(3);val profiles=AddressProfiles(context);val active=profiles.active()!!
        val manager=AppWidgetManager.getInstance(context)
        shadowOf(manager).bindAppWidgetId(152,ComponentName(context,SvitloWidget::class.java))
        val calls=java.util.Collections.synchronizedList(mutableListOf<Pair<String,Category>>())
        val source=OutageSource{account,category,_,_->
            calls+=account to category
            if(account==original[0].binding.account && category==Category.PLANNED)throw java.io.IOException("offline")
            JSONObject().put("DATETIME","14:00 28.10.2026").put("DISCONNECTIONS",JSONArray()).toString()
        }
        assertFalse(MultiAddressRefresh.refresh(context,source))
        assertEquals(9,calls.size);assertEquals(9,calls.distinct().size)
        assertEquals(active.id,profiles.active()!!.id);assertEquals(original.map{it.id},profiles.profiles().map{it.id})
        val saved=profiles.saved()
        assertEquals(setOf(Category.PLANNED),saved[0].data.failures)
        assertTrue(saved[1].data.failures.isEmpty());assertTrue(saved[2].data.failures.isEmpty())
    }
    @Test fun snapshotAndResizeDoNotRequestProviderOrAlterActiveBinding(){
        val original=seed(2);val repo=OutageRepository(context);val token=repo.generationToken()
        val before=context.getSharedPreferences("svitlo_profiles",0).getString("profiles",null)
        repeat(3){DetailedWidget.render(context,android.util.SizeF(360f,400f),1f,now)}
        assertEquals(original.last().binding,repo.binding());assertEquals(token,repo.generationToken())
        assertEquals(before,context.getSharedPreferences("svitlo_profiles",0).getString("profiles",null))
    }
    @Test fun minimumSizeAtLargestFontNeverClipsAnAddress(){
        try{
            val root=render(10,250,384,2f)
            val body=root.findViewById<View>(R.id.detail_body)
            assertEquals(View.GONE,root.findViewById<View>(R.id.detail_list).visibility)
            val rows=all(root).filter{it.id==R.id.address_row}
            rows.forEach{row->
                assertTrue(row.height>=48 && row.bottom<=body.height)
                val chart=row.findViewById<View>(R.id.address_chart)
                val meta=row.findViewById<View>(R.id.address_meta)
                assertTrue(chart.top>=meta.bottom && chart.height>=8 && chart.bottom<=row.height)
            }
            if(rows.isEmpty())assertTrue(root.findViewById<TextView>(R.id.detail_empty).text.startsWith("Збільште"))
        }finally{RuntimeEnvironment.setFontScale(1f)}
    }
    @Test fun emptyTwoAndFiveAddressLayoutsKeepEveryAddressAndNoDemo(){
        for(count in listOf(0,2,5)){
            clear();val root=render(count,414,640)
            assertEquals(minOf(4,count),all(root).count{it.id==R.id.address_row})
            assertEquals(if(count==0)View.VISIBLE else View.GONE,root.findViewById<View>(R.id.detail_empty).visibility)
            if(count==0){root.findViewById<View>(R.id.detail_empty).performClick();assertEquals("home",shadowOf(context).nextStartedActivity.getStringExtra("screen"))}
        }
    }
    @Test fun undersizedPagedWidgetShowsReadableResizeHintAndAccessibleArrows(){
        try{for(font in listOf(1f,1.5f,2f)){
            clear();val root=render(10,250,150,font)
            val body=root.findViewById<View>(R.id.detail_body)
            val profile=AddressProfiles(context).profiles().first()
            val next=Outage(Category.PLANNED,now.plusSeconds(86400),now.plusSeconds(90000),false,"","Планові")
            val snapshot=Snapshot(Category.entries.associateWith{c->CategorySnapshot(c,now,now,if(c==Category.PLANNED)listOf(next)else emptyList(),emptyList())},hourlyExcluded=true)
            val sizing=WidgetSizing.forSize(android.util.SizeF(250f,150f))
            val row=DetailedWidget.Row(profile,snapshot)
            val layout=DetailedWidget.metrics(context,row,body.width,now,sizing)
            assertTrue("font=$font viewport=${body.height}, row=${layout.minimum}",body.height>=layout.minimum)
            assertEquals(View.GONE,root.findViewById<View>(R.id.detail_refresh).visibility)
            assertEquals(View.VISIBLE,root.findViewById<View>(R.id.detail_pager).visibility)
            val nextButton=root.findViewById<View>(R.id.detail_next)
            assertTrue(nextButton.width>=48 && nextButton.height>=48)
            assertTrue(nextButton.contentDescription.startsWith("Наступні адреси"))
            val smallName=sizing.textPx(context,14f,11f)
            assertTrue(smallName>=11f);assertTrue(smallName<WidgetSizing().textPx(context,14f,11f))
            val rendered=DetailedWidget.row(context,row,body.width,layout.minimum,1f,now,true,true,false,layout,sizing).apply(context,FrameLayout(context))
            assertEquals(smallName,rendered.findViewById<TextView>(R.id.address_name).textSize,.01f)
            assertEquals(View.GONE,root.findViewById<View>(R.id.detail_list).visibility)
            assertTrue(root.findViewById<TextView>(R.id.detail_empty).text.startsWith("Збільште"))
        }}finally{RuntimeEnvironment.setFontScale(1f)}
    }
    @Test fun proportionalSizingPreservesSystemFontAndRegularSize(){
        try{
            val size=WidgetSizing.forSize(android.util.SizeF(250f,150f))
            RuntimeEnvironment.setFontScale(1f);val normal=size.textPx(context,14f,11f)
            RuntimeEnvironment.setFontScale(2f);assertTrue(size.textPx(context,14f,11f)>normal)
            assertEquals(1f,WidgetSizing.forSize(android.util.SizeF(414f,420f)).factor,0f)
        }finally{RuntimeEnvironment.setFontScale(1f)}
    }
    @Test fun sharedHeadingCountsAllProfilesAndEachRowShowsOnlyItsOwnKnownQueue(){
        seed(3,listOf("2.1","3.2",null))
        val rv=DetailedWidget.render(context,android.util.SizeF(414f,640f),1f,now)
        val root=rv.apply(context,FrameLayout(context))
        assertEquals("Мої адреси · 3",root.findViewById<TextView>(R.id.detail_heading).text.toString())
        assertNotNull(root.findViewById<TextView>(R.id.detail_heading).compoundDrawablesRelative[0])
        val names=all(root).filterIsInstance<TextView>().filter{it.id==R.id.address_name}.map{it.text.toString()}
        assertEquals(listOf("Назва 0","Назва 1","Назва 2"),names)
        assertEquals(listOf("ϟ 2.1 · ","ϟ 3.2 · ","ϟ "),all(root).filterIsInstance<TextView>().filter{it.id==R.id.address_queue}.map{it.text.toString()})
        val active=AddressProfiles(context).active()!!.id
        assertTrue(AddressProfiles(context).activate(AddressProfiles(context).profiles().first().id))
        val changed=DetailedWidget.render(context,android.util.SizeF(414f,640f),1f,now).apply(context,FrameLayout(context))
        assertEquals(names,all(changed).filterIsInstance<TextView>().filter{it.id==R.id.address_name}.map{it.text.toString()})
        assertNotEquals(active,AddressProfiles(context).active()!!.id)
    }
    @Test fun pagingVisitsAllTenProfilesWithStableSlotsAndCorrectRoutes(){
        val profiles=seed(10);val active=AddressProfiles(context).active()!!.id
        val sizes=mutableListOf<Int>()
        for(page in 0..2){
            WidgetPages.select(context,155,page,10)
            val rv=DetailedWidget.render(context,android.util.SizeF(414f,640f),1f,now,155)
            val root=rv.apply(context,FrameLayout(context))
            root.measure(View.MeasureSpec.makeMeasureSpec(414,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(640,View.MeasureSpec.EXACTLY));root.layout(0,0,414,640)
            val rows=all(root).filter{it.id==R.id.address_row}
            assertEquals(if(page==2)2 else 4,rows.size)
            rows.forEachIndexed{index,row->
                sizes+=row.height;row.performClick()
                val intent=shadowOf(context).nextStartedActivity
                assertEquals(profiles[page*4+index].id,intent.getStringExtra("profile_id"))
                assertEquals("graph",intent.getStringExtra("screen"))
            }
            assertEquals(page>0,root.findViewById<View>(R.id.detail_previous).isEnabled)
            assertEquals(page<2,root.findViewById<View>(R.id.detail_next).isEnabled)
            assertEquals(View.GONE,root.findViewById<View>(R.id.detail_refresh).visibility)
        }
        assertEquals("Row heights across pages: $sizes",1,sizes.distinct().size)
        assertEquals(active,AddressProfiles(context).active()!!.id)
    }
    @Test fun fiveToFourReapplyRestoresRefreshAndPageStateIsPerWidget(){
        val profiles=seed(5)
        WidgetPages.select(context,155,1,5)
        assertEquals(0,WidgetPages.page(context,156,5))
        fun rv()=DetailedWidget.render(context,android.util.SizeF(414f,640f),1f,now,155)
        val root=rv().apply(context,FrameLayout(context))
        assertEquals("Назва 4",all(root).filterIsInstance<TextView>().single{it.id==R.id.address_name}.text.toString())
        assertTrue(AddressProfiles(context).activate(profiles.first().id))
        assertTrue(AddressProfiles(context).remove(profiles.last().id))
        rv().reapply(context,root)
        assertEquals(0,WidgetPages.page(context,155,4))
        assertEquals(View.GONE,root.findViewById<View>(R.id.detail_pager).visibility)
        assertEquals(View.VISIBLE,root.findViewById<View>(R.id.detail_refresh).visibility)
        assertEquals(4,all(root).count{it.id==R.id.address_row})
        WidgetPages.select(context,155,999,10);assertEquals(2,WidgetPages.page(context,155,10))
        WidgetPages.select(context,155,-2,10);assertEquals(0,WidgetPages.page(context,155,10))
        WidgetPages.select(context,155,1,10);WidgetPages.remove(context,intArrayOf(155))
        assertEquals(0,WidgetPages.page(context,155,10))
    }
    @Test fun arrowPendingIntentsAreDistinctPerWidgetAndDoNotOpenTheApp(){
        seed(5)
        for(id in listOf(155,156)){
            val root=DetailedWidget.render(context,android.util.SizeF(414f,640f),1f,now,id).apply(context,FrameLayout(context))
            assertTrue(root.findViewById<View>(R.id.detail_next).performClick())
            val intent=shadowOf(context).broadcastIntents.last{it.action==WidgetRenderer.PAGE}
            assertEquals(id,intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID,-1))
            assertEquals(1,intent.getIntExtra("page",-1))
            assertTrue(intent.data.toString().contains("/$id/page/1"))
            assertNull(shadowOf(context).nextStartedActivity)
        }
    }
}
