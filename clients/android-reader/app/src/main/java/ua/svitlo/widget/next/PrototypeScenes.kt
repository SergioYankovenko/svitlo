package ua.svitlo.widget.next

import android.app.Dialog
import android.content.Context
import android.graphics.*
import android.graphics.drawable.Drawable
import android.os.Build
import android.view.*
import android.widget.*
import ua.svitlo.widget.AppAppearance
import ua.svitlo.widget.PowerGlyph
import kotlin.math.min

/** Native counterpart of adaptation.css privacy-conversation / onboarding mascot-speech.
 * This character scene intentionally has no ordinary dialog title, divider or outer card.
 */
internal object PrototypeScenes {
    fun compact(c:Context)=c.resources.configuration.fontScale>=1.5f||c.resources.configuration.screenWidthDp/c.resources.configuration.fontScale<340
    fun speech(c:Context,text:String,tailLeft:Boolean=false):TextView {
        val u=NextUi(c)
        return u.text(text,14f,u.p.ink).apply{setPadding(u.dp(14),u.dp(14),u.dp(14),u.dp(14));background=Bubble(c,tailLeft);accessibilityLiveRegion=View.ACCESSIBILITY_LIVE_REGION_POLITE}
    }
    fun conversation(c:Context,text:String,asset:String,mascotLeft:Boolean=false,loading:Boolean=false,settle:String?=null):View {
        val u=NextUi(c);val stack=compact(c)&&mascotLeft
        val row=LinearLayout(c).apply{orientation=if(stack)LinearLayout.VERTICAL else LinearLayout.HORIZONTAL;gravity=Gravity.BOTTOM;clipChildren=false;clipToPadding=false}
        val bubble=speech(c,text,mascotLeft)
        val portrait=NextMascot(c,asset,loading,settle)
        val narrow=c.resources.configuration.screenWidthDp<=350
        val figureWidth=if(mascotLeft)if(narrow)120 else 156 else if(narrow)116 else 150
        val figureHeight=if(mascotLeft)if(stack)200 else if(narrow)200 else 250 else 165
        if(stack){row.addView(bubble,LinearLayout.LayoutParams(-1,-2));row.addView(portrait,LinearLayout.LayoutParams(u.dp(156),u.dp(figureHeight)).apply{gravity=Gravity.END})}
        else{
            val mascotParams=LinearLayout.LayoutParams(u.dp(figureWidth),u.dp(figureHeight))
            val bubbleParams=LinearLayout.LayoutParams(0,-2,1f).apply{gravity=Gravity.CENTER_VERTICAL;if(mascotLeft)marginStart=u.dp(10)else marginEnd=u.dp(10)}
            if(mascotLeft){row.addView(portrait,mascotParams);row.addView(bubble,bubbleParams)}else{row.addView(bubble,bubbleParams);row.addView(portrait,mascotParams)}
        }
        return row
    }
    fun primary(c:Context,label:String,action:()->Unit)=NextUi(c).button(label,action=action).apply{val u=NextUi(c);background=u.bg(u.p.accent,16);setTextColor(u.p.background)}
    /** UI247/248: the extended lower torso is occluded by the following form. */
    fun onboarding(c:Context,text:String,asset:String,loading:Boolean=false,settle:String?=null)=object:ViewGroup(c){
        val u=NextUi(c);val bubble=speech(c,text);val portrait=NextMascot(c,asset,loading,settle)
        val large=compact(c)
        init{clipChildren=false;clipToPadding=false;addView(bubble);addView(portrait)}
        override fun onMeasure(w:Int,h:Int){val width=MeasureSpec.getSize(w);val figure=u.dp(if(large)132 else 164);bubble.measure(MeasureSpec.makeMeasureSpec(if(large)width else (width-figure-u.dp(8)).coerceAtLeast(u.dp(80)),MeasureSpec.EXACTLY),MeasureSpec.makeMeasureSpec(0,MeasureSpec.UNSPECIFIED));portrait.measure(MeasureSpec.makeMeasureSpec(figure,MeasureSpec.EXACTLY),MeasureSpec.makeMeasureSpec(u.dp(if(large)165 else 205),MeasureSpec.EXACTLY));setMeasuredDimension(width,if(large)bubble.measuredHeight+u.dp(112)else maxOf(u.dp(140),bubble.measuredHeight+u.dp(22)))}
        override fun onLayout(changed:Boolean,l:Int,t:Int,r:Int,b:Int){bubble.layout(0,0,bubble.measuredWidth,bubble.measuredHeight);val bottom=height+u.dp(if(large)18 else 73);portrait.layout(width-portrait.measuredWidth,bottom-portrait.measuredHeight,width,bottom)}
    }
    fun privacy(activity:NextActivity,accepted:()->Unit):Dialog {
        val u=NextUi(activity);val dialog=Dialog(activity)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        val body=u.column(12)
        val copy=if(compact(activity))"Я не використовую GPS. Адреси зберігаю на телефоні, а для пошуку звертаюся до Обленерго та сервера «Світло»." else "Я не використовую GPS. Список твоїх адрес зберігаю на телефоні. Для пошуку графіка звертаюся до Обленерго та сервера «Світло»."
        u.add(body,conversation(activity,copy,"privacy-shield-guide-v1.webp",mascotLeft=true),0)
        u.add(body,primary(activity,"Розумію"){dialog.dismiss();accepted()},0)
        val scroll=ScrollView(activity).apply{isVerticalScrollBarEnabled=false;addView(body)}
        dialog.setContentView(scroll)
        dialog.setCanceledOnTouchOutside(false)
        dialog.window?.apply{setBackgroundDrawableResource(android.R.color.transparent);addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);setDimAmount(.62f)}
        dialog.show()
        dialog.window?.setLayout(min(activity.resources.displayMetrics.widthPixels-u.dp(24),u.dp(520)),WindowManager.LayoutParams.WRAP_CONTENT)
        dialog.window?.decorView?.contentDescription="Твої дані"
        return dialog
    }
    fun welcome(c:Context,start:()->Unit):View {
        val u=NextUi(c);val frame=FrameLayout(c)
        val demo=WelcomeIllustration(c).apply{importantForAccessibility=View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS;if(Build.VERSION.SDK_INT>=31)setRenderEffect(RenderEffect.createBlurEffect(u.dp(2).toFloat(),u.dp(2).toFloat(),Shader.TileMode.CLAMP))}
        frame.addView(demo,FrameLayout.LayoutParams(-1,u.dp(520)))
        frame.addView(View(c).apply{setBackgroundColor(if(AppAppearance.light(c))0x70F3F7EE else 0x5514251E)},FrameLayout.LayoutParams(-1,u.dp(520)))
        val content=u.column(10).apply{tag="welcome_conversation"}
        u.add(content,conversation(c,"Привіт! Ось так виглядатиме твій графік.","welcome-card.webp"),0)
        u.add(content,primary(c,"Додати мою адресу",start),0)
        frame.addView(content,FrameLayout.LayoutParams(-1,-2).apply{topMargin=u.dp(130)})
        frame.minimumHeight=u.dp(520)
        return frame
    }
    private class Bubble(c:Context,private val left:Boolean):Drawable(){
        val u=NextUi(c);val paint=Paint(Paint.ANTI_ALIAS_FLAG)
        override fun draw(canvas:Canvas){val b=RectF(bounds);paint.color=u.p.surface;paint.style=Paint.Style.FILL;canvas.drawRoundRect(b,u.dp(18).toFloat(),u.dp(18).toFloat(),paint);val y=b.top+b.height()*.6f;val x=if(left)b.left else b.right;val delta=if(left)-u.dp(6).toFloat()else u.dp(6).toFloat();val path=Path().apply{moveTo(x,y-u.dp(6));lineTo(x+delta,y);lineTo(x,y+u.dp(6));close()};canvas.drawPath(path,paint);paint.style=Paint.Style.STROKE;paint.color=u.p.track;paint.strokeWidth=u.dp(1).toFloat();canvas.drawRoundRect(b,u.dp(18).toFloat(),u.dp(18).toFloat(),paint)}
        override fun setAlpha(alpha:Int){paint.alpha=alpha}
        override fun setColorFilter(filter:ColorFilter?){paint.colorFilter=filter}
        @Deprecated("opacity")override fun getOpacity()=PixelFormat.TRANSLUCENT
    }
    /** Read-only welcome artwork from the approved sample, never a stored/live address or plan. */
    private class WelcomeIllustration(c:Context):View(c){val u=NextUi(c);val paint=Paint(Paint.ANTI_ALIAS_FLAG)
        override fun onDraw(canvas:Canvas){val p=u.p;paint.color=p.surface;canvas.drawRoundRect(RectF(0f,0f,width.toFloat(),height.toFloat()),u.dp(22).toFloat(),u.dp(22).toFloat(),paint);val inset=u.dp(12).toFloat();val gap=u.dp(5).toFloat();val cell=(width-2*inset-3*gap)/4;paint.textAlign=Paint.Align.CENTER;paint.textSize=u.dp(12).toFloat();for((i,label)in listOf("Пн","Вт","Ср","Чт","Пт","Сб","Нд").withIndex()){paint.color=p.muted;canvas.drawText(label,(i+.5f)*width/7,u.dp(30).toFloat(),paint)};for(i in 0..23){val x=inset+(i%4)*(cell+gap);val y=u.dp(58)+(i/4)*u.dp(65);paint.color=if(i in listOf(4,5,12,13,20,21))p.hourly else p.background;canvas.drawRoundRect(RectF(x,y.toFloat(),x+cell,y+u.dp(58).toFloat()),u.dp(13).toFloat(),u.dp(13).toFloat(),paint);paint.color=if(i in listOf(4,5,12,13,20,21))p.outageIcon else p.ink;canvas.drawText("${i.toString().padStart(2,'0')}:00",x+cell/2,y+u.dp(34).toFloat(),paint)};paint.color=p.muted;canvas.drawText("ϟ Світло є     ϟ Світла немає",width/2f,u.dp(490).toFloat(),paint)}
    }
}
