package ua.svitlo.widget

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.*
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.*
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.*
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.*
import androidx.core.content.ContextCompat
import ua.svitlo.widget.core.*
import java.time.Instant
import java.time.LocalDate
import android.provider.Settings
import android.content.res.ColorStateList
import java.time.format.DateTimeFormatter
import java.util.concurrent.Executors
import java.util.concurrent.Future

class MainActivity:Activity() {
    private val executor=Executors.newSingleThreadExecutor()
    private val handler=Handler(Looper.getMainLooper())
    private lateinit var column:LinearLayout
    private lateinit var colors:Palette
    private lateinit var repo:OutageRepository
    private lateinit var weather:WeatherRepository
    private lateinit var addressApi:AddressApi
    private var screen="home"
    private var selectedDate=LocalDate.now(KYIV_ZONE)
    private var explicitDate=false
    private var profilesExpanded=false
    private var weatherScrollX=0
    private var pinRequestLeftActivity=false
    private var widgetPinPrompt:WidgetPinPrompt?=null
    private var widgetPinMessage=""
    private val pageScrolls=mutableMapOf<String,Int>()
    private data class PageFocus(val keyboardTag:String?,val keyboardTouchMode:Boolean,val accessibilityTag:String?)
    private var pendingPageFocus:PageFocus?=null
    private var returningExactPermission=false
    private var generation=0
    private var busy=false
    private var activeProgress:ProgressDialogCompat?=null
    private var activeWork:Future<*>?=null
    private var activeDeadline:Runnable?=null
    private var requestSerial=0
    private var shownSettingsState:List<Any?>?=null
    private var shownHomeBinding:ConfirmedBinding?=null
    private var shownHomeSchedule:List<Any?>?=null
    private var shownHomeSummary:List<Any?>?=null
    private var shownHomeNotices:List<Any?>?=null
    private var shownHomeProfiles:List<AddressProfile>?=null
    private var shownInboxState:List<Any?>?=null
    private var departments:List<AddressItem> = emptyList()
    private var department:AddressItem?=null
    private var city:AddressItem?=null
    private var street:AddressItem?=null
    private var house:String?=null
    private var changingAccount=false
    private var addingProfile=false
    private var pendingProfileName:String?=null
    private val geoPreferences by lazy { getSharedPreferences("svitlo_geo",MODE_PRIVATE) }
    private val updates=object:BroadcastReceiver(){override fun onReceive(c:Context,i:Intent){
        if(i.action==WidgetPins.ADDED){pinFeedback(WidgetPins.addedMessage(i.getBooleanExtra("compact",false)));return}
        if(screen=="settings" && !busy)refreshSettings(onlyIfChanged=true)else redraw()
    }}
    private val tick=object:Runnable{override fun run(){MessageNotifications.announce(this@MainActivity);redraw();handler.postDelayed(this,60_000)}}

    override fun attachBaseContext(base:Context){super.attachBaseContext(AppAppearance.context(base))}

    override fun onCreate(savedInstanceState:Bundle?) {
        setTheme(if(AppAppearance.light(this))R.style.SvitloAppLight else R.style.SvitloAppDark)
        super.onCreate(savedInstanceState)
        colors=Palette.app(this);repo=OutageRepository(this);weather=WeatherRepository(this);addressApi=AddressApi(this)
        runCatching{weather.discardTravelLocation()}
        geoPreferences.edit().clear().putBoolean("enabled",false).apply()
        window.statusBarColor=colors.background;window.navigationBarColor=colors.background
        if(Build.VERSION.SDK_INT<30)window.decorView.systemUiVisibility=0
        if(savedInstanceState!=null && (repo.binding()!=null || savedInstanceState.getString("screen") in listOf("inbox","settings"))){
            selectedDate=runCatching{LocalDate.parse(savedInstanceState.getString("selected_date"))}.getOrDefault(selectedDate)
            explicitDate=savedInstanceState.getBoolean("explicit_date",savedInstanceState.getString("screen")=="graph")
            profilesExpanded=savedInstanceState.getBoolean("profiles_expanded")
            weatherScrollX=savedInstanceState.getInt("weather_scroll")
            pinRequestLeftActivity=savedInstanceState.getBoolean("pin_left")
            widgetPinMessage=savedInstanceState.getString("widget_pin_message","")
            returningExactPermission=savedInstanceState.getBoolean("returning_exact")
            savedInstanceState.getBundle("page_scrolls")?.let{b->b.keySet().forEach{pageScrolls[it]=b.getInt(it)}}
            showPage(savedInstanceState.getString("screen","home"))
            savedInstanceState.getString("focused_control")?.let { tag ->
                restorePageFocus(PageFocus(tag,savedInstanceState.getBoolean("focused_touch"),if(savedInstanceState.getBoolean("focused_accessibility"))tag else null))
            }
        }else route(intent)
    }
    override fun onSaveInstanceState(outState:Bundle){
        saveScroll();outState.putString("screen",screen);outState.putString("selected_date",selectedDate.toString());outState.putInt("weather_scroll",weatherScrollX);outState.putBoolean("pin_left",pinRequestLeftActivity || WidgetPins.hasPending())
        outState.putString("widget_pin_message",widgetPinMessage)
        outState.putBoolean("explicit_date",explicitDate)
        outState.putBoolean("profiles_expanded",profilesExpanded)
        val focused=descendants(window.decorView).firstOrNull{it.isAccessibilityFocused} ?: window.decorView.findFocus()
        (focused?.tag as? String)?.let{outState.putString("focused_control",it);outState.putBoolean("focused_accessibility",focused.isAccessibilityFocused);outState.putBoolean("focused_touch",focused.isFocusableInTouchMode)}
        outState.putBoolean("returning_exact",returningExactPermission)
        outState.putBundle("page_scrolls",Bundle().apply{pageScrolls.forEach{(key,value)->putInt(key,value)}})
        super.onSaveInstanceState(outState)
    }
    override fun onNewIntent(intent:Intent){super.onNewIntent(intent);setIntent(intent);route(intent)}
    private fun route(intent:Intent){
        if(intent.getStringExtra("screen")=="inbox"){
            intent.getStringExtra("message_id")?.let{id->val messages=RemoteMessageRepository(this);if(messages.visible().any{it.id==id})messages.markViewed(id)}
            inboxPage();return
        }
        intent.getStringExtra("profile_id")?.let{id->
            val profiles=AddressProfiles(this)
            val target=profiles.profiles().firstOrNull{it.id==id}
            if(target==null){dashboard();note("Цю адресу вже видалено");return}
            if(profiles.active()?.id!=id){
                ScheduleNotifications.cancel(this);RefreshWorker.cancel(this)
                if(!profiles.activate(id)){dashboard();note("Не вдалося відкрити адресу");return}
                clearSourceAttemptTimes();pageScrolls.clear();profilesExpanded=false;weatherScrollX=0
                RefreshWorker.schedule(this);ScheduleNotifications.rebuild(this);WidgetRenderer.enqueueUpdate(this)
            }
        }
        if(repo.binding()==null)setup()
        else {
            explicitDate=intent.hasExtra("date")
            selectedDate=runCatching{LocalDate.parse(intent.getStringExtra("date"))}.getOrDefault(LocalDate.now(KYIV_ZONE))
            val page=intent.getStringExtra("screen") ?: "home"
            if(screen=="home" && page in listOf("home","graph","weather") && shownHomeBinding==repo.binding())refreshHome()
            else showPage(page)
            if(weather.location()==null && !RefreshWorker.running(this))RefreshWorker.request(this)
        }
    }
    private fun showPage(name:String){when(name){"graph"->dashboard();"inbox"->inboxPage();"settings","options"->settings();"weather"->weatherPage();"diagnostics"->diagnostics();else->dashboard()}}
    override fun onStart(){super.onStart();RefreshWorker.schedule(this);MessageWorker.schedule(this);ActiveInstallWorker.schedule(this);ContextCompat.registerReceiver(this,updates,IntentFilter(RefreshWorker.UPDATED).apply{addAction(AppUpdateWorker.UPDATED);addAction(WidgetPins.ADDED)},ContextCompat.RECEIVER_NOT_EXPORTED)}
    override fun onStop(){unregisterReceiver(updates);super.onStop()}
    override fun onResume(){
        super.onResume();handler.removeCallbacks(tick);handler.post(tick);RefreshWorker.requestIfStale(this)
        if(returningExactPermission){returningExactPermission=false;ScheduleNotifications.rebuild(this)}
        if(screen=="settings")refreshSettings(onlyIfChanged=true)
        MessageNotifications.announce(this)
    }
    override fun onPause(){handler.removeCallbacks(tick);super.onPause()}
    override fun onDestroy(){widgetPinPrompt?.close();generation++;cancelBackground();executor.shutdownNow();handler.removeCallbacksAndMessages(null);super.onDestroy()}
    @Deprecated("Native back compatibility") override fun onBackPressed(){if(screen=="home" && profilesExpanded){profilesExpanded=false;profileFocusRedraw()}else if(screen=="setup" || screen=="confirm"){backAddressStep()}else if(screen in listOf("diagnostics","weather") && repo.binding()!=null){settings()}else if(screen!="home" && repo.binding()!=null){dashboard()}else super.onBackPressed()}

    private fun dp(value:Int)=(value*resources.displayMetrics.density).toInt()
    private fun saveScroll(){
        if(!::column.isInitialized)return
        (column.parent as? ScrollView)?.let{pageScrolls[screen]=it.scrollY}
        descendants(column).filterIsInstance<HorizontalScrollView>().firstOrNull{it.tag=="weather_hours"}?.let{weatherScrollX=it.scrollX}
    }
    private fun redraw(){
        if(busy || !::column.isInitialized || screen !in listOf("home","inbox","weather","diagnostics"))return
        if(screen=="home"){refreshHome();return}
        if(screen=="inbox" && shownInboxState==inboxState())return
        val keyboard=window.decorView.findFocus()
        val accessibility=descendants(window.decorView).firstOrNull{it.isAccessibilityFocused}
        val focus=pendingPageFocus ?: PageFocus(keyboard?.tag as? String,
            keyboard?.isFocusableInTouchMode ?: false,accessibility?.tag as? String)
        pendingPageFocus=focus
        saveScroll();showPage(screen)
        restorePageFocus(focus)
    }
    private fun descendants(view:View):List<View> = listOf(view)+if(view is ViewGroup)(0 until view.childCount).flatMap{descendants(view.getChildAt(it))}else emptyList()
    private fun restorePageFocus(focus:PageFocus){
        if(focus.keyboardTag==null && focus.accessibilityTag==null){pendingPageFocus=null;return}
        pendingPageFocus=focus
        val content=column;val token=generation
        var restored=false
        fun restore(){
            if(restored)return
            restored=true
            if(isDestroyed || generation!=token || column!==content)return
            val views=descendants(window.decorView)
            if(focus.accessibilityTag==null)focus.keyboardTag?.let{tag->views.firstOrNull{it.tag==tag}?.let{
                if(focus.keyboardTouchMode)it.isFocusableInTouchMode=true
                it.requestFocus()
            }}
            val accessibilityTarget=focus.accessibilityTag?.let{tag->views.firstOrNull{it.tag==tag}}
            if(accessibilityTarget!=null){
                accessibilityTarget.requestRectangleOnScreen(android.graphics.Rect(0,0,accessibilityTarget.width,accessibilityTarget.height),true)
                accessibilityTarget.postOnAnimation{
                    if(!isDestroyed && generation==token && column===content){
                        accessibilityTarget.performAccessibilityAction(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS,null)
                        if(pendingPageFocus===focus)pendingPageFocus=null
                    }
                }
            }else if(pendingPageFocus===focus)pendingPageFocus=null
        }
        // Rebuilt views must be attached and laid out before Android accepts accessibility focus.
        val layout=object:View.OnLayoutChangeListener{
            override fun onLayoutChange(v:View,l:Int,t:Int,r:Int,b:Int,oldL:Int,oldT:Int,oldR:Int,oldB:Int){
                v.removeOnLayoutChangeListener(this);v.post{restore()}
            }
        }
        content.addOnLayoutChangeListener(layout)
        content.post{if(content.isLaidOut && !content.isLayoutRequested){content.removeOnLayoutChangeListener(layout);restore()}}
    }
    private fun root(name:String,subtitle:String) {
        if(name!=screen)pendingPageFocus=null
        saveScroll();generation++;screen=name;colors=Palette.app(this);shownHomeBinding=null
        val shell=LinearLayout(this).apply{orientation=LinearLayout.VERTICAL;setBackgroundColor(colors.background)}
        val scroll=ScrollView(this).apply {tag="page_scroll";isFillViewport=true;clipToPadding=true}
        column=LinearLayout(this).apply{orientation=LinearLayout.VERTICAL;setPadding(dp(18),dp(14),dp(18),dp(22))}
        scroll.addView(column);shell.addView(scroll,LinearLayout.LayoutParams(-1,0,1f))
        if((repo.binding()!=null && name !in listOf("setup","confirm")) || (repo.binding()==null && name!="confirm")){
            val nav=MatchingLabelRow(this,true,singleLineLabels=true).apply{tag="bottom_navigation";orientation=LinearLayout.HORIZONTAL;setPadding(dp(4),dp(6),dp(4),dp(6));setBackgroundColor(colors.surface)}
            val active=when(name){"settings","weather","diagnostics"->"settings";else->name}
            for((key,label) in listOf("home" to "Головна","inbox" to "Повідомлення","settings" to "Опції")){
                val item=Button(this).apply{
                    tag="navigation:$key"
                    text=label;isAllCaps=false;textSize=15f
                    setTextColor(if(active==key)colors.background else colors.muted);isSelected=active==key
                    background=rounded(if(active==key)colors.accent else colors.surface,14)
                    stateListAnimator=null;elevation=0f;translationZ=0f
                    minWidth=0;minimumWidth=0;minHeight=dp(54);setPadding(dp(3),dp(8),dp(3),dp(8));fitLabel(this,15)
                    contentDescription=label+if(active==key)", обрано"else""
                    setOnClickListener{if(!busy){if(key=="home"){explicitDate=false;selectedDate=LocalDate.now(KYIV_ZONE)};showPage(key)}}
                };nav.addView(item,LinearLayout.LayoutParams(0,-2,if(key=="inbox")1.5f else 1f).apply{marginStart=dp(2);marginEnd=dp(2)})
            };shell.addView(nav,LinearLayout.LayoutParams(-1,-2))
        }
        setContentView(shell)
        window.statusBarColor=colors.background;window.navigationBarColor=colors.surface
        if(Build.VERSION.SDK_INT>=30){
            val flags=WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            window.insetsController?.setSystemBarsAppearance(if(AppAppearance.light(this))flags else 0,flags)
        }
        if(Build.VERSION.SDK_INT<30)window.decorView.systemUiVisibility=if(AppAppearance.light(this))View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR else 0
        shell.setOnApplyWindowInsetsListener { v,insets ->
            if(Build.VERSION.SDK_INT>=30){val bars=insets.getInsets(WindowInsets.Type.systemBars());v.setPadding(bars.left,bars.top,bars.right,bars.bottom)}
            else v.setPadding(insets.systemWindowInsetLeft,insets.systemWindowInsetTop,insets.systemWindowInsetRight,insets.systemWindowInsetBottom)
            insets
        }
        val data=repo.snapshot()
        if(name=="home"){
            val now=Instant.now()
            column.addView(StatusHeader(this,data.queueLabel(),homeStatus(data,now),colors,
                ScheduleLabels.contextKind(selectedDate,data,now)?.label,data.explicitHourlyExclusion()),LinearLayout.LayoutParams(-1,-2))
        }else text(column,"Світло",22,true,colors.accent).apply{tag="app_title";setPadding(0,0,0,dp(24))}
        if(subtitle.isNotBlank() && name!="home")text(column,subtitle,13,false,colors.muted).setPadding(0,0,0,dp(14))
        scroll.post{scroll.scrollTo(0,pageScrolls[name] ?: 0)}
    }
    private fun homeStatus(data:Snapshot,now:Instant):String=when {
        data.categories.isEmpty()->"Дані недоступні"
        data.explicitHourlyExclusion() && data.checkedEmptyToday(now.atZone(KYIV_ZONE).toLocalDate(),now)->ScheduleLabels.NO_OUTAGES
        data.queueLabel()==null && !data.explicitHourlyExclusion() && Timeline.nextOutage(data,now)==null->"Чергу не визначено"
        data.isCompleteAndFresh(now) && Timeline.nextOutage(data,now)==null->"Не заплановано"
        else->Presentation.remainingTime(data,now).replace("залишилося ","").replace("До ввімкнення","До відновлення")
    }
    private fun compactActions(parent:LinearLayout)=CompactActionRow(this).also{
        parent.addView(it,LinearLayout.LayoutParams(-1,-2).apply{topMargin=dp(16)})
    }
    private fun divider(parent:LinearLayout,space:Int=16){parent.addView(View(this).apply{setBackgroundColor(colors.track)},LinearLayout.LayoutParams(-1,dp(1)).apply{topMargin=dp(space);bottomMargin=dp(space)})}
    private fun settingsState():List<Any?> = listOf(NotificationAccess.read(this),ScheduleNotifications.exactAllowed(this),
        AppAppearance.light(this),AppAppearance.twoRows(this),AppAppearance.bulbs(this),ScheduleNotifications.lead(this),AppUpdateRepository(this).enabled())+
        listOf("before_off","before_on","tomorrow","changes","emergency").map{ScheduleNotifications.enabled(this,it)}
    private fun refreshSettings(onlyIfChanged:Boolean=false){
        if(!::column.isInitialized)return
        if(onlyIfChanged && shownSettingsState==settingsState())return
        val keyboard=window.decorView.findFocus();val accessibility=descendants(window.decorView).firstOrNull{it.isAccessibilityFocused}
        val focus=pendingPageFocus ?: PageFocus(keyboard?.tag as? String,keyboard?.isFocusableInTouchMode ?: false,accessibility?.tag as? String)
        saveScroll();settings();restorePageFocus(focus)
    }
    private fun rounded(color:Int,radius:Int=16)=GradientDrawable().apply{setColor(color);cornerRadius=dp(radius).toFloat()}
    private fun text(parent:LinearLayout,value:String,size:Int=16,bold:Boolean=false,color:Int=colors.ink):TextView = TextView(this).apply {
        text=value;textSize=size.toFloat();setTextColor(color);if(bold)typeface=Typeface.create("sans-serif-medium",Typeface.NORMAL)
        setLineSpacing(dp(3).toFloat(),1f);parent.addView(this,LinearLayout.LayoutParams(-1,-2))
    }
    private fun card(parent:LinearLayout=column):LinearLayout=LinearLayout(this).apply {
        orientation=LinearLayout.VERTICAL;setPadding(dp(18),dp(18),dp(18),dp(18))
        background=GradientDrawable().apply{setColor(this@MainActivity.colors.surface);cornerRadius=dp(22).toFloat();setStroke(dp(1),this@MainActivity.colors.track)}
        parent.addView(this,LinearLayout.LayoutParams(-1,-2).apply{bottomMargin=dp(14)})
    }
    private fun button(parent:LinearLayout,label:String,action:()->Unit):Button=Button(this).apply {
        tag="${parent.tag ?: screen}:action:$label"
        text=label;isAllCaps=false;textSize=15f;setTextColor(colors.accent);minHeight=dp(48)
        background=rounded(colors.background);setPadding(dp(if(parent is CompactActionRow)8 else 12),dp(10),dp(if(parent is CompactActionRow)8 else 12),dp(10));minWidth=0;minimumWidth=0
        fitLabel(this,if(parent is CompactActionRow)14 else 15);stateListAnimator=null;elevation=0f;translationZ=0f
        parent.addView(this,LinearLayout.LayoutParams(-1,-2).apply{topMargin=dp(if(parent.childCount>0 && parent.getChildAt(parent.childCount-1) is Button)8 else 16)});setOnClickListener{if(!busy)action()}
    }
    private fun actionRow(parent:LinearLayout)=MatchingLabelRow(this,true).apply{
        orientation=LinearLayout.HORIZONTAL
        parent.addView(this,LinearLayout.LayoutParams(-1,-2).apply{topMargin=dp(16)})
    }
    private fun note(value:String){Toast.makeText(this,value,Toast.LENGTH_LONG).show()}
    private fun cancelSetupRequest(){
        activeProgress?.dismiss();activeProgress=null;busy=false
        setup() // A new screen generation makes the delayed response ineligible.
    }
    private fun cancelBackground(){
        requestSerial++;activeWork?.cancel(true);activeWork=null
        activeDeadline?.let(handler::removeCallbacks);activeDeadline=null
        activeProgress?.dismiss();activeProgress=null;busy=false
    }
    private fun <T> background(label:String,work:()->T,timeoutMs:Long?=null,done:(T)->Unit){
        if(busy)return
        busy=true;val token=generation;val serial=++requestSerial
        val cancel: (() -> Unit)?=when {
            changingAccount -> ::cancelAccountChange
            screen in listOf("setup","confirm") -> ::cancelSetupRequest
            else -> null
        }
        val progress=ProgressDialogCompat(this,label,cancel?.let{{cancelBackground();it()}})
        activeProgress=progress
        fun failure(error:Throwable){
            AppDialogs.builder(this).setTitle("Не вдалося отримати дані")
                .setMessage(if(error is SetupDataUnavailable)error.message else (if(!RefreshWorker.online(this))"Немає підключення до інтернету"else SourceFailure.of(error).messageText)+if(repo.snapshot().categories.isNotEmpty())". Збережені дані залишаються доступними."else". Дані ще не отримано.")
                .setPositiveButton("Повторити"){_,_->if(token==generation && !isDestroyed && !isFinishing)background(label,work,timeoutMs,done)}
                .setNegativeButton("Закрити",null).show().also(AppDialogs::style)
        }
        if(timeoutMs!=null){
            val deadline=Runnable{if(serial==requestSerial && token==generation && !isDestroyed && !isFinishing){
                cancelBackground();failure(java.net.SocketTimeoutException())
            }}
            activeDeadline=deadline;handler.postDelayed(deadline,timeoutMs)
        }
        activeWork=executor.submit {
            val result=runCatching(work)
            runOnUiThread {
                if(serial!=requestSerial)return@runOnUiThread
                activeDeadline?.let(handler::removeCallbacks);activeDeadline=null;activeWork=null
                progress.dismiss();if(activeProgress===progress){activeProgress=null;busy=false}
                if(isDestroyed || isFinishing || token!=generation)return@runOnUiThread
                result.fold(done,::failure)
            }
        }
    }
    private fun <T> choose(title:String,items:List<T>,label:(T)->String,
        emptyMessage:String?=null,alternativeLabel:String?=null,alternative:(()->Unit)?=null,selected:(T)->Unit):AlertDialog?{
        if(items.isEmpty() && emptyMessage==null){note("У сервісі немає варіантів для цього вибору");return null}
        val token=generation
        val panel=AppDialogPanel(this,title.substringBefore(" · "),title.substringAfter(" · ",""),"address_picker")
        val query=panel.input("Пошук","address_picker_search")
        val box=LinearLayout(this).apply{orientation=LinearLayout.VERTICAL;addView(query,LinearLayout.LayoutParams(-1,-2))}
        val body=object:FrameLayout(this){
            override fun onMeasure(widthMeasureSpec:Int,heightMeasureSpec:Int){
                val available=if(MeasureSpec.getMode(heightMeasureSpec)==MeasureSpec.UNSPECIFIED)dp(360)else MeasureSpec.getSize(heightMeasureSpec)
                super.onMeasure(widthMeasureSpec,MeasureSpec.makeMeasureSpec(minOf(dp(360),available),MeasureSpec.AT_MOST))
            }
        }
        box.addView(body,LinearLayout.LayoutParams(-1,-2).apply{topMargin=dp(4)})
        val list=ListView(this).apply{tag="address_picker_list";divider=null;cacheColorHint=colors.surface}
        body.addView(list,FrameLayout.LayoutParams(-1,-2))
        val empty=panel.text(emptyMessage ?: "Нічого не знайдено. Спробуйте інший пошук.","address_picker_empty")
            .apply{maxLines=1;ellipsize=android.text.TextUtils.TruncateAt.END;tooltipText=text}
        val emptyScroll=ScrollView(this).apply{addView(empty)}
        body.addView(emptyScroll,FrameLayout.LayoutParams(-1,-2));list.emptyView=emptyScroll
        var filtered=items
        lateinit var dialog:AlertDialog
        var selectedOnce=false
        fun select(item:T){
            if(selectedOnce || !dialog.isShowing || token!=generation || isDestroyed || isFinishing || item !in filtered)return
            selectedOnce=true;dialog.dismiss();selected(item)
        }
        val adapter=object:BaseAdapter(){
            override fun getCount()=filtered.size
            override fun getItem(position:Int)=label(filtered[position])
            override fun getItemId(position:Int)=position.toLong()
            override fun getView(position:Int,recycled:View?,parent:ViewGroup):View {
                val item=filtered[position];val value=label(item)
                return FrameLayout(this@MainActivity).apply{
                    setPadding(0,dp(4),0,dp(4));contentDescription=value
                    tag="address_picker_row:$position"
                    // A single real click target owns the whole row. An inert
                    // native Button inside a ListView can still consume touches
                    // on vendor Android builds despite clickable=false.
                    isFocusable=false;setOnClickListener{select(item)}
                    addView(panel.text(value,"address_picker_item:$position").apply{
                        textSize=15f;setTextColor(colors.accent)
                        typeface=Typeface.create("sans-serif",Typeface.NORMAL)
                        minHeight=dp(48);minimumHeight=dp(48)
                        setPadding(dp(12),dp(10),dp(12),dp(10));gravity=Gravity.START or Gravity.CENTER_VERTICAL
                        maxLines=1;ellipsize=android.text.TextUtils.TruncateAt.END
                        background=panel.rounded(colors.background)
                        importantForAccessibility=View.IMPORTANT_FOR_ACCESSIBILITY_NO
                    },FrameLayout.LayoutParams(-1,-2))
                }
            }
        }
        list.adapter=adapter;panel.setBody(box,scroll=false)
        val cancel=panel.button("Скасувати","address_picker_cancel",cancel=true)
        val back=if(alternativeLabel!=null && alternative!=null)panel.button(alternativeLabel,"address_picker_alternative")else null
        panel.footer(listOfNotNull(back,cancel))
        dialog=panel.show()
        cancel.setOnClickListener{dialog.dismiss()}
        back?.setOnClickListener{dialog.dismiss();if(token==generation && !isDestroyed && !isFinishing)alternative?.invoke()}
        query.addTextChangedListener(object:TextWatcher{
            override fun beforeTextChanged(s:CharSequence?,start:Int,count:Int,after:Int){}
            override fun onTextChanged(s:CharSequence?,start:Int,before:Int,count:Int){
                filtered=items.filter{label(it).contains(s.toString(),true)};adapter.notifyDataSetChanged()
            }
            override fun afterTextChanged(s:Editable?){}
        })
        list.setOnItemClickListener{_,_,position,_->filtered.getOrNull(position)?.let(::select)}
        return dialog
    }

    private fun clearAccountDraft(){
        changingAccount=false;addingProfile=false;pendingProfileName=null;department=null;city=null;street=null;house=null;departments=emptyList()
    }
    private fun startAccountChange(){
        if(repo.binding()==null)return setup()
        clearAccountDraft();changingAccount=true;setup()
    }
    private fun cancelAccountChange(){
        activeProgress?.dismiss();activeProgress=null;busy=false
        clearAccountDraft();dashboard()
    }
    private fun setup(){
        root("setup",if(addingProfile)""else if(changingAccount)"Зміна адреси" else "Налаштування адреси")
        val address=card();text(address,"Оберіть вашу адресу",24,true)
        val selected=listOfNotNull(department?.name,city?.name,street?.name,house?.let{"Будинок $it"})
        if(selected.isNotEmpty())text(address,selected.joinToString(" · "),14,false,colors.muted)
        when{
            department==null->button(address,"1. Обрати філію"){chooseDepartment()}
            city==null->button(address,"2. Населений пункт"){chooseCity(department!!)}
            street==null->button(address,"3. Вулиця"){chooseStreet(city!!)}
            house==null->button(address,"4. Будинок"){chooseHouse(street!!)}
            else->button(address,"Будинок $house"){chooseHouse(street!!)}
        }
        if(department!=null)button(address,"Назад"){backAddressStep()}
        if(changingAccount)button(column,"Скасувати зміну"){cancelAccountChange()}
    }
    private fun backAddressStep(){
        activeProgress?.dismiss();activeProgress=null;busy=false
        if(screen=="confirm" || house!=null){house=null;pendingProfileName=null}
        else if(street!=null)street=null
        else if(city!=null)city=null
        else if(department!=null)department=null
        else if(changingAccount){cancelAccountChange();return}
        else {super.onBackPressed();return}
        setup()
    }
    private fun verifyAddress(){
        if(!canVerifyAddress())return
        val branch=department!!;val locality=city!!;val road=street!!;val building=house!!
        val previousBinding=repo.binding()
        background("Перевірка адреси…",{addressApi.resolve(road.id,building)}) { result ->
            if(department!=branch || city!=locality || street!=road || house!=building)return@background
            if(repo.binding()!=previousBinding){note("Адреса вже змінилася. Перевірте поточні дані.");cancelAccountChange();return@background}
            val selection=DictionaryAddress(branch.id,locality.id,locality.name,road.id,road.name,building)
            when(result){
                is AddressResolution.Unique -> confirmAddressWithSelection(result.value.account,result.value.address,locality.name,selection)
                AddressResolution.Empty -> {
                    confirmAddressWithSelection("",selection.label,locality.name,selection)
                }
                AddressResolution.Ambiguous -> AppDialogs.builder(this).setTitle("Адреса неоднозначна")
                    .setMessage("Для цього будинку сервіс повернув кілька рахунків або різні адреси. Автоматично обрати ваш неможливо. Уточніть дані в Черкасиобленерго.").setPositiveButton("Зрозуміло",null).show().also(AppDialogs::style)
            }
        }
    }
    private fun canVerifyAddress()=department!=null && city!=null && street!=null && !house.isNullOrBlank()
    private fun chooseDepartment(){
        background("Завантаження філій…",{addressApi.departments()}){items->
            departments=items
            choose("Філія",items,{it.name},emptyMessage="У довіднику немає філій. Повторіть завантаження пізніше."){chosen->
                department=chosen;city=null;street=null;house=null;setup();chooseCity(chosen)
            }
        }
    }
    private fun chooseCity(branch:AddressItem){
        background("Завантаження міст і сіл…",{addressApi.cities(branch.id)}){items->
            if(department?.id!=branch.id)return@background
            choose("Населений пункт · ${branch.name}",items,{it.name},
                emptyMessage="Нічого не знайдено в цій філії. Змініть пошук або оберіть іншу філію.",
                alternativeLabel="Змінити філію",alternative={department=null;city=null;street=null;house=null;setup();chooseDepartment()}){chosen->
                city=chosen;street=null;house=null;setup();chooseStreet(chosen)
            }
        }
    }
    private fun chooseStreet(place:AddressItem){
        background("Завантаження вулиць…",{addressApi.streets(place.id)}){items->
            if(city?.id!=place.id)return@background
            choose("Вулиця · ${place.name}",items,{it.name},emptyMessage="У цьому населеному пункті нічого не знайдено. Змініть пошук або населений пункт.",
                alternativeLabel="Інше місто/село",alternative={city=null;street=null;house=null;setup();department?.let{chooseCity(it)}}){chosen->
                street=chosen;house=null;setup();chooseHouse(chosen)
            }
        }
    }
    private fun chooseHouse(road:AddressItem){
        background("Завантаження будинків…",{addressApi.houses(road.id)}){items->
            if(street?.id!=road.id)return@background
            choose("Будинок · ${road.name}",items,{it},emptyMessage="На цій вулиці нічого не знайдено. Змініть пошук або вулицю.",
                alternativeLabel="Змінити вулицю",alternative={street=null;house=null;setup();city?.let{chooseStreet(it)}}){house=it;setup();verifyAddress()}
        }
    }
    private fun confirmAddress(account:String,address:String,locality:String){
        confirmAddressWithSelection(account,address,locality,null)
    }
    private fun confirmAddressWithSelection(account:String,address:String,locality:String,selection:DictionaryAddress?){
        val replacing=changingAccount
        val previousBinding=repo.binding()
        val previousToken=repo.generationToken()
        root("confirm",if(replacing)"Підтвердження нової адреси" else "Підтвердження адреси")
        val panel=AppDialogPanel(this,"Це ваша адреса?",address,"address_confirmation")
        panel.detail.tag="confirmed_address"
        val name=panel.input("Назва адреси (необов’язково)","profile_name").apply{
            setText(if(addingProfile)pendingProfileName.orEmpty() else pendingProfileName ?: AddressProfiles(this@MainActivity).active()?.name.orEmpty())
            inputType=InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            filters=arrayOf(android.text.InputFilter.LengthFilter(32))
        }
        panel.setBody(name,scroll=false)
        val yes=panel.button("Так","confirm_yes")
        yes.setOnClickListener{
            pendingProfileName=name.text.toString().trim()
            background("Отримуємо графік…",{InitialScheduleLoader.forAddress(this,repo,account,address,locality,selection).load()},60_000){prepared->
                if(repo.binding()!=previousBinding || repo.generationToken()!=previousToken){note("Прив’язування вже змінилося. Перевірте поточні дані.");cancelAccountChange();return@background}
                ScheduleNotifications.cancel(this)
                val bound=AddressProfiles(this).confirm(account,address,prepared,locality,pendingProfileName,addingProfile,selection)
                if(bound){
                    ScheduleNotifications.cancel(this)
                    clearSourceAttemptTimes()
                    RefreshWorker.cancel(this)
                    if(runCatching{weather.clear()}.isFailure)note("Адресу збережено. Погоду повторно налаштуємо під час оновлення.")
                    geoPreferences.edit().remove("history").remove("last_check").remove("snooze_until").apply()
                    clearAccountDraft();RefreshWorker.schedule(this);WidgetRenderer.enqueueUpdate(this);selectWeather()
                }
                else {ScheduleNotifications.rebuild(this);note("Не вдалося зберегти прив’язування. Повторіть перевірку.");setup()}
            }
        }
        val no=panel.button("Ні","confirm_no",cancel=true).apply{
            setOnClickListener{if(changingAccount)cancelAccountChange()else{house=null;setup()}}
        }
        panel.footer(listOf(yes,no),horizontal=true)
        column.addView(panel.content,LinearLayout.LayoutParams(-1,-2).apply{topMargin=dp(8)})
    }
    private fun singleLine(view:TextView):TextView=TextSizing.singleLine(view,21)
    private fun fitLabel(view:TextView,maxSize:Int):TextView=TextSizing.singleLine(view,maxSize)
    private fun profileLabel(profile:AddressProfile)=listOf(profile.name.takeIf{it.isNotBlank()},profile.binding.address).filterNotNull().joinToString(": ")
    private fun addressProfilesCard(){
        val profiles=AddressProfiles(this);val active=profiles.active();val items=profiles.profiles()
        val binding=active?.binding ?: repo.binding() ?: return
        val box=card().apply{tag="address_profiles"}
        val selectable=items.size>1
        if(!selectable)profilesExpanded=false
        val selected=LinearLayout(this).apply{tag="active_profile_block";orientation=LinearLayout.HORIZONTAL;gravity=Gravity.CENTER_VERTICAL;minimumHeight=dp(48)}
        box.addView(selected,LinearLayout.LayoutParams(-1,-2))
        val lines=LinearLayout(this).apply{orientation=LinearLayout.VERTICAL;importantForAccessibility=View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS}
        selected.addView(lines,LinearLayout.LayoutParams(0,-2,1f))
        val name=active?.name.orEmpty()
        val primary=name.ifBlank{binding.dictionary?.city ?: binding.city.ifBlank{binding.address.substringBefore(',')}}
        val secondary=if(name.isNotBlank())binding.address else binding.dictionary?.let{"${it.street}, ${it.house}"}
            ?: binding.address.removePrefix(primary).trim().trimStart(',').trim().ifBlank{binding.address}
        fun line(value:String,size:Int,bold:Boolean,tagValue:String)=text(lines,value,size,bold,if(bold)colors.accent else colors.muted).apply{
            tag=tagValue;maxLines=1;ellipsize=android.text.TextUtils.TruncateAt.END;setHorizontallyScrolling(false);includeFontPadding=false;tooltipText=value
        }
        line(primary,21,true,"active_profile_name")
        line(secondary,14,false,"active_profile_address").apply{layoutParams=(layoutParams as LinearLayout.LayoutParams).apply{topMargin=dp(1)}}
        selected.contentDescription=listOf(primary,secondary).joinToString(". ")+if(selectable)". Обрати адресу. "+if(profilesExpanded)"Розгорнуто"else"Згорнуто" else ""
        selected.isFocusable=true
        if(selectable){
            selected.addView(ChevronView(this,colors.accent,profilesExpanded),LinearLayout.LayoutParams(dp(32),dp(32)).apply{marginStart=dp(8)})
            selected.setOnClickListener{profilesExpanded=!profilesExpanded;profileFocusRedraw()}
        }
        if(profilesExpanded)for(profile in items){
            val isActive=profile.id==active?.id
            val row=LinearLayout(this).apply{tag="profile_choice:${profile.id}";orientation=LinearLayout.HORIZONTAL;gravity=Gravity.CENTER_VERTICAL;isFocusable=true;minimumHeight=dp(48)
                setPadding(dp(10),dp(10),dp(8),dp(10));background=rounded(if(isActive)colors.track else colors.background,12)
                contentDescription=profileLabel(profile)+if(isActive)". Активна адреса"else". Обрати адресу"}
            box.addView(row,LinearLayout.LayoutParams(-1,-2).apply{topMargin=dp(8)})
            val labels=LinearLayout(this).apply{orientation=LinearLayout.VERTICAL;importantForAccessibility=View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS}
            row.addView(labels,LinearLayout.LayoutParams(0,-2,1f))
            if(profile.name.isNotBlank())text(labels,profile.name,18,true)
            text(labels,profile.binding.address,14,false,colors.muted)
            row.setOnClickListener{profilesExpanded=false;if(!isActive)activateAddressProfile(profile);profileFocusRedraw()}
        }
        val actions=compactActions(box)
        chip(actions,"Додати адресу",false){profilesExpanded=false;addAddressProfile()}
        chip(actions,"Керувати адресами",false){manageAddressProfiles()}
    }
    private fun profileFocusRedraw(){
        val manager=getSystemService(android.view.accessibility.AccessibilityManager::class.java)
        val focus=PageFocus("active_profile_block",false,if(manager.isTouchExplorationEnabled)"active_profile_block"else null)
        saveScroll();dashboard();restorePageFocus(focus)
    }

    private fun askProfileName(title:String,initial:String="",saved:(String)->Unit){
        val panel=AppDialogPanel(this,title,prefix="profile_name_dialog")
        val input=panel.input("Назва адреси","profile_rename_input").apply{
            setText(initial);inputType=InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            filters=arrayOf(android.text.InputFilter.LengthFilter(32))
        }
        panel.setBody(input,scroll=false)
        val cancel=panel.button("Скасувати","profile_rename_cancel",cancel=true)
        val save=panel.button("Далі","profile_rename_save")
        panel.footer(listOf(cancel,save),horizontal=true)
        val dialog=panel.show()
        cancel.setOnClickListener{dialog.dismiss()}
        save.setOnClickListener{val name=input.text.toString().trim();dialog.dismiss();saved(name)}
    }
    private fun addAddressProfile(){
        if(AddressProfiles(this).profiles().size>=AddressProfiles.MAX_PROFILES){note("Можна зберегти до ${AddressProfiles.MAX_PROFILES} адрес");return}
        clearAccountDraft();changingAccount=repo.binding()!=null;addingProfile=true;setup()
    }
    private fun chooseSavedAddress(){
        val profiles=AddressProfiles(this);val active=profiles.active()
        val items=profiles.profiles()
        AppDialogs.builder(this).setTitle("Оберіть адресу")
            .setItems(items.map{"${if(it.id==active?.id)"✓ "else""}${profileLabel(it)}"}.toTypedArray()){_,index->if(items[index].id!=active?.id)activateAddressProfile(items[index])}
            .setNegativeButton("Скасувати",null).show().also(AppDialogs::style)
    }
    private fun activateAddressProfile(profile:AddressProfile){
        if(busy)return
        ScheduleNotifications.cancel(this);RefreshWorker.cancel(this)
        if(AddressProfiles(this).activate(profile.id)){
            ScheduleNotifications.cancel(this);RefreshWorker.cancel(this)
            clearSourceAttemptTimes()
            runCatching{weather.clear()};geoPreferences.edit().remove("history").remove("last_check").remove("snooze_until").apply()
            clearAccountDraft();explicitDate=false;selectedDate=LocalDate.now(KYIV_ZONE);weatherScrollX=0;pageScrolls.clear()
            RefreshWorker.schedule(this);WidgetRenderer.enqueueUpdate(this);selectWeather();ScheduleNotifications.rebuild(this)
        }else{RefreshWorker.schedule(this);ScheduleNotifications.rebuild(this);note("Не вдалося перемкнути адресу. Поточні дані збережено.")}
    }
    private fun clearSourceAttemptTimes(){getSharedPreferences("svitlo_runtime",MODE_PRIVATE).edit().remove("address_attempt").remove("feed_attempt").remove("weather_attempt").apply()}
    private fun manageAddressProfiles():AlertDialog {
        val profiles=AddressProfiles(this);val active=profiles.active();val items=profiles.profiles()
        val panel=AppDialogPanel(this,"Збережені адреси",prefix="saved_addresses")
        val adapter=object:BaseAdapter(){
            override fun getCount()=items.size
            override fun getItem(position:Int)=items[position]
            override fun getItemId(position:Int)=items[position].id.hashCode().toLong()
            override fun getView(position:Int,recycled:View?,parent:ViewGroup):View {
                val profile=items[position];val isActive=profile.id==active?.id
                val outer=FrameLayout(this@MainActivity).apply{
                    tag="managed_profile:${profile.id}";setPadding(0,dp(4),0,dp(4));isSelected=isActive
                    contentDescription=profileLabel(profile)+if(isActive)". Активна адреса. Керувати адресою"else". Керувати адресою"
                }
                val card=LinearLayout(this@MainActivity).apply{
                    orientation=LinearLayout.VERTICAL;minimumHeight=dp(48);setPadding(dp(12),dp(12),dp(12),dp(12))
                    background=panel.rounded(if(isActive)colors.track else colors.background)
                    importantForAccessibility=View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
                }
                if(profile.name.isNotBlank())panel.text(profile.name).apply{
                    typeface=Typeface.create("sans-serif-medium",Typeface.NORMAL)
                    card.addView(this,LinearLayout.LayoutParams(-1,-2))
                }
                card.addView(panel.text(profile.binding.address),LinearLayout.LayoutParams(-1,-2))
                outer.addView(card,FrameLayout.LayoutParams(-1,-2));return outer
            }
        }
        val list=ListView(this).apply{tag="saved_addresses_list";this.adapter=adapter;divider=null;cacheColorHint=colors.surface}
        panel.setBody(list,scroll=false)
        val done=panel.button("Готово","managed_done").apply{gravity=Gravity.CENTER}
        val add=panel.button("Додати адресу","managed_add").apply{gravity=Gravity.CENTER}
        panel.footer(listOf(done,add),horizontal=resources.configuration.fontScale<1.5f,proportional=true)
        val dialog=panel.show()
        list.setOnItemClickListener{_,_,index,_->dialog.dismiss();profileActions(items[index])}
        done.setOnClickListener{dialog.dismiss()}
        add.setOnClickListener{dialog.dismiss();addAddressProfile()}
        return dialog
    }
    private fun profileActions(profile:AddressProfile):AlertDialog{
        val profiles=AddressProfiles(this);val active=profile.id==profiles.active()?.id
        val panel=AppDialogPanel(this,"Керування адресою",profile.binding.address,"profile_actions")
        val rows=LinearLayout(this).apply{orientation=LinearLayout.VERTICAL}
        val rename=panel.button("Перейменувати","profile_action_rename")
        val delete=panel.button("Видалити адресу","profile_action_delete").apply{
            // The existing storage contract protects the currently active binding.
            isEnabled=!active;alpha=if(active).5f else 1f
            if(active)contentDescription="Видалити адресу. Спочатку оберіть іншу активну адресу на головному екрані"
        }
        val cancel=panel.button("Відмінити","profile_action_cancel",cancel=true)
        listOf(rename,delete,cancel).forEachIndexed{index,view->rows.addView(view,LinearLayout.LayoutParams(-1,-2).apply{if(index>0)topMargin=dp(8)})}
        panel.setBody(rows)
        val dialog=panel.show()
        cancel.setOnClickListener{dialog.dismiss()}
        rename.setOnClickListener{dialog.dismiss();askProfileName("Назва адреси",profile.name){name->if(profiles.rename(profile.id,name))showPage(screen)else note("Не вдалося зберегти назву")}}
        delete.setOnClickListener{
            dialog.dismiss()
            val confirmation=AppDialogPanel(this,"Видалити адресу?",profile.name.ifBlank{profile.binding.address},"profile_delete")
            confirmation.setBody(confirmation.text("Збережену адресу та її локальний графік буде видалено. Активна адреса залишиться доступною."))
            val keep=confirmation.button("Залишити","profile_delete_cancel",cancel=true)
            val remove=confirmation.button("Видалити","profile_delete_confirm")
            confirmation.footer(listOf(keep,remove),horizontal=resources.configuration.fontScale<1.5f)
            val shown=confirmation.show();keep.setOnClickListener{shown.dismiss()}
            remove.setOnClickListener{shown.dismiss();if(profiles.remove(profile.id))showPage(screen)else note("Не вдалося видалити адресу")}
        }
        return dialog
    }

    private fun chooseReminderLead():AlertDialog{
        val panel=AppDialogPanel(this,"Нагадувати за",prefix="reminder_picker")
        val rows=LinearLayout(this).apply{orientation=LinearLayout.VERTICAL}
        val options=listOf(5,15,30,60).map{value->value to panel.button("$value хв","reminder_lead:$value",selected=ScheduleNotifications.lead(this)==value).apply{
            contentDescription="$value хвилин"+if(isSelected)". Обрано"else""
        }}
        val cancel=panel.button("Скасувати","reminder_cancel",cancel=true)
        (options.map{it.second}+cancel).forEachIndexed{index,view->rows.addView(view,LinearLayout.LayoutParams(-1,-2).apply{if(index>0)topMargin=dp(8)})}
        panel.setBody(rows)
        val dialog=panel.show();cancel.setOnClickListener{dialog.dismiss()}
        options.forEach{(value,view)->view.setOnClickListener{dialog.dismiss();ScheduleNotifications.setLead(this,value);refreshSettings()}}
        return dialog
    }

    private fun dashboard(){
        selectedDate=HomeSchedule.normalize(selectedDate,LocalDate.now(KYIV_ZONE),explicitDate)
        if(changingAccount)clearAccountDraft()
        val binding=repo.binding() ?: return setup()
        root("home","")
        addressProfilesCard()
        val snapshot=repo.snapshot();val now=Instant.now()
        val notices=LinearLayout(this).apply{tag="home_notices";orientation=LinearLayout.VERTICAL}
        column.addView(notices,LinearLayout.LayoutParams(-1,-2));homeNotices(notices,snapshot,now)
        scheduleCard(snapshot,now)
        val totals=LinearLayout(this).apply{tag="day_summary";orientation=LinearLayout.VERTICAL}
        column.addView(totals,LinearLayout.LayoutParams(-1,-2).apply{bottomMargin=dp(14)})
        addSummary(totals,selectedDate,snapshot,now)
        homeWeather(binding,now)
        addShareButton(snapshot,now)
        button(column,"♡ Подякувати за додаток"){openSource("https://send.monobank.ua/jar/5cWs9Zt1qa")}.apply{tag="donate_button";background=rounded(colors.surface,16)}
        shownHomeBinding=binding;rememberHome(snapshot,now)
    }
    private fun addShareButton(snapshot:Snapshot,now:Instant){
        if(ScheduleLabels.canShare(selectedDate,snapshot,now))button(column,"Поділитись графіком"){
            val current=repo.snapshot();val value=ScheduleLabels.shareText(selectedDate,current,Instant.now())
            if(value==null){dashboard();return@button}
            runCatching{startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT,value),"Поділитись графіком"))}
                .onFailure{note("Не вдалося відкрити меню поширення")}
        }.apply{tag="share_schedule";background=rounded(colors.surface,16);ShareButtonIcon.apply(this,colors.accent)}
    }
    private fun homeWeather(binding:ConfirmedBinding,now:Instant){
        val box=HomeWeatherCard(this,colors)
        column.addView(box,LinearLayout.LayoutParams(-1,-2).apply{bottomMargin=dp(14)})
        box.update(binding,weather.snapshotFor(binding),weather.lastError(),now)
        box.forecastScroll.post{box.forecastScroll.scrollTo(weatherScrollX,0)}
    }
    private fun homeNotices(parent:LinearLayout,snapshot:Snapshot,now:Instant){
        if(snapshot.failures.isNotEmpty() || snapshot.feedFailed){
            val warning=card(parent).apply{tag="source_warning"}
            val reason=if(snapshot.failures.isNotEmpty())repo.sourceFailure()?.messageText ?: "Адресні дані потребують повторної перевірки"
                else OfficialScheduleRepository(this).sourceFailure()?.messageText ?: "Не вдалося оновити публікації Черкасиобленерго. Спробуємо пізніше"
            text(warning,if(!RefreshWorker.online(this))"Немає підключення до інтернету"else reason,14,true,colors.muted)
            if(snapshot.failures.isNotEmpty()){
                val last=snapshot.failures.mapNotNull{snapshot.categories[it]?.fetchedAt}.minOrNull()
                text(warning,if(last==null)"Збережених адресних даних немає"else"Адресні дані · останнє успішне оновлення ${fullTime(last)}",12,false,colors.muted)
            }
            if(snapshot.feedFailed){
                val last=OfficialScheduleRepository(this).snapshot().checkedAt
                text(warning,if(last==null)"Успішної перевірки публікацій ще не було"else"Публікації · остання успішна перевірка ${fullTime(last)}",12,false,colors.muted)
            }
            button(actionRow(warning),"Повторити"){RefreshWorker.request(this)}
        }
        if(snapshot.registryQueue!=null && snapshot.queueLabel()!=null && snapshot.registryQueue!=snapshot.queueLabel()){
            text(parent,"Черга адресного API ${snapshot.queueLabel()} відрізняється від базового переліку ${snapshot.registryQueue}. Використано адресний API",12,false,colors.muted).setPadding(dp(3),0,dp(3),dp(10))
        }
        if(snapshot.failures.isNotEmpty())ServiceNotices(this).current(now)?.let{notice->
            val info=card(parent);text(info,"Черкасиобленерго повідомляє про технічні роботи",14,true)
            text(info,"Повідомлення ${fullTime(notice.publishedAt)} · за повідомленням оператора до ${fullTime(notice.until)}",12,false,colors.muted)
            button(actionRow(info),"Офіційне повідомлення"){openSource(notice.url)}
        }
    }
    private fun homeScheduleKey(snapshot:Snapshot,now:Instant):List<Any?> {
        val today=now.atZone(KYIV_ZONE).toLocalDate()
        val tiles=DisplaySchedule.tiles(selectedDate,snapshot,now)
        return listOf(selectedDate,tiles,tiles.indexOfFirst{now>=it.start && now<it.end},dayState(selectedDate,snapshot),
            HomeSchedule.week(selectedDate).map{listOf(HomeSchedule.selectable(it,snapshot,today),dayState(it,snapshot))},
            snapshot.emergency.status(now,snapshot.plans),ScheduleLabels.contextKind(selectedDate,snapshot,now),
            snapshot.plan(selectedDate)?.sourceUrl,
            dayState(selectedDate,snapshot)==ScheduleLabels.NO_OUTAGES && selectedDate==today && homeStatus(snapshot,now)==ScheduleLabels.NO_OUTAGES)
    }
    private fun homeSummaryKey(snapshot:Snapshot,now:Instant):List<Any?> = listOf(selectedDate,
        snapshot.emergency.affects(selectedDate,snapshot.plans,now),HourlySchedule.summary(selectedDate,snapshot,now))
    private fun homeNoticesKey(snapshot:Snapshot,now:Instant):List<Any?> = listOf(snapshot.failures,snapshot.feedFailed,
        snapshot.failures.map{snapshot.categories[it]?.fetchedAt},snapshot.registryQueue,snapshot.queueLabel(),
        repo.sourceFailure()?.messageText,if(snapshot.feedFailed)OfficialScheduleRepository(this).snapshot().checkedAt else null,
        if(snapshot.feedFailed)OfficialScheduleRepository(this).sourceFailure()?.messageText else null,
        if(snapshot.failures.isNotEmpty())ServiceNotices(this).current(now)else null,RefreshWorker.online(this))
    private fun rememberHome(snapshot:Snapshot,now:Instant,complete:Boolean=true){
        shownHomeSchedule=homeScheduleKey(snapshot,now);shownHomeSummary=homeSummaryKey(snapshot,now)
        if(complete){shownHomeNotices=homeNoticesKey(snapshot,now);shownHomeProfiles=AddressProfiles(this).profiles()}
    }
    /** A worker result and a clock tick update their own blocks; never replace the home shell. */
    private fun refreshHome(){
        val binding=repo.binding() ?: return setup()
        if(screen!="home" || shownHomeBinding!=binding)return dashboard()
        selectedDate=HomeSchedule.normalize(selectedDate,LocalDate.now(KYIV_ZONE),explicitDate)
        val snapshot=repo.snapshot();val now=Instant.now()
        val scroll=column.parent as ScrollView;val scrollY=scroll.scrollY
        val focused=window.decorView.findFocus();val accessibility=descendants(column).firstOrNull{it.isAccessibilityFocused}
        (column.getChildAt(0) as StatusHeader).update(snapshot.queueLabel(),homeStatus(snapshot,now),
            ScheduleLabels.contextKind(selectedDate,snapshot,now)?.label,snapshot.explicitHourlyExclusion())
        val profiles=AddressProfiles(this).profiles()
        if(profiles!=shownHomeProfiles){
            val old=column.findViewWithTag<View>("address_profiles");val index=column.indexOfChild(old)
            column.removeView(old);addressProfilesCard()
            val next=column.findViewWithTag<View>("address_profiles");column.removeView(next);column.addView(next,index)
            shownHomeProfiles=profiles
        }
        val noticesKey=homeNoticesKey(snapshot,now)
        if(noticesKey!=shownHomeNotices){
            val block=column.findViewWithTag<LinearLayout>("home_notices");block.removeAllViews();homeNotices(block,snapshot,now)
            shownHomeNotices=noticesKey
        }
        val scheduleKey=homeScheduleKey(snapshot,now)
        if(scheduleKey!=shownHomeSchedule){
            val old=column.findViewWithTag<View>("home_schedule");val index=column.indexOfChild(old)
            column.removeView(old);scheduleCard(snapshot,now,index);shownHomeSchedule=scheduleKey
        }
        column.findViewWithTag<TextView>("schedule_refresh")?.let{button->
            val label=if(RefreshWorker.running(this))"↻ Оновлення триває…"else"↻ Оновити"
            if(button.text.toString()!=label)button.text=label
        }
        val summaryKey=homeSummaryKey(snapshot,now)
        if(summaryKey!=shownHomeSummary){
            val block=column.findViewWithTag<LinearLayout>("day_summary");block.removeAllViews();addSummary(block,selectedDate,snapshot,now)
            shownHomeSummary=summaryKey
        }
        val share=column.findViewWithTag<View>("share_schedule")
        val canShare=ScheduleLabels.canShare(selectedDate,snapshot,now)
        if(share!=null && !canShare)column.removeView(share)
        else if(share==null && canShare){
            addShareButton(snapshot,now);val next=column.findViewWithTag<View>("share_schedule");column.removeView(next)
            column.addView(next,column.indexOfChild(column.findViewWithTag<View>("donate_button")))
        }
        column.findViewWithTag<HomeWeatherCard>("home_weather").update(binding,weather.snapshotFor(binding),weather.lastError(),now)
        val content=column;val token=generation
        content.post{if(!isDestroyed && screen=="home" && column===content && generation==token)scroll.scrollTo(0,scrollY)}
        if((accessibility!=null && !accessibility.isAttachedToWindow) || (focused!=null && !focused.isAttachedToWindow))
            restorePageFocus(PageFocus(focused?.tag as? String,focused?.isFocusableInTouchMode ?: false,accessibility?.tag as? String))
    }

    private fun dateLabel(date:LocalDate)=date.format(DateTimeFormatter.ofPattern("dd.MM.yyyy"))
    private fun dayState(date:LocalDate,snapshot:Snapshot):String=when{
        snapshot.emergency.affects(date,snapshot.plans,Instant.now())->"Точний прогноз недоступний"
        date in snapshot.conflictDates->"Є розбіжність джерел · потрібна перевірка"
        snapshot.plan(date)?.uncertain==true->"Збережений графік потребує перевірки"
        snapshot.plan(date)?.cancelled==true->"Оператор скасував опублікований графік"
        snapshot.feedFailed && snapshot.plan(date)!=null->"Збережений графік · перевірка недоступна"
        snapshot.feedFailed->"Перевірка публікацій недоступна"
        snapshot.categories.isEmpty() && snapshot.plan(date)==null->"Дані недоступні"
        snapshot.failures.isNotEmpty()->"Збережені дані · оновлення недоступне"
        snapshot.explicitHourlyExclusion() && snapshot.checkedEmptyToday(date,Instant.now())->ScheduleLabels.NO_OUTAGES
        snapshot.explicitHourlyExclusion() && snapshot.knownDay(date)->"Графік опубліковано"
        snapshot.queueLabel()==null->"Чергу не визначено"
        snapshot.checkedEmptyToday(date,Instant.now())->"Відключень не заплановано"
        snapshot.knownDay(date)->"Графік опубліковано"
        snapshot.plan(date)!=null->"Збережений графік застарів · потрібна перевірка"
        else->"Графік ще не опубліковано"
    }
    private fun addSummary(parent:LinearLayout,date:LocalDate,snapshot:Snapshot,now:Instant){
        if(snapshot.emergency.affects(date,snapshot.plans,now)){
            text(parent,"Немає точних даних",18,true,colors.muted).apply{tag="uncertain_summary";setPadding(dp(16),dp(20),dp(16),dp(20));background=rounded(colors.surface,22)}
            return
        }
        val summary=HourlySchedule.summary(date,snapshot,now)
        fun duration(minutes:Long)="${minutes/60} год"+if(minutes%60==0L)""else" ${minutes%60} хв"
        val row=MatchingLabelRow(this).apply{orientation=if(resources.configuration.fontScale>=1.5f)LinearLayout.VERTICAL else LinearLayout.HORIZONTAL;isBaselineAligned=false}
        parent.addView(row,LinearLayout.LayoutParams(-1,-2))
        val headings=mutableListOf<TextView>();val values=mutableListOf<TextView>();val captions=mutableListOf<TextView>()
        for((index,item) in listOf("Зі світлом" to summary.clearMinutes,"Без світла" to summary.outageMinutes).withIndex()){
            val (label,value)=item
            val cell=LinearLayout(this).apply{
                tag=if(index==0)"summary_clear"else"summary_outage"
                orientation=LinearLayout.VERTICAL;setPadding(dp(14),dp(18),dp(14),dp(18))
                background=rounded(colors.surface,22)
            }
            row.addView(cell,if(row.orientation==LinearLayout.VERTICAL)LinearLayout.LayoutParams(-1,-2).apply{bottomMargin=dp(12)}else LinearLayout.LayoutParams(0,-1,1f).apply{if(index==0)marginEnd=dp(6)else marginStart=dp(6)})
            val heading=LinearLayout(this).apply{orientation=LinearLayout.HORIZONTAL;gravity=Gravity.CENTER_VERTICAL;minimumHeight=dp(28)}
            cell.addView(heading,LinearLayout.LayoutParams(-1,-2))
            heading.addView(SummaryIconView(this,index==0,colors.accent).apply{background=rounded(colors.track,9)},LinearLayout.LayoutParams(dp(28),dp(28)).apply{marginEnd=dp(8)})
            headings+=fitLabel(text(heading,label,13,true),13).apply{layoutParams=LinearLayout.LayoutParams(0,-2,1f)}
            values+=text(cell,if(summary.unknownMinutes>0 && value==0L)"—"else duration(value),44,true,colors.accent).apply{
                val label=text.toString().replace(" год","\u00a0год").replace(" хв","\u00a0хв")
                text=android.text.SpannableString(label).apply{Regex("год|хв").findAll(label).forEach{setSpan(android.text.style.RelativeSizeSpan(0.42f),it.range.first,it.range.last+1,android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)}}
                tag=if(index==0)"summary_clear_duration"else"summary_outage_duration"
                layoutParams=LinearLayout.LayoutParams(-1,-2).apply{topMargin=dp(16)}
            }
            captions+=fitLabel(text(cell,"за графіком",12,false,colors.muted),12).apply{layoutParams=LinearLayout.LayoutParams(-1,-2).apply{topMargin=dp(4)}}
        }
        row.matchLabels(*headings.toTypedArray())
        row.matchLabels(*captions.toTypedArray(),sizeLimit={values.first().textSize*0.7f})
        if(summary.unknownMinutes>0)text(parent,"Невідомо: ${duration(summary.unknownMinutes)}",12,false,colors.muted).setPadding(dp(4),dp(10),dp(4),0)
        if(summary.unverifiedOutages)text(parent,"Збережені інтервали · потребують перевірки",12,false,colors.muted).setPadding(dp(4),dp(10),dp(4),0)
    }
    private fun refreshButton(parent:LinearLayout){button(parent,if(RefreshWorker.running(this))"↻ Оновлення триває…"else"↻ Оновити"){
        RefreshWorker.request(this);note(if(RefreshWorker.online(this))"Оновлення заплановано"else"Немає інтернету. Показуємо збережені дані.")
    }.apply{tag="schedule_refresh"}}
    private fun graphPage(){dashboard()}
    private var departingGrid:View?=null
    private var departingIndicator:Float?=null
    private var movingForward=true
    private fun selectCalendarDay(date:LocalDate,forward:Boolean,direct:Boolean=false){
        val today=LocalDate.now(KYIV_ZONE)
        if(date==selectedDate || !(if(direct)HomeSchedule.selectable(date,repo.snapshot(),today)else HomeSchedule.canMoveDay(selectedDate,date,repo.snapshot(),today,explicitDate)))return
        departingIndicator=(descendants(column).firstOrNull{it.tag=="week_days"} as? DayStrip)?.fraction()
        val previous=descendants(column).firstOrNull{it.tag=="day_grid_frame"} as? DayGridFrame
        val oldGrid=previous?.takeIf{!it.transitioning()}?.getChildAt(0)
        departingGrid=if(oldGrid!=null){
            val h=oldGrid.height;(oldGrid.parent as ViewGroup).removeView(oldGrid)
            oldGrid.layoutParams=ViewGroup.LayoutParams(-1,h);oldGrid
        }else previous?.takeIf{it.width>0 && it.height>0}?.let{view->
            val bitmap=android.graphics.Bitmap.createBitmap(view.width,view.height,android.graphics.Bitmap.Config.ARGB_8888)
            view.draw(android.graphics.Canvas(bitmap))
            ImageView(this).apply{setImageBitmap(bitmap);scaleType=ImageView.ScaleType.FIT_START;layoutParams=ViewGroup.LayoutParams(view.width,view.height)}
        }
        movingForward=forward;selectedDate=date
        // Replace only date-dependent content. Header, address and weather retain their views.
        val panel=descendants(column).firstOrNull{it.tag=="home_schedule"} ?: return dashboard()
        val index=column.indexOfChild(panel);column.removeView(panel)
        val snapshot=repo.snapshot();val now=Instant.now()
        scheduleCard(snapshot,now,index)
        (descendants(column).firstOrNull{it.tag=="day_summary"} as? LinearLayout)?.let{it.removeAllViews();addSummary(it,selectedDate,snapshot,now)}
        descendants(column).firstOrNull{it.tag=="share_schedule"}?.let{column.removeView(it)}
        val donate=descendants(column).firstOrNull{it.tag=="donate_button"}
        addShareButton(snapshot,now)
        val share=descendants(column).firstOrNull{it.tag=="share_schedule"}
        if(share!=null && donate!=null){column.removeView(share);column.addView(share,column.indexOfChild(donate))}
        (column.getChildAt(0) as? StatusHeader)?.update(snapshot.queueLabel(),homeStatus(snapshot,now),
            ScheduleLabels.contextKind(selectedDate,snapshot,now)?.label,snapshot.explicitHourlyExclusion())
        rememberHome(snapshot,now,false)
    }
    private fun scheduleCard(snapshot:Snapshot,now:Instant,atIndex:Int=-1){
        val box=WeekPanel(this){forward->
            val today=LocalDate.now(KYIV_ZONE)
            selectedDate=HomeSchedule.normalize(selectedDate,today,explicitDate)
            HomeSchedule.swipe(selectedDate,forward,repo.snapshot(),today)?.let{selectedDate=it;explicitDate=false;dashboard()}
        }.apply{tag="home_schedule";orientation=LinearLayout.VERTICAL;setPadding(dp(12),dp(18),dp(12),dp(18));background=rounded(colors.surface,22)}
        column.addView(box,atIndex,LinearLayout.LayoutParams(-1,-2).apply{bottomMargin=dp(14)})
        val regime=snapshot.emergency.status(now,snapshot.plans)
        if(regime.confirmedActive){
            val warning=LinearLayout(this).apply{tag="emergency_warning";orientation=LinearLayout.VERTICAL;setPadding(dp(8),0,dp(8),dp(16))}
            box.addView(warning)
            val warningColor=android.graphics.Color.parseColor(if(AppAppearance.light(this))"#A94A24" else "#F1AD72")
            text(warning,"⚠  Аварійні відключення в області",18,true,warningColor)
            text(warning,regime.hourly.label,15,false,warningColor)
        }
        val today=now.atZone(KYIV_ZONE).toLocalDate()
        val week=HomeSchedule.week(selectedDate)
        val row=DayStrip(this,colors,departingIndicator).apply{tag="week_days";orientation=LinearLayout.HORIZONTAL};box.addView(row)
        val names=listOf("Пн","Вт","Ср","Чт","Пт","Сб","Нд")
        week.forEach{date->
            val dayName=names[date.dayOfWeek.value-1]
            val enabled=HomeSchedule.selectable(date,snapshot,today)
            val selected=date==selectedDate
            row.addView(DayTab(this,colors).apply{
                tag="week_day:$date";text=dayName;isAllCaps=false;isSelected=selected;isEnabled=enabled;showIndicator=false
                textSize=14f;minWidth=0;minimumWidth=0;minHeight=dp(48);setPadding(0,dp(7),0,dp(7))
                fitLabel(this,14)
                setTextColor(if(selected)colors.accent else if(enabled)colors.ink else colors.muted)
                background=null;alpha=if(enabled || selected)1f else 0.5f
                contentDescription="${dayName}, ${dateLabel(date)}. ${if(enabled)dayState(date,snapshot)else"Графік не опубліковано"}${if(selected)". Обрано"else""}"
                setOnClickListener{selectCalendarDay(date,date>selectedDate,true)}
            },LinearLayout.LayoutParams(0,-2,1f).apply{setMargins(dp(1),dp(8),dp(1),dp(8))})
        }
        // A deep link may show an unpublished day as unknown; only published days can be tapped.
        box.addView(View(this).apply{setBackgroundColor(colors.track)},LinearLayout.LayoutParams(-1,dp(1)).apply{bottomMargin=dp(12)})
        val state=dayState(selectedDate,snapshot)
        val duplicate=state==ScheduleLabels.NO_OUTAGES && selectedDate==today && homeStatus(snapshot,now)==state
        if(state!="Графік опубліковано" && !duplicate)fitLabel(text(box,state,13,false,colors.muted),13).apply{tag="selected_day_state";contentDescription="${dateLabel(selectedDate)}. $text"}
        val frame=DayGridFrame(this){forward->selectCalendarDay(selectedDate.plusDays(if(forward)1 else -1),forward)}
        box.addView(frame,LinearLayout.LayoutParams(-1,-2).apply{topMargin=dp(8);bottomMargin=dp(10)})
        val available=(resources.configuration.screenWidthDp*resources.displayMetrics.density).toInt()-dp(66)
        val grid=GridLayout(this).apply{tag="hour_grid";columnCount=HourTileView.columns(this@MainActivity,available)}
        frame.addView(grid,android.widget.FrameLayout.LayoutParams(-1,-2))
        DisplaySchedule.tiles(selectedDate,snapshot,now).forEachIndexed{index,hour->
            grid.addView(HourTileView(this,hour,now,colors),GridLayout.LayoutParams(GridLayout.spec(index/grid.columnCount),GridLayout.spec(index%grid.columnCount,1f)).apply{width=0;height=-2;setMargins(dp(3),dp(3),dp(3),dp(3))})
        }
        frame.transitionFrom(departingGrid,movingForward);departingGrid=null;departingIndicator=null
        divider(box,12)
        shortLegend(box,ScheduleLabels.contextKind(selectedDate,snapshot,now) ?: OutageKind.HOURLY)
        val actions=actionRow(box)
        button(actions,"Джерело"){openSource(snapshot.plan(selectedDate)?.sourceUrl ?: "https://www.cherkasyoblenergo.com/off")}.layoutParams=LinearLayout.LayoutParams(0,-2,1f).apply{marginEnd=dp(4)}
        refreshButton(actions)
        actions.getChildAt(1).layoutParams=LinearLayout.LayoutParams(0,-2,1f).apply{marginStart=dp(4)}
    }
    private fun chip(parent:LinearLayout,label:String,selected:Boolean,equal:Boolean=true,action:()->Unit){
        val view=Button(this).apply{tag="chip:$screen:$label";stateListAnimator=null;elevation=0f;translationZ=0f;text=label;isAllCaps=false;textSize=14f;isSelected=selected;setTextColor(if(selected)colors.background else colors.ink);background=rounded(if(selected)colors.accent else colors.background,14);minWidth=0;minimumWidth=0;minHeight=dp(48);setPadding(dp(if(parent is CompactActionRow)8 else 10),dp(8),dp(if(parent is CompactActionRow)8 else 10),dp(8));fitLabel(this,14);setOnClickListener{if(!busy)action()}}
        parent.addView(view,LinearLayout.LayoutParams(if(equal)0 else -2,-2,if(equal)1f else 0f).apply{if(parent.childCount>0)marginStart=dp(8)})
    }
    private fun openSource(url:String){runCatching{startActivity(Intent(Intent.ACTION_VIEW,Uri.parse(url)))}.onFailure{note("Не вдалося відкрити посилання")}}
    private fun inboxState():List<Any?> = listOf(NotificationAccess.read(this),
        InboxRepository(this).changes(),AppUpdateRepository(this).available(),repo.snapshot().queueLabel(),
        RemoteMessageRepository(this).visible())
    private fun inboxPage(){
        root("inbox","")
        val inbox=InboxRepository(this);val queue=repo.snapshot().queueLabel().orEmpty()
        val release=AppUpdateRepository(this).available()
        val remote=RemoteMessageRepository(this);val messages=remote.visible()
        val changes=(inbox.changes().filter{it.queue==queue || it.queue=="*"}+listOfNotNull(release?.takeIf{r->messages.none{it.targetVersion==r.code}}?.change()))
            .filter{it.at>=Instant.now().minusSeconds(7*86400)}.sortedWith(InboxHistory.newestFirst)
        if(changes.isEmpty() && messages.isEmpty()){
            val empty=card();text(empty,"Повідомлень поки немає",20,true)
            text(empty,if(!RefreshWorker.online(this))"Немає інтернету. Тут буде локальна історія після успішних перевірок."else"Тут з’являться нові публікації, зміни графіка та важливі події вашої підчерги. Порожня історія не означає відсутності відключень.",14,false,colors.muted)
        }
        // Merge by publication time; remote announcements are not tied to the selected queue.
        val entries=(changes.map{Triple(it.at,it,null as RemoteMessage?)}+messages.map{Triple(it.published,null as OfficialChange?,it)})
            .sortedByDescending{it.first}
        for(entry in entries){
            val message=entry.third
            if(message!=null){
                val box=card().apply{tag="remote_message:${message.id}"}
                text(box,"Оновлено · ${fullTime(message.published)}",12,false,colors.muted)
                text(box,message.title,18,true);text(box,message.body,14,false,colors.muted)
                box.isFocusable=true;box.contentDescription="${message.title}. ${message.body}"
                box.setOnClickListener{remote.markViewed(message.id)}
                message.action?.let{url->button(actionRow(box),if(message.type=="app_update")"Завантажити"else"Відкрити"){
                    if(RemoteMessageSchema.allowedUrl(url)){remote.markViewed(message.id);openSource(url)}
                }}
                // Read only when the card actually enters the visible viewport, not while constructing an off-screen row.
                box.viewTreeObserver.addOnScrollChangedListener{val rect=android.graphics.Rect();if(box.isAttachedToWindow && box.getGlobalVisibleRect(rect) && rect.height()>=minOf(box.height,dp(48)))remote.markViewed(message.id)}
                box.post{val rect=android.graphics.Rect();if(box.isAttachedToWindow && box.getGlobalVisibleRect(rect) && rect.height()>=minOf(box.height,dp(48)))remote.markViewed(message.id)}
                continue
            }
            val change=entry.second ?: continue
            if(change.kind=="app_update" && release!=null){
                val box=card().apply{tag="app_update_card"}
                text(box,"Оновлено · ${fullTime(release.publishedAt)}",12,false,colors.muted)
                text(box,change.title,18,true);text(box,"Оновіть застосунок, коли вам зручно",14,false,colors.muted)
                val releaseRepository=AppUpdateRepository(this)
                button(actionRow(box),"Завантажити"){releaseRepository.markViewed(release.code);openSource(release.apk)}
                fun viewed(){val rect=android.graphics.Rect();if(box.isAttachedToWindow && box.getGlobalVisibleRect(rect) && rect.height()>=minOf(box.height,dp(48)))releaseRepository.markViewed(release.code)}
                box.viewTreeObserver.addOnScrollChangedListener{viewed()};box.post{viewed()}
                continue
            }
            val title=ScheduleLabels.messageTitle(change);val metadata=ScheduleLabels.messageMeta(change);val queueLabel=ScheduleLabels.queueLine(change.queue)
            val box=card().apply{tag="inbox_${change.id}";isClickable=true;isFocusable=true;contentDescription="$metadata. $title. $queueLabel. ${dateLabel(change.date)}";setOnClickListener{inbox.markRead(change.id);explicitDate=true;selectedDate=change.date;graphPage()}}
            fun messageLine(value:String,size:Int,bold:Boolean,color:Int,space:Int){
                if(value.isBlank())return
                text(box,value,size,bold,color).apply{
                    includeFontPadding=false;tooltipText=value;contentDescription=value
                    if(resources.configuration.fontScale>=1.5f){maxLines=1;ellipsize=android.text.TextUtils.TruncateAt.END;setHorizontallyScrolling(false)}
                    (layoutParams as LinearLayout.LayoutParams).topMargin=dp(space)
                }
            }
            messageLine(metadata,12,false,colors.muted,0)
            messageLine(title,20,true,colors.ink,8)
            messageLine(queueLabel,14,false,colors.muted,4)
            val actions=compactActions(box).apply{(layoutParams as LinearLayout.LayoutParams).topMargin=dp(18)}
            button(actions,"Переглянути графік"){inbox.markRead(change.id);explicitDate=true;selectedDate=change.date;graphPage()}
            button(actions,"Джерело"){openSource(change.sourceUrl)}
        }
        shownInboxState=inboxState()
    }

    private fun fullTime(at:Instant?):String=at?.atZone(KYIV_ZONE)?.format(DateTimeFormatter.ofPattern("dd.MM HH:mm")) ?: "—"
    override fun onWindowFocusChanged(hasFocus:Boolean){
        super.onWindowFocusChanged(hasFocus)
        // onPause can precede the focus return caused by dismissing our own
        // confirmation. Observe actual external focus loss instead; floating
        // launcher confirmations on Android 8 do not pause this Activity.
        if(!hasFocus && WidgetPins.hasPending())pinRequestLeftActivity=true
        if(hasFocus && pinRequestLeftActivity){WidgetPins.launcherReturned();pinRequestLeftActivity=false}
    }
    private fun pinWidget(compact:Boolean){
        val prompt=widgetPinPrompt ?: WidgetPinPrompt(this,::pinFeedback).also{widgetPinPrompt=it}
        prompt.show(compact)
    }
    private fun pinFeedback(message:String){
        widgetPinMessage=message
        if(::column.isInitialized)descendants(column).filterIsInstance<TextView>().firstOrNull{it.tag=="widget_pin_status"}?.apply{
            text=message;visibility=View.VISIBLE
        }
        note(message)
    }
    private fun weatherPage(){dashboard()}
    private fun selectWeather(){
        val binding=repo.binding() ?: return setup()
        if(weather.location()==null)AddressWeather.knownLocation(binding.city)?.let{
            runCatching{weather.bindLocation(it,addressBased=true)}
        }
        RefreshWorker.request(this);dashboard()
    }
    override fun onRequestPermissionsResult(requestCode:Int,permissions:Array<out String>,grantResults:IntArray){
        super.onRequestPermissionsResult(requestCode,permissions,grantResults)
        if(requestCode==72){
            ScheduleNotifications.rebuild(this)
            AppUpdateWorker.announce(this,AppUpdateRepository(this))
            MessageNotifications.announce(this)
            if(!ScheduleNotifications.notificationPermission(this))note("Сповіщення вимкнено системою. Графік залишається доступним.")
            if(screen=="settings")settings()
            else if(screen=="inbox")redraw()
        }
    }
    private fun shortLegend(parent:LinearLayout,kind:OutageKind){
        val flow=LegendFlow(this).apply{tag="schedule_legend"}
        parent.addView(flow,LinearLayout.LayoutParams(-1,-2))
        listOf("Світло є","Світла немає","Поточна година").forEachIndexed{index,label->
            val group=LinearLayout(this).apply{orientation=LinearLayout.HORIZONTAL;gravity=Gravity.CENTER_VERTICAL;minimumHeight=dp(30)
                contentDescription="Умовне позначення: $label";isFocusable=true}
            group.addView(LegendSample(this,colors,if(index==1)kind.category else null,current=index==2,kind=if(index==1)kind else null),LinearLayout.LayoutParams(dp(20),dp(20)))
            group.addView(TextView(this).apply{text=label;textSize=14f;setTextColor(colors.muted);maxLines=1;importantForAccessibility=View.IMPORTANT_FOR_ACCESSIBILITY_NO},LinearLayout.LayoutParams(-2,-2).apply{marginStart=dp(6)})
            flow.addView(group)
        }
    }
    private fun fullLegend(parent:LinearLayout){
        divider(parent)
        text(parent,"Умовні позначення",18,true).apply{tag="full_legend_title";androidx.core.view.ViewCompat.setAccessibilityHeading(this,true)}
        val dynamic=ScheduleLabels.contextKind(selectedDate,repo.snapshot(),Instant.now()) ?: OutageKind.HOURLY
        val entries=listOf("— Погодинне відключення" to OutageKind.HOURLY,"— Планові роботи" to OutageKind.PLANNED,
            "— Позапланове відключення" to OutageKind.UNPLANNED,"— Аварійне відключення" to OutageKind.EMERGENCY,"— 30 хв без світла" to dynamic)
        entries.forEachIndexed{index,(label,kind)->
            val row=LinearLayout(this).apply{orientation=LinearLayout.HORIZONTAL;gravity=Gravity.CENTER_VERTICAL}
            parent.addView(row,LinearLayout.LayoutParams(-1,-2).apply{topMargin=dp(12)})
            row.addView(LegendSample(this,colors,kind.category,half=index==4,kind=kind),LinearLayout.LayoutParams(dp(30),dp(if(index==4)40 else 30)).apply{marginEnd=dp(12)})
            row.addView(TextView(this).apply{text=label;textSize=14f;setTextColor(colors.ink)},LinearLayout.LayoutParams(0,-2,1f))
        }
    }
    private fun appearancePair(parent:LinearLayout,label:String,kind:String,secondSelected:Boolean,changed:(Boolean)->Unit){
        val large=resources.configuration.fontScale>=1.5f
        val row=LinearLayout(this).apply{orientation=if(large)LinearLayout.VERTICAL else LinearLayout.HORIZONTAL;gravity=Gravity.CENTER_VERTICAL;tag="appearance_group:$kind"}
        parent.addView(row,LinearLayout.LayoutParams(-1,-2).apply{topMargin=dp(10)})
        row.addView(TextView(this).apply{text=label;textSize=14f;setTextColor(colors.ink)},LinearLayout.LayoutParams(if(large)-1 else dp(65),-2).apply{if(large)bottomMargin=dp(8)else marginEnd=dp(10)})
        val pair=LinearLayout(this).apply{orientation=LinearLayout.HORIZONTAL;setPadding(dp(4),dp(4),dp(4),dp(4));background=rounded(colors.track,14);contentDescription=label}
        row.addView(pair,if(large)LinearLayout.LayoutParams(-1,-2)else LinearLayout.LayoutParams(0,-2,1f))
        for(second in listOf(false,true)){
            val option=AppearanceOption(this,kind,second,colors).apply{tag="appearance:$kind:$second";isSelected=second==secondSelected
                setOnClickListener{if(second!=secondSelected){saveScroll();changed(second);if(kind!="theme")refreshSettings()}}}
            pair.addView(option,LinearLayout.LayoutParams(0,-2,1f).apply{if(second)marginStart=dp(5)})
        }
    }
    private fun settings(){
        root("settings","")
        val appearance=card().apply{tag="appearance"};text(appearance,"Вигляд",20,true)
        appearancePair(appearance,"Тема","theme",AppAppearance.light(this)){AppAppearance.setLight(this,it);recreate()}
        divider(appearance,10)
        appearancePair(appearance,"Час","time",AppAppearance.twoRows(this)){AppAppearance.setTwoRows(this,it)}
        divider(appearance,10)
        appearancePair(appearance,"Значки","icons",AppAppearance.bulbs(this)){AppAppearance.setBulbs(this,it)}
        val notifications=card().apply{tag="notifications"}
        val access=NotificationAccess.read(this)
        val bell=NotificationBell(this,colors,access.enabled).apply{
            tag="notification_status";contentDescription="${access.label}. ${access.explanation}. Пояснення статусу";tooltipText="${access.label}. ${access.explanation}"
            setOnClickListener{AppDialogs.builder(this@MainActivity).setTitle(access.label).setMessage(access.explanation)
                .setPositiveButton("Налаштування Android"){_,_->runCatching{startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE,packageName))}.onFailure{note("Не вдалося відкрити налаштування Android")}}
                .setNegativeButton("Закрити",null).show().also(AppDialogs::style)}
        }
        notifications.addView(BellHeading(this,colors,bell),LinearLayout.LayoutParams(-1,-2))
        fun notificationSwitch(key:String,label:String){
            addSwitch(notifications,label,ScheduleNotifications.enabled(this,key),"notification_$key"){enabled->
                ScheduleNotifications.setEnabled(this,key,enabled)
                if(enabled && Build.VERSION.SDK_INT>=33 && !ScheduleNotifications.notificationPermission(this))requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS),72)
                ScheduleNotifications.rebuild(this);refreshSettings()
            }
        }
        notificationSwitch("before_off","Перед відключенням")
        notificationSwitch("before_on","Перед очікуваним відновленням")
        val reminderRow=ReminderLeadRow(this).apply{tag="reminder_lead_row"}
        notifications.addView(reminderRow,LinearLayout.LayoutParams(-1,-2))
        val reminderText=LinearLayout(this).apply{orientation=LinearLayout.VERTICAL}
        reminderRow.addView(reminderText,ViewGroup.LayoutParams(-2,-2))
        reminderText.addView(TextView(this).apply{text="Нагадувати за";textSize=14f;setTextColor(colors.ink);setPadding(0,dp(6),0,dp(6));maxLines=1})
        val reminders=ScheduleNotifications.enabled(this,"before_off") || ScheduleNotifications.enabled(this,"before_on")
        val pickerHost=LinearLayout(this)
        val leadPicker=button(pickerHost,"${ScheduleNotifications.lead(this)} хв ▾"){
            if(reminders)chooseReminderLead()
        }.apply{tag="reminder_lead";layoutParams=LinearLayout.LayoutParams(-2,-2);isEnabled=reminders;alpha=if(reminders)1f else .5f
            contentDescription="Нагадувати за ${ScheduleNotifications.lead(this@MainActivity)} хвилин"+if(!reminders)". Недоступно: увімкніть нагадування"else""}
        pickerHost.removeView(leadPicker);reminderRow.addView(leadPicker,ViewGroup.LayoutParams(-2,-2))
        text(reminderText,if(reminders)"Оберіть час нагадування"else"Увімкніть нагадування, щоб вибрати час",12,false,colors.muted).tag="reminder_hint"
        divider(notifications)
        notificationSwitch("tomorrow","Графік на завтра")
        notificationSwitch("changes","Зміни графіка")
        notificationSwitch("emergency","Аварії за адресою")
        divider(notifications)
        val appUpdates=AppUpdateRepository(this)
        addSwitch(notifications,"Нові версії застосунку",appUpdates.enabled(),"notification_app_versions"){enabled->
            appUpdates.setEnabled(enabled)
            if(enabled && Build.VERSION.SDK_INT>=33 && !ScheduleNotifications.notificationPermission(this))requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS),72)
            AppUpdateWorker.announce(this,appUpdates);MessageNotifications.announce(this);refreshSettings()
        }
        if(Build.VERSION.SDK_INT>=31 && !ScheduleNotifications.exactAllowed(this)){
            text(notifications,"Без дозволу на точні нагадування Android може показати їх із затримкою. Нові публікації виявляються під час наступної успішної перевірки.",13,false,colors.muted)
            button(notifications,"Дозволити точні нагадування"){returningExactPermission=true;runCatching{startActivity(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,Uri.parse("package:$packageName")))}.onFailure{returningExactPermission=false;note("Відкрийте системні налаштування спеціальних дозволів")}}
        }
        val widgets=card();fitLabel(text(widgets,"Віджети",20,true),20)
        val widgetActions=compactActions(widgets)
        button(widgetActions,"Детальний · 4×4"){pinWidget(false)}
        button(widgetActions,"Компактний · 4×2"){pinWidget(true)}
        text(widgets,widgetPinMessage,13,false,colors.muted).apply{
            tag="widget_pin_status";accessibilityLiveRegion=View.ACCESSIBILITY_LIVE_REGION_POLITE
            visibility=if(widgetPinMessage.isBlank())View.GONE else View.VISIBLE
        }
        fullLegend(column)
        shownSettingsState=settingsState()
    }
    private fun addSwitch(parent:LinearLayout,label:String,checked:Boolean,key:String,changed:(Boolean)->Unit){
        parent.addView(Switch(this).apply{tag=key;text=label;textSize=14f;setTextColor(colors.ink);isChecked=checked;minHeight=dp(48);setPadding(0,dp(6),0,dp(6));switchPadding=dp(12);thumbTintList=ColorStateList.valueOf(colors.accent);setOnCheckedChangeListener{_,enabled->changed(enabled)}},LinearLayout.LayoutParams(-1,-2))
    }
    private fun diagnostics(){
        if(repo.binding()==null)return setup()
        root("diagnostics","Джерела та діагностика")
        val snapshot=repo.snapshot();val feed=OfficialScheduleRepository(this).snapshot()
        val runtime=getSharedPreferences("svitlo_runtime",MODE_PRIVATE)
        fun attempted(key:String)=runtime.getLong(key,0).takeIf{it>0}?.let{fullTime(Instant.ofEpochMilli(it))} ?: "ще не виконувалась"
        val public=card();text(public,"Офіційні новини · ГПВ",20,true)
        text(public,"Остання спроба: ${attempted("feed_attempt")}\nОстання успішна перевірка: ${fullTime(feed.checkedAt)}\nСтан: ${if(feed.failed)"перевірка недоступна або помилка формату"else"останній збережений результат"}",14)
        text(public,"Доступні дати: ${snapshot.plans.joinToString{dateLabel(it.date)}.ifBlank{"немає"}}",13,false,colors.muted)
        feed.issues.forEach{text(public,it,13,false,colors.emergency)}
        snapshot.plans.forEach{plan->text(public,"${dateLabel(plan.date)} · опубліковано ${fullTime(plan.publishedAt)} · перевірено ${fullTime(plan.checkedAt)}${if(plan.uncertain)" · потребує перевірки"else""}",13);button(public,"Публікація ${dateLabel(plan.date)}"){openSource(plan.sourceUrl)}}
        for(category in Category.entries){
            val box=card();val source=snapshot.categories[category];text(box,"Адресний API · ${category.label}",19,true)
            text(box,"Остання спроба адресного API: ${attempted("address_attempt")}\nЧас у відповіді: ${fullTime(source?.sourceUpdatedAt)}\nУспішно отримано: ${fullTime(source?.fetchedAt)}\nСтан: ${if(category in snapshot.failures)"помилка перевірки; збережено кеш"else"останній збережений результат"}",13,false,colors.muted)
            if(source?.events.isNullOrEmpty())text(box,"У відповіді немає подій. Це не є підтвердженням наявності електрики.",14)
            source?.events.orEmpty().forEach{event->text(box,"${Presentation.range(event,Instant.now())} · ${event.type} · ${event.status}${if(event.plannedEnd)" · орієнтовне завершення"else""}",14)}
        }
        val forecast=card();text(forecast,"Погода · Open-Meteo",19,true)
        text(forecast,"Остання спроба: ${attempted("weather_attempt")}\nУспішно отримано: ${fullTime(weather.snapshot()?.fetchedAt)}\nСтан: ${weather.lastError() ?: "останній збережений результат"}",13,false,colors.muted)
        button(column,"До опцій"){settings()}
    }


}

private class ProgressDialogCompat(context:Context,label:String,onCancel:(()->Unit)?=null) {
    private val dialog:AlertDialog
    init {
        val box=LinearLayout(context).apply{orientation=LinearLayout.HORIZONTAL;gravity=Gravity.CENTER_VERTICAL;setPadding(32,32,32,32);addView(ProgressBar(context));addView(TextView(context).apply{text=label;setPadding(24,0,0,0)})}
        val builder=AppDialogs.builder(context).setView(box).setCancelable(onCancel!=null)
        if(onCancel!=null)builder.setNegativeButton("Скасувати"){_,_->onCancel()}.setOnCancelListener{onCancel()}
        dialog=builder.create();dialog.setCanceledOnTouchOutside(false);dialog.show();AppDialogs.style(dialog)
    }
    fun dismiss(){if(dialog.isShowing)dialog.dismiss()}
}
