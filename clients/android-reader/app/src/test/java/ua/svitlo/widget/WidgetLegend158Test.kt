package ua.svitlo.widget

import android.app.Application
import android.content.Context
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.util.SizeF
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Before
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import ua.svitlo.widget.core.*
import java.time.*
import java.time.format.DateTimeFormatter

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[28],qualifiers="mdpi")
class WidgetLegend158Test {
    private lateinit var context:Application
    private val now=Instant.parse("2026-10-28T06:00:00Z")
    @Before fun clear(){
        context=RuntimeEnvironment.getApplication()
        listOf("svitlo_private","svitlo_profiles","svitlo_official","svitlo_registry","svitlo_ui","svitlo_runtime","svitlo_widget_pages")
            .forEach{context.getSharedPreferences(it,Context.MODE_PRIVATE).edit().clear().commit()}
    }
    private fun at(hour:Int)=LocalDate.of(2026,10,28).atTime(hour,0).atZone(KYIV_ZONE).toInstant()
    private fun event(category:Category,hour:Int,type:String)=Outage(category,at(hour),at(hour+1),false,"",type)
    private fun seed(events:List<List<Outage>>) {
        val format=DateTimeFormatter.ofPattern("HH:mm dd.MM.yyyy")
        val source=OutageSource{account,category,_,_->
            JSONObject().put("DATETIME",now.atZone(KYIV_ZONE).format(format)).put("DISCONNECTIONS",JSONArray().apply{
                events[account.takeLast(2).toInt()].filter{it.sourceCategory==category}.forEach{event->put(JSONObject()
                    .put("DATE_START",event.start.atZone(KYIV_ZONE).format(format)).put("DATE_STOP",event.end!!.atZone(KYIV_ZONE).format(format))
                    .put("DISCONN_TYPE",event.type).put("STATE_CHAR","Заплановано"))}
            }).put("DISCONN_QUEUQ",if(category==Category.SCHEDULE)JSONArray().put(JSONObject().put("QUEUE_INFO","Графік погодинних відключень: 3 черга 2 підчерга"))else JSONArray()).toString()
        }
        val repo=OutageRepository(context,source,now={now});val profiles=AddressProfiles(context)
        events.indices.forEach{index->val account="123456789"+index.toString().padStart(2,'0')
            assertTrue(profiles.confirm(account,"Адреса $index",repo.prepare(account),"Місто","Назва $index",add=true))}
    }
    private fun legend(widgetId:Int=158):TextView {
        val rv=DetailedWidget.render(context,SizeF(414f,640f),1f,now,widgetId)
        return rv.apply(context,FrameLayout(context)).findViewById(R.id.detail_legend)
    }
    @Test fun detailedLegendShowsOneOutageSwatchEvenWhenTheDayHasThreeKinds(){
        seed(listOf(listOf(event(Category.PLANNED,12,"Планові роботи"),event(Category.SCHEDULE,14,"ГПВ"),event(Category.PLANNED,18,"Позапланове відключення"))))
        assertEquals("One supply swatch and one outage swatch",2,legend().text.count{it=='■'})
    }
    private fun outageColor(view:TextView):Int {
        val label=view.text as Spanned
        val off=label.toString().indexOf('■',1)
        return label.getSpans(off,off+1,ForegroundColorSpan::class.java).single().foregroundColor
    }
    @Test fun earliestConfirmedKindControlsTheSingleSwatch(){
        seed(listOf(listOf(event(Category.PLANNED,12,"Планові роботи"),event(Category.SCHEDULE,14,"ГПВ"),event(Category.PLANNED,18,"Позапланове відключення"))))
        assertEquals(Palette.app().planned,outageColor(legend()))
    }
    @Test fun otherPagesCannotControlTheVisibleLegend(){
        seed(List(4){listOf(event(Category.SCHEDULE,14,"ГПВ"))}+listOf(listOf(event(Category.EMERGENCY,12,"Аварійне відключення"))))
        WidgetPages.select(context,158,0,5)
        assertEquals(Palette.app().hourly,outageColor(legend()))
        WidgetPages.select(context,158,1,5)
        assertEquals(Palette.app().emergency,outageColor(legend()))
        assertEquals(2,legend().text.count{it=='■'})
    }
    @Test fun noEventsUseOneGenericYellowExampleWithoutClaimingAnOutage(){
        seed(listOf(emptyList()))
        val view=legend()
        assertEquals(Palette.app().hourly,outageColor(view))
        assertEquals(2,view.text.count{it=='■'})
        assertTrue(view.contentDescription.toString().contains("зразок позначення"))
    }
}
