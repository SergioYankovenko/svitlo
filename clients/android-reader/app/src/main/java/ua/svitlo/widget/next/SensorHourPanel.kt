package ua.svitlo.widget.next

import android.app.AlertDialog
import android.content.Context
import android.graphics.*
import android.view.*
import android.widget.*
import org.json.JSONObject
import ua.svitlo.widget.*
import java.time.*

internal data class HourFact(val start:Instant,val end:Instant,val state:String)
/** device-ui-policy.js timeline, using real instants so the merged autumn hour stays two hours. */
internal object SensorHourPolicy {
    fun facts(start:Instant,end:Instant,now:Instant,observed:List<HourFact>):List<HourFact>{
        require(start<end);val limit=maxOf(start,minOf(now,end));var cursor=start;val out=mutableListOf<HourFact>()
        fun add(a:Instant,b:Instant,state:String){if(a>=b)return;val last=out.lastOrNull();if(last?.end==a&&last.state==state)out[out.lastIndex]=last.copy(end=b)else out+=HourFact(a,b,state)}
        for(row in observed){val from=maxOf(cursor,start,row.start);val to=minOf(end,limit,row.end);if(to<=from||row.state !in setOf("on","off"))continue;if(from>cursor)add(cursor,from,"unknown");add(from,to,row.state);cursor=to}
        if(cursor<limit)add(cursor,limit,"unknown");if(limit<end)add(limit,end,"future");return out
    }
    fun transition(start:Instant,end:Instant,now:Instant,rows:List<HourFact>):HourFact?=rows.zipWithNext().lastOrNull{(a,b)->a.end==b.start&&a.state!=b.state&&a.state in setOf("on","off")&&b.state in setOf("on","off")&&b.start>=start&&b.start<end&&b.start<=now}?.second
}
internal object SensorHourPanel {
    fun show(c:Context,profile:NextProfile,hour:DisplayHour,observation:JSONObject?,more:()->Unit){
        val u=NextUi(c);val now=Instant.now();val observed=observation?.optJSONArray("intervals")?.objects()?.map{HourFact(wireInstant(it.getString("start")),wireInstant(it.getString("end")),it.getString("powerState"))}.orEmpty()
        val facts=SensorHourPolicy.facts(hour.start,hour.end,now,observed)
        val transition=SensorHourPolicy.transition(hour.start,hour.end,now,observed)
        val title="Деталі за год"+(transition?.let{" · ${if(it.state=="on")"Увімкнули"else"Вимкнули"} о ${clock(it.start)}"} ?:"")
        val panel=AppDialogPanel(c,title,prefix="sensor_hour");val col=u.column()
        val inline=panel.button("Детальніше","sensor_hour_more").apply{gravity=Gravity.END;minHeight=u.dp(48);setOnClickListener{more()}}
        inline.textSize=12f;panel.header.removeView(panel.heading)
        val titleRow=LinearLayout(c).apply{orientation=LinearLayout.HORIZONTAL;gravity=Gravity.CENTER_VERTICAL}
        titleRow.addView(panel.heading,LinearLayout.LayoutParams(0,-2,1f));titleRow.addView(inline,LinearLayout.LayoutParams(-2,-2));panel.header.addView(titleRow,0,LinearLayout.LayoutParams(-1,-2))
        val band=HourBand(c,hour,facts,now);u.add(col,band,0)
        fun label(state:String)=when(state){"on"->"Світло є";"off"->"Світла немає";"future"->"Вимірів ще немає";else->"Немає вимірів"}
        for(f in facts){val row=LinearLayout(c).apply{orientation=LinearLayout.HORIZONTAL;gravity=Gravity.CENTER_VERTICAL;minimumHeight=u.dp(40)}
            row.addView(u.text(clock(f.start)+"–"+clock(f.end),13f,u.p.muted),LinearLayout.LayoutParams(0,-2,1f))
            row.addView(object:View(c){override fun onDraw(canvas:Canvas){if(f.state=="on"||f.state=="off")PowerGlyph.draw(canvas,width/2f,height/2f,u.dp(16).toFloat(),if(f.state=="off")u.p.emergency else u.p.accent,f.state=="off",AppAppearance.bulbs(c))else{val p=Paint(Paint.ANTI_ALIAS_FLAG).apply{color=u.p.muted;style=Paint.Style.STROKE;strokeWidth=u.dp(1).toFloat()};canvas.drawCircle(width/2f,height/2f,u.dp(6).toFloat(),p);canvas.drawLine(width/2f,height/2f,width/2f,height/2f-u.dp(4),p)}}},LinearLayout.LayoutParams(u.dp(24),u.dp(24)))
            row.addView(u.text(label(f.state),13f,when(f.state){"on"->u.p.accent;"off"->u.p.emergency;else->u.p.muted}),LinearLayout.LayoutParams(0,-2,1.4f));u.add(col,row,6)
        }
        panel.setBody(col);lateinit var dialog:AlertDialog
        inline.setOnClickListener{dialog.dismiss();more()}
        panel.footer(listOf(panel.button("Зрозуміло","sensor_hour_close").apply{gravity=Gravity.CENTER;setOnClickListener{dialog.dismiss()}}))
        dialog=panel.show();dialog.setCanceledOnTouchOutside(true)
    }
    private class HourBand(c:Context,val hour:DisplayHour,val facts:List<HourFact>,val now:Instant):View(c){
        val u=NextUi(c);val p=Paint(Paint.ANTI_ALIAS_FLAG)
        init{contentDescription="${clock(hour.start)}–${clock(hour.end)}. За графіком: "+hour.parts.joinToString("; "){clock(it.start)+"–"+clock(it.end)+": "+if(it.unknown)"Стан за графіком невідомий"else it.kind?.title ?:"Світло є"};isFocusable=true}
        override fun onMeasure(w:Int,h:Int){setMeasuredDimension(resolveSize(u.dp(300),w),resolveSize(u.dp(134),h))}
        override fun onDraw(c:Canvas){val span=Duration.between(hour.start,hour.end).toMillis().toDouble();fun x(t:Instant)=(Duration.between(hour.start,t).toMillis()/span*width).toFloat()
            fun area(a:Instant,b:Instant,top:Float,bottom:Float,color:Int,unknown:Boolean){p.style=Paint.Style.FILL;p.color=color;c.drawRect(x(a),top,x(b),bottom,p);if(unknown){val save=c.save();c.clipRect(x(a),top,x(b),bottom);p.color=u.p.muted;p.alpha=70;p.strokeWidth=u.dp(1).toFloat();var from=x(a)-(bottom-top);while(from<x(b)){c.drawLine(from,bottom,from+bottom-top,top,p);from+=u.dp(7)};c.restoreToCount(save);p.alpha=255}}
            val top=u.dp(25).toFloat();val middle=u.dp(67).toFloat();val bottom=u.dp(109).toFloat()
            for(part in hour.parts)area(part.start,part.end,top,middle,if(part.unknown)u.p.track else when(part.kind){null->u.p.background;Kind.HOURLY->u.p.hourly;Kind.PLANNED->u.p.planned;Kind.UNPLANNED->u.p.unplanned;Kind.EMERGENCY->u.p.emergency},part.unknown)
            for(f in facts)area(f.start,f.end,middle,bottom,when(f.state){"on"->Color.rgb(82,109,76);"off"->u.p.emergency;else->u.p.track},f.state !in setOf("on","off"))
            p.style=Paint.Style.FILL;p.typeface=Typeface.create("sans-serif-medium",Typeface.NORMAL);p.textSize=u.dp(12).toFloat();p.color=u.p.ink;p.textAlign=Paint.Align.CENTER;c.drawText("За графіком",width/2f,top+u.dp(25),p);c.drawText("За датчиком",width/2f,middle+u.dp(25),p)
            p.color=u.p.muted;p.textSize=u.dp(11).toFloat();p.textAlign=Paint.Align.LEFT;c.drawText(clock(hour.start),0f,height.toFloat()-u.dp(3),p);p.textAlign=Paint.Align.RIGHT;c.drawText(if(hour.end.atZone(NEXT_ZONE).toLocalDate()>hour.start.atZone(NEXT_ZONE).toLocalDate())"24:00"else clock(hour.end),width.toFloat(),height.toFloat()-u.dp(3),p)
            if(now>=hour.start&&now<hour.end){val at=x(now);p.color=u.p.ink;p.strokeWidth=u.dp(1).toFloat();c.drawLine(at,top-u.dp(4),at,bottom,p);p.textAlign=Paint.Align.CENTER;c.drawText(clock(now),at.coerceIn(u.dp(18).toFloat(),width-u.dp(18).toFloat()),u.dp(15).toFloat(),p)}
        }
    }
}
