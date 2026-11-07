package ua.svitlo.widget

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.core.graphics.ColorUtils
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import ua.svitlo.widget.core.*
import java.time.*

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[28])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class UnplannedAppearance156Test {
    private val date=LocalDate.of(2026,10,28)
    private val now=date.atTime(9,0).atZone(KYIV_ZONE).toInstant()
    private fun at(hour:Int,minute:Int=0)=date.atTime(hour,minute).atZone(KYIV_ZONE).toInstant()
    private fun event(start:Instant,end:Instant,type:String,category:Category=Category.PLANNED)=Outage(category,start,end,false,"",type)
    private fun snapshot(events:List<Outage>)=Snapshot(Category.entries.associateWith{category->
        CategorySnapshot(category,now,now,events.filter{it.category==category},if(category==Category.SCHEDULE)listOf("Графік погодинних відключень: 3 черга 2 підчерга")else emptyList())
    })
    @After fun reset(){
        val context=RuntimeEnvironment.getApplication()
        context.getSharedPreferences("svitlo_ui",0).edit().clear().commit()
        RuntimeEnvironment.setFontScale(1f)
    }
    @Test fun subtypeSurvivesRoundingWithoutChangingRawTimesTotalsOrPriority(){
        val events=listOf(event(at(10,1),at(11,2),"Планові роботи"),event(at(12,1),at(13,2),"Позапланове відключення"))
        val snapshot=snapshot(events)
        val before=HourlySchedule.summary(date,snapshot,now)
        val tiles=DisplaySchedule.tiles(date,snapshot,now)
        assertEquals(OutageKind.PLANNED,tiles.single{it.label=="10:00"}.segments.first().kind)
        assertEquals(OutageKind.UNPLANNED,tiles.single{it.label=="12:00"}.segments.first().kind)
        assertEquals(OutageKind.UNPLANNED,Timeline.bins(date,snapshot,now).single{it.start==at(12,5)}.kind)
        assertEquals(events,snapshot.allEvents())
        assertEquals(before,HourlySchedule.summary(date,snapshot,now))
        assertEquals(122L,before.outageMinutes)
        val emergency=event(at(12,30),at(12,45),"Аварійне",Category.EMERGENCY)
        val overlap=TimelineViewport(date).segments(snapshot(events+emergency),now).single{it.start==at(12,30)}
        assertEquals(Category.EMERGENCY,overlap.category);assertEquals(OutageKind.EMERGENCY,overlap.kind)
    }
    @Test fun repeatedHourKeepsFourChronologicalKindsAndTwentyFiveRealHours(){
        val date=LocalDate.of(2026,10,25)
        val repeated=date.atTime(3,0).atZone(KYIV_ZONE).withEarlierOffsetAtOverlap().toInstant()
        val events=(0..3).map{index->event(repeated.plusSeconds(index*1800L),repeated.plusSeconds((index+1)*1800L),if(index%2==0)"Планові роботи"else"Позапланове відключення")}
        val tile=DisplaySchedule.tiles(date,snapshot(events),now).single{it.clockChange}
        assertEquals(listOf(OutageKind.PLANNED,OutageKind.UNPLANNED,OutageKind.PLANNED,OutageKind.UNPLANNED),tile.segments.map{it.kind})
        assertEquals(300,Timeline.bins(date,snapshot(events),now).size)
        assertEquals(7200L,Duration.between(tile.start,tile.end).seconds)
    }
    @Test fun bothThemesTileStylesAndGlyphsDistinguishUnplannedWithReadableInk(){
        val context=RuntimeEnvironment.getApplication()
        val start=at(12)
        for(light in listOf(false,true))for(rows in listOf(false,true))for(bulbs in listOf(false,true)){
            AppAppearance.setLight(context,light);AppAppearance.setTwoRows(context,rows);AppAppearance.setBulbs(context,bulbs)
            val colors=Palette.app(context)
            val detail=Palette.of(context)
            assertTrue(ColorUtils.calculateLuminance(detail.unplanned)<ColorUtils.calculateLuminance(detail.planned))
            assertTrue(ColorUtils.calculateLuminance(colors.unplanned)<ColorUtils.calculateLuminance(colors.planned))
            assertTrue(ColorUtils.calculateContrast(colors.outageInk(Category.PLANNED,OutageKind.UNPLANNED),colors.unplanned)>=4.5)
            val hour=HourTile(start,start.plusSeconds(3600),"12:00",listOf(
                TimelineSegment(start,start.plusSeconds(1800),Category.PLANNED,false,OutageKind.PLANNED),
                TimelineSegment(start.plusSeconds(1800),start.plusSeconds(3600),Category.PLANNED,false,OutageKind.UNPLANNED)))
            val view=HourTileView(context,hour,now,colors).apply{layout(0,0,240,120)}
            val image=Bitmap.createBitmap(240,120,Bitmap.Config.ARGB_8888);view.draw(Canvas(image))
            assertEquals(colors.planned,image.getPixel(20,20))
            assertEquals(colors.unplanned,image.getPixel(if(rows)20 else 220,if(rows)100 else 20))
            assertTrue(view.contentDescription.toString().contains("Позапланове відключення"))
            val legend=LegendSample(context,colors,Category.PLANNED,kind=OutageKind.UNPLANNED).apply{layout(0,0,40,40)}
            val sample=Bitmap.createBitmap(40,40,Bitmap.Config.ARGB_8888);legend.draw(Canvas(sample))
            assertEquals(colors.unplanned,sample.getPixel(8,8))
            val glyphPixels=(10 until 30).flatMap{y->(10 until 30).map{x->sample.getPixel(x,y)}}
            assertTrue("Outage glyph stays dark, including unplanned events",glyphPixels.count{it==colors.outageIcon}>5)
            assertFalse("Legend must not use the light time-label color for its icon",glyphPixels.contains(colors.outageInk(Category.PLANNED,OutageKind.UNPLANNED)))
        }
    }
    @Test fun chartAndWidgetSwatchesUseTheSameUnplannedShade(){
        val snapshot=snapshot(listOf(event(at(10),at(11),"Планові роботи"),event(at(12),at(13),"Позапланове відключення")))
        val colors=WidgetStyle.palette()
        val image=ChartPainter.draw(720,date,snapshot,now,colors,height=100,pixelsPerDp=1f,showDate=false)
        assertEquals(colors.planned,image.getPixel(312,20))
        assertEquals(colors.unplanned,image.getPixel(372,20))
        val legend=WidgetStyle.legend(listOf(Category.PLANNED),listOf(OutageKind.PLANNED,OutageKind.UNPLANNED))
        val spans=legend.getSpans(0,legend.length,android.text.style.ForegroundColorSpan::class.java).map{it.foregroundColor}
        assertTrue(spans.containsAll(listOf(colors.planned,colors.unplanned)))
    }
}
