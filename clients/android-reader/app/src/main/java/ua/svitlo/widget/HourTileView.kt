package ua.svitlo.widget

import android.content.Context
import android.graphics.*
import android.util.TypedValue
import android.widget.TextView
import ua.svitlo.widget.core.*
import java.time.Duration
import java.time.Instant

/** Informational visual projection, independent of precise timers and totals. */
class HourTileView(context:Context,val hour:HourTile,private val now:Instant,private val palette:Palette):TextView(context) {
    private val paint=Paint(Paint.ANTI_ALIAS_FLAG)
    private val twoRows=AppAppearance.twoRows(context)
    private val bulbs=AppAppearance.bulbs(context)
    private val density=resources.displayMetrics.density
    private val scale=resources.configuration.fontScale.coerceAtLeast(1f)
    private fun dp(n:Float)=n*density
    private val fontPx get()=TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP,14f,resources.displayMetrics).coerceAtMost(dp(24f))
    init {
        tag="hour_tile_${hour.start}";text="";typeface=Typeface.create("sans-serif-medium",Typeface.NORMAL)
        background=null;setPadding(0,0,0,0);minimumWidth=0;minWidth=0
        minHeight=dp(52f*scale).toInt();isFocusable=true;isClickable=false;isLongClickable=false
        importantForAccessibility=IMPORTANT_FOR_ACCESSIBILITY_YES
        contentDescription=hour.label+(if(hour.clockChange)", зміна часу. "else". ")+hour.segments.mapIndexed{index,part->
            (if(hour.clockChange)"Частина ${index+1} з 4, "else"")+"${DisplaySchedule.clock(part.start)}–${DisplaySchedule.clock(part.end)}: "+
            (part.kind?.let{if(it==OutageKind.HOURLY)"погодинне відключення"else it.label} ?: part.category?.let{if(it==Category.SCHEDULE)"погодинне відключення"else it.label+" відключення"} ?: if(part.uncertain)"дані невідомі"else"відключень не заплановано")+
            if(part.uncertain && part.category!=null)"; потребує перевірки"else""
        }.joinToString("; ")+". Плитки округлено до 30 хвилин"
    }
    override fun getAccessibilityClassName():CharSequence="android.widget.TextView"
    override fun onMeasure(w:Int,h:Int){setMeasuredDimension(resolveSize(dp(100f).toInt(),w),resolveSize(dp(52f*scale).toInt(),h))}
    override fun onDraw(canvas:Canvas){
        val save=canvas.save();canvas.clipPath(Path().apply{addRoundRect(RectF(0f,0f,width.toFloat(),height.toFloat()),dp(13f),dp(13f),Path.Direction.CW)})
        val parts=hour.segments.ifEmpty{listOf(TimelineSegment(hour.start,hour.end,null,true))}
        val duration=Duration.between(hour.start,hour.end).toMillis().toFloat()
        fun bounds(p:TimelineSegment):RectF {
            val a=Duration.between(hour.start,p.start).toMillis()/duration;val b=Duration.between(hour.start,p.end).toMillis()/duration
            return if(twoRows)RectF(0f,a*height,width.toFloat(),b*height)else RectF(a*width,0f,b*width,height.toFloat())
        }
        fun ink(p:TimelineSegment)=if(p.category!=null)palette.outageInk(p.category,p.kind)else palette.ink
        for(part in parts){
            val rect=bounds(part);paint.style=Paint.Style.FILL;paint.color=if(part.category!=null)palette.outage(part.category,part.kind) else if(part.uncertain)palette.track else palette.background
            canvas.drawRect(rect,paint)
            if(part.uncertain){val s=canvas.save();canvas.clipRect(rect);paint.color=palette.muted;paint.alpha=90;paint.strokeWidth=dp(1f)
                var x=rect.left-height;while(x<rect.right){canvas.drawLine(x,height.toFloat(),x+height,0f,paint);x+=dp(8f)};paint.alpha=255;canvas.restoreToCount(s)}
        }
        val uniform=parts.map{Triple(it.category,it.kind,it.uncertain)}.distinct().size==1
        val labels=DisplaySchedule.labels(hour)
        paint.textSize=fontPx
        val textWidth=maxOf(paint.measureText(labels.first),paint.measureText(labels.second))
        val iconSize=dp(14f)*minOf(scale,2f);val gap=dp(4f);val total=textWidth+iconSize+gap
        val iconX=(width-total)/2+iconSize/2;val textX=(width-total)/2+iconSize+gap+textWidth/2
        fun time(value:String,cy:Float,color:Int){paint.typeface=typeface;paint.textSize=fontPx;paint.color=color;paint.style=Paint.Style.FILL;paint.textAlign=Paint.Align.CENTER
            canvas.drawText(value,textX,cy-(paint.ascent()+paint.descent())/2,paint)}
        if(hour.clockChange && !uniform){
            parts.forEach{p->val b=bounds(p);icon(canvas,if(twoRows)dp(12f)else b.centerX(),if(twoRows)b.centerY()else dp(10f),iconSize*.55f,p,ink(p))}
            paint.color=palette.background;paint.style=Paint.Style.FILL
            canvas.drawRoundRect(RectF(textX-textWidth/2-dp(3f),if(twoRows)dp(4f)else height*.29f,textX+textWidth/2+dp(3f),height-dp(4f)),dp(4f),dp(4f),paint)
            time(labels.first,if(twoRows)height*.30f else height*.45f,palette.ink)
            if(twoRows)time(labels.second,height*.77f,palette.ink)
        }else if(twoRows && !uniform){
            time(labels.first,height*.25f,ink(parts.first()));time(labels.second,height*.75f,ink(parts.last()))
            parts.forEach{p->if(p.category!=null || p.uncertain)icon(canvas,iconX,bounds(p).centerY(),iconSize,p,ink(p))}
        }else{
            for(part in parts){val s=canvas.save();canvas.clipRect(bounds(part))
                if(twoRows){time(labels.first,height*.31f,ink(part));time(labels.second,height*.73f,ink(part))}else time(hour.label,height*.5f,ink(part))
                icon(canvas,iconX,if(hour.clockChange && twoRows)height*.31f else height*.5f,iconSize,parts.firstOrNull{it.category!=null} ?: part,ink(part));canvas.restoreToCount(s)
            }
        }
        if(hour.clockChange){paint.typeface=Typeface.DEFAULT;paint.textSize=minOf(dp(9f)*scale,dp(12f));paint.color=palette.muted;paint.style=Paint.Style.FILL;paint.textAlign=Paint.Align.CENTER
            val cy=if(twoRows)height*.49f else height*.78f
            canvas.drawText("зміна часу",textX,cy-(paint.ascent()+paint.descent())/2,paint)}
        canvas.restoreToCount(save)
        if(now>=hour.start && now<hour.end){paint.color=palette.accent;paint.style=Paint.Style.STROKE;paint.strokeWidth=dp(2f)
            canvas.drawRoundRect(RectF(dp(1f),dp(1f),width-dp(1f),height-dp(1f)),dp(13f),dp(13f),paint);paint.style=Paint.Style.FILL}
    }
    private fun icon(canvas:Canvas,cx:Float,cy:Float,size:Float,p:TimelineSegment,color:Int){
        paint.color=if(p.category!=null)palette.outageIcon else color;paint.alpha=255;paint.strokeWidth=dp(1.3f);paint.strokeJoin=Paint.Join.ROUND;paint.strokeCap=Paint.Cap.ROUND
        if(p.category==null && p.uncertain){paint.style=Paint.Style.FILL;paint.textAlign=Paint.Align.CENTER;paint.textSize=size;canvas.drawText("?",cx,cy-(paint.ascent()+paint.descent())/2,paint);return}
        val saved=canvas.save();canvas.translate(cx,cy);canvas.scale(size/dp(14f),size/dp(14f));val off=p.category!=null
        if(bulbs){paint.style=if(off)Paint.Style.STROKE else Paint.Style.FILL;canvas.drawCircle(0f,-dp(1f),dp(4f),paint)
            paint.style=Paint.Style.STROKE;canvas.drawLine(-dp(2f),dp(4f),dp(2f),dp(4f),paint);canvas.drawLine(-dp(1.5f),dp(6f),dp(1.5f),dp(6f),paint)
            if(!off)for(a in listOf(-150.0,-90.0,-30.0,30.0,150.0)){val r=Math.toRadians(a);canvas.drawLine((kotlin.math.cos(r)*dp(6f)).toFloat(),(kotlin.math.sin(r)*dp(6f)-dp(1f)).toFloat(),(kotlin.math.cos(r)*dp(7.5f)).toFloat(),(kotlin.math.sin(r)*dp(7.5f)-dp(1f)).toFloat(),paint)}
        }else{val bolt=Path().apply{moveTo(dp(2f),-dp(7f));lineTo(-dp(4f),dp(1f));lineTo(0f,dp(1f));lineTo(-dp(2f),dp(7f));lineTo(dp(4f),-dp(1f));lineTo(0f,-dp(1f));close()}
            paint.style=if(off)Paint.Style.STROKE else Paint.Style.FILL;canvas.drawPath(bolt,paint)
            if(off){paint.style=Paint.Style.STROKE;canvas.drawLine(-dp(5.5f),-dp(6f),dp(5.5f),dp(6f),paint)}}
        canvas.restoreToCount(saved);paint.style=Paint.Style.FILL
    }
    companion object {
        fun columns(context:Context,availableWidthPx:Int):Int {
            val m=context.resources.displayMetrics;val scale=context.resources.configuration.fontScale
            val p=Paint().apply{textSize=TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP,14f,m).coerceAtMost(24*m.density)}
            val min=p.measureText("24:00")+14*m.density*minOf(scale,2f)+22*m.density
            val preferred=if(context.resources.configuration.screenWidthDp>=600)6 else 4
            return (2..preferred).lastOrNull{availableWidthPx/it>=min} ?: 2
        }
    }
}
