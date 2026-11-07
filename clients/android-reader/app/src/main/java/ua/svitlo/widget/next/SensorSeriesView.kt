package ua.svitlo.widget.next

import android.content.Context
import android.graphics.*
import android.view.*
import org.json.JSONObject
import java.time.*
import kotlin.math.*

/** UI253 line-series chart. A point is never stretched into an observed interval. */
internal class SensorSeriesView(c:Context,val date:LocalDate,private val prediction:Boolean):View(c){
    private val u=NextUi(c);private val paint=Paint(Paint.ANTI_ALIAS_FLAG)
    var observation:JSONObject?=null;set(value){field=value;invalidate()}
    var zoom=1f;var offset=0f;var changed:((Float,Float)->Unit)?=null
    private val start=date.atStartOfDay(NEXT_ZONE).toInstant();private val end=date.plusDays(1).atStartOfDay(NEXT_ZONE).toInstant()
    private val length=Duration.between(start,end).toMillis().toFloat()
    private val scale=ScaleGestureDetector(c,object:ScaleGestureDetector.SimpleOnScaleGestureListener(){override fun onScale(d:ScaleGestureDetector):Boolean{val old=zoom;zoom=(zoom*d.scaleFactor).coerceIn(1f,length/3600000f);offset=(offset+(1/old-1/zoom)*(d.focusX/width)).coerceIn(0f,1-1/zoom);updated();return true}})
    private val gestures=GestureDetector(c,object:GestureDetector.SimpleOnGestureListener(){override fun onDown(e:MotionEvent)=true;override fun onScroll(a:MotionEvent?,b:MotionEvent,dx:Float,dy:Float):Boolean{if(!scale.isInProgress){offset=(offset+dx/width/zoom).coerceIn(0f,1-1/zoom);updated()};return true}})
    init{isFocusable=true;contentDescription=if(prediction)"Прогноз. Орієнтовний стан, не вимір"else"Історія вимірів. Підтверджені інтервали та невідомі проміжки окремо"}
    private fun updated(){changed?.invoke(zoom,offset);invalidate()}
    override fun onMeasure(w:Int,h:Int){setMeasuredDimension(resolveSize(u.dp(300),w),resolveSize(u.dp(if(resources.configuration.orientation==android.content.res.Configuration.ORIENTATION_LANDSCAPE)110 else 150),h))}
    override fun onTouchEvent(e:MotionEvent):Boolean{parent?.requestDisallowInterceptTouchEvent(true);scale.onTouchEvent(e);gestures.onTouchEvent(e);if(e.actionMasked==MotionEvent.ACTION_UP||e.actionMasked==MotionEvent.ACTION_CANCEL)parent?.requestDisallowInterceptTouchEvent(false);return true}
    override fun onKeyDown(keyCode:Int,event:KeyEvent):Boolean{when(keyCode){KeyEvent.KEYCODE_PLUS,KeyEvent.KEYCODE_EQUALS->zoom=(zoom*1.5f).coerceAtMost(length/3600000f);KeyEvent.KEYCODE_MINUS->zoom=(zoom/1.5f).coerceAtLeast(1f);KeyEvent.KEYCODE_DPAD_LEFT->offset=(offset-.1f/zoom).coerceAtLeast(0f);KeyEvent.KEYCODE_DPAD_RIGHT->offset=(offset+.1f/zoom).coerceAtMost(1-1/zoom);else->return super.onKeyDown(keyCode,event)};offset=offset.coerceIn(0f,1-1/zoom);updated();return true}
    override fun onDraw(canvas:Canvas){
        val textSize=minOf(u.dp(16).toFloat(),u.dp(11).toFloat()*resources.configuration.fontScale)
        paint.textSize=textSize
        val left=paint.measureText("Немає")+u.dp(8);val right=width-u.dp(3).toFloat();val top=maxOf(u.dp(8).toFloat(),-paint.ascent());val bottom=maxOf(top+u.dp(20),height-textSize-u.dp(12));val w=(right-left).coerceAtLeast(1f)
        fun x(at:Instant)=left+((Duration.between(start,at).toMillis()/length-offset)*zoom)*w
        paint.style=Paint.Style.FILL;paint.color=u.p.background;canvas.drawRoundRect(RectF(left,top,right,bottom),u.dp(4).toFloat(),u.dp(4).toFloat(),paint)
        paint.textSize=textSize;paint.textAlign=Paint.Align.LEFT;paint.color=u.p.muted
        canvas.drawText("Є",0f,top-paint.ascent()/2,paint);canvas.drawText("Немає",0f,bottom,paint)
        paint.style=Paint.Style.STROKE;paint.strokeWidth=u.dp(1).toFloat();paint.color=u.p.track
        for(y in listOf(top,bottom))canvas.drawLine(left,y,right,y,paint)
        val save=canvas.save();canvas.clipRect(left,top-u.dp(3),right,bottom+u.dp(3))
        paint.color=u.p.muted;paint.alpha=35;paint.strokeWidth=u.dp(2).toFloat()
        var hatch=left-(bottom-top);while(hatch<right){canvas.drawLine(hatch,bottom,hatch+(bottom-top),top,paint);hatch+=u.dp(10)};paint.alpha=255
        var previousEnd:Instant?=null;var previousY=0f
        val intervals=observation?.optJSONArray("intervals")?.objects().orEmpty()
        for(row in intervals){
            val a=runCatching{wireInstant(row.getString("start"))}.getOrNull() ?:continue;val b=runCatching{wireInstant(row.getString("end"))}.getOrNull() ?:continue
            val state=row.optString("powerState");if(state!in setOf("on","off")||a>=b)continue
            val xa=x(a);val xb=x(b);val y=if(state=="on")top else bottom
            paint.style=Paint.Style.FILL;paint.color=u.p.background;canvas.drawRect(xa,top,xb,bottom,paint)
            paint.style=Paint.Style.STROKE;paint.strokeWidth=u.dp(3).toFloat();paint.color=if(state=="on")u.p.accent else if(prediction)u.p.hourly else u.p.emergency
            paint.pathEffect=if(prediction)DashPathEffect(floatArrayOf(u.dp(6).toFloat(),u.dp(4).toFloat()),0f)else null
            if(previousEnd==a)canvas.drawLine(xa,previousY,xa,y,paint)
            canvas.drawLine(xa,y,xb,y,paint);previousEnd=b;previousY=y
        }
        paint.pathEffect=null
        if(!prediction)for(point in observation?.optJSONArray("points")?.objects().orEmpty()){
            val at=runCatching{wireInstant(point.getString("at"))}.getOrNull() ?:continue;val state=point.optString("powerState");if(at<start||at>=end||state !in setOf("on","off"))continue
            paint.style=Paint.Style.FILL;paint.color=if(state=="on")u.p.accent else u.p.emergency;canvas.drawCircle(x(at),if(state=="on")top else bottom,u.dp(3).toFloat(),paint)
        }
        canvas.restoreToCount(save);paint.style=Paint.Style.FILL;paint.color=u.p.muted;paint.textSize=textSize;paint.textAlign=Paint.Align.CENTER
        val ticks=if(w<paint.measureText("00:00")*5.2f)2 else 4
        for(i in 0..ticks){val fraction=offset+i.toFloat()/ticks/zoom;val at=start.plusMillis((fraction*length).toLong());val label=if(at>=end)"24:00"else clock(at);val half=paint.measureText(label)/2;canvas.drawText(label,(left+i*w/ticks).coerceIn(half,width-half),height-u.dp(3).toFloat(),paint)}
    }
}
