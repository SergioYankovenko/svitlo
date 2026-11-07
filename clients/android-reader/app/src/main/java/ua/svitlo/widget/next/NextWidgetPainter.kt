package ua.svitlo.widget.next

import android.content.Context
import android.graphics.*
import androidx.core.graphics.PathParser
import org.json.JSONObject
import ua.svitlo.widget.PowerGlyph
import ua.svitlo.widget.WeatherDisplay
import ua.svitlo.widget.WidgetStyle
import java.time.*
import kotlin.math.*

/** Same live repository as Home. The bitmap is a bounded RemoteViews transport,
 * not a separate schedule, a 24-hour clock model or a source of measurements. */
internal object NextWidgetPainter {
    data class Picture(val bitmap:Bitmap,val topDp:Int,val bottomDp:Int,val rows:List<String>)
    fun picture(c:Context,repo:NextRepository,profiles:List<NextProfile>,count:Int,detailed:Boolean,widthDp:Int,heightDp:Int,now:Instant=Instant.now()):Picture {
        val wdp=widthDp.coerceIn(172,800);val hdp=heightDp.coerceIn(82,800)
        val unit=minOf(2f,900f/wdp,600f/hdp)
        val bitmap=Bitmap.createBitmap((wdp*unit).roundToInt(),(hdp*unit).roundToInt(),Bitmap.Config.ARGB_8888)
        val canvas=Canvas(bitmap);canvas.scale(unit,unit)
        val p=WidgetStyle.palette();val paint=Paint(Paint.ANTI_ALIAS_FLAG);val today=now.atZone(NEXT_ZONE).toLocalDate()
        val narrow=wdp<260;val top=if(hdp<200)44 else 54;val bottom=48;val slots=if(detailed)4 else 1
        val slot=((hdp-top-bottom).toFloat()/slots).coerceAtLeast(1f);val inset=if(narrow)12f else 16f
        fun text(value:String,x:Float,baseline:Float,size:Float,color:Int,maxWidth:Float,bold:Boolean=false,minSize:Float=9f){
            if(maxWidth<=0)return
            paint.typeface=Typeface.create(if(bold)"sans-serif-medium"else"sans-serif",Typeface.NORMAL);paint.color=color;paint.style=Paint.Style.FILL;paint.textSize=size
            if(paint.measureText(value)>maxWidth)paint.textSize=(size*maxWidth/paint.measureText(value)).coerceAtLeast(minOf(size,minSize))
            val display=if(paint.measureText(value)>maxWidth){var end=value.length;while(end>0&&paint.measureText(value.take(end)+"…")>maxWidth)end--;value.take(end)+"…"}else value
            canvas.drawText(display,x,baseline,paint)
        }
        fun category(kind:Kind?)=when(kind){Kind.HOURLY->p.hourly;Kind.PLANNED->p.planned;Kind.UNPLANNED->p.unplanned;Kind.EMERGENCY->p.emergency;null->WidgetStyle.power}
        fun next(profile:NextProfile):Span? {val snapshot=repo.snapshot(profile) ?:return null;return (0..1).mapNotNull{snapshot.day(today.plusDays(it.toLong()),profile.lineId,now).takeIf{it.timerAllowed}?.next(now)}.minByOrNull{it.start}}
        fun status(plan:DayPlan,next:Span?,compact:Boolean):String {val event=plan.eventAt(now)
            return when{
                !plan.timerAllowed->if(plan.state=="not_published")"Графік ще не опубліковано"else"Стан невідомий"
                event!=null&&event.end==null->"Час уточнюється"
                event?.end!=null->if(compact)"До відновлення "+durationText((Duration.between(now,event.end).seconds+59)/60)else"Увімкнуть світло о ${clock(event.end)}"
                next!=null->{val tomorrow=next.start.atZone(NEXT_ZONE).toLocalDate()>today;if(compact)if(tomorrow)"Відключення завтра о ${clock(next.start)}"else"Відключення через "+durationText((Duration.between(now,next.start).seconds+59)/60)else"Вимкнуть світло "+(if(tomorrow)"завтра о "else"о ")+clock(next.start)}
                else->if(plan.known)"Без відключень"else"За графіком"
            }
        }
        val plans=profiles.map{profile->repo.snapshot(profile)?.day(today,profile.lineId,now) ?:DayPlan(today,emptyList(),false,"unknown",false)}
        val upcoming=profiles.map(::next)
        paint.color=p.surface;canvas.drawRoundRect(RectF(0f,0f,wdp.toFloat(),hdp.toFloat()),26f,26f,paint)
        val weatherProfile=repo.active()
        val weather=weatherProfile?.let{runCatching{JSONObject(repo.prefs.getString("weather-${it.id}",null) ?:return@runCatching null)}.getOrNull()}
        val weatherAt=weatherProfile?.let{repo.prefs.getLong("weather-at-${it.id}",0)} ?:0
        val current=weather?.optJSONObject("current");val temperature=current?.optDouble("temperature_2m",Double.NaN) ?:Double.NaN
        val validWeather=weatherAt in (System.currentTimeMillis()-7200000)..System.currentTimeMillis()&&temperature.isFinite()&&temperature in -100.0..70.0
        val weatherText=if(validWeather)WeatherDisplay.icon(current!!.optInt("weather_code",3))+" "+(if(temperature>0)"+"else"")+temperature.roundToInt()+"°"else"—°"
        val weatherWidth=if(narrow)62f else 76f;val headerY=if(hdp<200)27f else 33f
        val save=canvas.save();canvas.translate(inset,headerY-18);canvas.scale(20/24f,20/24f);paint.style=Paint.Style.STROKE;paint.color=p.ink;paint.strokeWidth=1.8f;paint.strokeCap=Paint.Cap.ROUND;paint.strokeJoin=Paint.Join.ROUND
        if(detailed)canvas.drawPath(PathParser.createPathFromPathData("M3 10.5L12 3L21 10.5M5 9V21H19V9M9 21V14H15V21"),paint)else PowerGlyph.draw(canvas,12f,12f,19f,p.hourly,false,false)
        canvas.restoreToCount(save)
        val header=if(detailed)"Мої адреси · $count"else profiles.firstOrNull()?.let{profile->(repo.snapshot(profile)?.line(profile.lineId)?.group?.let{"$it · "} ?:"")+status(plans[0],upcoming[0],true)} ?:"Світло"
        text(header,inset+25,headerY,if(narrow)14f else 16f,p.ink,wdp-inset*2-25-weatherWidth,true)
        text(weatherText,wdp-inset-weatherWidth+4,headerY,if(narrow)15f else 18f,p.ink,weatherWidth-4)
        paint.color=p.track;paint.strokeWidth=1f;canvas.drawLine(inset,(top-10).toFloat(),wdp-inset,(top-10).toFloat(),paint)
        val descriptions=mutableListOf<String>();val activeCandidates=mutableListOf<Span>();val nextCandidates=mutableListOf<Span>()
        for((i,profile)in profiles.withIndex()){
            val plan=plans[i];val next=upcoming[i];val event=plan.eventAt(now);if(event!=null)activeCandidates+=event else if(next!=null)nextCandidates+=next
            val label=(repo.snapshot(profile)?.line(profile.lineId)?.group?.let{"$it · "} ?:"")+profile.name.ifBlank{profile.label}
            val state=status(plan,next,false);val y=top+i*slot
            descriptions+="${profile.label}. ${repo.snapshot(profile)?.line(profile.lineId)?.group?.let{"Черга $it. "} ?:""}$state"
            val labelHeight=if(detailed)minOf(20f,slot*.55f)else 0f
            if(detailed){val side=minOf(12f,labelHeight*.8f);PowerGlyph.draw(canvas,inset+side/2,y+labelHeight*.5f,side,p.hourly,false,false)
                text(label,inset+side+3,y+labelHeight*.76f,minOf(13f,labelHeight*.72f),p.ink,(wdp-inset*2)*.48f-side-3)
                text(state,wdp*.52f,y+labelHeight*.76f,minOf(11f,labelHeight*.68f),p.accent,wdp*.48f-inset)
            }
            val a=y+labelHeight;val b=(y+slot-4).coerceAtLeast(a+1);val duration=Duration.between(plan.start,plan.end).toMillis().toDouble();val band=canvas.save();canvas.clipPath(Path().apply{addRoundRect(RectF(inset,a,wdp-inset,b),5f,5f,Path.Direction.CW)})
            for(part in plan.parts(true)){val x1=inset+(Duration.between(plan.start,part.start).toMillis()/duration*(wdp-2*inset)).toFloat();val x2=inset+(Duration.between(plan.start,part.end).toMillis()/duration*(wdp-2*inset)).toFloat();paint.style=Paint.Style.FILL;paint.color=if(part.unknown)p.track else category(part.kind);canvas.drawRect(x1,a,x2+.5f,b,paint)
                if(part.unknown){val clip=canvas.save();canvas.clipRect(x1,a,x2,b);paint.color=p.muted;paint.alpha=65;paint.strokeWidth=.7f;var x=x1-(b-a);while(x<x2){canvas.drawLine(x,b,x+b-a,a,paint);x+=6};paint.alpha=255;canvas.restoreToCount(clip)}
            };canvas.restoreToCount(band)
            if(now>=plan.start&&now<plan.end){val x=inset+(Duration.between(plan.start,now).toMillis()/duration*(wdp-2*inset)).toFloat();paint.color=p.ink;paint.strokeWidth=1.5f;canvas.drawLine(x,a-2,x,b+2,paint)}
        }
        // Calendar labels use real instants, including 23/25-hour Kyiv days.
        val dayStart=today.atStartOfDay(NEXT_ZONE).toInstant();val dayEnd=today.plusDays(1).atStartOfDay(NEXT_ZONE).toInstant();val dayLength=Duration.between(dayStart,dayEnd).toMillis().toDouble()
        for(hour in listOf(0,6,12,18,24)){val at=if(hour==24)dayEnd else today.atTime(hour,0).atZone(NEXT_ZONE).toInstant();val x=inset+(Duration.between(dayStart,at).toMillis()/dayLength*(wdp-inset*2)).toFloat();text(hour.toString().padStart(2,'0'),x-(if(hour==24)12 else if(hour==0)0 else 6),hdp-36f,9f,p.muted,25f)}
        paint.color=p.track;paint.strokeWidth=1f;canvas.drawLine(inset,hdp-29f,wdp-inset,hdp-29f,paint)
        val chosen=activeCandidates.maxByOrNull{it.kind.priority} ?:nextCandidates.minWithOrNull(compareBy<Span>{it.start}.thenByDescending{it.kind.priority})
        val controlWidth=100f;val legendWidth=wdp-inset*2-controlWidth;val oneLine=legendWidth>=143
        val font=if(oneLine)10f else 9f
        fun legend(label:String,color:Int,x:Float,y:Float,max:Float){paint.style=Paint.Style.FILL;paint.color=color;canvas.drawRect(x,y-6,x+6,y,paint);text(label,x+9,y,font,p.muted,max-9,minSize=8f)}
        legend("Світло є",WidgetStyle.power,inset,hdp-(if(oneLine)12f else 17f),if(oneLine)68f else legendWidth)
        legend("Світла немає",category(chosen?.kind ?:Kind.HOURLY),inset+(if(oneLine)72 else 0),hdp-(if(oneLine)12f else 5f),if(oneLine)legendWidth-72 else legendWidth)
        if(profiles.isEmpty())text("Додайте адресу в застосунку",inset,hdp/2f,14f,p.muted,wdp-inset*2)
        return Picture(bitmap,top,bottom,descriptions)
    }
}
