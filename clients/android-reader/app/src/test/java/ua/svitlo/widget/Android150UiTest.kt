package ua.svitlo.widget

import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.MotionEvent
import android.view.View
import android.widget.FrameLayout
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import ua.svitlo.widget.core.*
import java.time.Instant
import java.time.LocalDate

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[28])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class Android150UiTest {
    private val context get()=RuntimeEnvironment.getApplication()
    private val at=Instant.parse("2026-10-25T00:00:00Z")
    @Test fun matrixBothThemesModesIconsWidthsScalesAndClockTileGeometry(){
        val results=mutableListOf<String>()
        for(width in listOf(320,360,414))for(scale in listOf(1f,1.5f,2f))for(light in listOf(false,true))for(rows in listOf(false,true))for(bulbs in listOf(false,true)){
            val config=android.content.res.Configuration(context.resources.configuration).apply{fontScale=scale;screenWidthDp=width}
            val c=context.createConfigurationContext(config)
            AppAppearance.setLight(c,light);AppAppearance.setTwoRows(c,rows);AppAppearance.setBulbs(c,bulbs)
            val colors=Palette.app(c);val available=((width-66)*c.resources.displayMetrics.density).toInt()
            val cols=HourTileView.columns(c,available);assertTrue(cols in 2..4)
            val w=available/cols-(6*c.resources.displayMetrics.density).toInt()
            val normal=HourTile(at,at.plusSeconds(3600),"03:00",listOf(TimelineSegment(at,at.plusSeconds(3600),null,false)))
            val repeat=HourTile(at,at.plusSeconds(7200),"03:00",(0..3).map{i->TimelineSegment(at.plusSeconds(i*1800L),at.plusSeconds((i+1)*1800L),null,false)},true)
            val mixed=repeat.copy(segments=repeat.segments.mapIndexed{i,p->p.copy(category=listOf(null,Category.SCHEDULE,Category.PLANNED,Category.EMERGENCY)[i],uncertain=i==0)})
            val views=listOf(normal,repeat,mixed).map{hour->HourTileView(c,hour,at.minusSeconds(1),colors).also{
                it.measure(View.MeasureSpec.makeMeasureSpec(w,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(0,View.MeasureSpec.UNSPECIFIED))
                it.layout(0,0,it.measuredWidth,it.measuredHeight)
            }}
            assertEquals(views[0].height,views[1].height);assertEquals(views[0].height,views[2].height)
            assertFalse(views[0].isClickable);assertFalse(views[0].isLongClickable)
            assertEquals("android.widget.TextView",views[0].accessibilityClassName)
            assertTrue(views[2].contentDescription.contains("Частина 4 з 4"))
            val node=views[0].createAccessibilityNodeInfo();assertFalse(node.isClickable);assertFalse(node.actionList.any{it.id==android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK})
            views.forEachIndexed{i,v->
                val bitmap=Bitmap.createBitmap(v.width,v.height,Bitmap.Config.ARGB_8888);v.draw(Canvas(bitmap))
                assertNotEquals(0,bitmap.getPixel(v.width/2,v.height/2))
                if(width==320 && scale==2f){
                    val dir=java.io.File("build/qa150/matrix").apply{mkdirs()}
                    java.io.File(dir,"${light}-${rows}-${bulbs}-$i.png").outputStream().use{bitmap.compress(Bitmap.CompressFormat.PNG,100,it)}
                }
            }
            results+="width=$width scale=$scale light=$light rows=$rows bulbs=$bulbs columns=$cols tile=${views[0].width}x${views[0].height}"
        }
        java.io.File("build/qa150").mkdirs();java.io.File("build/qa150/layout-matrix.txt").writeText(results.joinToString("\n"))
        assertEquals(72,results.size)
    }
    @Test fun headerSharesBaselinesOrMovesWholeTimerBelowWithoutTextShrinking(){
        for(width in listOf(320,360,414))for(scale in listOf(1f,1.5f,2f)){
            val config=android.content.res.Configuration(context.resources.configuration).apply{fontScale=scale}
            val c=context.createConfigurationContext(config)
            val header=StatusHeader(c,"3.2","До відключення 15 год 45 хв",Palette.app())
            header.measure(View.MeasureSpec.makeMeasureSpec(((width-36)*c.resources.displayMetrics.density).toInt(),View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(0,View.MeasureSpec.UNSPECIFIED))
            header.layout(0,0,header.measuredWidth,header.measuredHeight)
            val title=header.findViewWithTag<android.widget.TextView>("app_title");val caption=header.findViewWithTag<android.widget.TextView>("countdown_label")
            assertTrue(title.textSize>=22*c.resources.displayMetrics.density)
            if(caption.top<header.getChildAt(1).bottom)assertEquals(title.top+title.baseline,caption.top+caption.baseline)
            else assertTrue(caption.top>=header.getChildAt(1).bottom)
            for(i in 0 until header.childCount){val v=header.getChildAt(i);assertTrue(v.left>=0 && v.right<=header.width && v.bottom<=header.height)}
        }
    }
    @Test fun deliberateSwipeMovesOnceAndCancelledVerticalShortDiagonalDoNothing(){
        var count=0;var forward=false
        val frame=DayGridFrame(context){count++;forward=it};frame.layout(0,0,320,700)
        fun event(action:Int,x:Float,y:Float){val e=MotionEvent.obtain(0,100,action,x,y,0);frame.dispatchTouchEvent(e);e.recycle()}
        fun gesture(x:Float,y:Float,cancel:Boolean=false){event(MotionEvent.ACTION_DOWN,240f,100f);event(MotionEvent.ACTION_MOVE,x,y);event(if(cancel)MotionEvent.ACTION_CANCEL else MotionEvent.ACTION_UP,x,y)}
        gesture(220f,100f);gesture(200f,250f);gesture(100f,250f);gesture(80f,100f,true);assertEquals(0,count)
        gesture(80f,100f);assertEquals(1,count);assertTrue(forward)
    }
    @Test fun calendarNavigationCannotSkipUnavailableDatesOrReturnToPastWeek(){
        val monday=LocalDate.of(2026,10,26)
        fun plan(day:LocalDate)=PublishedPlan(day,"3.2",emptyList(),at,at,"https://www.cherkasyoblenergo.com/off","test")
        val data=Snapshot(emptyMap(),plans=listOf(plan(monday),plan(monday.minusDays(1)),plan(monday.plusDays(2))))
        assertTrue(HomeSchedule.canMoveDay(monday.minusDays(1),monday,data,monday.minusDays(1)))
        assertFalse(HomeSchedule.canMoveDay(monday,monday.minusDays(1),data,monday))
        assertTrue(HomeSchedule.canMoveDay(monday,monday.minusDays(1),data,monday,true))
        assertFalse(HomeSchedule.canMoveDay(monday,monday.plusDays(1),data,monday))
        assertFalse(HomeSchedule.canMoveDay(monday,monday.plusDays(2),data,monday))
    }
}
