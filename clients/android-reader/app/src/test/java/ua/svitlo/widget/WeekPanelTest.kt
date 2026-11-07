package ua.svitlo.widget

import android.app.Activity
import android.view.MotionEvent
import android.view.View
import android.widget.LinearLayout
import android.widget.ScrollView
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class) @Config(sdk=[28])
class WeekPanelTest {
    @Test fun verticalDragOverNonClickableHoursScrollsWhileHorizontalDragChangesWeek(){
        val controller=Robolectric.buildActivity(Activity::class.java).setup()
        try {
            val activity=controller.get();val swipes=mutableListOf<Boolean>()
            val scroll=ScrollView(activity);val column=LinearLayout(activity).apply{orientation=LinearLayout.VERTICAL}
            val panel=WeekPanel(activity){swipes+=it}
            panel.addView(View(activity),LinearLayout.LayoutParams(300,900))
            column.addView(panel,LinearLayout.LayoutParams(300,900));scroll.addView(column)
            activity.setContentView(scroll)
            scroll.measure(View.MeasureSpec.makeMeasureSpec(300,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(300,View.MeasureSpec.EXACTLY));scroll.layout(0,0,300,300)
            fun event(action:Int,x:Float,y:Float,t:Long){MotionEvent.obtain(1000,1000+t,action,x,y,0).also{scroll.dispatchTouchEvent(it);it.recycle()}}
            event(MotionEvent.ACTION_DOWN,150f,250f,0)
            event(MotionEvent.ACTION_MOVE,150f,200f,100)
            event(MotionEvent.ACTION_MOVE,150f,100f,200)
            event(MotionEvent.ACTION_MOVE,150f,40f,300)
            // End without starting a fling, so the next gesture tests week navigation
            // rather than Android's touch-to-stop-a-fling behavior.
            event(MotionEvent.ACTION_CANCEL,150f,40f,400)
            assertTrue("Vertical drag on hour grid must scroll the page",scroll.scrollY>0)
            assertTrue(swipes.isEmpty());scroll.scrollTo(0,0)
            event(MotionEvent.ACTION_DOWN,260f,150f,500)
            event(MotionEvent.ACTION_MOVE,200f,150f,600)
            event(MotionEvent.ACTION_MOVE,100f,150f,700)
            event(MotionEvent.ACTION_UP,40f,150f,800)
            assertEquals(listOf(true),swipes);assertEquals(0,scroll.scrollY)
        }finally{controller.pause().stop().destroy()}
    }
}
