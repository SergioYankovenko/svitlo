package ua.svitlo.widget.next

import android.content.Context
import android.graphics.*
import android.view.*
import android.widget.*
import java.time.LocalDate

/** UI254: explicit opt-in, REF-01 conditional steps, real underlying tab transitions. */
internal class NativeTour(private val context:Context,private val root:FrameLayout,private val repo:NextRepository,private val navigate:(String)->Unit,private val hint:Boolean=false,private val finished:()->Unit){
    private data class Step(val tab:String,val tag:String,val title:String,val copy:String)
    private val u=NextUi(context);private var layer:FrameLayout?=null;private var generation=0
    private var dockedScroll:Pair<ScrollView,LinearLayout.LayoutParams>?=null
    private var dockedNav:Pair<View,LinearLayout.LayoutParams>?=null
    private var index=if(hint)repo.prefs.getInt("addressHintStep",0).coerceIn(0,1)else if(repo.prefs.getString("tour",null)=="active")repo.prefs.getInt("tourStep",0)else 0
    private fun say(full:String,compact:String)=if(PrototypeScenes.compact(context))compact else full
    private val knownPlan=repo.active()?.let{repo.snapshot(it)?.day(LocalDate.now(NEXT_ZONE),it.lineId)}?.let{it.known&&it.totals().unknown==0L}==true
    private val steps=if(hint)listOf(Step("home","tour_address_rows","Адреси тепер тут","Замість «+» з’явилась стрілка зі списком адрес. Обирай адресу, а через олівець змінюй назву чи видаляй її."),Step("home","tour_list_add","Додай ще одну адресу","Натисни «Додати адресу» внизу списку, щоб додати наступну."))else buildList{
        if(repo.profiles().size==1)add(Step("home","tour_add","Додай ще одну адресу","Натисни «+», щоб додати ще одну адресу."))else add(Step("home","tour_address","Твоя адреса",say("Натисни адресу, щоб відкрити список. Через олівець там можна змінити назву або видалити адресу.","Натисни адресу: у списку обирай, перейменовуй чи видаляй через олівець.")))
        if(knownPlan)add(Step("home","tour_graph","Твій графік",say("Ось тут живе твій графік. Обирай день угорі.","Тут твій графік. Обирай день угорі.")))
        if(knownPlan||root.findViewWithTag<View>("tour_summaries")!=null)add(Step("home","tour_summaries","Підсумки дня",say("Тут підсумки дня: скільки часу зі світлом і без нього.","Тут час зі світлом і без нього за день.")))
        if(knownPlan)add(Step("home","tour_share","Поділись графіком",say("Тут можеш скопіювати графік і надіслати його у Viber чи інший застосунок.","Скопіюй графік і надішли у Viber чи інший застосунок.")))
        add(Step("messages","nav_messages","Повідомлення","Тут знайдеш повідомлення про зміни графіка й нові версії «Світла»."))
        add(Step("options","nav_options","Усе під тебе","В «Опціях» змінюй вигляд і нагадування та знаходь віджети."+if(!repo.prefs.getBoolean("preferencesComplete",false))" Крапка означає незавершені налаштування."else""))
    }
    fun start(){if(steps.isEmpty()){finished();return};index=index.coerceIn(0,steps.lastIndex);show()}
    private fun clear(){generation++;layer?.let{root.removeView(it)};layer=null;dockedScroll?.let{(view,params)->view.layoutParams=params};dockedScroll=null;dockedNav?.let{(view,params)->view.layoutParams=params};dockedNav=null;for(i in 0 until root.childCount)root.getChildAt(i).importantForAccessibility=View.IMPORTANT_FOR_ACCESSIBILITY_AUTO}
    private fun show(){
        clear();val step=steps[index]
        if(hint)repo.prefs.edit().putInt("addressHintStep",index).commit()else repo.prefs.edit().putString("tour","active").putInt("tourStep",index).commit()
        navigate(step.tab);val token=generation;val target=root.findViewWithTag<View>(step.tag) ?:run{next();return}
        var ancestor=target.parent;while(ancestor is View&&ancestor !is ScrollView)ancestor=ancestor.parent
        (ancestor as? ScrollView)?.let{val b=Rect();target.getDrawingRect(b);it.offsetDescendantRectToMyCoords(target,b);it.scrollTo(0,(b.top-u.dp(40)).coerceAtLeast(0))}
        target.post{
            if(token!=generation||!root.isAttachedToWindow)return@post
            val base=IntArray(2);root.getLocationOnScreen(base)
            fun targetRect():RectF{val r=Rect();target.getGlobalVisibleRect(r);return RectF(r).apply{offset(-base[0]-root.paddingLeft.toFloat(),-base[1]-root.paddingTop.toFloat())}}
            val rect=targetRect()
            val overlay=FrameLayout(context).apply{isClickable=true;isFocusable=true}
            androidx.core.view.ViewCompat.setAccessibilityPaneTitle(overlay,step.title)
            overlay.addView(object:View(context){val p=Paint(Paint.ANTI_ALIAS_FLAG);override fun onDraw(c:Canvas){val path=Path().apply{fillType=Path.FillType.EVEN_ODD;addRect(0f,0f,width.toFloat(),height.toFloat(),Path.Direction.CW);addRoundRect(rect,u.dp(16).toFloat(),u.dp(16).toFloat(),Path.Direction.CW)};p.color=0xB8000000.toInt();p.style=Paint.Style.FILL;c.drawPath(path,p);p.color=u.p.accent;p.style=Paint.Style.STROKE;p.strokeWidth=u.dp(2).toFloat();c.drawRoundRect(rect,u.dp(16).toFloat(),u.dp(16).toFloat(),p)}},FrameLayout.LayoutParams(-1,-1))
            val explanation=u.column(12)
            u.add(explanation,u.text(if(hint)"Підказка ${index+1} із 2"else"Крок ${index+1} із ${steps.size}",12f,u.p.muted),0);u.add(explanation,u.heading(step.title),4);u.add(explanation,u.text(step.copy),4)
            val forward=u.button(if(index==steps.lastIndex)"Зрозуміло"else"Далі"){next()}
            val controls=if(hint)u.actions(forward)else u.actions(u.button("Пропустити"){finish("deferred")},forward)
            controls.setPadding(u.dp(12),u.dp(8),u.dp(12),u.dp(12))
            val textScroll=ScrollView(context).apply{addView(explanation);isVerticalScrollBarEnabled=false}
            val contentHeight=root.height-root.paddingTop-root.paddingBottom
            val maximum=minOf(u.dp(330),contentHeight-u.dp(160)).coerceAtLeast(u.dp(130))
            val bubble=object:LinearLayout(context){init{orientation=VERTICAL;addView(textScroll);addView(controls)}
                override fun onMeasure(w:Int,h:Int){controls.measure(w,View.MeasureSpec.makeMeasureSpec(maximum,View.MeasureSpec.AT_MOST));textScroll.measure(w,View.MeasureSpec.makeMeasureSpec((maximum-controls.measuredHeight).coerceAtLeast(0),View.MeasureSpec.AT_MOST));setMeasuredDimension(View.MeasureSpec.getSize(w),controls.measuredHeight+textScroll.measuredHeight)}
            }.apply{background=u.bg(u.p.surface,18)}
            val availableWidth=root.width-root.paddingLeft-root.paddingRight
            val fw=(availableWidth/4).coerceIn(u.dp(78),u.dp(112));val fh=(fw*1.15f).toInt()
            bubble.measure(View.MeasureSpec.makeMeasureSpec(availableWidth-u.dp(34)-fw,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(maximum,View.MeasureSpec.AT_MOST))
            val height=maxOf(fh,bubble.measuredHeight)
            val nav=root.findViewWithTag<View>("nav_home")?.parent as? View
            val navTop=(nav?.let{val r=Rect();it.getGlobalVisibleRect(r);r.top-base[1]-root.paddingTop} ?:contentHeight).toFloat()
            val scroller=ancestor as? ScrollView
            if(scroller!=null&&target.height+height+u.dp(32)>navTop){
                val previous=LinearLayout.LayoutParams(scroller.layoutParams as LinearLayout.LayoutParams);dockedScroll=scroller to previous
                scroller.layoutParams=LinearLayout.LayoutParams(-1,(navTop-height-u.dp(32)).toInt().coerceAtLeast(u.dp(60)),0f)
                if(nav!=null){val old=LinearLayout.LayoutParams(nav.layoutParams as LinearLayout.LayoutParams);dockedNav=nav to old;nav.layoutParams=LinearLayout.LayoutParams(old).apply{topMargin=height+u.dp(32)}}
            }
            target.post{
                if(token!=generation||!root.isAttachedToWindow)return@post
                rect.set(targetRect())
                val top=when{dockedScroll!=null->navTop-height-u.dp(12);navTop-rect.bottom-u.dp(20)>=height->rect.bottom+u.dp(12);rect.top-u.dp(20)>=height->rect.top-height-u.dp(12);else->navTop-height-u.dp(12)}.coerceIn(u.dp(8).toFloat(),(contentHeight-height-u.dp(8)).coerceAtLeast(u.dp(8)).toFloat())
                val d=context.resources.displayMetrics.density.toDouble()
                val aim=GuidePolicy.pointing(GuidePolicy.Box(rect.left/d,rect.top/d,rect.right/d,rect.bottom/d),GuidePolicy.Box(12.0,top/d,(availableWidth-u.dp(12))/d,(top+height)/d),fw/d,fh/d)
                val fx=u.dp(12)+(if(aim.side=="right")availableWidth-u.dp(24)-fw else 0)+(aim.shift*d).toFloat();val fy=top+(aim.offset*d).toFloat();val diameter=fw*2.2f
                overlay.addView(GuideBlur(context,root).apply{region=RectF(fx+fw/2-diameter/2,fy+fh/2-diameter/2,fx+fw/2+diameter/2,fy+fh/2+diameter/2)},FrameLayout.LayoutParams(-1,-1))
                val row=FrameLayout(context).apply{clipChildren=false;clipToPadding=false}
                bubble.background=PrototypeScenes.speech(context,"",aim.side=="left").background
                row.addView(bubble,FrameLayout.LayoutParams(availableWidth-u.dp(34)-fw,-2).apply{gravity=if(aim.side=="right")Gravity.START else Gravity.END})
                val figure=FrameLayout(context).apply{clipChildren=false;importantForAccessibility=View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS}
                figure.addView(NextMascot(context,"tour-point-${aim.pose}-v3.webp"),FrameLayout.LayoutParams((fw*1.35).toInt(),(fh*1.35).toInt()).apply{leftMargin=(-fw*.175).toInt();topMargin=(-fh*.175).toInt()})
                row.addView(figure,FrameLayout.LayoutParams(fw,fh).apply{gravity=if(aim.side=="right")Gravity.END else Gravity.START;leftMargin=(aim.shift*d).toInt();topMargin=(aim.offset*d).toInt()})
                overlay.addView(row,FrameLayout.LayoutParams(availableWidth-u.dp(24),height).apply{leftMargin=u.dp(12);topMargin=top.toInt()})
                for(i in 0 until root.childCount)root.getChildAt(i).importantForAccessibility=View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
                root.addView(overlay,FrameLayout.LayoutParams(-1,-1));layer=overlay;forward.requestFocus();bubble.announceForAccessibility(step.title+". "+step.copy)
            }
        }
    }
    private fun next(){index++;if(index>=steps.size)finish("completed")else show()}
    private fun finish(status:String){if(hint)repo.prefs.edit().putString("addressHint","seen").remove("addressHintStep").commit()else repo.prefs.edit().putString("tour",status).remove("tourStep").commit();close();if(status=="completed")navigate("home")}
    fun dismiss(){finish("deferred")}
    fun close(){clear();finished()}
}
