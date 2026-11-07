package ua.svitlo.widget.next

import android.content.Context
import android.graphics.*
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.TextUtils
import android.view.*
import android.widget.*
import org.json.JSONObject
import ua.svitlo.widget.*
import java.time.*
import kotlin.math.*

internal class NextUi(val context:Context){
    val p get()=Palette.app(context)
    fun dp(n:Float)=(n*context.resources.displayMetrics.density).roundToInt()
    fun dp(n:Int)=dp(n.toFloat())
    fun bg(color:Int,radius:Int=16)=GradientDrawable().apply{setColor(color);cornerRadius=dp(radius).toFloat()}
    fun column(padding:Int=0)=LinearLayout(context).apply{orientation=LinearLayout.VERTICAL;setPadding(dp(padding),dp(padding),dp(padding),dp(padding))}
    fun text(value:String,size:Float=14f,color:Int=p.ink,bold:Boolean=false)=TextView(context).apply{text=value;textSize=size;setTextColor(color);includeFontPadding=false;if(bold)typeface=Typeface.create("sans-serif-medium",Typeface.NORMAL)}
    fun heading(value:String)=text(value,18f,p.ink,true).apply{androidx.core.view.ViewCompat.setAccessibilityHeading(this,true)}
    fun button(value:String,cancel:Boolean=false,selected:Boolean=false,action:()->Unit)=Button(context).apply{
        text=value;isAllCaps=false;textSize=15f;minWidth=0;minimumWidth=0;minimumHeight=dp(48);minHeight=dp(48);setPadding(dp(12),dp(10),dp(12),dp(10));setSingleLine();setHorizontallyScrolling(false);ellipsize=TextUtils.TruncateAt.END;gravity=Gravity.CENTER
        stateListAnimator=null;elevation=0f;translationZ=0f;backgroundTintList=null;background=bg(when{cancel->if(AppAppearance.light(context))Color.rgb(248,236,233)else Color.rgb(59,44,41);selected->p.track;else->p.background},12)
        setAutoSizeTextTypeUniformWithConfiguration(dp(11),textSize.roundToInt().coerceAtLeast(dp(11)),1,android.util.TypedValue.COMPLEX_UNIT_PX)
        setTextColor(if(cancel)if(AppAppearance.light(context))Color.rgb(153,80,72)else Color.rgb(224,170,160)else if(selected)p.ink else p.accent);setOnClickListener{action()}
    }
    fun row(vararg children:View,weights:FloatArray=FloatArray(children.size){1f})=LinearLayout(context).apply{orientation=LinearLayout.HORIZONTAL;gravity=Gravity.CENTER_VERTICAL;isBaselineAligned=false;children.forEachIndexed{i,v->addView(v,LinearLayout.LayoutParams(0,-2,weights[i]).apply{if(i>0)marginStart=dp(8)})}}
    fun actions(vararg children:Button)=CompactActionRow(context).apply{children.forEach{addView(it,LinearLayout.LayoutParams(0,-2,1f))}}
    fun add(parent:LinearLayout,child:View,gap:Int=12){val height=child.layoutParams?.height ?: -2;parent.addView(child,LinearLayout.LayoutParams(-1,height).apply{if(parent.childCount>0)topMargin=dp(gap)})}
    fun divider()=View(context).apply{setBackgroundColor(p.track);minimumHeight=dp(1);layoutParams=LinearLayout.LayoutParams(-1,dp(1));importantForAccessibility=View.IMPORTANT_FOR_ACCESSIBILITY_NO}
    fun card(outlined:Boolean=true)=column(16).apply{background=bg(p.surface,22).apply{if(outlined)setStroke(dp(1),p.track)}}
    fun input(hintValue:String)=EditText(context).apply{hint=hintValue;contentDescription=hintValue;textSize=16f;setTextColor(p.ink);setHintTextColor(p.muted);setSingleLine();minHeight=dp(48);setPadding(dp(12),dp(10),dp(12),dp(10));background=bg(if(AppAppearance.light(context))Color.rgb(244,247,240)else Color.rgb(59,81,67),12);backgroundTintList=null}
    fun single(view:TextView){view.maxLines=1;view.ellipsize=TextUtils.TruncateAt.END;view.contentDescription=view.text;view.setHorizontallyScrolling(false)}
}

/** Wrap complete attribution links, never individual letters inside a provider name. */
internal class NextLinkFlow(c:Context):ViewGroup(c){
    private val u=NextUi(c);private val positions=mutableListOf<Pair<Int,Int>>()
    override fun onMeasure(w:Int,h:Int){val width=MeasureSpec.getSize(w);var x=0;var y=0;var row=0;positions.clear()
        for(i in 0 until childCount){val child=getChildAt(i);child.measure(MeasureSpec.makeMeasureSpec(width,MeasureSpec.AT_MOST),MeasureSpec.makeMeasureSpec(0,MeasureSpec.UNSPECIFIED));if(x>0&&x+child.measuredWidth>width){x=0;y+=row;row=0};positions+=x to y;x+=child.measuredWidth+u.dp(8);row=maxOf(row,child.measuredHeight)}
        setMeasuredDimension(width,resolveSize(y+row,h))
    }
    override fun onLayout(changed:Boolean,l:Int,t:Int,r:Int,b:Int){for(i in 0 until childCount){val child=getChildAt(i);val(x,y)=positions[i];child.layout(x,y,x+child.measuredWidth,y+child.measuredHeight)}}
}

/** UI254 onboarding choice: the authored example includes the power glyph,
 * half-hour tint and its own label. It does not mutate the saved appearance. */
internal class NextTimePreview(c:Context,private val range:Boolean):View(c){
    private val u=NextUi(c);private val paint=Paint(Paint.ANTI_ALIAS_FLAG)
    init{isClickable=true;isFocusable=true;contentDescription=if(range)"Інтервал часу"else"Лише початок години"}
    override fun onInitializeAccessibilityNodeInfo(info:android.view.accessibility.AccessibilityNodeInfo){super.onInitializeAccessibilityNodeInfo(info);info.className="android.widget.RadioButton";info.isCheckable=true;info.isChecked=isSelected}
    override fun onMeasure(w:Int,h:Int){val tile=u.dp(78f*minOf(resources.configuration.fontScale,1.6f));val label=android.util.TypedValue.applyDimension(android.util.TypedValue.COMPLEX_UNIT_SP,13f,resources.displayMetrics);setMeasuredDimension(resolveSize(u.dp(120),w),resolveSize(tile+u.dp(28)+ceil(label*1.3f).toInt(),h))}
    override fun onDraw(c:Canvas){
        val p=u.p;val d=resources.displayMetrics.density;val scale=minOf(resources.configuration.fontScale,1.6f)
        val tile=RectF(8*d,8*d,width-8*d,8*d+78*d*scale)
        paint.style=Paint.Style.FILL;paint.color=if(isSelected)androidx.core.graphics.ColorUtils.blendARGB(p.track,p.accent,.16f)else p.background;c.drawRoundRect(RectF(d,d,width-d,height-d),12*d,12*d,paint)
        if(isSelected){paint.style=Paint.Style.STROKE;paint.strokeWidth=d;paint.color=p.accent;c.drawRoundRect(RectF(d,d,width-d,height-d),12*d,12*d,paint)}
        paint.style=Paint.Style.FILL;paint.color=p.background;c.drawRoundRect(tile,13*d,13*d,paint)
        val clip=c.save();c.clipPath(Path().apply{addRoundRect(tile,13*d,13*d,Path.Direction.CW)});paint.color=androidx.core.graphics.ColorUtils.blendARGB(p.background,p.hourly,.65f);c.drawRect(tile.left,tile.centerY(),tile.right,tile.bottom,paint);c.restoreToCount(clip)
        paint.color=p.accent;paint.style=Paint.Style.STROKE;paint.strokeWidth=2*d;c.drawRoundRect(tile,13*d,13*d,paint)
        paint.style=Paint.Style.FILL;paint.typeface=Typeface.create("sans-serif-medium",Typeface.NORMAL);paint.textSize=19*d*scale
        val glyph=20*d*scale;val gap=8*d;val ideal=paint.measureText("13:00")+glyph+gap;val fit=minOf(1f,(tile.width()-12*d)/ideal)
        paint.textSize*=fit;val icon=glyph*fit;val group=paint.measureText("13:00")+icon+gap;val start=tile.centerX()-group/2
        PowerGlyph.draw(c,start+icon/2,tile.centerY(),icon,p.ink,false,AppAppearance.bulbs(context))
        paint.color=p.ink;paint.textAlign=Paint.Align.LEFT
        fun time(text:String,y:Float){c.drawText(text,start+icon+gap,y-(paint.ascent()+paint.descent())/2,paint)}
        if(range){time("13:00",tile.centerY()-12*d*scale);time("14:00",tile.centerY()+12*d*scale)}else time("13:00",tile.centerY())
        paint.typeface=Typeface.create("sans-serif",Typeface.NORMAL);paint.textSize=android.util.TypedValue.applyDimension(android.util.TypedValue.COMPLEX_UNIT_SP,13f,resources.displayMetrics);paint.color=p.muted;paint.textAlign=Paint.Align.CENTER
        val label=if(range)"Інтервал"else"Початок";if(paint.measureText(label)>width-16*d)paint.textSize*=(width-16*d)/paint.measureText(label)
        c.drawText(label,width/2f,tile.bottom+8*d-paint.ascent(),paint)
    }
}

/** Reuses approved WebP masters; no mirrored or distorted poses. One bounded cache per process. */
internal class NextMascot(context:Context,private var asset:String,private var sprite:Boolean=false,private val settle:String?=null):View(context){
    private val paint=Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private var bitmap=load(context,asset,sprite)
    private var frame=0;private var previous=0;private var fadedAt=0L
    private val handler=Handler(Looper.getMainLooper())
    private val tick=object:Runnable{override fun run(){
        if(!isAttachedToWindow||!isShown||!animations(context))return
        if(asset.startsWith("mascot-finish-")&&frame==3){settle?.let{asset=it;sprite=false;bitmap=load(context,it,false);frame=0;previous=0;invalidate()};return}
        previous=frame;frame=(frame+1)%4;fadedAt=android.os.SystemClock.uptimeMillis();invalidate();handler.postDelayed(this,holds()[frame])
    }}
    private fun holds()=if(asset.startsWith("mascot-finish-"))longArrayOf(480,600,650,1000)else longArrayOf(1800,1500,1600,1900)
    init{importantForAccessibility=IMPORTANT_FOR_ACCESSIBILITY_NO}
    override fun onAttachedToWindow(){super.onAttachedToWindow();if(sprite&&animations(context))handler.postDelayed(tick,holds()[frame])else if(sprite&&asset.startsWith("mascot-finish-")){settle?.let{asset=it;sprite=false;bitmap=load(context,it,false)}}}
    override fun onDetachedFromWindow(){handler.removeCallbacksAndMessages(null);super.onDetachedFromWindow()}
    override fun onMeasure(w:Int,h:Int){val width=resolveSize((180*resources.displayMetrics.density).toInt(),w);setMeasuredDimension(width,resolveSize((width*1.1).toInt(),h))}
    override fun onDraw(c:Canvas){val b=bitmap ?:return;val fw=if(sprite)b.width/4 else b.width;val scale=minOf(width.toFloat()/fw,height.toFloat()/b.height);val x=(width-fw*scale)/2;val y=(height-b.height*scale)/2;val dst=RectF(x,y,x+fw*scale,y+b.height*scale)
        fun draw(index:Int,alpha:Int){paint.alpha=alpha;c.drawBitmap(b,Rect(if(sprite)index*fw else 0,0,if(sprite)(index+1)*fw else fw,b.height),dst,paint)}
        val mix=if(sprite&&fadedAt>0)((android.os.SystemClock.uptimeMillis()-fadedAt)/240f).coerceIn(0f,1f)else 1f
        if(mix<1f){draw(previous,((1-mix)*255).roundToInt());draw(frame,(mix*255).roundToInt());postInvalidateOnAnimation()}else draw(frame,255);paint.alpha=255
    }
    companion object{
        private val cache=object:android.util.LruCache<String,Bitmap>(minOf(24*1024*1024,(Runtime.getRuntime().maxMemory()/12).toInt())){override fun sizeOf(key:String,value:Bitmap)=value.byteCount}
        private fun load(c:Context,name:String,sheet:Boolean):Bitmap?=synchronized(cache){cache.get(name) ?:runCatching{val bounds=BitmapFactory.Options().apply{inJustDecodeBounds=true};c.assets.open("next/$name").use{BitmapFactory.decodeStream(it,null,bounds)};val options=BitmapFactory.Options();while(bounds.outWidth/options.inSampleSize.coerceAtLeast(1)>(if(sheet)2048 else 768)||bounds.outHeight/options.inSampleSize.coerceAtLeast(1)>1024)options.inSampleSize=options.inSampleSize.coerceAtLeast(1)*2;c.assets.open("next/$name").use{BitmapFactory.decodeStream(it,null,options)}}.getOrNull()?.also{cache.put(name,it)}}
        fun animations(c:Context)=Settings.Global.getFloat(c.contentResolver,Settings.Global.ANIMATOR_DURATION_SCALE,1f)>0f
    }
}

internal class NextHourView(context:Context,val hour:DisplayHour,private var now:Instant,private val currentDate:LocalDate,private var observation:JSONObject?=null,private val sensorBound:Boolean=false,private var signal:String="unknown"):View(context){
    private val u=NextUi(context);private val p=u.p;private val paint=Paint(Paint.ANTI_ALIAS_FLAG)
    init{minimumHeight=u.dp(58);isFocusable=true;contentDescription=hour.label+(if(hour.repeated)", зміна часу, "else", ")+hour.parts.mapIndexed{i,x->(if(hour.repeated)"Частина ${i+1} з 4. "else"")+clock(x.start)+"–"+clock(x.end)+": "+(if(x.unknown)"дані невідомі"else x.kind?.title ?:"світло за графіком")}.joinToString("; ")}
    override fun onMeasure(w:Int,h:Int){val scale=resources.configuration.fontScale;setMeasuredDimension(resolveSize(u.dp(90),w),resolveSize(u.dp((58*minOf(scale,1.5f)).roundToInt()),h))}
    fun setLive(at:Instant,state:String){now=at;signal=state;invalidate()}
    fun setObservation(value:JSONObject?){observation=value;contentDescription=hour.label+", "+hour.parts.joinToString("; "){clock(it.start)+"–"+clock(it.end)+": "+if(it.unknown)"дані невідомі"else it.kind?.title ?:"світло за графіком"}+if(sensorBound)". За датчиком: "+value?.optJSONArray("intervals")?.objects().orEmpty().filter{wireInstant(it.getString("start"))<hour.end&&wireInstant(it.getString("end"))>hour.start}.joinToString("; "){clock(maxOf(hour.start,wireInstant(it.getString("start"))))+"–"+clock(minOf(hour.end,wireInstant(it.getString("end"))))+": "+if(it.getString("powerState")=="on")"Світло є"else"Світла немає"}else"";invalidate()}
    private fun color(k:Kind?)=when(k){Kind.HOURLY->p.hourly;Kind.PLANNED->p.planned;Kind.UNPLANNED->p.unplanned;Kind.EMERGENCY->p.emergency;null->p.background}
    override fun onDraw(c:Canvas){val clip=c.save();val bounds=RectF(0f,0f,width.toFloat(),height.toFloat());val radius=u.dp(13).toFloat();c.clipPath(Path().apply{addRoundRect(bounds,radius,radius,Path.Direction.CW)})
        hour.parts.forEachIndexed{i,part->val r=RectF(0f,height.toFloat()*i/hour.parts.size,width.toFloat(),height.toFloat()*(i+1)/hour.parts.size);paint.style=Paint.Style.FILL;paint.color=if(part.unknown&&part.kind==null)p.track else color(part.kind);c.drawRect(r,paint);if(part.unknown){val save=c.save();c.clipRect(r);paint.color=p.muted;paint.alpha=80;paint.strokeWidth=u.dp(1).toFloat();var x=-height.toFloat();while(x<width){c.drawLine(x,height.toFloat(),x+height,0f,paint);x+=u.dp(8)};paint.alpha=255;c.restoreToCount(save)}}
        val uniform=hour.parts.map{it.kind to it.unknown}.distinct().size==1;val density=resources.displayMetrics.density;val scale=resources.configuration.fontScale;val base=14*density*minOf(scale,1.6f)
        paint.typeface=Typeface.create("sans-serif-medium",Typeface.NORMAL);paint.textSize=minOf(base,(width-u.dp(33))/paint.apply{textSize=base}.measureText("24:00")*base);paint.textAlign=Paint.Align.CENTER
        val glyph=minOf(u.dp(17).toFloat(),paint.textSize*1.12f);val timeWidth=paint.measureText("24:00");val all=timeWidth+glyph+u.dp(4);val x=(width-all)/2;val timeX=x+glyph+u.dp(4)+timeWidth/2
        fun label(value:String,y:Float,ink:Int){paint.style=Paint.Style.FILL;paint.color=ink;c.drawText(value,timeX,y-(paint.ascent()+paint.descent())/2,paint)}
        if(!uniform && hour.repeated){hour.parts.forEachIndexed{i,part->val y=height.toFloat()*(i+.5f)/4;val ink=if(part.kind!=null)p.outageIcon else p.ink;PowerGlyph.draw(c,u.dp(13).toFloat(),y,glyph*.65f,ink,part.kind!=null,AppAppearance.bulbs(context))};label(hour.label,height*.37f,p.ink);if(AppAppearance.twoRows(context))label(clock(hour.end),height*.68f,p.ink)}
        else{hour.parts.forEachIndexed{i,part->val save=c.save();c.clipRect(0f,height.toFloat()*i/hour.parts.size,width.toFloat(),height.toFloat()*(i+1)/hour.parts.size);val ink=if(part.kind!=null)p.outageIcon else p.ink
                if(AppAppearance.twoRows(context)){label(hour.label,height*.32f,ink);label(if(hour.end.atZone(NEXT_ZONE).toLocalDate()>currentDate)"24:00"else clock(hour.end),height*.73f,ink)}else label(hour.label,height*.5f,ink)
                if(part.unknown&&part.kind==null){paint.color=ink;c.drawText("?",x+glyph/2,height*.5f-(paint.ascent()+paint.descent())/2,paint)}else PowerGlyph.draw(c,x+glyph/2,height*.5f,glyph,ink,part.kind!=null,AppAppearance.bulbs(context));c.restoreToCount(save)}}
        if(hour.repeated){paint.color=p.muted;paint.textSize=u.dp(9).toFloat();paint.textAlign=Paint.Align.CENTER;c.drawText("зміна часу",width/2f,height-u.dp(4).toFloat(),paint)}
        c.restoreToCount(clip)
        val current=now>=hour.start&&now<hour.end&&currentDate==now.atZone(NEXT_ZONE).toLocalDate()
        if(sensorBound){observation?.optJSONArray("intervals")?.objects()?.forEach{e->val a=runCatching{wireInstant(e.getString("start"))}.getOrNull() ?: return@forEach;val b=runCatching{wireInstant(e.getString("end"))}.getOrNull() ?: return@forEach;if(a<hour.end && b>hour.start){val span=Duration.between(hour.start,hour.end).toMillis().toFloat();val top=(Duration.between(hour.start,maxOf(a,hour.start)).toMillis()/span*height).coerceIn(0f,height.toFloat());val bottom=(Duration.between(hour.start,minOf(b,hour.end)).toMillis()/span*height).coerceIn(0f,height.toFloat());paint.style=Paint.Style.STROKE;paint.strokeWidth=u.dp(2).toFloat();paint.color=if(e.optString("powerState")=="on")Color.rgb(91,158,91)else p.emergency;paint.pathEffect=if(e.optString("powerState")=="off")DashPathEffect(floatArrayOf(u.dp(3).toFloat(),u.dp(3).toFloat()),0f)else null;c.drawRoundRect(RectF(u.dp(5).toFloat(),maxOf(top,u.dp(5).toFloat()),width-u.dp(5).toFloat(),minOf(bottom,height-u.dp(5).toFloat())),u.dp(8).toFloat(),u.dp(8).toFloat(),paint)}}}
        if(current){paint.style=Paint.Style.STROKE;paint.strokeWidth=u.dp(2).toFloat();paint.color=if(!sensorBound)p.accent else when(signal){"on"->Color.rgb(91,158,91);"off"->p.emergency;else->p.muted};paint.pathEffect=if(sensorBound&&signal!="on")DashPathEffect(floatArrayOf(u.dp(4).toFloat(),u.dp(3).toFloat()),0f)else null;c.drawRoundRect(RectF(u.dp(1).toFloat(),u.dp(1).toFloat(),width-u.dp(1).toFloat(),height-u.dp(1).toFloat()),radius,radius,paint);paint.pathEffect=null;if(sensorBound){paint.style=Paint.Style.FILL;c.drawCircle(width-u.dp(8).toFloat(),u.dp(8).toFloat(),u.dp(3).toFloat(),paint)}}
        paint.style=Paint.Style.FILL;paint.pathEffect=null
    }
}

/** Native, synchronized viewport for plan and measurement graphs; epoch geometry preserves DST. */
internal class NextPlot(context:Context,val day:DayPlan,private val observation:JSONObject?=null):View(context){
    var zoom=1f;var offset=0f;var changed:((Float,Float)->Unit)?=null
    private val u=NextUi(context);private val paint=Paint(Paint.ANTI_ALIAS_FLAG)
    private val scaleDetector=ScaleGestureDetector(context,object:ScaleGestureDetector.SimpleOnScaleGestureListener(){override fun onScale(d:ScaleGestureDetector):Boolean{val before=zoom;zoom=(zoom*d.scaleFactor).coerceIn(1f,24f);offset=(offset+(1/before-1/zoom)*(d.focusX/width)).coerceIn(0f,(1-1/zoom).coerceAtLeast(0f));changed?.invoke(zoom,offset);invalidate();return true}})
    private val gestures=GestureDetector(context,object:GestureDetector.SimpleOnGestureListener(){override fun onDown(e:android.view.MotionEvent)=true;override fun onScroll(a:android.view.MotionEvent?,b:android.view.MotionEvent,dx:Float,dy:Float):Boolean{if(scaleDetector.isInProgress)return true;offset=(offset+dx/width/zoom).coerceIn(0f,(1-1/zoom).coerceAtLeast(0f));changed?.invoke(zoom,offset);invalidate();return true};override fun onDoubleTap(e:android.view.MotionEvent):Boolean{zoom=1f;offset=0f;changed?.invoke(zoom,offset);invalidate();return true}})
    init{minimumHeight=u.dp(112);contentDescription=if(observation==null)"План відключень. Масштаб двома пальцями, переміщення одним, подвійний дотик повертає добу"else"Точні виміри датчика. Невідомі проміжки позначені окремо";isFocusable=true}
    override fun onMeasure(w:Int,h:Int){setMeasuredDimension(resolveSize(u.dp(300),w),resolveSize(u.dp(112),h))}
    override fun onTouchEvent(e:MotionEvent):Boolean{parent?.requestDisallowInterceptTouchEvent(true);scaleDetector.onTouchEvent(e);gestures.onTouchEvent(e);if(e.actionMasked==MotionEvent.ACTION_UP)performClick();return true}
    override fun performClick():Boolean{super.performClick();return true}
    override fun onDraw(c:Canvas){
        val p=u.p
        val duration=Duration.between(day.start,day.end).toMillis().toDouble()
        fun x(at:Instant):Float {return ((Duration.between(day.start,at).toMillis()/duration-offset)*zoom*width).toFloat()}
        val top=u.dp(6).toFloat();val bottom=height-u.dp(25).toFloat();paint.style=Paint.Style.FILL;paint.color=p.track;c.drawRoundRect(RectF(0f,top,width.toFloat(),bottom),u.dp(8).toFloat(),u.dp(8).toFloat(),paint)
        val save=c.save();c.clipRect(0f,top,width.toFloat(),bottom)
        if(observation==null)for(part in day.parts(false)){paint.color=if(part.unknown)p.track else when(part.kind){null->Color.rgb(78,106,67);Kind.HOURLY->p.hourly;Kind.PLANNED->p.planned;Kind.UNPLANNED->p.unplanned;Kind.EMERGENCY->p.emergency};c.drawRect(x(part.start),top,x(part.end),bottom,paint)}
        else observation.optJSONArray("intervals")?.objects()?.forEach{e->val a=runCatching{wireInstant(e.getString("start"))}.getOrNull() ?: return@forEach;val b=runCatching{wireInstant(e.getString("end"))}.getOrNull() ?: return@forEach;paint.color=if(e.optString("powerState")=="on")Color.rgb(78,128,72)else p.emergency;c.drawRect(x(a),top,x(b),bottom,paint)}
        c.restoreToCount(save);paint.color=p.muted;paint.textSize=u.dp(11).toFloat();paint.textAlign=Paint.Align.CENTER
        var at=day.start;while(at<=day.end){val px=x(at);if(px>=0&&px<=width){val label=if(at==day.end)"24"else clock(at);c.drawText(label,px.coerceIn(u.dp(14).toFloat(),(width-u.dp(14)).toFloat()),height-u.dp(4).toFloat(),paint)};at=at.plusSeconds(if(zoom>=4)3600 else 21600)}
    }
}
