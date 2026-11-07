package ua.svitlo.widget

import android.graphics.Bitmap
import android.graphics.Canvas
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import ua.svitlo.widget.core.*
import java.time.Instant

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[28])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class HourTileViewTest {
    private val start=Instant.parse("2026-10-23T07:00:00Z")
    private val colors=Palette.app()
    @Test fun smallIconAndTimeOccupyOneCenteredHorizontalRow(){
        val hour=HourTile(start,start.plusSeconds(3600),"10:00",listOf(TimelineSegment(start,start.plusSeconds(3600),null,false)))
        val view=HourTileView(RuntimeEnvironment.getApplication(),hour,start.minusSeconds(1),colors)
        view.layout(0,0,120,72)
        val bitmap=Bitmap.createBitmap(120,72,Bitmap.Config.ARGB_8888);view.draw(Canvas(bitmap))
        val ink=(0 until 72).flatMap{y->(10 until 110).filter{x->bitmap.getPixel(x,y)==colors.ink}.map{x->x to y}}
        assertTrue(ink.isNotEmpty())
        assertTrue("Icon and text must share the center row",ink.all{it.second in 23..49})
        assertTrue("Small icon must precede the text",ink.any{it.first<45})
    }
    @Test fun clearHoursHaveDistinctRoundedTileBackground(){
        val hour=HourTile(start,start.plusSeconds(3600),"10:00",listOf(TimelineSegment(start,start.plusSeconds(3600),null,false)))
        val view=HourTileView(RuntimeEnvironment.getApplication(),hour,start.minusSeconds(1),colors)
        view.layout(0,0,120,120)
        val bitmap=Bitmap.createBitmap(120,120,Bitmap.Config.ARGB_8888);view.draw(Canvas(bitmap))
        assertNotEquals("Clear hours must remain visible on their containing surface",colors.surface,bitmap.getPixel(15,60))
        assertEquals(0,bitmap.getPixel(0,0))
    }
    @Test fun minuteSevenEdgeIsNotRoundedToQuarterAndTheTwoEdgesRemainSeparate(){
        val hour=HourTile(start,start.plusSeconds(3600),"10:00",listOf(
            TimelineSegment(start,start.plusSeconds(420),Category.SCHEDULE,false),
            TimelineSegment(start.plusSeconds(420),start.plusSeconds(2700),null,false),
            TimelineSegment(start.plusSeconds(2700),start.plusSeconds(3600),Category.EMERGENCY,false)))
        val view=HourTileView(RuntimeEnvironment.getApplication(),hour,start.minusSeconds(1),colors)
        view.layout(0,0,600,120)
        val bitmap=Bitmap.createBitmap(600,120,Bitmap.Config.ARGB_8888);view.draw(Canvas(bitmap))
        assertEquals(colors.hourly,bitmap.getPixel(69,18))
        assertEquals(colors.background,bitmap.getPixel(71,18))
        assertEquals(colors.background,bitmap.getPixel(449,18))
        assertEquals(colors.emergency,bitmap.getPixel(451,18))
        assertEquals("No quarter guide is drawn through clear space",colors.background,bitmap.getPixel(300,110))
        assertTrue(view.contentDescription.toString().contains("10:07"))
        assertTrue(view.contentDescription.toString().contains("10:45"))
        assertEquals("android.widget.TextView",view.accessibilityClassName)
        assertFalse(view.isClickable)
    }
    @Test fun unknownHoursUseVisiblePatternWithoutOpaqueLabelPill(){
        val hour=HourTile(start,start.plusSeconds(3600),"10:00",listOf(TimelineSegment(start,start.plusSeconds(3600),null,true)))
        val view=HourTileView(RuntimeEnvironment.getApplication(),hour,start.minusSeconds(1),colors)
        view.layout(0,0,600,120)
        val bitmap=Bitmap.createBitmap(600,120,Bitmap.Config.ARGB_8888);view.draw(Canvas(bitmap))
        assertTrue((30..200).map{bitmap.getPixel(it,18)}.distinct().size>1)
        assertNotEquals("The hour label sits directly on its tile",colors.background,bitmap.getPixel(270,50))
        assertFalse(view.isClickable)
        assertTrue(view.contentDescription.toString().contains("дані невідомі"))
    }
}
