package ua.svitlo.widget

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.widget.Button
import android.widget.LinearLayout
import kotlin.math.abs

/** Intercept only deliberate horizontal gestures inside the schedule panel. */
class WeekPanel(context:Context,private val swipe:(Boolean)->Unit):LinearLayout(context){
    init{isClickable=true}
    private var downX=0f;private var downY=0f;private var horizontal=false
    private var delegated=false
    private val slop=ViewConfiguration.get(context).scaledTouchSlop
    private fun track(event:MotionEvent) {
        if(event.actionMasked==MotionEvent.ACTION_DOWN){
            val child=(0 until childCount).map{getChildAt(it)}.firstOrNull{it is DayGridFrame && event.y>=it.top && event.y<it.bottom}
            delegated=child!=null
        }
        if(delegated){horizontal=false;return}
        when(event.actionMasked){
            MotionEvent.ACTION_DOWN->{downX=event.x;downY=event.y;horizontal=false;parent?.requestDisallowInterceptTouchEvent(true)}
            MotionEvent.ACTION_MOVE->{
                val dx=abs(event.x-downX);val dy=abs(event.y-downY)
                if(dy>slop && dy>dx)parent?.requestDisallowInterceptTouchEvent(false)
                if(dx>slop*2 && dx>dy*1.5f)horizontal=true
            }
            MotionEvent.ACTION_UP,MotionEvent.ACTION_CANCEL->parent?.requestDisallowInterceptTouchEvent(false)
        }
    }
    override fun onInterceptTouchEvent(event:MotionEvent):Boolean {
        track(event)
        return horizontal
    }
    override fun onTouchEvent(event:MotionEvent):Boolean {
        // Non-clickable hour tiles leave the panel itself as the touch target. In
        // that case Android no longer calls onInterceptTouchEvent for MOVE; still
        // release vertical gestures to the surrounding ScrollView here.
        track(event)
        if(!horizontal)return super.onTouchEvent(event)
        if(event.actionMasked==MotionEvent.ACTION_UP){
            if(abs(event.x-downX)>maxOf(slop*3f,width*0.15f))swipe(event.x<downX)
            horizontal=false;parent?.requestDisallowInterceptTouchEvent(false);performClick()
        }else if(event.actionMasked==MotionEvent.ACTION_CANCEL){horizontal=false;parent?.requestDisallowInterceptTouchEvent(false)}
        return true
    }
    override fun performClick():Boolean=super.performClick()
}

class DayTab(context:Context,private val colors:Palette):Button(context){
    var showIndicator=true
    private val paint=Paint(Paint.ANTI_ALIAS_FLAG)
    override fun onDraw(canvas:Canvas){
        super.onDraw(canvas)
        if(isSelected && showIndicator){
            val d=resources.displayMetrics.density
            val w=minOf(24*d,width*0.6f)
            paint.color=colors.accent
            canvas.drawRoundRect((width-w)/2,height-4*d,(width+w)/2,height.toFloat(),2*d,2*d,paint)
        }
    }
}
