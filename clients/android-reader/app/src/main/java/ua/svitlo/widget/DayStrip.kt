package ua.svitlo.widget

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint

internal class DayStrip(context:Context,private val colors:Palette,private val from:Float?):MatchingLabelRow(context,true) {
    private val paint=Paint(Paint.ANTI_ALIAS_FLAG)
    private var center=0f;private var animation:ValueAnimator?=null;private var ready=false
    fun fraction():Float=if(width>0)center/width else 0f
    override fun onLayout(changed:Boolean,l:Int,t:Int,r:Int,b:Int){
        super.onLayout(changed,l,t,r,b)
        val selected=(0 until childCount).map{getChildAt(it)}.firstOrNull{it.isSelected} ?: return
        val target=(selected.left+selected.right)/2f
        if(!ready){ready=true
            if(from!=null && ValueAnimator.areAnimatorsEnabled()){
                center=from*width
                animation=ValueAnimator.ofFloat(center,target).apply{duration=260;interpolator=android.view.animation.DecelerateInterpolator();addUpdateListener{center=it.animatedValue as Float;invalidate()};start()}
            }else center=target
        }
    }
    override fun dispatchDraw(canvas:Canvas){super.dispatchDraw(canvas)
        val d=resources.displayMetrics.density;paint.color=colors.accent
        canvas.drawRoundRect(center-12*d,height-12*d,center+12*d,height-8*d,2*d,2*d,paint)
    }
    override fun onDetachedFromWindow(){animation?.cancel();super.onDetachedFromWindow()}
}
