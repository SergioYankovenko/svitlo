package ua.svitlo.widget.next

import android.Manifest
import android.app.*
import android.content.*
import android.content.ClipboardManager
import android.content.pm.PackageManager
import android.graphics.*
import android.net.Uri
import android.os.*
import android.text.*
import android.text.style.RelativeSizeSpan
import android.view.*
import android.view.inputmethod.InputMethodManager
import android.widget.*
import org.json.*
import ua.svitlo.widget.*
import java.time.*
import java.time.format.DateTimeFormatter
import java.util.*
import java.util.concurrent.Executors
import kotlin.math.*

/** Isolated native client. No production binding, migration or WebView. */
class NextActivity:Activity(){
    private lateinit var repo:NextRepository;private lateinit var u:NextUi;private lateinit var frame:FrameLayout
    private lateinit var shell:LinearLayout;private lateinit var body:LinearLayout;private lateinit var scroll:ScrollView
    private val executor=Executors.newFixedThreadPool(3);private val handler=Handler(Looper.getMainLooper())
    private var preservingTour=false;private var generation=0;private var lookupSequence=0;private var tab="home";private var date=LocalDate.now(NEXT_ZONE);private var week=date.with(DayOfWeek.MONDAY)
    private var expanded=false;private var city:CatalogItem?=null;private var street:CatalogItem?=null;private var house:CatalogItem?=null;private var selectedLine:String?=null;private var resolution:JSONObject?=null
    private var lastDiagnosticCode="temporary";private var journeyPhase="cities";private var editBackup:List<CatalogItem?>?=null;private val queries=mutableMapOf<String,String>();private var preferenceChoice:Boolean?=null;private var preferenceRange=false;private var pendingProfile:NextProfile?=null;private var reviewEditing:String?=null;private var draftName="";private var draftHouse="";private var journey=false;private var editAfterReview=false;private var busy=false
    private var statusHeader:StatusHeader?=null;private var summaryHost:LinearLayout?=null;private var headerValue:TextView?=null;private var headerContext:TextView?=null;private var dayHost:FrameLayout?=null;private var dayTabs:List<TextView> = emptyList();private var underline:View?=null
    private var weatherHost:LinearLayout?=null;private var weatherFor:String?=null;private var tour:NativeTour?=null;private var supportHint:NativeSupportHint?=null;private var closed=false;private var refreshPending=false
    private var homeRoot:LinearLayout?=null;private var lastSnapshotRevision:String?=null;private var observationPending=false;private var lastSensorPoll=0L;private var transition=0;private var versionPending=false
    private var foreground=false
    private val ticker=object:Runnable{override fun run(){if(closed)return;if(foreground&&!journey&&tab=="home"){val signature=daySignature();if(signature!=lastSnapshotRevision){updateDay(false);refreshTabs()};updateHeader();refreshLiveTiles();if(repo.refreshDue())refresh(false);loadSensors(false);loadHomeObservation()};handler.postDelayed(this,30000)}}
    override fun attachBaseContext(base:Context){super.attachBaseContext(AppAppearance.context(base))}
    override fun onCreate(saved:Bundle?){super.onCreate(saved);repo=NextRepository(this);u=NextUi(this);window.statusBarColor=u.p.background;window.navigationBarColor=u.p.background;window.decorView.systemUiVisibility=if(AppAppearance.light(this))View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR else 0
        frame=FrameLayout(this);setContentView(frame);frame.setBackgroundColor(u.p.background)
        frame.setOnApplyWindowInsetsListener{v,insets->v.setPadding(insets.systemWindowInsetLeft,insets.systemWindowInsetTop,insets.systemWindowInsetRight,insets.systemWindowInsetBottom);insets.consumeSystemWindowInsets()}
        if(saved!=null){tab=saved.getString("tab","home");date=runCatching{LocalDate.parse(saved.getString("date"))}.getOrDefault(date);week=date.with(DayOfWeek.MONDAY)}
        intent.getStringExtra("profile")?.let{runCatching{repo.select(it)}}
        intent.getStringExtra("date")?.let{runCatching{date=LocalDate.parse(it);week=date.with(DayOfWeek.MONDAY)}}
        if(!restoreJourney()){if(repo.profiles().isEmpty())welcome()else render()};NextWork.schedule(this);handler.post(ticker)
        if(repo.api.ready()){refresh(false);loadSensors(false)}
    }
    override fun onSaveInstanceState(out:Bundle){out.putString("tab",tab);out.putString("date",date.toString());super.onSaveInstanceState(out)}
    override fun onResume(){super.onResume();foreground=true;NextNotices.retryPending(this);if(::repo.isInitialized){loadVersion();if(repo.api.ready()&&repo.profiles().isNotEmpty())refresh(false)};if(::frame.isInitialized)frame.post{if(!closed&&!journey&&tour==null&&repo.prefs.getString("tour",null)=="active"){tour=NativeTour(this,frame,repo,::tourNavigate){tour=null};tour?.start()}else if(!journey&&tab=="home")prepareSupportHint()}}
    override fun onNewIntent(value:Intent){super.onNewIntent(value);intent=value;value.getStringExtra("profile")?.let{runCatching{repo.select(it)}};value.getStringExtra("date")?.let{runCatching{date=LocalDate.parse(it);week=date.with(DayOfWeek.MONDAY)}};tab="home";render();refresh(false)}
    override fun onPause(){foreground=false;if(::repo.isInitialized&&journey)saveJourney();supportHint?.close();supportHint=null;SensorWindows.pause(this);super.onPause()}
    override fun onWindowFocusChanged(hasFocus:Boolean){super.onWindowFocusChanged(hasFocus);if(!hasFocus){supportHint?.close();supportHint=null}else if(::repo.isInitialized&&!journey&&tab=="home")prepareSupportHint()}
    override fun onDestroy(){closed=true;generation++;lookupSequence++;handler.removeCallbacksAndMessages(null);tour?.close();SensorWindows.close(this);executor.shutdownNow();super.onDestroy()}
    override fun onRequestPermissionsResult(requestCode:Int,permissions:Array<out String>,grantResults:IntArray){super.onRequestPermissionsResult(requestCode,permissions,grantResults);if(requestCode==941)SensorWindows.permission(this,grantResults.firstOrNull()==PackageManager.PERMISSION_GRANTED);if(requestCode==91&&journey&&journeyPhase=="preferences"){preferencePermission=NextNotices.allowed(this);preferencesStep()}}
    @Deprecated("native back") override fun onBackPressed(){when{tour!=null->{tour?.dismiss();tour=null};journey->{lookupSequence++;busy=false;pendingProfile=null;repo.prefs.edit().remove("journeyDraft").remove("journey").commit();journey=false;if(repo.profiles().isEmpty())welcome()else render()};tab!="home"->{tab="home";render()};else->super.onBackPressed()}}
    private fun async(block:()->Unit){executor.submit{try{block()}catch(_:InterruptedException){}catch(e:Exception){runOnUiThread{if(!closed)toast(e.message?.takeIf{it.length<160} ?:"Не вдалося виконати дію")}}}}
    private fun loadVersion(){if(versionPending)return;versionPending=true;val old=NextNotices.items(this).map{it.getString("id")};executor.submit{try{NextWork.scheduleVersionRetry(this,NextWork.checkVersion(this))}catch(_:Exception){}finally{ui{versionPending=false;if(!journey&&tab=="messages"&&old!=NextNotices.items(this).map{it.getString("id")})render()}}}}
    private fun ui(block:()->Unit){runOnUiThread{if(!closed)block()}}
    private fun toast(message:String){Toast.makeText(this,message,Toast.LENGTH_SHORT).show()}
    private fun hideKeyboard(){getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(frame.windowToken,0);currentFocus?.clearFocus()}
    private fun reset(nav:Boolean=true){
        supportHint?.close();supportHint=null
        if(!preservingTour){tour?.close();tour=null}
        generation++;lookupSequence++;transition++;dayHost=null;summaryHost=null;statusHeader=null;weatherHost=null;headerValue=null;headerContext=null
        frame.removeAllViews();shell=u.column();frame.addView(shell,FrameLayout.LayoutParams(-1,-1));scroll=ScrollView(this).apply{isFillViewport=false;isVerticalScrollBarEnabled=false};body=u.column(16);scroll.addView(body);shell.addView(scroll,LinearLayout.LayoutParams(-1,0,1f));if(nav)addNav()
        val screen=generation
        handler.postDelayed({if(screen==generation&&!closed&&getSystemService(android.view.accessibility.AccessibilityManager::class.java).isEnabled){val event=android.view.accessibility.AccessibilityEvent.obtain(android.view.accessibility.AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED);event.contentChangeTypes=android.view.accessibility.AccessibilityEvent.CONTENT_CHANGE_TYPE_SUBTREE;event.setSource(frame);event.packageName=packageName;event.className=frame.javaClass.name;runCatching{frame.parent?.requestSendAccessibilityEvent(frame,event)}}},350)
    }
    private fun logo(){
        val row=LinearLayout(this).apply{orientation=LinearLayout.HORIZONTAL;gravity=Gravity.CENTER_VERTICAL}
        row.addView(ImageView(this).apply{setImageResource(ua.svitlo.widget.R.drawable.ic_svitlo);importantForAccessibility=View.IMPORTANT_FOR_ACCESSIBILITY_NO},LinearLayout.LayoutParams(u.dp(30),u.dp(30)))
        row.addView(u.text("Світло",22f,u.p.accent,true),LinearLayout.LayoutParams(0,-2,1f).apply{marginStart=u.dp(8)})
        if(journey&&repo.profiles().isEmpty())row.addView(u.text("Крок 1 із 2",12f,u.p.muted))
        u.add(body,row,0)
    }
    private fun addNav(){
        val bar=MatchingLabelRow(this,matchChildren=true,singleLineLabels=true).apply{orientation=LinearLayout.HORIZONTAL;gravity=Gravity.CENTER_VERTICAL}
        arrayOf("home" to "Головна","messages" to "Повідомлення","options" to "Опції").forEachIndexed{i,(key,label)->
            val button=u.button(label,selected=tab==key){if(tab!=key){tab=key;render()}}.apply{tag="nav_$key";setPadding(u.dp(3),u.dp(8),u.dp(3),u.dp(8));background=u.bg(if(tab==key)u.p.accent else u.p.surface,16);setTextColor(if(tab==key)u.p.background else u.p.muted)}
            bar.addView(button,LinearLayout.LayoutParams(0,-2,if(i==1)1.5f else 1f).apply{if(i>0)marginStart=u.dp(4)})
        }
        bar.setPadding(u.dp(6),u.dp(6),u.dp(6),u.dp(6));bar.setBackgroundColor(u.p.surface);shell.addView(bar,LinearLayout.LayoutParams(-1,-2))
    }
    private fun render(){frame.findViewWithTag<View>("tour_offer")?.let{frame.removeView(it)};if(journey)repo.prefs.edit().remove("journeyDraft").commit();journey=false;reset();when(tab){"messages"->messages();"options"->options();else->home()}}
    private fun welcome(){journey=false;reset(false);logo();u.add(body,PrototypeScenes.welcome(this){startJourney()},24)}
    private fun privacy(next:()->Unit){
        val welcome=body.findViewWithTag<View>("welcome_conversation")
        welcome?.visibility=View.INVISIBLE
        val dialog=PrototypeScenes.privacy(this){repo.prefs.edit().putBoolean("privacy",true).commit();next()}
        dialog.setOnDismissListener{welcome?.visibility=View.VISIBLE}
    }
    private fun connection(next:()->Unit){if(repo.api.ready()){next();return};val panel=AppDialogPanel(this,"Тестова версія 1.7.0",prefix="pilot_setup");val col=u.column();u.add(col,u.text("Ця збірка працює з окремим приватним сервером. Введіть наданий ключ тестового доступу."),0);val field=u.input("Ключ тестового доступу").apply{inputType=android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD};u.add(col,field);panel.setBody(col);lateinit var d:AlertDialog;val connect=panel.button("Підключити","pilot_connect").apply{gravity=Gravity.CENTER};connect.setOnClickListener{val value=field.text.toString().trim();connect.isEnabled=false;async{try{repo.api.setPilot(value);ui{d.dismiss();next()}}catch(e:Exception){ui{connect.isEnabled=true;field.error=if(e is NextApiException)e.message else"Перевірте ключ і доступ до мережі"}}}};panel.footer(listOf(connect,panel.button("Скасувати","pilot_cancel",cancel=true).apply{setOnClickListener{d.dismiss()}}));d=panel.show()}
    private fun startJourney(){connection{if(!repo.prefs.getBoolean("privacy",false))privacy{beginJourney()}else beginJourney()}}
    private fun beginJourney(){queries.clear();editBackup=null;pendingProfile=null;city=null;street=null;house=null;resolution=null;selectedLine=null;draftName="";reviewEditing=null;editAfterReview=false;journey=true;repo.prefs.edit().putBoolean("journey",true).commit();addressStep("cities")}
    private var mascotWasLoading=false
    private var preferencePermission:Boolean?=null
    private fun mascot(parent:LinearLayout,text:String,asset:String="onboarding-guide-ready-extended-v1.webp",loading:Boolean=false){
        val closing=mascotWasLoading&&!loading;mascotWasLoading=loading;parent.clipChildren=false
        val scene=if(!loading&&asset.startsWith("onboarding-guide-"))PrototypeScenes.onboarding(this,text,if(closing)"mascot-finish-compact-v2.webp"else asset,loading=closing,settle=if(closing)asset else null)else PrototypeScenes.conversation(this,text,if(loading)"mascot-search-full-v2.webp"else asset,loading=loading)
        u.add(parent,scene,12)
    }
    private fun addressGreeting(kind:String){
        val initial=repo.profiles().isEmpty();val small=PrototypeScenes.compact(this)
        val copy=when(kind){
            "cities"->if(initial)if(small)"Допоможу налаштувати «Світло». Яке твоє місто чи село?"else"Давай я допоможу налаштувати «Світло». Як називається твоє місто чи село?"else if(small)"Додамо ще одну адресу. Як називається місто чи село?"else"Радий знову тебе бачити! Додамо ще одну адресу. У якому місті чи селі вона знаходиться?"
            "streets"->if(initial)"Чудово, гарний початок! Яка вулиця?"else"Супер, продовжимо! Яка тут вулиця?"
            else->if(initial)"Гарно виходить! Який номер будинку?"else"Чудово, вулицю обрано! Який номер будинку?"
        }
        mascot(body,copy,when(kind){"cities"->"onboarding-guide-peeking-extended-v1.webp";"streets"->"onboarding-guide-street.webp";else->"onboarding-guide-house.webp"})
    }
    private fun addressStep(kind:String){
        journeyPhase=kind;journey=true;reset(false);logo();addressGreeting(kind)
        val card=u.card();u.add(body,card,0)
        if(city!=null){val label=listOfNotNull(city?.label,if(kind=="houses")street?.label else null).joinToString(", ");u.add(card,u.text(label,15f,u.p.ink,true),0)}
        lookup(card,kind){picked->
            when(kind){"cities"->{city=picked;street=null;house=null;addressStep("streets")};"streets"->{street=picked;house=null;addressStep("houses")};else->{house=picked;resolveHouse()}}
        }
        if(repo.profiles().isNotEmpty())u.add(body,u.button("Повернутись до графіка",cancel=true){lookupSequence++;render()},16)
    }
    private fun lookup(container:LinearLayout,kind:String,picked:(CatalogItem)->Unit){
        val fieldName=when(kind){"cities"->"Населений пункт";"streets"->"Вулиця";else->"Будинок"}
        if(kind!="cities")u.add(container,u.text(fieldName,12f,u.p.muted),8)
        val input=u.input(when(kind){"cities"->"Введіть місто або село";"streets"->"Назва вулиці";else->"Номер будинку"}).apply{tag="lookup_$kind";contentDescription=fieldName}
        u.add(container,input,8)
        val results=u.column();u.add(container,results,8);var cursor:String?=null;var query="";var pending:Runnable?=null;var currentItems=listOf<CatalogItem>();var currentQuery=""
        fun search(q:String,append:Boolean=false){
            val seq=++lookupSequence;query=q;if(!append)currentItems=emptyList();if(kind=="houses")draftHouse=q
            if(!append){results.removeAllViews();cursor=null}
            if(kind=="cities"&&q.trim().length<2){u.add(results,u.text("Введіть щонайменше 2 літери",12f,u.p.muted),0);return}
            val pendingLabel=u.text("Шукаю…",14f,u.p.muted);u.add(results,pendingLabel,0)
            val parent=if(kind=="streets")city?.id else if(kind=="houses")street?.id else null;val page=if(append)cursor else null
            executor.submit{try{
                val data=repo.api.search(kind,parent,q,page);val items=data.getJSONArray("items").objects().map(CatalogItem::parse)
                ui{if(seq!=lookupSequence||!journey)return@ui;results.removeView(pendingLabel);currentQuery=q;currentItems=if(append)currentItems+items else items
                    if(items.isEmpty()&&!append){lastDiagnosticCode="empty";u.add(results,u.text(if(kind=="houses")"Нічого не знайшов. Перевір номер."else"Нічого не знайшов. Перевір назву."),0);u.add(results,u.button("Повідомити"){diagnosticDialog()})}
                    for(item in items){val row=u.button(item.label){hideKeyboard();picked(item)}.apply{gravity=Gravity.START or Gravity.CENTER_VERTICAL;contentDescription=item.label+(item.district?.let{", $it"} ?:"")};u.add(results,row,8)}
                    cursor=data.optString("nextCursor").takeUnless{it.isBlank()||it=="null"}
                    if(cursor!=null)u.add(results,u.button("Показати ще"){results.removeViewAt(results.childCount-1);search(query,true)},8)
                }
            }catch(e:Exception){ui{if(seq!=lookupSequence||!journey)return@ui;results.removeView(pendingLabel);u.add(results,u.text("Не вдалося завантажити дані."),0);u.add(results,u.button("Спробувати ще"){search(q,append)},8);u.add(results,u.button("Повідомити"){diagnosticDialog()})}}}
        }
        input.filters=arrayOf(InputFilter.LengthFilter(if(kind=="houses")32 else 160))
        input.addTextChangedListener(object:TextWatcher{override fun beforeTextChanged(s:CharSequence?,a:Int,c:Int,after:Int){};override fun onTextChanged(s:CharSequence?,a:Int,b:Int,c:Int){lookupSequence++;currentItems=emptyList();queries[kind]=s.toString();pending?.let(handler::removeCallbacks);results.removeAllViews();pending=Runnable{search(s.toString())}.also{handler.postDelayed(it,250)}};override fun afterTextChanged(e:Editable?) {}})
        input.setText(queries[kind].orEmpty())
        pending?.let(handler::removeCallbacks)
        input.setOnEditorActionListener{_,action,event->
            if(action==android.view.inputmethod.EditorInfo.IME_ACTION_DONE||action==android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH||event?.keyCode==KeyEvent.KEYCODE_ENTER&&event.action==KeyEvent.ACTION_UP){
                if(currentQuery==input.text.toString()&&currentItems.size==1&&cursor==null){hideKeyboard();picked(currentItems.single())};true
            }else false
        }
        search(input.text.toString())
    }
    private fun resolveHouse(){resolution=null;selectedLine=null;reviewEditing=null;review()}
    private fun review(){
        journeyPhase="review";reset(false);journey=true;logo();val first=repo.profiles().isEmpty()
        mascot(body,if(first)"Перевір адресу й продовжимо."else"Клас! Ще одну адресу обрано. Дамо їй назву?","onboarding-guide-ready-extended-v1.webp")
        val card=if(first)u.column()else u.card();u.add(body,card,0)
        if(first){
            for(kind in listOf("cities","streets","houses")){
                val label=when(kind){"cities"->"Населений пункт";"streets"->"Вулиця";else->"Будинок"}
                val position=listOf("cities","streets","houses").indexOf(kind)
                val selected=listOf(city,street,house)[position] ?:editBackup?.get(position)
                val row=u.column(12).apply{background=u.bg(u.p.surface,14)}
                val toggle=LinearLayout(this).apply{orientation=LinearLayout.HORIZONTAL;gravity=Gravity.CENTER_VERTICAL;minimumHeight=u.dp(48);isClickable=true;isFocusable=true;contentDescription="$label: ${selected?.label ?:"Обери зі списку"}. Змінити";isEnabled=kind=="cities"||if(kind=="streets")city!=null else street!=null}
                val labels=u.column();u.add(labels,u.text(label,12f,u.p.muted),0);u.add(labels,u.text(selected?.label ?:"Обери зі списку",15f,u.p.ink,true).apply{maxLines=1;ellipsize=android.text.TextUtils.TruncateAt.END},4)
                toggle.addView(labels,LinearLayout.LayoutParams(0,-2,1f));toggle.addView(PrototypeGlyph(this,"edit").apply{importantForAccessibility=View.IMPORTANT_FOR_ACCESSIBILITY_NO})
                toggle.setOnClickListener{
                    val same=reviewEditing==kind
                    editBackup?.let{city=it[0];street=it[1];house=it[2]}
                    editBackup=null
                    if(same)reviewEditing=null else{editBackup=listOf(city,street,house);reviewEditing=kind;queries[kind]=selected?.label.orEmpty();when(kind){"cities"->{city=null;street=null;house=null};"streets"->{street=null;house=null};else->house=null}}
                    review()
                }
                u.add(row,toggle,0)
                if(reviewEditing==kind)lookup(row,kind){item->
                    if(editBackup?.get(position)?.id==item.id){editBackup?.let{city=it[0];street=it[1];house=it[2]};editBackup=null;reviewEditing=null;review()}
                    else {selectedLine=null;resolution=null;queries[kind]=""
                        when(kind){"cities"->{city=item;street=null;house=null;reviewEditing="streets";review()};"streets"->{street=item;house=null;reviewEditing="houses";review()};else->{house=item;editBackup=null;reviewEditing=null;resolveHouse()}}
                    }
                }
                u.add(card,row,8)
            }
        }else{
            u.add(card,u.text(listOfNotNull(city?.label,street?.label,house?.label).joinToString(", "),15f,u.p.ink,true),0)
            val name=u.input("Назва адреси (необов’язково)").apply{setText(draftName);filters=arrayOf(InputFilter.LengthFilter(32))}
            name.addTextChangedListener(object:TextWatcher{override fun beforeTextChanged(s:CharSequence?,a:Int,c:Int,d:Int){};override fun onTextChanged(s:CharSequence?,a:Int,b:Int,c:Int){draftName=s.toString()};override fun afterTextChanged(e:Editable?) {}})
            u.add(card,name)
        }
        u.add(card,PrototypeScenes.primary(this,if(first)"Продовжити"else"Показати графік"){submitAddress()}.apply{isEnabled=house!=null&&reviewEditing==null})
        if(!first)u.add(body,u.button("Повернутись до графіка",cancel=true){render()})
    }
    private fun submitAddress(){hideKeyboard();val selected=house ?: return;val chosen=selectedLine;val previousResolution=resolution;val name=draftName;val cityValue=city?.label ?:"";val streetValue=street?.label ?:"";val first=repo.profiles().isEmpty();reset(false);journey=true;busy=true;logo();mascot(body,"Дай мені секундочку, зараз усе знайду.",loading=true);u.add(body,u.button("Скасувати",cancel=true){lookupSequence++;busy=false;review()});val seq=lookupSequence;val deadline=SystemClock.elapsedRealtime()+60000
        executor.submit{try{
            val r=previousResolution ?: repo.api.resolve(selected.id,chosen)
            val lines=r.getJSONObject("resolution").getJSONArray("lines").objects()
            require(r.getJSONObject("resolution").getBoolean("complete")){"Потрібно уточнити підключення цієї адреси"}
            val selectedId=lines.firstOrNull()?.getString("id") ?: chosen ?: r.getJSONObject("selection").optString("lineId").takeUnless{it.isBlank()||it=="null"}
            if(selectedId==null&&lines.size>1){ui{if(seq==lookupSequence&&journey){busy=false;resolution=r;lookupFailure("Не вдалося завантажити дані."){submitAddress()}}};return@submit}
            repo.ownerSubscription();val today=LocalDate.now(NEXT_ZONE);val monday=today.with(DayOfWeek.MONDAY);val result=repo.api.snapshots(listOf(selected.id),monday,monday.plusDays(13)).getJSONArray("results").getJSONObject(0);require(result.optString("status")=="snapshot"){"Графік поки не вдалося отримати"};val snapshot=Universal.parse(result.getJSONObject("snapshot"));require(SystemClock.elapsedRealtime()<=deadline){"Сервер відповідає надто довго"};val line=snapshot.line(selectedId);require(line!=null || snapshot.json.getJSONObject("resolution").getString("state")=="excluded"){"Потрібно ще раз уточнити лінію цієї адреси"}
                val label=r.getJSONObject("address").optString("label").ifBlank{listOf(cityValue,streetValue,selected.house.ifBlank{selected.label}).joinToString(", ")};val profile=NextProfile(UUID.randomUUID().toString(),name,selected.id,line?.id ?: selectedId,label,cityValue,streetValue,selected.house.ifBlank{selected.label},snapshot.json.getString("operatorId"))
                ui{if(seq!=lookupSequence||!journey)return@ui;try{repo.remember(snapshot);busy=false;date=today;week=monday;if(first){pendingProfile=profile;preferenceChoice=null;preferenceRange=AppAppearance.twoRows(this);preferencesStep()}else{repo.saveConfirmed(profile);journey=false;expanded=repo.profiles().size==2;render();if(expanded)offerAddressHint()};NextWork.schedule(this);NextWidgets.update(this)}catch(e:Exception){lookupFailure("Не вдалося зберегти адресу"){submitAddress()}}}
            }catch(e:Exception){ui{if(seq!=lookupSequence||!journey)return@ui;busy=false;lookupFailure(e.message?.takeIf{it.length<140} ?:"Джерело тимчасово недоступне"){submitAddress()}}}}
    }
    private fun lookupFailure(message:String,retry:()->Unit){reset(false);journey=true;logo();mascot(body,message,"mascot-technician.webp");u.add(body,u.button("Спробувати ще"){retry()});u.add(body,u.button("Змінити адресу"){review()});u.add(body,u.button("Повідомити"){diagnosticDialog()});if(repo.profiles().isNotEmpty())u.add(body,u.button("До графіка",cancel=true){render()})}
    private fun preferencesStep(){
        if(preferenceChoice==null)preferenceChoice=false
        if(preferenceChoice==true&&NextNotices.allowed(this))preferencePermission=true
        journeyPhase="preferences";reset(false);journey=true;logo()
        mascot(body,if(pendingProfile!=null)"Графік знайшов! Давай налаштуємо «Світло» під тебе."else"Продовжимо налаштування. Обери нагадування й вигляд часу.","onboarding-guide-preferences-v2.webp")
        val card=u.card();u.add(body,card,0)
        u.add(card,u.heading("Нагадувати про відключення?"),0)
        u.add(card,u.text("Перед відключенням і відновленням, про аварії та зміни графіка.",14f,u.p.muted),6)
        val yes=u.button("Так, нагадувати",selected=preferenceChoice==true){preferenceChoice=true;preferencePermission=if(NextNotices.allowed(this))true else if(Build.VERSION.SDK_INT<33)false else null;preferencesStep();permission()}
        val no=u.button("Ні, поки що",selected=preferenceChoice==false){preferenceChoice=false;preferencesStep()}
        u.add(card,if(resources.configuration.fontScale>=1.5f)u.column().apply{u.add(this,yes,0);u.add(this,no,8)}else u.row(yes,no))
        if(preferenceChoice==true&&preferencePermission!=true)u.add(card,u.text(if(preferencePermission==false)"Дозвіл не надано. Його можна увімкнути в опціях."else"Очікуємо вибір дозволу",14f,u.p.muted),8)
        u.add(card,u.divider(),16);u.add(card,u.heading("Як показувати час?"))
        val first=NextTimePreview(this,false).apply{isSelected=!preferenceRange;setOnClickListener{preferenceRange=false;preferencesStep()}}
        val range=NextTimePreview(this,true).apply{isSelected=preferenceRange;setOnClickListener{preferenceRange=true;preferencesStep()}}
        val choices=if(resources.configuration.screenWidthDp<=360&&resources.configuration.fontScale>=1.5f)u.column().apply{u.add(this,first,0);u.add(this,range,8)}else u.row(first,range)
        u.add(card,choices)
        u.add(card,PrototypeScenes.primary(this,"Готово"){finishPreferences(false)})
        u.add(card,u.button("Пропустити"){finishPreferences(true)},8)
    }
    private fun finishPreferences(skipped:Boolean){
        val wasEmpty=repo.profiles().isEmpty()
        pendingProfile?.let{repo.saveConfirmed(it)};pendingProfile=null
        if(!skipped){
            val edit=repo.prefs.edit();val enabled=preferenceChoice==true
            for(key in listOf("before","restore","emergency","changes"))edit.putBoolean(key,enabled)
            edit.putInt("lead",30).commit();AppAppearance.setTwoRows(this,preferenceRange)
        }
        repo.prefs.edit().putBoolean("preferencesComplete",!skipped).remove("journeyDraft").commit()
        journey=false;render();NextWork.schedule(this);NextWidgets.update(this)
        if(wasEmpty)offerTour()
    }
    private fun home(){
        homeRoot=body
        val profile=repo.active() ?: run{welcome();return}
        val header=LinearLayout(this).apply{orientation=LinearLayout.HORIZONTAL;gravity=Gravity.TOP}
        header.addView(ImageView(this).apply{setImageResource(ua.svitlo.widget.R.drawable.ic_svitlo);importantForAccessibility=View.IMPORTANT_FOR_ACCESSIBILITY_NO},LinearLayout.LayoutParams(u.dp(30),u.dp(30)))
        statusHeader=StatusHeader(this,null,"",u.p,hideUnknownQueue=true)
        header.addView(statusHeader,LinearLayout.LayoutParams(0,-2,1f).apply{marginStart=u.dp(8)})
        u.add(body,header,0);updateHeader()
        val address=u.card()
        val titleCol=u.column()
        val firstLine=LinearLayout(this).apply{orientation=LinearLayout.HORIZONTAL;gravity=Gravity.CENTER_VERTICAL}
        firstLine.addView(u.text(profile.title,18f,u.p.accent,true).apply{maxLines=1;ellipsize=android.text.TextUtils.TruncateAt.END},LinearLayout.LayoutParams(0,-2,1f))
        val member=repo.member(profile)
        if(member!=null){val state=signalState(repo.signal(member));firstLine.addView(PrototypeGlyph(this,"sensor",when(state){"on"->Color.rgb(91,158,91);"off"->u.p.emergency;else->u.p.muted},if(state=="unknown")"?"else"").apply{importantForAccessibility=View.IMPORTANT_FOR_ACCESSIBILITY_NO},LinearLayout.LayoutParams(u.dp(28),u.dp(28)))}
        u.add(titleCol,firstLine,0)
        u.add(titleCol,u.text(if(profile.name.isBlank())listOf(profile.street,profile.house).filter{it.isNotBlank()}.joinToString(", ")else profile.label,14f,u.p.muted).apply{maxLines=1;ellipsize=android.text.TextUtils.TruncateAt.END},4)
        titleCol.isClickable=true;titleCol.isFocusable=true;titleCol.contentDescription="Обрати адресу: ${profile.label}";titleCol.setOnClickListener{expanded=!expanded;render()}
        val toggle=PrototypeGlyph(this,if(repo.profiles().size==1)"plus"else if(expanded)"up"else"chevron").apply{tag="tour_add";contentDescription=if(repo.profiles().size==1)"Додати адресу"else"Збережені адреси";isFocusable=true;setOnClickListener{if(repo.profiles().size==1)startJourney()else{expanded=!expanded;render()}}}
        val head=LinearLayout(this).apply{tag="tour_address";orientation=LinearLayout.HORIZONTAL;gravity=Gravity.CENTER_VERTICAL;addView(titleCol,LinearLayout.LayoutParams(0,-2,1f));addView(toggle,LinearLayout.LayoutParams(u.dp(48),u.dp(48)))}
        u.add(address,head,0)
        if(expanded){val rows=u.column().apply{tag="tour_address_rows"};u.add(address,rows,8);for(item in repo.profiles()){
            val row=LinearLayout(this).apply{orientation=LinearLayout.HORIZONTAL;gravity=Gravity.CENTER_VERTICAL;background=u.bg(if(item.id==profile.id)u.p.track else u.p.background,12);minimumHeight=u.dp(48)}
            val info=u.column(12).apply{isClickable=true;isFocusable=true;contentDescription=item.label;setOnClickListener{repo.select(item.id);expanded=false;lastSnapshotRevision=null;weatherFor=null;render();refresh(false);NextWidgets.update(this@NextActivity)}}
            if(item.name.isNotBlank())u.add(info,u.text(item.name,14f,u.p.ink,true).apply{maxLines=1;ellipsize=android.text.TextUtils.TruncateAt.END},0)
            u.add(info,u.text(item.label,14f,u.p.muted).apply{maxLines=1;ellipsize=android.text.TextUtils.TruncateAt.END},3)
            row.addView(info,LinearLayout.LayoutParams(0,-2,1f))
            row.addView(PrototypeGlyph(this,"edit").apply{contentDescription="Редагувати адресу ${item.name.ifBlank{item.label}}";setOnClickListener{manageAddress(item)}},LinearLayout.LayoutParams(u.dp(48),u.dp(48)))
            u.add(rows,row,8)
        };u.add(address,u.button("Додати адресу"){startJourney()}.apply{tag="tour_list_add"})}
        u.add(body,address,0)
        val graph=u.card(false).apply{tag="tour_graph"};u.add(body,graph)
        buildDayTabs(graph)
        val host=FrameLayout(this).apply{clipChildren=true};dayHost=host;u.add(graph,host)
        val totals=u.column();summaryHost=totals;u.add(body,totals)
        updateDay(false);loadHomeObservation()
        val weather=u.card();weatherHost=weather;u.add(body,weather);renderWeather(profile);loadWeather(profile)
        val plan=repo.snapshot(profile)?.day(date,profile.lineId)
        if(plan?.known==true)u.add(body,u.button("Поділитись графіком"){share()}.apply{tag="tour_share";ShareButtonIcon.apply(this,u.p.accent)})
        u.add(body,u.button("♡ Подякувати за додаток"){repo.prefs.edit().putBoolean("supportClicked",true).commit();supportHint?.close();supportHint=null;openLink("https://send.monobank.ua/jar/5cWs9Zt1qa")}.apply{tag="support_action"})
        if(repo.prefs.getString("tour",null)==null)offerTour()
        prepareSupportHint()
    }
    private fun buildDayTabs(parent:LinearLayout){
        val row=LinearLayout(this).apply{orientation=LinearLayout.HORIZONTAL}
        dayTabs=(0..6).map{i->u.text(listOf("Пн","Вт","Ср","Чт","Пт","Сб","Нд")[i],14f).apply{
            gravity=Gravity.CENTER;minHeight=u.dp(48);contentDescription=week.plusDays(i.toLong()).toString();setOnClickListener{selectDate(week.plusDays(i.toLong()))}
            row.addView(this,LinearLayout.LayoutParams(0,-2,1f))
        }}
        val weekGestures=DaySwipeFrame(this){direction->moveWeek(direction)};weekGestures.addView(row,FrameLayout.LayoutParams(-1,-2));u.add(parent,weekGestures,0)
        val strip=FrameLayout(this).apply{minimumHeight=u.dp(6)};val line=View(this).apply{background=u.bg(u.p.accent,4)};underline=line
        strip.addView(line,FrameLayout.LayoutParams(u.dp(23),u.dp(3)));u.add(parent,strip,0);u.add(parent,u.divider(),4);refreshTabs()
    }
    private fun available(target:LocalDate):Boolean {val today=LocalDate.now(NEXT_ZONE);if(target==today||target==today.plusDays(1))return true;val p=repo.active() ?: return false;val day=repo.snapshot(p)?.day(target,p.lineId) ?: return false;return day.publicationAvailable}
    private fun refreshTabs(){val todayWeek=LocalDate.now(NEXT_ZONE).with(DayOfWeek.MONDAY);dayTabs.forEachIndexed{i,v->val d=week.plusDays(i.toLong());v.isEnabled=available(d);v.setTextColor(if(d==date)u.p.accent else if(v.isEnabled)u.p.ink else u.p.muted);v.alpha=if(v.isEnabled)1f else .45f;v.contentDescription=d.toString()+if(d==date)", обрано"else""};underline?.post{val row=dayTabs.firstOrNull()?.parent as? LinearLayout ?: return@post;val position=Duration.between(week.atStartOfDay(),date.atStartOfDay()).toDays().toInt().coerceIn(0,6);val x=(position+.5f)*row.width/7-u.dp(23)/2f;underline?.animate()?.cancel();if(NextMascot.animations(this))underline?.animate()?.translationX(x)?.setDuration(220)?.start()else underline?.translationX=x};(body.findViewWithTag<View>("week_navigation") as? LinearLayout)?.let{nav->nav.getChildAt(0).isEnabled=week>todayWeek;val p=repo.active();val next=week.plusWeeks(1);nav.getChildAt(1).isEnabled=p!=null&&repo.snapshot(p)?.day(next,p.lineId)?.let{it.publicationAvailable}==true}}
    private fun moveWeek(delta:Int){val todayWeek=LocalDate.now(NEXT_ZONE).with(DayOfWeek.MONDAY);val next=week.plusWeeks(delta.toLong());if(next<todayWeek)return;if(delta>0){val p=repo.active() ?: return;val monday=repo.snapshot(p)?.day(next,p.lineId);if(monday?.publicationAvailable!=true)return};week=next;date=next;render()}
    private fun selectDate(target:LocalDate){if(target==date||!available(target))return;val lower=LocalDate.now(NEXT_ZONE).with(DayOfWeek.MONDAY);if(target.with(DayOfWeek.MONDAY)<lower)return;val nextWeek=target.with(DayOfWeek.MONDAY);if(nextWeek>week){val p=repo.active() ?: return;if(repo.snapshot(p)?.day(nextWeek,p.lineId)?.let{it.publicationAvailable}!=true)return};val direction=if(target>date)1 else -1;date=target;if(nextWeek!=week){week=nextWeek;render()}else{refreshTabs();updateHeader();updateDay(true,direction);loadHomeObservation()}}
    private fun updateHeader(){
        val p=repo.active() ?:return;val snapshot=repo.snapshot(p);val now=Instant.now();val today=now.atZone(NEXT_ZONE).toLocalDate()
        val plan=snapshot?.day(today,p.lineId,now);val active=plan?.eventAt(now);val next=plan?.next(now)
        val warning=active?.kind==Kind.EMERGENCY
        val kind=if(warning)null else active?.kind ?: next?.kind
        val text=when{
            warning||plan?.state=="not_published"->""
            plan==null||!plan.timerAllowed->"Стан уточнюється"
            active!=null&&active.end==null->"Час відновлення уточнюється"
            active?.end!=null->"До відновлення "+durationText((Duration.between(now,active.end).seconds+59)/60)
            next!=null->"До відключення "+durationText((Duration.between(now,next.start).seconds+59)/60)
            !plan.known->"За графіком"
            plan.events.isEmpty()->"У вас відключень поки немає"
            else->"Без відключень до кінця дня"
        }
        statusHeader?.update(snapshot?.line(p.lineId)?.group,text,kind?.title,true)
    }
    private fun loadHomeObservation(){
        val p=repo.active() ?: return;val m=repo.member(p) ?: return
        if(observationPending||date>LocalDate.now(NEXT_ZONE))return
        val cached=repo.cachedOverview(m,date)
        if(cached!=null && runCatching{wireInstant(cached.getString("asOf")).plusSeconds(30)>Instant.now()}.getOrDefault(false))return
        observationPending=true;val requested=date;val screen=generation
        executor.submit{try{val value=repo.overview(m,requested);ui{if(screen==generation&&!journey&&tab=="home"&&date==requested&&repo.active()?.id==p.id){val observation=SensorPolicy.observation(value,requested);fun update(v:View){if(v is NextHourView)v.setObservation(observation);if(v is ViewGroup)for(i in 0 until v.childCount)update(v.getChildAt(i))};dayHost?.let(::update);val plan=repo.snapshot(p)?.day(date,p.lineId) ?:DayPlan(date,emptyList(),false,"unknown",false);summaryHost?.let{it.removeAllViews();it.visibility=View.VISIBLE;u.add(it,summaries(plan,observation,true),0)}}}}catch(_:Exception){}finally{ui{observationPending=false}}}
    }
    private fun refreshLiveTiles(){
        val p=repo.active() ?:return;val m=repo.member(p)
        val state=m?.let{signalState(repo.signal(it))} ?:"unknown"
        fun visit(v:View){if(v is NextHourView)v.setLive(Instant.now(),state);if(v is ViewGroup)for(i in 0 until v.childCount)visit(v.getChildAt(i))}
        dayHost?.let(::visit)
    }
    private fun updateDay(animate:Boolean,direction:Int=1){
        val host=dayHost ?: return;val p=repo.active() ?: return;val now=Instant.now()
        val plan=repo.snapshot(p)?.day(date,p.lineId,now) ?: DayPlan(date,emptyList(),false,"unknown",false)
        val contents=u.column();val member=repo.member(p)
        val overview=member?.let{repo.cachedOverview(it,date)}
        val observation=overview?.let{SensorPolicy.observation(it,date)}
        if(plan.publicationAvailable&&!plan.timerAllowed)u.add(contents,u.text("Дані графіка уточнюються",14f,u.p.muted),0)
        if(plan.state=="not_published"){
            val dayName=when(date){LocalDate.now(NEXT_ZONE)->"на сьогодні";LocalDate.now(NEXT_ZONE).plusDays(1)->"на завтра";else->"на "+date.format(DateTimeFormatter.ofPattern("d MMMM",Locale.forLanguageTag("uk")))}
            val enabled=repo.prefs.getBoolean("tomorrow",false)&&NextNotices.allowed(this)
            mascot(contents,"Ще не маю графіка $dayName. "+if(enabled)"Покажу тобі, коли отримаю."else"Повідомити тобі, коли з’явиться?","schedule-unpublished.webp")
            if(!enabled)u.add(contents,u.button("Увімкнути сповіщення"){repo.prefs.edit().putBoolean("tomorrow",true).commit();permission();updateDay(false)})
        }else if(!plan.publicationAvailable)u.add(contents,u.text(if(repo.prefs.contains("networkError"))"Збережений графік · немає мережі"else"Дані графіка уточнюються",13f,u.p.muted),0)
        if(plan.state!="not_published"){
            val grid=u.column();grid.tag="hour_grid"
            val hours=plan.hours();val cols=if(resources.configuration.fontScale>=1.5f)if(resources.configuration.screenWidthDp<=360)2 else 3 else 4
            var index=0
            while(index<hours.size){
                val row=LinearLayout(this).apply{orientation=LinearLayout.HORIZONTAL}
                repeat(cols){column->
                    val hour=hours.getOrNull(index++)
                    val tile=if(hour!=null)NextHourView(this,hour,now,date,observation,member!=null,member?.let{signalState(repo.signal(it))} ?:"unknown").apply{
                        tag="hour_${hour.label}";if(member!=null){isClickable=true;setOnClickListener{hourDetails(p,member,hour)}}
                    }else View(this)
                    row.addView(tile,LinearLayout.LayoutParams(0,if(hour==null)u.dp(58)else -2,1f).apply{if(column>0)marginStart=u.dp(5)})
                }
                u.add(grid,row,5)
            }
            val pager=DaySwipeFrame(this){delta->selectDate(date.plusDays(delta.toLong()))};pager.addView(grid)
            u.add(contents,pager,0);u.add(contents,u.divider(),18);legend(contents,plan)
        }
        summaryHost?.let{totals->totals.removeAllViews();totals.visibility=View.GONE;val measured=observation?.optJSONObject("summary")?.optLong("knownMs",0) ?:0L;if(plan.state!="not_published"||measured>0){totals.visibility=View.VISIBLE;u.add(totals,summaries(plan,observation,member!=null),0)}}
        if(plan.state!="not_published")u.add(contents,u.button(if(member==null)"Не співпадає графік?"else"Придбати ще один датчик"){sensorHub(p)}.apply{isEnabled=false})
        val token=++transition
        val old=host.getChildAt(host.childCount-1)
        for(i in 0 until host.childCount)host.getChildAt(i).animate().cancel()
        host.removeAllViews()
        val animateNow=animate&&old!=null&&NextMascot.animations(this)&&host.width>0
        if(animateNow){
            host.addView(old,FrameLayout.LayoutParams(-1,-2));old!!.importantForAccessibility=View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS;old.isEnabled=false;old.alpha=1f
            host.addView(contents,FrameLayout.LayoutParams(-1,-2));contents.translationX=direction*host.width.toFloat()
            old.animate().translationX(-direction*host.width.toFloat()).setDuration(220).start()
            contents.animate().translationX(0f).setDuration(220).setInterpolator(android.view.animation.PathInterpolator(.2f,.7f,.2f,1f)).withEndAction{if(token==transition)host.removeView(old)}.start()
        }else host.addView(contents,FrameLayout.LayoutParams(-1,-2))
        lastSnapshotRevision=daySignature()
    }
    private fun daySignature():String?=repo.active()?.let{p->repo.snapshot(p)?.let{s->val day=s.day(date,p.lineId);"${p.id}:${p.lineId}:$date:${s.revision}:${day.state}:${day.known}:${day.fresh}:${day.publicationAvailable}:${day.applicability}"}}
    private fun legend(parent:LinearLayout,plan:DayPlan){
        val now=Instant.now();val kind=if(date==now.atZone(NEXT_ZONE).toLocalDate())plan.eventAt(now)?.kind ?: plan.next(now)?.kind else plan.events.minByOrNull{it.start}?.kind
        val flow=LegendFlow(this)
        for((index,label)in listOf("Світло є","Світла немає","Поточна година").withIndex()){
            val row=LinearLayout(this).apply{orientation=LinearLayout.HORIZONTAL;gravity=Gravity.CENTER_VERTICAL}
            val k=kind ?:Kind.HOURLY
            val category=when(k){Kind.HOURLY->ua.svitlo.widget.core.Category.SCHEDULE;Kind.EMERGENCY->ua.svitlo.widget.core.Category.EMERGENCY;else->ua.svitlo.widget.core.Category.PLANNED}
            val sample=LegendSample(this,u.p,if(index==1)category else null,current=index==2,kind=ua.svitlo.widget.core.OutageKind.valueOf(k.name))
            row.addView(sample,LinearLayout.LayoutParams(u.dp(20),u.dp(20)))
            row.addView(u.text(label,14f,u.p.muted).apply{maxLines=1},LinearLayout.LayoutParams(-2,-2).apply{marginStart=u.dp(6)})
            flow.addView(row)
        }
        u.add(parent,flow,12)
    }
    private fun summaries(plan:DayPlan,observation:JSONObject?=null,bound:Boolean=false):View{
        val actual=bound&&(observation?.optJSONObject("summary")?.optLong("knownMs",0) ?:0L)>0 && (repo.prefs.getBoolean("actual-${repo.active()?.id}",false)||plan.state=="not_published")
        val total=plan.totals(true);val measured=observation?.optJSONObject("summary")
        fun value(key:String,fallback:Long)=if(actual){if(measured==null||measured.isNull(key))"?"else durationText(measured.getLong(key)/60000)}else if(total.unknown>0&&(key=="offMs"||fallback==0L))"?"else durationText(fallback)
        val source=if(actual)"за фактом"else"за графіком"
        val a=summaryCard("Зі світлом",value("onMs",total.on),source)
        val b=summaryCard("Без світла",value("offMs",total.off),source)
        val pair=if(resources.configuration.fontScale>=1.5f)u.column().apply{u.add(this,a,0);u.add(this,b,12)}else u.row(a,b)
        pair.tag="tour_summaries";return pair
    }
    private fun summaryCard(title:String,value:String,source:String="за графіком"):LinearLayout {
        val card=u.column(12);card.background=u.bg(u.p.surface,18)
        val heading=LinearLayout(this).apply{orientation=LinearLayout.HORIZONTAL;gravity=Gravity.CENTER_VERTICAL}
        heading.addView(SummaryIconView(this,title=="Зі світлом",u.p.accent).apply{background=u.bg(u.p.track,10)},LinearLayout.LayoutParams(u.dp(32),u.dp(32)))
        heading.addView(u.text(title,14f,u.p.ink,true),LinearLayout.LayoutParams(0,-2,1f).apply{marginStart=u.dp(10)})
        u.add(card,heading,0)
        val text=SpannableString(value.replace(" год","\u00a0год").replace(" хв","\u00a0хв"))
        Regex("год|хв").findAll(text).forEach{text.setSpan(RelativeSizeSpan(.42f),it.range.first,it.range.last+1,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)}
        val number=u.text(value,44f,u.p.accent,true).apply{setText(text,TextView.BufferType.SPANNABLE);maxLines=1;setAutoSizeTextTypeUniformWithConfiguration(14,44,1,android.util.TypedValue.COMPLEX_UNIT_SP);minHeight=u.dp(55);contentDescription="$title: $value, $source"}
        u.add(card,number,12);u.add(card,u.text(source,12f,u.p.muted),4);return card
    }
    private fun share(){val p=repo.active() ?: return;val plan=repo.snapshot(p)?.day(date,p.lineId) ?: return;if(!plan.known){toast("Поки немає підтвердженого графіка для поширення");return};val totals=plan.totals(true);if(totals.unknown>0)return;val month=listOf("Січня","Лютого","Березня","Квітня","Травня","Червня","Липня","Серпня","Вересня","Жовтня","Листопада","Грудня")[date.monthValue-1];val group=repo.snapshot(p)?.line(p.lineId)?.group;val ranges=mutableListOf<Pair<Instant,Instant>>();for(part in plan.parts(true).filter{it.kind!=null}){val old=ranges.lastOrNull();if(old!=null&&old.second==part.start)ranges[ranges.lastIndex]=old.first to part.end else ranges+=part.start to part.end};val text="Графік · ${date.dayOfMonth} $month"+(group?.let{" · Черга $it"} ?:"")+"\nЗі світлом: ${durationText(totals.on)}\nБез світла: ${durationText(totals.off)}\n"+ranges.joinToString(", "){clock(it.first)+"–"+if(it.second.atZone(NEXT_ZONE).toLocalDate()>date)"24:00"else clock(it.second)}+"\n-----------------\nВстановити собі\nhttps://www.svitlo.guru";val panel=AppDialogPanel(this,"Поділитись графіком",prefix="next_share");panel.setBody(u.text(text).apply{setTextIsSelectable(true)})
        lateinit var dialog:AlertDialog
        panel.footer(listOf(panel.button("Скопіювати","share_copy").apply{gravity=Gravity.CENTER;setOnClickListener{getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Графік",text));toast("Текст скопійовано")}},panel.button("Закрити","share_close").apply{gravity=Gravity.CENTER;setOnClickListener{dialog.dismiss()}}),horizontal=resources.configuration.fontScale<1.5f)
        dialog=panel.show()}
    private fun returnToAddresses(){tab="home";expanded=repo.profiles().isNotEmpty();if(repo.profiles().isEmpty())welcome()else render();NextWidgets.update(this)}
    private fun manageAddress(p:NextProfile){
        val panel=AppDialogPanel(this,"Керування адресою",if(p.name.isBlank())p.label else p.name+" · "+p.label,prefix="next_address_actions")
        lateinit var d:AlertDialog
        val rename=panel.button("Перейменувати","rename").apply{setOnClickListener{d.dismiss();rename(p)}}
        val delete=panel.button("Видалити адресу","delete").apply{setOnClickListener{
            d.dismiss()
            if(repo.profiles().size>1){repo.delete(p.id);returnToAddresses()}
            else{
                val confirm=AppDialogPanel(this@NextActivity,"Видалити адресу?",prefix="next_delete");confirm.setBody(u.text("Після видалення ви зможете додати нову адресу."));lateinit var c:AlertDialog
                confirm.footer(listOf(confirm.button("Видалити","delete_yes").apply{setOnClickListener{repo.delete(p.id);c.dismiss();returnToAddresses()}},confirm.button("Відмінити","delete_no",cancel=true).apply{setOnClickListener{c.dismiss();returnToAddresses()}}));c=confirm.show()
            }
        }}
        panel.footer(listOf(rename,delete,panel.button("Скасувати","address_cancel",cancel=true).apply{setOnClickListener{d.dismiss();returnToAddresses()}}));d=panel.show()
    }
    private fun rename(p:NextProfile){
        val panel=AppDialogPanel(this,"Перейменувати адресу",p.label,prefix="next_rename")
        val input=panel.input("Назва адреси (необов’язково)","address_name").apply{setText(p.name);contentDescription="Назва адреси";filters=arrayOf(InputFilter.LengthFilter(32))}
        panel.setBody(input);lateinit var d:AlertDialog
        panel.footer(listOf(panel.button("Зберегти","rename_save").apply{setOnClickListener{repo.rename(p.id,input.text.toString());d.dismiss();returnToAddresses()}},panel.button("Скасувати","rename_cancel",cancel=true).apply{setOnClickListener{d.dismiss();returnToAddresses()}}));d=panel.show();input.requestFocus()
    }
    private fun permission(){if(Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS),91)}
    internal fun requestNoticePermission(){permission()}
    private fun appearanceRow(parent:LinearLayout,label:String,kind:String,selected:Boolean,change:(Boolean)->Unit){
        val first=AppearanceOption(this,kind,false,u.p).apply{isSelected=!selected;setOnClickListener{change(false)}}
        val second=AppearanceOption(this,kind,true,u.p).apply{isSelected=selected;setOnClickListener{change(true)}}
        u.add(parent,u.row(u.text(label),first,second,weights=floatArrayOf(.6f,1f,1f)))
    }
    private fun options(){
        logo();val appearance=u.card();u.add(body,appearance,24);u.add(appearance,u.heading("Вигляд"),0)
        appearanceRow(appearance,"Тема","theme",AppAppearance.light(this)){AppAppearance.setLight(this,it);recreate()}
        u.add(appearance,u.divider());appearanceRow(appearance,"Час","time",AppAppearance.twoRows(this)){AppAppearance.setTwoRows(this,it);render()}
        u.add(appearance,u.divider());appearanceRow(appearance,"Значки","icons",AppAppearance.bulbs(this)){AppAppearance.setBulbs(this,it);render()}
        val notices=u.card();notices.tag="tour_options";u.add(body,notices)
        val heading=LinearLayout(this).apply{orientation=LinearLayout.HORIZONTAL;gravity=Gravity.CENTER_VERTICAL}
        heading.addView(u.heading("Сповіщення"),LinearLayout.LayoutParams(0,-2,1f))
        heading.addView(PrototypeGlyph(this,if(NextNotices.allowed(this))"bell"else"bell-off").apply{contentDescription="Стан дозволу на сповіщення";setOnClickListener{noticePermissionAction()}})
        u.add(notices,heading,0)
        for((key,label)in listOf("before" to "Перед відключенням","restore" to "Перед очікуваним відновленням"))addSwitch(notices,key,label)
        val enabled=repo.prefs.getBoolean("before",false)||repo.prefs.getBoolean("restore",false)
        val hint=u.column();u.add(hint,u.text("Нагадувати за"),0);u.add(hint,u.text(if(enabled)"Оберіть час нагадування"else"Увімкніть нагадування, щоб вибрати час",12f,u.p.muted),4)
        val reminder=ReminderLeadRow(this).apply{addView(hint);addView(u.button("${repo.prefs.getInt("lead",30)} хв ▾"){leadPicker()}.apply{isEnabled=enabled})};u.add(notices,reminder)
        u.add(notices,u.divider())
        for((key,label)in listOf("tomorrow" to "Графік на завтра","changes" to "Зміни графіка","emergency" to "Аварії за адресою"))addSwitch(notices,key,label)
        u.add(notices,u.divider());addSwitch(notices,"versions","Нові версії застосунку")
        val widgets=u.card();u.add(body,widgets);u.add(widgets,u.heading("Віджети"),0)
        u.add(widgets,u.actions(u.button("Детальний · 4×4"){NextWidgets.pin(this,true)},u.button("Компактний · 4×2"){NextWidgets.pin(this,false)}))
        sensorOptions()
        if(!repo.prefs.getBoolean("preferencesComplete",false))u.add(body,u.button("Завершити налаштування"){preferenceChoice=listOf("before","restore","emergency","changes").any{repo.prefs.getBoolean(it,false)};preferencePermission=NextNotices.allowed(this);preferenceRange=AppAppearance.twoRows(this);preferencesStep()})
        u.add(body,u.button(if(repo.prefs.getString("tour",null)=="completed")"Повторити навчання"else"Як користуватися додатком"){tab="home";render();startTour()})
        u.add(body,u.divider(),20);u.add(body,u.heading("Умовні позначення"),20)
        for(k in Kind.entries){val category=when(k){Kind.HOURLY->ua.svitlo.widget.core.Category.SCHEDULE;Kind.EMERGENCY->ua.svitlo.widget.core.Category.EMERGENCY;else->ua.svitlo.widget.core.Category.PLANNED};val row=LinearLayout(this).apply{orientation=LinearLayout.HORIZONTAL;gravity=Gravity.CENTER_VERTICAL};row.addView(LegendSample(this,u.p,category,kind=ua.svitlo.widget.core.OutageKind.valueOf(k.name)),LinearLayout.LayoutParams(u.dp(32),u.dp(32)));row.addView(u.text(if(k==Kind.HOURLY)"Погодинне відключення"else k.title,14f),LinearLayout.LayoutParams(0,-2,1f).apply{marginStart=u.dp(14)});u.add(body,row,14)}
        val row=LinearLayout(this).apply{orientation=LinearLayout.HORIZONTAL;gravity=Gravity.CENTER_VERTICAL};row.addView(LegendSample(this,u.p,ua.svitlo.widget.core.Category.SCHEDULE,half=true),LinearLayout.LayoutParams(u.dp(32),u.dp(40)));row.addView(u.text("30 хв без світла",14f),LinearLayout.LayoutParams(0,-2,1f).apply{marginStart=u.dp(14)});u.add(body,row,14)
    }
    private var sensorsExpanded=false
    private fun sensorOptions(){
        val bound=repo.profiles().mapNotNull{p->repo.member(p)?.let{p to it}}
        val card=u.card();u.add(body,card)
        val header=LinearLayout(this).apply{orientation=LinearLayout.HORIZONTAL;gravity=Gravity.CENTER_VERTICAL}
        val title=u.column();u.add(title,u.heading("Датчики"),0);u.add(title,u.text("${bound.size} · один на лінію",12f,u.p.muted),3)
        if(bound.isNotEmpty()){title.isClickable=true;title.contentDescription="Список датчиків";title.setOnClickListener{sensorsExpanded=!sensorsExpanded;render()}}
        header.addView(title,LinearLayout.LayoutParams(0,-2,1f))
        val add=bound.size<2||sensorsExpanded
        header.addView(PrototypeGlyph(this,if(add)"plus"else"chevron").apply{contentDescription=if(add)if(bound.isEmpty())"Підключити датчик"else"Підключити ще один датчик"else"Список датчиків";setOnClickListener{if(add)sensorHub(repo.active())else{sensorsExpanded=true;render()}}})
        u.add(card,header,0)
        if(sensorsExpanded)for((p,m)in bound){
            val row=LinearLayout(this).apply{orientation=LinearLayout.HORIZONTAL;gravity=Gravity.CENTER_VERTICAL}
            val info=u.column();u.add(info,u.text(p.title,14f,u.p.ink,true).apply{maxLines=1;ellipsize=android.text.TextUtils.TruncateAt.END},0)
            u.add(info,u.text(sensorLabel(m),12f,u.p.muted),3);info.minimumHeight=u.dp(48);info.isClickable=true;info.contentDescription="Графіки датчика: ${p.title}";info.setOnClickListener{sensorOverview(p,m,date)}
            row.addView(info,LinearLayout.LayoutParams(0,-2,1f))
            row.addView(PrototypeGlyph(this,"settings",opticalOffsetDp=10).apply{contentDescription="Налаштування датчика: ${p.title}";setOnClickListener{sensorSettings(p,m)}})
            row.addView(PrototypeGlyph(this,"access").apply{contentDescription="Спільний доступ до датчика: ${p.title}";setOnClickListener{sensorSharing(p,m)}})
            u.add(card,row,8)
        }
    }
    private fun sensorLabel(m:JSONObject):String {val s=repo.signal(m);return when(SensorPolicy.signal(s,Instant.now())){"on"->"Світло є";"off"->"Світла немає";else->if(s==null||s.optString("transportState")=="never_seen")"Очікую перший сигнал"else if((s.optString("clockQuality")=="unsynchronized"||s.optString("reason")=="clock_untrusted"))"Час сигналу ненадійний"else"Зв’язок втрачено"}}
    private fun noticePermissionAction(){
        if(Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED){permission();return}
        startActivity(Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE,packageName))
    }
    private fun addSwitch(parent:LinearLayout,key:String,label:String){val toggle=Switch(this).apply{text=label;textSize=14f;setTextColor(u.p.ink);minHeight=u.dp(48);isChecked=repo.prefs.getBoolean(key,false);setPadding(0,u.dp(6),0,u.dp(6));setOnCheckedChangeListener{_,value->repo.prefs.edit().putBoolean(key,value).commit();if(value)permission();NextWork.schedule(this@NextActivity);if(key=="before"||key=="restore")render()}};u.add(parent,toggle,4)}
    private fun leadPicker(){val panel=AppDialogPanel(this,"Нагадувати за",prefix="next_lead");val col=u.column();lateinit var d:AlertDialog;for(minutes in listOf(5,15,30,60))u.add(col,panel.button("$minutes хв","lead_$minutes",selected=minutes==repo.prefs.getInt("lead",30)).apply{setOnClickListener{repo.prefs.edit().putInt("lead",minutes).commit();d.dismiss();NextWork.schedule(this@NextActivity);render()}},8);u.add(col,panel.button("Скасувати","lead_cancel",cancel=true).apply{setOnClickListener{d.dismiss()}},8);panel.setBody(col);d=panel.show()}
    private fun messages(){logo();val items=NextNotices.items(this);if(items.isEmpty())u.add(body,u.text("Нових повідомлень поки немає",14f,u.p.muted),24);for(item in items){val card=u.card();u.add(body,card,16);u.add(card,u.text("Оновлено · "+Instant.ofEpochMilli(item.getLong("at")).atZone(NEXT_ZONE).format(DateTimeFormatter.ofPattern("dd.MM HH:mm")),12f,u.p.muted),0);u.add(card,u.text(item.getString("title"),18f,u.p.ink,true),4);u.add(card,u.text(item.optString("body")),4);if(item.has("profile"))u.add(card,u.button("Переглянути графік"){runCatching{repo.select(item.getString("profile"))};date=runCatching{LocalDate.parse(item.getString("date"))}.getOrDefault(LocalDate.now(NEXT_ZONE));week=date.with(DayOfWeek.MONDAY);tab="home";render()});if(item.optString("url").isNotBlank())u.add(card,u.button("Завантажити"){openLink(item.getString("url"))})};NextNotices.markViewed(this)}
    private fun refresh(force:Boolean){if(refreshPending||!repo.refreshDue(force=force))return;refreshPending=true;executor.submit{try{repo.refresh(force=force);NextWork.afterRefresh(this)}catch(_:Exception){}finally{ui{refreshPending=false;if(!journey&&tab=="home"){if(daySignature()!=lastSnapshotRevision){updateDay(false);refreshTabs()};updateHeader()}}}}}
    private fun loadSensors(force:Boolean){
        if(!repo.api.ready()||repo.api.vault.read("cookie")==null||(!force&&SystemClock.elapsedRealtime()-lastSensorPoll<30000))return
        lastSensorPoll=SystemClock.elapsedRealtime()
        executor.submit{try{NextWork.pollSensors(this,repo);ui{refreshLiveTiles();if(tab=="home"&&!journey)loadHomeObservation()}}catch(_:Exception){}}
    }
    private fun signalState(value:JSONObject?):String=SensorPolicy.signal(value,Instant.now())
    private fun openLink(value:String){val uri=Uri.parse(value);if(uri.scheme!="https"||uri.host !in setOf("www.svitlo.guru","svitlo.guru","send.monobank.ua","open-meteo.com","www.geonames.org","creativecommons.org")){toast("Посилання недоступне");return};runCatching{startActivity(Intent(Intent.ACTION_VIEW,uri))}.onFailure{toast("Не вдалося відкрити посилання")}}
    private fun renderWeather(profile:NextProfile){
        val host=weatherHost ?: return
        host.removeAllViews()
        u.add(host,u.text("СЬОГОДНІ",12f,u.p.muted),0)
        val cached=runCatching{JSONObject(repo.prefs.getString("weather-${profile.id}",null) ?: "{}")} .getOrDefault(JSONObject())
        val current=cached.optJSONObject("current")
        val temperature=current?.optDouble("temperature_2m",Double.NaN)
        val fresh=System.currentTimeMillis()-repo.prefs.getLong("weather-at-${profile.id}",0)<7200000
        val details=u.column()
        u.add(details,u.text(profile.city,18f,u.p.ink,true),0)
        if(current!=null)u.add(details,u.text(WeatherDisplay.icon(current.optInt("weather_code",3))+" "+WeatherDisplay.description(current.optInt("weather_code",3)),14f,u.p.muted),4)
        u.add(host,u.row(u.text(if(fresh&&temperature!=null&&!temperature.isNaN())"${if(temperature>0)"+"else""}${temperature.roundToInt()}°"else"—°",40f,u.p.accent,true),details))
        val hours=cached.optJSONObject("hourly")
        if(hours!=null){
            val horizontal=HorizontalScrollView(this).apply{isHorizontalScrollBarEnabled=false}
            val cells=LinearLayout(this).apply{orientation=LinearLayout.HORIZONTAL}
            horizontal.addView(cells)
            val times=hours.optJSONArray("time") ?: JSONArray()
            val temps=hours.optJSONArray("temperature_2m") ?: JSONArray()
            val codes=hours.optJSONArray("weather_code") ?: JSONArray()
            val now=Instant.now();var count=0
            for(i in 0 until minOf(times.length(),temps.length())){
                val time=runCatching{Instant.ofEpochSecond(times.getLong(i))}.getOrNull() ?: continue
                if(time<=now||count>=24)continue
                count++
                val cell=u.column(10).apply{background=u.bg(u.p.background,16);gravity=Gravity.CENTER}
                u.add(cell,u.text(clock(time),13f,u.p.muted),0)
                u.add(cell,u.text(WeatherDisplay.icon(codes.optInt(i,3)),22f))
                u.add(cell,u.text("${temps.getDouble(i).roundToInt()}°",18f,u.p.ink,true),4)
                cells.addView(cell,LinearLayout.LayoutParams(u.dp(82),-2).apply{marginEnd=u.dp(6)})
            }
            u.add(host,horizontal)
        }
        val links=NextLinkFlow(this).apply{listOf("Open-Meteo" to "https://open-meteo.com/","CC BY 4.0" to "https://creativecommons.org/licenses/by/4.0/","GeoNames" to "https://www.geonames.org/").forEach{(label,url)->addView(u.text(label,11f,u.p.muted).apply{minHeight=u.dp(48);maxLines=1;gravity=Gravity.CENTER_VERTICAL;setOnClickListener{openLink(url)};contentDescription="$label, відкрити посилання"})}}
        u.add(host,links,6)
    }
    private fun loadWeather(profile:NextProfile){
        if(weatherFor==profile.id)return
        weatherFor=profile.id
        executor.submit{try{
            if(System.currentTimeMillis()-repo.prefs.getLong("weather-at-${profile.id}",0)<1800000)return@submit
            val value=NextWeather.fetch(profile) ?: return@submit
            if(repo.profiles().none{it.id==profile.id})return@submit
            repo.prefs.edit().putString("weather-${profile.id}",value).putLong("weather-at-${profile.id}",System.currentTimeMillis()).commit()
            ui{if(tab=="home"&&!journey&&repo.active()?.id==profile.id)renderWeather(profile)}
        }catch(_:Exception){}finally{ui{if(weatherFor==profile.id)weatherFor=null}}}
    }
    private fun offerTour(){
        if(repo.prefs.getString("tour",null)!=null||journey||tab!="home"||frame.findViewWithTag<View>("tour_offer")!=null)return
        val offer=LinearLayout(this).apply{orientation=LinearLayout.HORIZONTAL;gravity=Gravity.BOTTOM;tag="tour_offer"}
        val bubble=u.column(14).apply{background=u.bg(u.p.surface,18)};u.add(bubble,u.text("Давай я покажу, що тут де знаходиться?"),0)
        u.add(bubble,u.row(u.button("Потім"){repo.prefs.edit().putString("tour","deferred").commit();frame.removeView(offer)},u.button("Давай"){frame.removeView(offer);startTour()}),12)
        offer.addView(bubble,LinearLayout.LayoutParams(0,-2,1f));offer.addView(NextMascot(this,"tour-invite-v2.webp"),LinearLayout.LayoutParams(u.dp(116),u.dp(140)))
        frame.addView(offer,FrameLayout.LayoutParams(-1,-2,Gravity.BOTTOM).apply{setMargins(u.dp(12),0,u.dp(12),u.dp(76))})
    }
    private fun tourNavigate(destination:String){if(tab==destination)return;preservingTour=true;try{tab=destination;render()}finally{preservingTour=false}}
    private fun offerAddressHint(){if(repo.prefs.getString("addressHint",null)=="seen")return;repo.prefs.edit().putString("addressHint","pending").commit();tour?.close();tour=NativeTour(this,frame,repo,::tourNavigate,true){tour=null;if(repo.prefs.getString("addressHint",null)=="seen"){expanded=false;render()}};tour?.start()}
    private fun startTour(){tour?.close();repo.prefs.edit().remove("tourStep").putString("tour","active").commit();tour=NativeTour(this,frame,repo,::tourNavigate){tour=null};tour?.start()}
    private fun prepareSupportHint(){
        if(!::scroll.isInitialized||!::frame.isInitialized||supportHint!=null||journey||tab!="home"||repo.active()==null)return
        supportHint=NativeSupportHint(this,frame,scroll,repo){
            val p=repo.active();val plan=p?.let{repo.snapshot(it)?.day(date,it.lineId)}
            closed||journey||tab!="home"||tour!=null||!hasWindowFocus()||frame.findViewWithTag<View>("tour_offer")!=null||plan==null||plan.state in setOf("unknown","stale")
        }.also{it.start()}
    }
    private fun diagnosticDialog(){NextDiagnosticWindow(this,repo,when(journeyPhase){"cities"->"city";"streets"->"street";"houses"->"house";else->"submit"},lastDiagnosticCode,::async,::ui).open()}
    private fun catalogJson(v:CatalogItem?)=v?.let{JSONObject().put("id",it.id).put("label",it.label).put("operatorId",it.operatorId).put("city",it.city).put("street",it.street).put("house",it.house)} ?:JSONObject.NULL
    private fun saveJourney(){
        val d=JSONObject().put("phase",journeyPhase).put("city",catalogJson(city)).put("street",catalogJson(street)).put("house",catalogJson(house)).put("name",draftName).put("line",selectedLine ?:JSONObject.NULL).put("editing",reviewEditing ?:JSONObject.NULL).put("queries",JSONObject(queries.toMap())).put("range",preferenceRange).put("choice",preferenceChoice ?:JSONObject.NULL).put("profile",pendingProfile?.json() ?:JSONObject.NULL)
        editBackup?.let{d.put("backup",JSONArray(it.map(::catalogJson)))}
        d.put("permission",preferencePermission ?:JSONObject.NULL)
        repo.prefs.edit().putString("journeyDraft",d.toString()).commit()
    }
    private fun restoreJourney():Boolean=runCatching{
        val raw=repo.prefs.getString("journeyDraft",null) ?:return false;val d=JSONObject(raw)
        fun record(key:String)=d.optJSONObject(key)?.let(CatalogItem::parse)
        city=record("city");street=record("street");house=record("house");draftName=d.optString("name");selectedLine=d.optString("line").takeUnless{it=="null"||it.isBlank()};reviewEditing=d.optString("editing").takeUnless{it=="null"||it.isBlank()}
        d.optJSONObject("queries")?.let{q->q.keys().forEach{queries[it]=q.getString(it)}}
        d.optJSONArray("backup")?.let{b->editBackup=(0..2).map{b.optJSONObject(it)?.let(CatalogItem::parse)}}
        preferenceRange=d.optBoolean("range");preferenceChoice=if(d.isNull("choice"))null else d.getBoolean("choice");preferencePermission=if(d.isNull("permission"))null else d.getBoolean("permission");pendingProfile=d.optJSONObject("profile")?.let(NextProfile::parse);journey=true
        when(val phase=d.getString("phase")){"review"->review();"preferences"->preferencesStep();"cities","streets","houses"->addressStep(phase);else->return false};true
    }.getOrDefault(false)
    internal fun sensorScreenToken()=generation
    private fun sensorHub(profile:NextProfile?){SensorScreens(this,repo,u,::async,::ui,{render()}).hub(profile)}
    private fun sensorOverview(p:NextProfile,m:JSONObject,d:LocalDate){SensorScreens(this,repo,u,::async,::ui,{render()}).overview(p,m,d)}
    private fun sensorSettings(p:NextProfile,m:JSONObject){SensorScreens(this,repo,u,::async,::ui,{render()}).settings(p,m)}
    private fun sensorSharing(p:NextProfile,m:JSONObject){SensorScreens(this,repo,u,::async,::ui,{render()}).sharing(p,m)}
    private fun hourDetails(p:NextProfile,m:JSONObject,h:DisplayHour){val observation=repo.cachedOverview(m,date)?.let{SensorPolicy.observation(it,date)};SensorHourPanel.show(this,p,h,observation){sensorOverview(p,m,date)}}
}

internal class DaySwipeFrame(context:Context,private val move:(Int)->Unit):FrameLayout(context){private var x=0f;private var y=0f;private var start=0L;private var horizontal=false
    override fun onInterceptTouchEvent(e:MotionEvent):Boolean{when(e.actionMasked){MotionEvent.ACTION_DOWN->{x=e.x;y=e.y;start=e.eventTime;horizontal=false};MotionEvent.ACTION_MOVE->{val dx=abs(e.x-x);val dy=abs(e.y-y);if(dx>40*resources.displayMetrics.density&&dx>dy*1.7){horizontal=true;parent?.requestDisallowInterceptTouchEvent(true);return true}}};return false}
    override fun onTouchEvent(e:MotionEvent):Boolean{if(e.actionMasked==MotionEvent.ACTION_UP&&horizontal){val dx=e.x-x;val dy=abs(e.y-y);if(abs(dx)>48*resources.displayMetrics.density&&abs(dx)>dy*1.7&&e.eventTime-start>=80)move(if(dx<0)1 else -1);horizontal=false;return true};if(e.actionMasked==MotionEvent.ACTION_CANCEL){horizontal=false;return true};return horizontal}
}
