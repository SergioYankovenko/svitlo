package ua.svitlo.widget

import android.content.Context
import android.content.res.Configuration
import android.graphics.*
import ua.svitlo.widget.core.*
import java.time.*
import java.time.format.DateTimeFormatter

data class Palette(val background:Int, val surface:Int, val ink:Int, val muted:Int, val track:Int, val accent:Int, val hourly:Int, val planned:Int, val emergency:Int,
    val unplanned:Int = Color.rgb(120,87,159)) {
    fun category(category: Category?) = when(category) { Category.SCHEDULE -> hourly; Category.PLANNED -> planned; Category.EMERGENCY -> emergency; null -> track }
    fun outage(category:Category?,kind:OutageKind?) = if(category==Category.PLANNED && kind==OutageKind.UNPLANNED)unplanned else category(category)
    val outageIcon:Int get()=Color.rgb(20,37,30)
    fun outageInk(category:Category?,kind:OutageKind?) = if(category==Category.PLANNED && kind==OutageKind.UNPLANNED)Color.rgb(240,243,232) else outageIcon
    companion object {
        fun app(context:Context):Palette = if(!AppAppearance.light(context))app() else
            listOf("EFF5EC","FFFFFF","20382C","52654F","D8E5D1","416B2A","D9A746","B3A1D8","DF8272")
                .map { Color.parseColor("#$it") }.let { Palette(it[0],it[1],it[2],it[3],it[4],it[5],it[6],it[7],it[8],Color.rgb(125,93,166)) }
        fun app(): Palette = listOf("14251E","20382C","F0F3E8","BCC9BD","43594C","C1D99A","D9A746","AD9CD1","DF8272")
            .map { Color.parseColor("#$it") }.let { Palette(it[0],it[1],it[2],it[3],it[4],it[5],it[6],it[7],it[8]) }
        fun of(context: Context): Palette {
            val dark = context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
            val colors = if(dark) listOf("18241e","22352b","f0f4eb","b7c9bc","425346","c4e3ad","e2b15f","b6a6d3","ee8a75")
            else listOf("f3f4ee","fffffc","1b3024","5c6d61","e4e9df","245b3c","ca8b37","8279aa","c75f4f")
            return colors.map { Color.parseColor("#$it") }.let { Palette(it[0],it[1],it[2],it[3],it[4],it[5],it[6],it[7],it[8],if(dark)Color.rgb(120,87,159)else Color.rgb(113,81,151)) }
        }
    }
}

object ChartPainter {
    fun draw(width:Int, date:LocalDate, snapshot:Snapshot, now:Instant, colors:Palette, condensed:Boolean=false,
        height:Int?=null, pixelsPerDp:Float=2f,unpublishedLabel:Boolean=false,powerColor:Int=colors.track,showDate:Boolean=true): Bitmap {
        val w = if(height==null)width.coerceIn(240,1000) else width.coerceAtLeast(1)
        val h = height?.coerceAtLeast(1) ?: if(condensed)64 else 104
        val unit=pixelsPerDp.coerceAtLeast(0.01f)
        val bitmap = Bitmap.createBitmap(w,h,Bitmap.Config.ARGB_8888)
        val c = Canvas(bitmap)
        val p = Paint(Paint.ANTI_ALIAS_FLAG)
        p.color=colors.muted; p.textSize=(if(condensed)9f else 11f)*unit; p.typeface=Typeface.create("sans-serif-medium",Typeface.NORMAL)
        val today=now.atZone(KYIV_ZONE).toLocalDate()
        val title=when(date){today->"Сьогодні";today.plusDays(1)->"Завтра";else->date.format(DateTimeFormatter.ofPattern("dd.MM"))}
        val titleText="$title · ${date.format(DateTimeFormatter.ofPattern("dd.MM"))}"
        if(showDate && p.measureText(titleText)<=w)c.drawText(titleText,0f,(if(condensed)9f else 11f)*unit,p)
        val bins=Timeline.bins(date,snapshot,now)
        val top=(if(showDate){if(condensed)12f else 17f}else 3f)*unit
        val bottom=(h-(if(condensed)12.5f else 18.5f)*unit).coerceAtLeast(top+unit)
        val bandClip=c.save()
        c.clipPath(Path().apply{addRoundRect(RectF(0f,top,w.toFloat(),bottom),5*unit,5*unit,Path.Direction.CW)})
        // Subpixel bins must not leave translucent seams when the bitmap budget
        // makes an individual five-minute cell narrower than one physical pixel.
        p.isAntiAlias=false;p.color=colors.track;c.drawRect(0f,top,w.toFloat(),bottom,p)
        bins.forEachIndexed { i,b ->
            val left=i.toFloat()*w/bins.size; val right=(i+1f)*w/bins.size
            p.color=if(b.category==null && !b.uncertain)powerColor else colors.outage(b.category,b.kind); c.drawRect(left,top,right+0.3f,bottom,p)
        }
        p.isAntiAlias=true
        // Diagonal marks denote uncertain data, rather than claiming supply is present.
        p.color=colors.muted; p.alpha=90; p.strokeWidth=0.8f*unit
        var index=0
        while(index<bins.size){
            if(!bins[index].uncertain){index++;continue}
            val first=index
            while(index<bins.size && bins[index].uncertain)index++
            val left=first.toFloat()*w/bins.size;val right=index.toFloat()*w/bins.size
            val saved=c.save();c.clipRect(left,top,right,bottom)
            val rise=bottom-top
            var x=left-rise
            while(x<right){c.drawLine(x,bottom,x+rise,top,p);x+=5f*unit}
            c.restoreToCount(saved)
        }
        c.restoreToCount(bandClip)
        p.alpha=255; p.textSize=(if(condensed)8f else 9.5f)*unit; p.typeface=Typeface.DEFAULT
        val from=date.atStartOfDay(KYIV_ZONE).toInstant(); val until=date.plusDays(1).atStartOfDay(KYIV_ZONE).toInstant()
        val seconds=Duration.between(from,until).seconds.toFloat()
        var previousLabelEnd = -1f
        for(tick in TimelineViewport(date).ticks()) {
            val x=Duration.between(from,tick.at).seconds/seconds*w
            p.color=colors.muted;p.strokeWidth=(if(tick.major)0.85f else 0.5f)*unit
            p.alpha=if(tick.major)40 else 22
            c.drawLine(x,top,x,bottom,p)
            p.alpha=255
            c.drawLine(x,bottom+0.5f*unit,x,bottom+(if(tick.major)3f else 2f)*unit,p)
            val label=tick.label ?: continue
            val labelWidth=p.measureText(label)
            if(labelWidth>w)continue
            val left=(x-labelWidth/2).coerceIn(0f,(w-labelWidth).coerceAtLeast(0f))
            if(left>=previousLabelEnd+2f*unit || tick.at==from){
                p.textAlign=Paint.Align.LEFT
                c.drawText(label,left,h-(if(condensed)2.5f else 5f)*unit,p)
                previousLabelEnd=left+labelWidth
            }
        }
        if(now>=from && now<until){
            val x=Duration.between(from,now).seconds/seconds*w
            p.color=colors.ink;p.strokeWidth=1.5f*unit;c.drawLine(x,top-2f*unit,x,bottom+2f*unit,p)
        }
        if(unpublishedLabel){
            // Keep the neutral chart area but replace its implication with the actual publication state.
            p.color=colors.track;c.drawRect(0f,top,w.toFloat(),bottom,p)
            p.color=colors.muted;p.textAlign=Paint.Align.CENTER;p.textSize=12f*unit
            val label="Графік не сформовано"
            if(p.measureText(label)>w-8*unit)p.textSize*=((w-8*unit)/p.measureText(label)).coerceAtLeast(0.1f)
            c.drawText(label,w/2f,(top+bottom)/2f-(p.ascent()+p.descent())/2f,p)
        }
        return bitmap
    }
}

object WeatherDisplay {
    fun icon(code:Int, day:Boolean=true):String=when(code){0->if(day) "☀" else "☾";1,2->"⛅";3->"☁";45,48->"≋";71,73,75,77,85,86->"❄";95,96,99->"ϟ";else->"☂"}
    fun description(code:Int):String=when(code){0->"Ясно";1,2->"Мінлива хмарність";3->"Хмарно";45,48->"Туман";51,53,55,56,57->"Мряка";61,63,65,66,67,80,81,82->"Дощ";71,73,75,77,85,86->"Сніг";95,96,99->"Гроза";else->"Погода"}
    fun temperature(value:Double):String = "${if(value>0) "+" else ""}${kotlin.math.round(value).toInt()}°"
}
