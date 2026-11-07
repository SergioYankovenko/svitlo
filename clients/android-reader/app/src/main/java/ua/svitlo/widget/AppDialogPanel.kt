package ua.svitlo.widget

import android.app.AlertDialog
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.InputType
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import kotlin.math.roundToInt

/** Shared chrome; the caller continues to own selection, cancellation and persistence. */
internal class AppDialogPanel(val context:Context,title:String,subtitle:String="",prefix:String="app_dialog") {
    val colors=Palette.app(context)
    fun dp(value:Int)=(value*context.resources.displayMetrics.density).roundToInt()
    fun rounded(color:Int,radius:Int=12)=GradientDrawable().apply{setColor(color);cornerRadius=dp(radius).toFloat()}
    val header=LinearLayout(context).apply{orientation=LinearLayout.VERTICAL;setPadding(dp(20),dp(20),dp(20),dp(16))}
    val heading=TextView(context).apply{
        text=title;textSize=18f;setTextColor(colors.ink);tag="${prefix}_title"
        typeface=Typeface.create("sans-serif-medium",Typeface.NORMAL)
        androidx.core.view.ViewCompat.setAccessibilityHeading(this,true)
    }
    val detail=TextView(context).apply{
        text=subtitle;textSize=14f;setTextColor(colors.ink);tag="${prefix}_context"
        maxLines=1;ellipsize=TextUtils.TruncateAt.END;setHorizontallyScrolling(false);tooltipText=subtitle
    }
    val divider=View(context).apply{tag="${prefix}_divider";setBackgroundColor(colors.track);importantForAccessibility=View.IMPORTANT_FOR_ACCESSIBILITY_NO}
    val body=FrameLayout(context).apply{setPadding(dp(20),0,dp(20),0)}
    val actions=LinearLayout(context).apply{
        orientation=LinearLayout.VERTICAL;isBaselineAligned=false;tag="${prefix}_actions"
        setPadding(dp(20),dp(8),dp(20),dp(20));visibility=View.GONE
    }
    // Measure fixed chrome first. Only the body yields space to the keyboard or
    // a small screen, so neither the title nor actions can be pushed off screen.
    val content=object:LinearLayout(context){
        init{orientation=VERTICAL;tag="svitlo_dialog_panel";background=rounded(colors.surface,24)}
        override fun onMeasure(widthMeasureSpec:Int,heightMeasureSpec:Int){
            val width=MeasureSpec.getSize(widthMeasureSpec)
            val limit=if(MeasureSpec.getMode(heightMeasureSpec)==MeasureSpec.UNSPECIFIED)
                (resources.displayMetrics.heightPixels*.85f).roundToInt() else MeasureSpec.getSize(heightMeasureSpec)
            val w=MeasureSpec.makeMeasureSpec(width,MeasureSpec.EXACTLY)
            fun measureChrome(){
                header.measure(w,MeasureSpec.makeMeasureSpec(limit,MeasureSpec.AT_MOST))
                if(actions.visibility!=GONE)actions.measure(w,MeasureSpec.makeMeasureSpec((limit-header.measuredHeight).coerceAtLeast(0),MeasureSpec.AT_MOST))
            }
            // The keyboard height varies between devices. A fixed viewport
            // threshold alone misses large-font layouts with no room for results.
            fitSearchViewport(false)
            measureChrome()
            val regularBodyRoom=limit-header.measuredHeight-if(actions.visibility==GONE)0 else actions.measuredHeight
            if(prefix=="address_picker" && (limit<dp(360) || regularBodyRoom<dp(144))){
                fitSearchViewport(true)
                measureChrome()
            }
            val footerLimit=(limit-header.measuredHeight).coerceAtLeast(0)
            val footer=if(actions.visibility==GONE)0 else actions.measuredHeight
            body.measure(w,MeasureSpec.makeMeasureSpec((footerLimit-footer).coerceAtLeast(0),MeasureSpec.AT_MOST))
            setMeasuredDimension(resolveSize(width,widthMeasureSpec),resolveSize(header.measuredHeight+body.measuredHeight+footer,heightMeasureSpec))
        }
    }
    private var compactSearch=false
    private fun fitSearchViewport(compact:Boolean){
        if(compactSearch==compact)return
        compactSearch=compact
        val unit=if(compact)TypedValue.COMPLEX_UNIT_PX else TypedValue.COMPLEX_UNIT_SP
        heading.setTextSize(unit,if(compact)dp(16).toFloat()else 18f)
        detail.setTextSize(unit,if(compact)dp(12).toFloat()else 14f)
        header.setPadding(dp(20),dp(if(compact)12 else 20),dp(20),dp(if(compact)8 else 16))
        (divider.layoutParams as LinearLayout.LayoutParams).topMargin=dp(if(compact)8 else 14)
        fun fields(view:View){
            if(view is EditText){view.setTextSize(unit,if(compact)dp(16).toFloat()else 16f);view.setPadding(dp(12),dp(if(compact)8 else 12),dp(12),dp(if(compact)8 else 12))}
            if(view is android.view.ViewGroup)for(i in 0 until view.childCount)fields(view.getChildAt(i))
        }
        fields(body)
        actions.orientation=if(compact)LinearLayout.HORIZONTAL else LinearLayout.VERTICAL
        actions.setPadding(dp(20),dp(8),dp(20),dp(if(compact)12 else 20))
        for(i in 0 until actions.childCount){
            val action=actions.getChildAt(i) as Button
            action.setTextSize(unit,if(compact)dp(14).toFloat()else 15f)
            action.layoutParams=LinearLayout.LayoutParams(if(compact)0 else -1,-2,if(compact)1f else 0f).apply{
                if(i>0){if(compact)marginStart=dp(8)else topMargin=dp(8)}
            }
        }
    }
    init {
        header.addView(heading,LinearLayout.LayoutParams(-1,-2))
        if(subtitle.isNotEmpty())header.addView(detail,LinearLayout.LayoutParams(-1,-2).apply{topMargin=dp(4)})
        header.addView(divider,LinearLayout.LayoutParams(-1,dp(1)).apply{topMargin=dp(14)})
        content.addView(header,LinearLayout.LayoutParams(-1,-2))
        content.addView(body,LinearLayout.LayoutParams(-1,-2))
        content.addView(actions,LinearLayout.LayoutParams(-1,-2))
        androidx.core.view.ViewCompat.setAccessibilityPaneTitle(content,title)
    }
    fun text(value:String,tagValue:String?=null)=TextView(context).apply{
        text=value;textSize=14f;setTextColor(colors.ink);tag=tagValue
    }
    fun input(hintValue:String,tagValue:String)=EditText(context).apply{
        hint=hintValue;tag=tagValue;contentDescription=hintValue;isSingleLine=true
        textSize=16f;inputType=InputType.TYPE_CLASS_TEXT;ellipsize=TextUtils.TruncateAt.END
        setTextColor(colors.ink)
        val light=AppAppearance.light(context)
        setHintTextColor(if(light)Color.rgb(100,114,95)else Color.rgb(184,197,181))
        background=rounded(if(light)Color.rgb(244,247,240)else Color.rgb(59,81,67)).apply{
            setStroke(dp(1),if(light)Color.rgb(214,224,208)else Color.rgb(98,117,102))
        }
        backgroundTintList=null;minHeight=dp(48);minimumHeight=dp(48)
        setPadding(dp(12),dp(12),dp(12),dp(12));stateListAnimator=null;elevation=0f
    }
    fun button(label:String,tagValue:String,cancel:Boolean=false,selected:Boolean=false,truncate:Boolean=false)=Button(context).apply{
        text=label;tag=tagValue;isAllCaps=false;textSize=15f;typeface=Typeface.create("sans-serif",Typeface.NORMAL)
        minWidth=0;minimumWidth=0;minHeight=dp(48);minimumHeight=dp(48)
        setPadding(dp(12),dp(10),dp(12),dp(10));gravity=Gravity.START or Gravity.CENTER_VERTICAL
        setSingleLine(true);ellipsize=if(truncate)TextUtils.TruncateAt.END else null
        setHorizontallyScrolling(false);isSelected=selected
        val light=AppAppearance.light(context)
        background=rounded(when{cancel->if(light)Color.rgb(248,236,233)else Color.rgb(59,44,41);selected->colors.track;else->colors.background})
        setTextColor(when{cancel->if(light)Color.rgb(153,80,72)else Color.rgb(224,170,160);selected->colors.ink;else->colors.accent})
        stateListAnimator=null;elevation=0f;translationZ=0f
        if(truncate)tooltipText=label
    }
    fun setBody(view:View,scroll:Boolean=true){
        body.removeAllViews()
        val child=if(scroll)ScrollView(context).apply{isFillViewport=false;addView(view);tag="${heading.tag.toString().removeSuffix("_title")}_body"}else view
        body.addView(child,FrameLayout.LayoutParams(-1,-2))
        if(actions.visibility==View.GONE)body.setPadding(dp(20),0,dp(20),dp(20))
    }
    fun footer(buttons:List<Button>,horizontal:Boolean=false,proportional:Boolean=false){
        actions.removeAllViews();actions.visibility=if(buttons.isEmpty())View.GONE else View.VISIBLE
        actions.orientation=if(horizontal)LinearLayout.HORIZONTAL else LinearLayout.VERTICAL
        body.setPadding(dp(20),0,dp(20),if(buttons.isEmpty())dp(20)else 0)
        for((index,button)in buttons.withIndex()){
            if(proportional)button.setAutoSizeTextTypeUniformWithConfiguration(12,15,1,TypedValue.COMPLEX_UNIT_SP)
            val weight=if(horizontal)if(proportional)button.paint.measureText(button.text.toString())+button.paddingLeft+button.paddingRight else 1f else 0f
            actions.addView(button,LinearLayout.LayoutParams(if(horizontal)0 else -1,-2,weight).apply{
                if(index>0){if(horizontal)marginStart=dp(8)else topMargin=dp(8)}
            })
        }
    }
    fun show():AlertDialog=AppDialogs.builder(context).setView(content).create().also{
        it.show();AppDialogs.style(it)
        it.window?.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
    }
}
