package ua.svitlo.widget

import android.animation.ValueAnimator
import android.content.Context
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.widget.FrameLayout
import android.view.animation.DecelerateInterpolator
import kotlin.math.abs

/** Owns exactly one calendar-day gesture and its decorative outgoing grid. */
class DayGridFrame(context:Context,private val swipe:(Boolean)->Unit):FrameLayout(context) {
    private var x=0f;private var y=0f;private var horizontal=false;private var cancelled=false
    private val slop=ViewConfiguration.get(context).scaledTouchSlop
    init {tag="day_grid_frame";isClickable=true;clipChildren=true;importantForAccessibility=IMPORTANT_FOR_ACCESSIBILITY_NO}
    private fun track(e:MotionEvent){when(e.actionMasked){
        MotionEvent.ACTION_DOWN->{x=e.x;y=e.y;horizontal=false;cancelled=false;parent?.requestDisallowInterceptTouchEvent(true)}
        MotionEvent.ACTION_POINTER_DOWN,MotionEvent.ACTION_CANCEL->{cancelled=true;horizontal=false;parent?.requestDisallowInterceptTouchEvent(false)}
        MotionEvent.ACTION_MOVE->{val dx=abs(e.x-x);val dy=abs(e.y-y)
            if(dy>slop && dy>=dx){cancelled=true;parent?.requestDisallowInterceptTouchEvent(false)}
            if(!cancelled && dx>slop*2 && dx>dy*1.5f)horizontal=true}
    }}
    override fun onInterceptTouchEvent(e:MotionEvent):Boolean{track(e);return horizontal}
    override fun onTouchEvent(e:MotionEvent):Boolean {
        track(e)
        if(e.actionMasked==MotionEvent.ACTION_UP){
            val dx=e.x-x;val dy=abs(e.y-y)
            val accepted=!cancelled && horizontal && abs(dx)>=maxOf(slop*3f,48*resources.displayMetrics.density) && abs(dx)>dy*1.5f
            parent?.requestDisallowInterceptTouchEvent(false);horizontal=false
            if(accepted)swipe(dx<0)else performClick()
        }
        return true
    }
    override fun performClick():Boolean=true // Touch container has no tap action or click announcement.
    private var pendingTransition:Pair<View,Boolean>?=null
    fun transitioning()=childCount>1 || pendingTransition!=null
    fun transitionFrom(old:View?,forward:Boolean){
        if(old==null || !ValueAnimator.areAnimatorsEnabled())return
        old.importantForAccessibility=IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        old.isEnabled=false;old.isClickable=false
        val oldHeight=old.layoutParams?.height?.takeIf{it>0} ?: old.height
        addView(old,0,LayoutParams(LayoutParams.MATCH_PARENT,oldHeight.coerceAtLeast(1)))
        pendingTransition=old to forward
    }
    override fun onLayout(changed:Boolean,l:Int,t:Int,r:Int,b:Int){
        super.onLayout(changed,l,t,r,b)
        val pending=pendingTransition ?: return
        pendingTransition=null
        val old=pending.first;val incoming=getChildAt(childCount-1) ?: return
        val distance=width.toFloat()*(if(pending.second)1 else -1)
        // Layout precedes every pre-draw observer, regardless of attachment/observer merge order.
        incoming.translationX=distance;old.translationX=0f
        old.animate().translationX(-distance).setDuration(260).setInterpolator(DecelerateInterpolator()).start()
        incoming.animate().translationX(0f).setDuration(260).setInterpolator(DecelerateInterpolator()).withEndAction{
            if(old.parent===this)removeView(old)
        }.start()
    }
    override fun onDetachedFromWindow(){
        pendingTransition=null
        for(i in 0 until childCount)getChildAt(i).let{it.animate().setListener(null).withEndAction(null).cancel();it.translationX=0f}
        while(childCount>1)removeViewAt(0)
        super.onDetachedFromWindow()
    }
}
