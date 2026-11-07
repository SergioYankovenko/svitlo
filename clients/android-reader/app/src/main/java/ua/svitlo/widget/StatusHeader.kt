package ua.svitlo.widget

import android.content.Context
import android.graphics.Typeface
import android.text.TextUtils
import android.view.View
import android.view.ViewGroup
import android.widget.TextView

/** Baseline-aligned header. Only the type fragment may ellipsize. */
class StatusHeader(context:Context,queue:String?,timer:String,colors:Palette,kind:String?=null,hideUnknownQueue:Boolean=false):ViewGroup(context) {
    private fun label(value:String,size:Float,color:Int,viewTag:String)=TextView(context).apply{
        text=value;textSize=size;setTextColor(color);tag=viewTag
        typeface=Typeface.create("sans-serif-medium",Typeface.NORMAL)
    }.also{addView(it)}
    private val title=label("Світло",22f,colors.accent,"app_title")
    private val queueText=label(queue?.let{"Черга $it"+(if(kind!=null)" | "else"")} ?: if(kind==null && !hideUnknownQueue)"Чергу не визначено"else"",14f,colors.muted,"header_queue")
    private val kindText=label(kind.orEmpty(),14f,colors.muted,"header_kind").apply{maxLines=1;ellipsize=TextUtils.TruncateAt.END;tooltipText=kind;contentDescription=kind}
    private var prefix=listOf("До відключення","До відновлення").firstOrNull{timer.startsWith(it)}
    private val caption=label(prefix ?: timer,13f,colors.muted,"countdown_label")
    private val value=label(prefix?.let{timer.removePrefix(it).trim()}.orEmpty(),13f,colors.muted,"current_countdown")
    private val gap=(12*resources.displayMetrics.density).toInt()
    private var stacked=false;private var baseline1=0;private var baseline2=0;private var contentBottom=0
    init {
        update(queue,timer,kind,hideUnknownQueue)
        setPadding(0,0,0,(24*resources.displayMetrics.density).toInt())
    }
    fun update(queue:String?,timer:String,kind:String?,hideUnknownQueue:Boolean){
        fun TextView.show(value:String){if(text.toString()!=value)text=value}
        queueText.show(queue?.let{"Черга $it"+(if(kind!=null)" | "else"")} ?: if(kind==null && !hideUnknownQueue)"Чергу не визначено"else"")
        kindText.show(kind.orEmpty());kindText.tooltipText=kind;kindText.contentDescription=kind
        prefix=listOf("До відключення","До відновлення").firstOrNull{timer.startsWith(it)}
        caption.show(prefix ?: timer);value.show(prefix?.let{timer.removePrefix(it).trim()}.orEmpty())
        queueText.contentDescription=queue?.let{"Черга $it"} ?: queueText.text
        queueText.importantForAccessibility=if(queueText.text.isEmpty())IMPORTANT_FOR_ACCESSIBILITY_NO else IMPORTANT_FOR_ACCESSIBILITY_AUTO
        kindText.importantForAccessibility=if(kind==null)IMPORTANT_FOR_ACCESSIBILITY_NO else IMPORTANT_FOR_ACCESSIBILITY_AUTO
        value.contentDescription=if(prefix!=null)timer else ""
    }
    override fun onMeasure(w:Int,h:Int){
        val width=MeasureSpec.getSize(w)
        val unspecified=MeasureSpec.makeMeasureSpec(0,MeasureSpec.UNSPECIFIED)
        listOf(title,queueText,kindText,caption,value).forEach{it.measure(MeasureSpec.makeMeasureSpec(width,MeasureSpec.AT_MOST),unspecified)}
        val right=maxOf(caption.measuredWidth,value.measuredWidth)
        stacked=maxOf(title.measuredWidth,queueText.measuredWidth+kindText.measuredWidth)+gap+right>width
        val leftLimit=if(stacked)width else (width-right-gap).coerceAtLeast(0)
        kindText.measure(MeasureSpec.makeMeasureSpec((leftLimit-queueText.measuredWidth).coerceAtLeast(0),MeasureSpec.AT_MOST),unspecified)
        baseline1=maxOf(title.baseline,if(stacked)0 else caption.baseline)
        val firstBottom=baseline1+maxOf(title.measuredHeight-title.baseline,if(stacked)0 else caption.measuredHeight-caption.baseline)
        val hasLeft=queueText.text.isNotEmpty() || kindText.text.isNotEmpty()
        val secondBaseline=maxOf(if(hasLeft)maxOf(queueText.baseline,kindText.baseline)else 0,if(stacked)0 else value.baseline)
        baseline2=firstBottom+(2*resources.displayMetrics.density).toInt()+secondBaseline
        contentBottom=baseline2+maxOf(if(hasLeft)maxOf(queueText.measuredHeight-queueText.baseline,kindText.measuredHeight-kindText.baseline)else 0,if(stacked)0 else value.measuredHeight-value.baseline)
        val bottom=contentBottom+if(stacked)gap+caption.measuredHeight+if(prefix!=null)value.measuredHeight else 0 else 0
        setMeasuredDimension(width,resolveSize(bottom+paddingBottom,h))
    }
    override fun onLayout(changed:Boolean,l:Int,t:Int,r:Int,b:Int){
        fun place(v:View,x:Int,y:Int){v.layout(x,y,x+v.measuredWidth,y+v.measuredHeight)}
        place(title,0,baseline1-title.baseline)
        place(queueText,0,baseline2-queueText.baseline);place(kindText,queueText.right,baseline2-kindText.baseline)
        if(stacked){place(caption,0,contentBottom+gap);place(value,0,caption.bottom)}
        else{place(caption,width-caption.measuredWidth,baseline1-caption.baseline);place(value,width-value.measuredWidth,baseline2-value.baseline)}
    }
}
