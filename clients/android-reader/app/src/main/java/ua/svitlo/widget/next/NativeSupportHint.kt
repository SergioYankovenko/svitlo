package ua.svitlo.widget.next

import android.content.Context
import android.graphics.*
import android.view.*
import android.widget.*
import org.json.JSONArray
import java.time.LocalDate

/** UI221–223: passive, pinned conversation, eligible after three distinct active
 * days. It never locks Home, intercepts scrolling or makes a paid claim. */
internal class NativeSupportHint(private val c:Context,private val root:FrameLayout,private val page:ScrollView,private val repo:NextRepository,private val blocked:()->Boolean){
    private val u=NextUi(c);private var layer:FrameLayout?=null;private var panel:LinearLayout?=null;private var blur:GuideBlur?=null
    private var anchorGap=0;private var target:View?=null;private var oldDescription:CharSequence?=null;private var stopped=false
    private val layoutListener=ViewTreeObserver.OnGlobalLayoutListener{sync()}
    private val scrollListener=ViewTreeObserver.OnScrollChangedListener{sync()}
    private val ring=RectF();private var ringVisible=false
    fun start(){
        val days=runCatching{JSONArray(repo.prefs.getString("supportDays","[]")).let{a->(0 until a.length()).map{LocalDate.parse(a.getString(it))}}}.getOrDefault(emptyList())
        repo.prefs.edit().putString("supportDays",JSONArray(GuidePolicy.activeDays(days,LocalDate.now(NEXT_ZONE)).map{it.toString()}).toString()).commit()
        root.viewTreeObserver.addOnGlobalLayoutListener(layoutListener);root.viewTreeObserver.addOnScrollChangedListener(scrollListener);root.post{sync()}
    }
    private fun relative(v:View):RectF{val bounds=Rect();v.getGlobalVisibleRect(bounds);val base=IntArray(2);root.getLocationOnScreen(base);return RectF(bounds).apply{offset(-base[0]-root.paddingLeft.toFloat(),-base[1]-root.paddingTop.toFloat())}}
    private fun visible(v:View):Boolean{val bounds=Rect();return v.isShown&&v.getGlobalVisibleRect(bounds)&&bounds.width()>=v.width&&bounds.height()>=v.height}
    private fun sync(){
        if(stopped||!root.isAttachedToWindow)return
        val button=root.findViewWithTag<View>("support_action") ?:return
        if(layer==null){
            val days=runCatching{JSONArray(repo.prefs.getString("supportDays","[]")).let{a->(0 until a.length()).map{LocalDate.parse(a.getString(it))}}}.getOrDefault(emptyList())
            if(!GuidePolicy.supportEligible(days,repo.prefs.getBoolean("supportClicked",false),repo.prefs.getBoolean("supportHintSeen",false),true,visible(button),blocked()))return
            show(button)
        }
        if(blocked()){close();return}
        val current=target ?:return;val tr=relative(current);val pr=relative(page);ring.set(tr);ring.inset(-u.dp(2).toFloat(),-u.dp(2).toFloat());ringVisible=visible(current)
        val conversation=panel ?:return
        val params=conversation.layoutParams as FrameLayout.LayoutParams;val top=maxOf(pr.top.toInt()+u.dp(8),pr.bottom.toInt()-conversation.measuredHeight-anchorGap)
        if(params.topMargin!=top){params.topMargin=top;conversation.layoutParams=params}
        val figure=conversation.getChildAt(1);val fr=RectF();val xy=IntArray(2);figure.getLocationOnScreen(xy);val base=IntArray(2);root.getLocationOnScreen(base);fr.set((xy[0]-base[0]-root.paddingLeft).toFloat(),(xy[1]-base[1]-root.paddingTop).toFloat(),(xy[0]-base[0]-root.paddingLeft+figure.width).toFloat(),(xy[1]-base[1]-root.paddingTop+figure.height).toFloat())
        val diameter=fr.width()*1.7f;blur?.apply{region=RectF(fr.centerX()-diameter/2,fr.centerY()-diameter/2,fr.centerX()+diameter/2,fr.centerY()+diameter/2);clearBelow=if(ringVisible)tr.top-u.dp(6)else pr.bottom;invalidate()};layer?.getChildAt(0)?.invalidate()
    }
    private fun show(button:View){
        target=button;repo.prefs.edit().putBoolean("supportHintSeen",true).commit()
        val copy=if(PrototypeScenes.compact(c))"Раді допомагати тобі! Можеш підтримати й нас."else"Ми раді допомагати тобі! Якщо хочеш, можеш підтримати й нас."
        oldDescription=button.contentDescription;button.contentDescription=(oldDescription ?:"Подякувати за додаток").toString()+". "+copy
        val overlay=FrameLayout(c).apply{tag="support_hint"}
        overlay.addView(object:View(c){val paint=Paint(Paint.ANTI_ALIAS_FLAG);override fun onDraw(canvas:Canvas){val path=Path().apply{fillType=Path.FillType.EVEN_ODD;addRect(0f,0f,width.toFloat(),height.toFloat(),Path.Direction.CW);if(ringVisible)addRoundRect(ring,u.dp(18).toFloat(),u.dp(18).toFloat(),Path.Direction.CW)};paint.style=Paint.Style.FILL;paint.color=0x99000000.toInt();canvas.drawPath(path,paint);if(ringVisible){paint.style=Paint.Style.STROKE;paint.strokeWidth=u.dp(2).toFloat();paint.color=u.p.accent;canvas.drawRoundRect(ring,u.dp(18).toFloat(),u.dp(18).toFloat(),paint)}}},FrameLayout.LayoutParams(-1,-1))
        blur=GuideBlur(c,root,.6f);overlay.addView(blur,FrameLayout.LayoutParams(-1,-1))
        val conversation=LinearLayout(c).apply{orientation=LinearLayout.HORIZONTAL;gravity=Gravity.BOTTOM;clipChildren=false}
        val bubble=u.column(12).apply{background=u.bg(u.p.surface,18)}
        u.add(bubble,u.text(copy).apply{setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX,minOf(textSize,u.dp(18).toFloat()))},0)
        u.add(bubble,u.button("Зрозуміло"){close()},10)
        val width=(root.width-root.paddingLeft-root.paddingRight)*.36f
        val figure=if(c.resources.configuration.screenHeightDp<=420)u.dp(112)else width.toInt().coerceIn(u.dp(120),u.dp(164))
        conversation.addView(bubble,LinearLayout.LayoutParams(0,-2,1f).apply{marginEnd=u.dp(10)})
        conversation.addView(NextMascot(c,"support-bowl-point-down-left-v2.webp"),LinearLayout.LayoutParams(figure,figure))
        overlay.addView(conversation,FrameLayout.LayoutParams(-1,-2).apply{leftMargin=u.dp(12);rightMargin=u.dp(12)})
        anchorGap=maxOf(u.dp(12),(relative(page).bottom-relative(button).top).toInt()+u.dp(12))
        panel=conversation;layer=overlay;root.addView(overlay,FrameLayout.LayoutParams(-1,-1));conversation.post{sync()}
    }
    fun close(){stopped=true;if(root.viewTreeObserver.isAlive){root.viewTreeObserver.removeOnGlobalLayoutListener(layoutListener);root.viewTreeObserver.removeOnScrollChangedListener(scrollListener)};target?.contentDescription=oldDescription;layer?.let(root::removeView);target=null;layer=null;panel=null;blur=null}
}
