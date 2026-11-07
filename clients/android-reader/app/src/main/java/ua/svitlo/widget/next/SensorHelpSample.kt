package ua.svitlo.widget.next

import android.content.Context
import android.graphics.*
import android.view.View

/** UI245 r2 / UI253: instructional marks, not simulated device evidence. */
internal class SensorHelpSample(c:Context,private val mode:String):View(c){
    private val u=NextUi(c);private val paint=Paint(Paint.ANTI_ALIAS_FLAG)
    init{importantForAccessibility=IMPORTANT_FOR_ACCESSIBILITY_NO}
    override fun onDraw(canvas:Canvas){val r=RectF(u.dp(1).toFloat(),u.dp(1).toFloat(),width-u.dp(1).toFloat(),height-u.dp(1).toFloat());val radius=u.dp(if(mode=="current")11 else 6).toFloat();paint.style=Paint.Style.FILL;paint.color=u.p.background
        if(mode=="prediction"){paint.style=Paint.Style.STROKE;paint.strokeWidth=u.dp(3).toFloat();paint.pathEffect=DashPathEffect(floatArrayOf(u.dp(6).toFloat(),u.dp(4).toFloat()),0f);paint.color=u.p.hourly;canvas.drawLine(0f,height/2f,width.toFloat(),height/2f,paint);paint.pathEffect=null;return}
        val save=canvas.save();canvas.clipPath(Path().apply{addRoundRect(r,radius,radius,Path.Direction.CW)});canvas.drawRect(r,paint)
        when(mode){
            "plan"->{paint.color=u.p.hourly;canvas.drawRect(r.left,r.centerY(),r.right,r.bottom,paint)}
            "actual"->{paint.color=u.p.accent;canvas.drawRect(0f,0f,width/2f,height.toFloat(),paint);paint.color=u.p.emergency;canvas.drawRect(width/2f,0f,width.toFloat(),height.toFloat(),paint)}
            "unknown"->{paint.color=u.p.track;paint.strokeWidth=u.dp(2).toFloat();var x=-height.toFloat();while(x<width){canvas.drawLine(x,height.toFloat(),x+height,0f,paint);x+=u.dp(5)}}
        };canvas.restoreToCount(save)
        if(mode=="actual")return
        paint.style=Paint.Style.STROKE;paint.color=if(mode=="current")u.p.muted else u.p.track;paint.strokeWidth=u.dp(if(mode=="current")2 else 1).toFloat();paint.pathEffect=if(mode=="current")DashPathEffect(floatArrayOf(u.dp(4).toFloat(),u.dp(3).toFloat()),0f)else null;canvas.drawRoundRect(r,radius,radius,paint);paint.pathEffect=null
        if(mode=="current"){val clip=canvas.save();canvas.clipRect(0f,0f,width.toFloat(),height/2f);paint.color=Color.rgb(91,158,91);canvas.drawRoundRect(r,radius,radius,paint);canvas.restoreToCount(clip);paint.style=Paint.Style.FILL;canvas.drawCircle(width-u.dp(8).toFloat(),u.dp(8).toFloat(),u.dp(3).toFloat(),paint)}
    }
}
