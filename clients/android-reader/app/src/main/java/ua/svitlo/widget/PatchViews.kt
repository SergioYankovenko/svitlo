package ua.svitlo.widget

import android.content.Context
import android.graphics.*
import android.view.*
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.*
import android.util.TypedValue
import ua.svitlo.widget.core.*

/** Whole labels share a size; large fonts use separate full-width action rows. */
internal class CompactActionRow(context:Context):MatchingLabelRow(context,true,true,minimumButtonDp=10f) {
    override fun onMeasure(w:Int,h:Int){
        orientation=if(resources.configuration.fontScale>=1.5f)VERTICAL else HORIZONTAL
        for(i in 0 until childCount){
            val child=getChildAt(i)
            val desired=LayoutParams(if(orientation==HORIZONTAL)0 else -1,-2,if(orientation==HORIZONTAL)1f else 0f).apply{
                if(orientation==HORIZONTAL){if(i>0)leftMargin=px(4);if(i<childCount-1)rightMargin=px(4)}
                else if(i>0)topMargin=px(8)
            }
            val current=child.layoutParams as LayoutParams
            if(current.isMarginRelative || current.width!=desired.width || current.weight!=desired.weight || current.height!=desired.height ||
                current.leftMargin!=desired.leftMargin || current.rightMargin!=desired.rightMargin || current.topMargin!=desired.topMargin || current.bottomMargin!=0)child.layoutParams=desired
            (child as? TextView)?.apply{setSingleLine(true);ellipsize=null}
        }
        super.onMeasure(w,h)
    }
    private fun px(n:Int)=(n*resources.displayMetrics.density).toInt()
}

/** Fit all labels together before wrapping whole groups at the readable minimum. */
internal class LegendFlow(context:Context):ViewGroup(context){
    private val gap=(16*resources.displayMetrics.density).toInt()
    private val lineGap=(10*resources.displayMetrics.density).toInt()
    override fun generateDefaultLayoutParams()=LayoutParams(LayoutParams.WRAP_CONTENT,LayoutParams.WRAP_CONTENT)
    override fun onMeasure(w:Int,h:Int){
        val limit=(MeasureSpec.getSize(w)-paddingLeft-paddingRight).coerceAtLeast(0)
        val maximum=TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP,14f,resources.displayMetrics)
        val minimum=TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP,11f,resources.displayMetrics)
        fun applySize(size:Float):Int {
            var required=gap*(childCount-1).coerceAtLeast(0)
            for(i in 0 until childCount){
                val group=getChildAt(i) as? LinearLayout
                if(group!=null){
                    for(j in 0 until group.childCount){val item=group.getChildAt(j)
                        if(item is TextView)item.setTextSize(TypedValue.COMPLEX_UNIT_PX,size)
                        if(item is LegendSample){val side=(20*resources.displayMetrics.density*size/maximum).toInt().coerceAtLeast(1)
                            item.layoutParams.width=side;item.layoutParams.height=side}
                    }
                }
                getChildAt(i).measure(MeasureSpec.makeMeasureSpec(0,MeasureSpec.UNSPECIFIED),MeasureSpec.makeMeasureSpec(0,MeasureSpec.UNSPECIFIED))
                required+=getChildAt(i).measuredWidth
            }
            return required
        }
        var chosen=maximum
        if(applySize(maximum)>limit){
            var low=kotlin.math.ceil(minimum).toInt();var high=maximum.toInt().coerceAtLeast(low)
            while(low<high){val mid=(low+high+1)/2;if(applySize(mid.toFloat())<=limit)low=mid else high=mid-1}
            chosen=low.toFloat()
        }
        applySize(chosen)
        var x=0;var y=0;var rowHeight=0
        for(i in 0 until childCount){val child=getChildAt(i)
            child.measure(MeasureSpec.makeMeasureSpec(limit,MeasureSpec.AT_MOST),MeasureSpec.makeMeasureSpec(0,MeasureSpec.UNSPECIFIED))
            if(x>0 && x+gap+child.measuredWidth>limit){y+=rowHeight+lineGap;x=0;rowHeight=0}
            if(x>0)x+=gap
            x+=child.measuredWidth;rowHeight=maxOf(rowHeight,child.measuredHeight)
        }
        setMeasuredDimension(MeasureSpec.getSize(w),resolveSize(paddingTop+y+rowHeight+paddingBottom,h))
    }
    override fun onLayout(changed:Boolean,l:Int,t:Int,r:Int,b:Int){
        var x=paddingLeft;var y=paddingTop;var rowHeight=0
        val limit=width-paddingRight
        for(i in 0 until childCount){val child=getChildAt(i)
            if(x>paddingLeft && x+gap+child.measuredWidth>limit){y+=rowHeight+lineGap;x=paddingLeft;rowHeight=0}
            if(x>paddingLeft)x+=gap
            child.layout(x,y,x+child.measuredWidth,y+child.measuredHeight)
            x+=child.measuredWidth;rowHeight=maxOf(rowHeight,child.measuredHeight)
        }
    }
}

internal object PowerGlyph {
    fun draw(canvas:Canvas,cx:Float,cy:Float,size:Float,color:Int,off:Boolean,bulbs:Boolean){
        val p=Paint(Paint.ANTI_ALIAS_FLAG).apply{this.color=color;strokeWidth=1.3f;strokeJoin=Paint.Join.ROUND;strokeCap=Paint.Cap.ROUND}
        val saved=canvas.save();canvas.translate(cx,cy);canvas.scale(size/14f,size/14f)
        if(bulbs){
            p.style=if(off)Paint.Style.STROKE else Paint.Style.FILL;canvas.drawCircle(0f,-1f,4f,p)
            p.style=Paint.Style.STROKE;canvas.drawLine(-2f,4f,2f,4f,p);canvas.drawLine(-1.5f,6f,1.5f,6f,p)
            if(!off)for(a in listOf(-150.0,-90.0,-30.0,30.0,150.0)){
                val r=Math.toRadians(a);canvas.drawLine((kotlin.math.cos(r)*6).toFloat(),(kotlin.math.sin(r)*6-1).toFloat(),(kotlin.math.cos(r)*7.5).toFloat(),(kotlin.math.sin(r)*7.5-1).toFloat(),p)
            }
        }else{
            val bolt=Path().apply{moveTo(2f,-7f);lineTo(-4f,1f);lineTo(0f,1f);lineTo(-2f,7f);lineTo(4f,-1f);lineTo(0f,-1f);close()}
            p.style=if(off)Paint.Style.STROKE else Paint.Style.FILL;canvas.drawPath(bolt,p)
            if(off){p.style=Paint.Style.STROKE;canvas.drawLine(-5.5f,-6f,5.5f,6f,p)}
        }
        canvas.restoreToCount(saved)
    }
}

internal class LegendSample(context:Context,private val colors:Palette,private val category:Category?=null,
    private val current:Boolean=false,private val half:Boolean=false,private val kind:OutageKind?=null):View(context){
    private val p=Paint(Paint.ANTI_ALIAS_FLAG)
    init{importantForAccessibility=IMPORTANT_FOR_ACCESSIBILITY_NO}
    override fun onDraw(c:Canvas){
        val d=resources.displayMetrics.density;val radius=5*d
        val bounds=RectF(d/2,d/2,width-d/2,height-d/2)
        p.style=Paint.Style.FILL;p.color=colors.background;c.drawRoundRect(bounds,radius,radius,p)
        if(category!=null){
            val saved=c.save();c.clipPath(Path().apply{addRoundRect(bounds,radius,radius,Path.Direction.CW)})
            p.color=colors.outage(category,kind);c.drawRect(0f,0f,width.toFloat(),if(half)height/2f else height.toFloat(),p);c.restoreToCount(saved)
        }
        if(current || half){p.style=Paint.Style.STROKE;p.color=if(current)colors.accent else colors.muted;p.strokeWidth=(if(current)2 else 1)*d;c.drawRoundRect(bounds,radius,radius,p)}
        if(!current)PowerGlyph.draw(c,width/2f,if(half)height/4f else height/2f,minOf(width*.6f,if(half)height*.3f else height*.6f),
            if(category!=null)colors.outageIcon else colors.accent,category!=null,AppAppearance.bulbs(context))
    }
}

internal class AppearanceOption(context:Context,private val kind:String,private val second:Boolean,private val colors:Palette):View(context){
    private val p=Paint(Paint.ANTI_ALIAS_FLAG)
    init{isFocusable=true;isClickable=true;minimumHeight=dp(56);tooltipText=when(kind){"theme"->if(second)"Світла тема"else"Темна тема";"time"->if(second)"Початок і кінець"else"Лише початок";else->if(second)"Лампочки"else"Блискавки"};contentDescription=tooltipText}
    private fun dp(n:Int)=(n*resources.displayMetrics.density).toInt()
    override fun onMeasure(w:Int,h:Int){setMeasuredDimension(resolveSize(dp(90),w),resolveSize(dp(if(kind=="theme")64 else 56),h))}
    override fun onInitializeAccessibilityNodeInfo(info:AccessibilityNodeInfo){super.onInitializeAccessibilityNodeInfo(info);info.className="android.widget.RadioButton";info.isCheckable=true;info.isChecked=isSelected}
    override fun onDraw(c:Canvas){
        val d=resources.displayMetrics.density;val ink=if(isSelected)colors.accent else colors.muted
        val bounds=RectF(d,d,width-d,height-d)
        p.style=Paint.Style.FILL;p.color=if(isSelected)androidx.core.graphics.ColorUtils.blendARGB(colors.track,colors.accent,.16f)else colors.background
        c.drawRoundRect(bounds,10*d,10*d,p)
        if(isSelected){p.style=Paint.Style.STROKE;p.strokeWidth=d;p.color=colors.accent;c.drawRoundRect(bounds,10*d,10*d,p)}
        val cx=width/2f;val cy=height/2f
        p.style=Paint.Style.FILL;p.color=ink;p.textAlign=Paint.Align.CENTER;p.typeface=Typeface.create("sans-serif-medium",Typeface.NORMAL)
        fun value(s:String,y:Float,sp:Float,cap:Float){p.textSize=minOf(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP,sp,resources.displayMetrics),cap*d);c.drawText(s,cx,y-(p.ascent()+p.descent())/2,p)}
        when(kind){
            "theme"->{
                if(second){p.style=Paint.Style.STROKE;p.strokeWidth=1.5f*d;c.drawCircle(cx,cy-11*d,4*d,p)
                    for(i in 0..7){val a=i*Math.PI/4;c.drawLine(cx+(kotlin.math.cos(a)*6*d).toFloat(),cy-11*d+(kotlin.math.sin(a)*6*d).toFloat(),cx+(kotlin.math.cos(a)*9*d).toFloat(),cy-11*d+(kotlin.math.sin(a)*9*d).toFloat(),p)}}
                else {
                    // Exact 24×24 PWA moon, including the SVG elliptical-arc geometry.
                    val icon=resources.getDrawable(R.drawable.ic_theme_moon,null).mutate()
                    icon.setTint(ink);icon.setBounds((cx-12*d).toInt(),(cy-23*d).toInt(),(cx+12*d).toInt(),(cy+d).toInt());icon.draw(c)
                }
                p.style=Paint.Style.FILL;value(if(second)"Світла"else"Темна",cy+13*d,13f,18f)
            }
            "time"->{if(second){value("13:00",cy-10*d,15f,20f);value("14:00",cy+12*d,15f,20f)}else value("13:00",cy,15f,20f)}
            else->PowerGlyph.draw(c,cx,cy,24*d,ink,false,second)
        }
    }
}

/** A stable right edge for the lead picker; only text wraps until a stacked row is needed. */
internal class ReminderLeadRow(context:Context):ViewGroup(context){
    private val gap=(16*resources.displayMetrics.density).toInt()
    private var stacked=false
    override fun onMeasure(w:Int,h:Int){
        val width=MeasureSpec.getSize(w);val label=getChildAt(0);val field=getChildAt(1)
        field.measure(MeasureSpec.makeMeasureSpec(width,MeasureSpec.AT_MOST),MeasureSpec.makeMeasureSpec(0,MeasureSpec.UNSPECIFIED))
        val title=(label as ViewGroup).getChildAt(0) as TextView
        val titleWidth=kotlin.math.ceil(title.paint.measureText(title.text.toString())).toInt()+title.paddingLeft+title.paddingRight
        stacked=width-field.measuredWidth-gap<titleWidth
        val textWidth=if(stacked)width else (width-field.measuredWidth-gap).coerceAtLeast(0)
        label.measure(MeasureSpec.makeMeasureSpec(textWidth,MeasureSpec.EXACTLY),MeasureSpec.makeMeasureSpec(0,MeasureSpec.UNSPECIFIED))
        setMeasuredDimension(width,resolveSize(if(stacked)label.measuredHeight+gap+field.measuredHeight else maxOf(label.measuredHeight,field.measuredHeight),h))
    }
    override fun onLayout(changed:Boolean,l:Int,t:Int,r:Int,b:Int){
        val label=getChildAt(0);val field=getChildAt(1)
        label.layout(0,0,label.measuredWidth,label.measuredHeight)
        val top=if(stacked)label.bottom+gap else (height-field.measuredHeight)/2
        field.layout(width-field.measuredWidth,top,width,top+field.measuredHeight)
    }
}

internal class NotificationBell(context:Context,private val colors:Palette,private val enabled:Boolean):View(context){
    private val p=Paint(Paint.ANTI_ALIAS_FLAG)
    init{isClickable=true;isFocusable=true;minimumWidth=dp(48);minimumHeight=dp(48)}
    private fun dp(n:Int)=(n*resources.displayMetrics.density).toInt()
    override fun onMeasure(w:Int,h:Int){setMeasuredDimension(resolveSize(dp(48),w),resolveSize(dp(48),h))}
    override fun getAccessibilityClassName():CharSequence="android.widget.Button"
    override fun onDraw(c:Canvas){
        val d=resources.displayMetrics.density;val saved=c.save();c.translate(0f,(height-28*d)/2f);c.scale(d,d)
        p.color=if(enabled)colors.accent else colors.muted;p.strokeWidth=2f;p.style=Paint.Style.STROKE;p.strokeCap=Paint.Cap.ROUND;p.strokeJoin=Paint.Join.ROUND
        c.drawPath(Path().apply{moveTo(5f,21f);lineTo(8f,17f);lineTo(8f,12f);cubicTo(8f,4f,20f,4f,20f,12f);lineTo(20f,17f);lineTo(23f,21f);close()},p)
        c.drawArc(RectF(11f,20f,17f,26f),0f,180f,false,p);c.drawLine(14f,3f,14f,5f,p)
        if(!enabled)c.drawLine(3f,3f,25f,25f,p)
        c.restoreToCount(saved)
    }
}

internal class ChevronView(context:Context,private val color:Int,private val expanded:Boolean):View(context){
    init{importantForAccessibility=IMPORTANT_FOR_ACCESSIBILITY_NO}
    override fun onDraw(c:Canvas){val d=resources.displayMetrics.density
        val p=Paint(Paint.ANTI_ALIAS_FLAG).apply{this.color=this@ChevronView.color;style=Paint.Style.STROKE;strokeWidth=2.5f*d;strokeCap=Paint.Cap.ROUND;strokeJoin=Paint.Join.ROUND}
        val cy=height/2f;val direction=if(expanded)-1 else 1
        c.drawPath(Path().apply{moveTo(width/2f-8*d,cy-4*d*direction);lineTo(width/2f,cy+4*d*direction);lineTo(width/2f+8*d,cy-4*d*direction)},p)
    }
}

/** The bell follows the actual title width, with its extra hit area on the right. */
internal class BellHeading(context:Context,colors:Palette,val bell:NotificationBell):ViewGroup(context){
    private val title=TextView(context).apply{text="Сповіщення";textSize=20f;setTextColor(colors.ink);typeface=Typeface.create("sans-serif-medium",Typeface.NORMAL)
        tag="notification_heading";androidx.core.view.ViewCompat.setAccessibilityHeading(this,true)}
    private val d=resources.displayMetrics.density
    init{addView(title);addView(bell)}
    override fun onMeasure(w:Int,h:Int){
        val width=MeasureSpec.getSize(w);val free=(width-52*d).toInt().coerceAtLeast(0)
        title.measure(MeasureSpec.makeMeasureSpec(free,MeasureSpec.AT_MOST),MeasureSpec.makeMeasureSpec(0,MeasureSpec.UNSPECIFIED))
        bell.measure(MeasureSpec.makeMeasureSpec((48*d).toInt(),MeasureSpec.EXACTLY),MeasureSpec.makeMeasureSpec((48*d).toInt(),MeasureSpec.EXACTLY))
        setMeasuredDimension(width,resolveSize(maxOf(title.measuredHeight,bell.measuredHeight),h))
    }
    override fun onLayout(changed:Boolean,l:Int,t:Int,r:Int,b:Int){
        val ty=(height-title.measuredHeight)/2;title.layout(0,ty,title.measuredWidth,ty+title.measuredHeight)
        val x=title.right+(4*d).toInt();val y=(height-bell.measuredHeight)/2;bell.layout(x,y,x+bell.measuredWidth,y+bell.measuredHeight)
    }
}
