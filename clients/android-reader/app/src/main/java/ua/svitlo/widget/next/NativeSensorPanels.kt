package ua.svitlo.widget.next

import android.app.*
import android.content.*
import android.graphics.*
import android.os.*
import android.view.*
import android.widget.*
import org.json.*
import ua.svitlo.widget.*
import java.time.*
import java.time.format.DateTimeFormatter
import java.util.*
import java.security.MessageDigest

/** Product routes transcribed from UI254 sensor-lab.js, with real BE-06 transport. */
internal class SensorScreens(private val activity:NextActivity,private val repo:NextRepository,private val u:NextUi,private val async:((()->Unit)->Unit),private val ui:((()->Unit)->Unit),private val changed:()->Unit,private val subscription:()->MainAppSubscription={repo.ownerSubscription()},private val commandTransport:((String,JSONObject)->JSONObject)?=null){
    companion object {private val mutationLock=Any()}
    private var currentDialog:AlertDialog?=null
    @Volatile private var commandBusy=false
    private var selectedDate=LocalDate.now(NEXT_ZONE)
    private val viewports=mutableMapOf<String,Pair<Float,Float>>()
    private fun fields(m:JSONObject)=JSONObject().put("sensorId",m.getString("sensorId")).put("bindingEpoch",m.getLong("bindingEpoch"))
    private fun alert(text:String){Toast.makeText(activity,text,Toast.LENGTH_SHORT).show()}
    private fun show(panel:AppDialogPanel):AlertDialog {currentDialog?.dismiss();return panel.show().also{currentDialog=it;SensorWindows.register(activity,it)}}
    /** One UI command at a time. A failed request keeps its idempotency key and
     * re-enables the same action; an old response cannot reopen a closed window. */
    private fun command(button:View,work:((()->Boolean)->Unit)){
        if(commandBusy)return
        commandBusy=true;button.isEnabled=false;val origin=currentDialog
        async{try{work{origin!=null&&origin===currentDialog&&origin.isShowing}}finally{commandBusy=false;ui{if(button.isAttachedToWindow)button.isEnabled=true}}}
    }
    private fun mutate(action:String,body:JSONObject):JSONObject = synchronized(mutationLock) {
        val fingerprint=MessageDigest.getInstance("SHA-256").digest((action+":"+body.toString()).toByteArray()).joinToString(""){"%02x".format(it)}
        val pending=runCatching{JSONObject(repo.api.vault.read("pending-sensor-command") ?:"{}")} .getOrDefault(JSONObject())
        val id=if(pending.optString("fingerprint")==fingerprint)pending.getString("requestId")else UUID.randomUUID().toString()
        repo.api.vault.write("pending-sensor-command",JSONObject().put("fingerprint",fingerprint).put("requestId",id).toString())
        val packet=body.put("requestId",id)
        val result=commandTransport?.invoke(action,packet) ?:repo.api.sensors(action,packet);repo.api.vault.write("pending-sensor-command",null);result
    }
    private fun state(m:JSONObject):String {
        val signal=repo.signal(m);val live=SensorPolicy.signal(signal,Instant.now())
        if(live=="on")return "Світло є"
        if(live=="off")return "Світла немає"
        if(signal==null||signal.optString("transportState")=="never_seen")return "Очікую перший сигнал"
        if((signal.optString("clockQuality")=="unsynchronized"||signal.optString("reason")=="clock_untrusted"))return "Час сигналу ненадійний"
        return "Зв’язок втрачено"
    }
    fun hub(selected:NextProfile?){
        if(repo.profiles().isEmpty()){alert("Спочатку додай адресу");return}
        val free=repo.profiles().filter{repo.member(it)==null}
        val target=selected?.takeIf{p->free.any{it.id==p.id}} ?: free.singleOrNull()
        NativeSensorScanner(activity,u,target?.label ?:"Адресу обереш після сканування"){raw,scanner->
            if(SensorPolicy.qr(raw).getString("kind")=="viewer_invite"){
                scanner.close();if(target!=null)confirmPoint(raw,target)else chooseProfile(raw,free)
            }else connectOwnerScan(raw,scanner,target,free)
        }.show()
    }
    /** Bound owner QR uses the server's existing point. Only a genuinely unbound
     * device asks for the approved initial point confirmation. No transfer wizard. */
    private fun connectOwnerScan(raw:String,scanner:NativeSensorScanner,target:NextProfile?,free:List<NextProfile>){
        val screen=activity.sensorScreenToken()
        fun alive()=scanner.isOpen&&activity.sensorScreenToken()==screen
        async{try{
            subscription().requireActive()
            if(!scanner.maySubmit)return@async
            val sensor=mutate("connect_qr",JSONObject().put("qr",SensorPolicy.qr(raw))).getJSONObject("sensor")
            val accepted=acceptConnection(sensor)
            ui{if(!alive()){scanner.close();return@ui};scanner.close();changed();accepted.first?.let{settings(it,accepted.second)}}
        }catch(e:Exception){ui{
            if(!alive()){scanner.close();return@ui}
            if(SensorConnectFailure.needsInitialProfile(e)){
                scanner.close();if(target!=null)confirmPoint(raw,target)else chooseProfile(raw,free)
            }else scanner.result(SensorConnectFailure.message(e))
        }}}
    }
    private fun acceptConnection(sensor:JSONObject):Pair<NextProfile?,JSONObject> {
        repo.loadMemberships();repo.refreshSensors()
        val current=SensorMembershipPolicy.confirmed(sensor,repo.memberships())
        var local=repo.profiles().find{it.serverId==current.optString("readerProfileId")}
        if(local==null){
            val canonical=current.getString("canonicalAddressId");val line=current.optString("lineId").takeUnless{it.isBlank()||it=="null"}
            val a=repo.api.resolve(canonical,line).getJSONObject("address")
            local=repo.save(NextProfile(UUID.randomUUID().toString(),"",canonical,line,a.getString("label"),a.optString("city"),a.optString("street"),a.optString("house"),a.getString("operatorId"),current.getString("readerProfileId")))
            // Operator availability does not undo a successful sensor command.
            runCatching{repo.refresh(force=true)}
        }
        return local to current
    }
    private fun chooseProfile(raw:String,profiles:List<NextProfile>){
        if(profiles.isEmpty()){alert("До цієї адреси вже підключено датчик");return}
        val panel=AppDialogPanel(activity,"Адреса датчика",prefix="sensor_address");val col=u.column()
        for(p in profiles)u.add(col,panel.button(p.name.ifBlank{p.label},"sensor_address_${p.id}",truncate=true).apply{setOnClickListener{confirmPoint(raw,p)}},8)
        panel.setBody(col);panel.footer(listOf(panel.button("Скасувати","sensor_address_cancel",cancel=true).apply{setOnClickListener{currentDialog?.dismiss()}}));show(panel)
    }
    private fun confirmPoint(raw:String,p:NextProfile){
        val panel=AppDialogPanel(activity,"Підтвердити точку",prefix="sensor_point");panel.setBody(u.text(p.label))
        panel.footer(listOf(panel.button("Скасувати","point_cancel",cancel=true).apply{gravity=Gravity.CENTER;setOnClickListener{currentDialog?.dismiss()}},panel.button("Підключити","point_connect").apply{gravity=Gravity.CENTER;setOnClickListener{currentDialog?.dismiss();connectPayload(raw,p)}}),horizontal=true)
        show(panel)
    }
    fun connectPayload(raw:String,selected:NextProfile?){
        val qr=runCatching{SensorPolicy.qr(raw)}.getOrElse{alert("Цей QR не підходить. Наведи камеру на код датчика.");return}
        val target=selected ?:return
        val panel=AppDialogPanel(activity,"Підключити датчик",target.label,prefix="sensor_connecting");val status=u.text("Підключення")
        panel.setBody(status);val dialog=show(panel)
        var step="profile"
        async{try{
            if(qr.getString("kind")!="viewer_invite")subscription().requireActive()
            val profile=repo.ensureSensorProfile(target)
            step="connect"
            val sensor=mutate("connect_qr",JSONObject().put("qr",qr).put("profileId",profile.serverId)).getJSONObject("sensor")
            step="refresh"
            val accepted=acceptConnection(sensor)
            ui{if(!dialog.isShowing)return@ui;dialog.dismiss();changed();accepted.first?.let{settings(it,accepted.second)}}
        }catch(e:Exception){if(ua.svitlo.widget.BuildConfig.DEBUG)java.io.File(activity.filesDir,"sensor-qa-error.json").writeText(JSONObject().put("stage",step).put("exception",e.javaClass.simpleName).put("http",(e as? NextApiException)?.status).put("code",(e as? NextApiException)?.code).toString());ui{if(!dialog.isShowing)return@ui;status.text=SensorConnectFailure.message(e);panel.footer(listOf(panel.button("Спробувати ще","connect_retry").apply{setOnClickListener{dialog.dismiss();connectPayload(raw,target)}},panel.button("Скасувати","connect_cancel",cancel=true).apply{setOnClickListener{dialog.dismiss()}}))}}}
    }
    fun settings(p:NextProfile,m:JSONObject){
        val panel=AppDialogPanel(activity,"Налаштування датчика",p.label,prefix="sensor_settings");val col=u.column()
        u.add(col,u.heading("Підсумки дня"),0)
        fun choice(actual:Boolean){repo.prefs.edit().putBoolean("actual-${p.id}",actual).commit();settings(p,m);changed()}
        u.add(col,u.row(u.button("За графіком",selected=!repo.prefs.getBoolean("actual-${p.id}",false)){choice(false)},u.button("За датчиком",selected=repo.prefs.getBoolean("actual-${p.id}",false)){choice(true)}))
        u.add(col,u.text("Якщо графіка немає, покажу доступні виміри датчика.",12f,u.p.muted),10)
        u.add(col,Switch(activity).apply{text="Сповіщення про світло та зв’язок";textSize=14f;setTextColor(u.p.ink);minHeight=u.dp(56);isChecked=repo.prefs.getBoolean("sensor-notify-${p.id}",false);setOnCheckedChangeListener{_,enabled->repo.prefs.edit().putBoolean("sensor-notify-${p.id}",enabled).commit();if(enabled)activity.requestNoticePermission()}})
        panel.setBody(col);panel.footer(listOf(panel.button("До огляду","settings_overview").apply{gravity=Gravity.CENTER;setOnClickListener{overview(p,m,selectedDate)}}));show(panel)
    }
    fun sharing(p:NextProfile,m:JSONObject){
        val panel=AppDialogPanel(activity,"Доступ до датчика",p.label,prefix="sensor_access");val col=u.column();val owner=m.optString("role")=="owner"
        u.add(col,u.text(if(owner)"Цей телефон: власник."else"Цей телефон: глядач."),0)
        fun action(label:String,key:String,cancel:Boolean=false,block:(View)->Unit){u.add(col,panel.button(label,key,cancel=cancel).apply{setOnClickListener{block(it)}},8)}
        if(owner){
            action("Запросити телефон","sensor_invite"){button->command(button){alive->val invitation=mutate("invite_create",fields(m)).getJSONObject("invitation");val q=JSONObject().put("version",1).put("kind","viewer_invite").put("sensorId",m.getString("sensorId")).put("proof",invitation.getString("inviteToken"));ui{if(alive())showQr(q,"Запрошення"){sharing(p,m)}}}}
            action("Учасники","sensor_members"){members(p,m)}
            action("Передати власність","sensor_transfer"){button->command(button){alive->val result=mutate("owner_qr",fields(m));val q=result.getJSONObject("qr");ui{if(alive())showQr(q,"Передати власність"){sharing(p,m)}}}}
            action("Від’єднати для всіх","sensor_disconnect",true){
                val confirm=AppDialogPanel(activity,"Від’єднати для всіх?",prefix="sensor_disconnect_confirm");confirm.setBody(u.text("Усі учасники втратять доступ до цієї точки. Інші адреси залишаться."))
                confirm.footer(listOf(confirm.button("Скасувати","disconnect_cancel",cancel=true).apply{gravity=Gravity.CENTER;setOnClickListener{sharing(p,m)}},confirm.button("Від’єднати","disconnect_yes").apply{gravity=Gravity.CENTER;setOnClickListener{button->command(button){alive->mutate("disconnect",fields(m).put("confirmed",true));repo.loadMemberships();ui{if(alive()){currentDialog?.dismiss();changed()}}}}}),horizontal=true);show(confirm)
            }
        }else action("Прибрати у себе","sensor_leave",true){button->command(button){alive->mutate("leave",fields(m).put("membershipId",m.getString("membershipId")));repo.loadMemberships();ui{if(alive()){currentDialog?.dismiss();changed()}}}}
        panel.setBody(col);panel.footer(listOf(panel.button("До огляду","access_overview").apply{gravity=Gravity.CENTER;setOnClickListener{overview(p,m,selectedDate)}}));show(panel)
    }
    private fun members(p:NextProfile,m:JSONObject){
        val panel=AppDialogPanel(activity,"Учасники",p.label,prefix="sensor_members");val col=u.column();val status=u.text("Шукаю…");u.add(col,status,0);panel.setBody(col)
        panel.footer(listOf(panel.button("До доступу","members_access").apply{setOnClickListener{sharing(p,m)}}));val dialog=show(panel)
        async{val result=repo.api.sensors("members",fields(m));ui{if(!dialog.isShowing)return@ui;col.removeAllViews();for((index,row)in result.getJSONArray("members").objects().withIndex()){
            val owner=row.getString("role")=="owner";val line=u.row(u.text("Телефон ${index+1}: "+if(owner)"власник"else"глядач"),panel.button("Відкликати","revoke_$index").apply{visibility=if(owner)View.GONE else View.VISIBLE;setOnClickListener{button->command(button){alive->mutate("member_revoke",fields(m).put("membershipId",row.getString("membershipId")));ui{if(alive())members(p,m)}}}});u.add(col,line,8)
        }}}
    }
    private fun showQr(q:JSONObject,title:String,back:()->Unit){
        SensorPolicy.qr(q.toString());val matrix=com.google.zxing.MultiFormatWriter().encode(q.toString(),com.google.zxing.BarcodeFormat.QR_CODE,600,600)
        val bitmap=Bitmap.createBitmap(600,600,Bitmap.Config.ARGB_8888);val pixels=IntArray(600*600){i->if(matrix[i%600,i/600])Color.BLACK else Color.WHITE};bitmap.setPixels(pixels,0,600,0,0,600,600);pixels.fill(0)
        val panel=AppDialogPanel(activity,title,prefix="sensor_qr");val image=ImageView(activity).apply{setImageBitmap(bitmap);adjustViewBounds=true;contentDescription="QR датчика"};panel.setBody(image)
        panel.footer(listOf(panel.button("До доступу","qr_access").apply{setOnClickListener{back()}}));val dialog=show(panel);dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        SensorWindows.sensitive(activity,dialog);dialog.setOnDismissListener{image.setImageDrawable(null);bitmap.recycle()};Handler(Looper.getMainLooper()).postDelayed({if(dialog.isShowing)dialog.dismiss()},15*60*1000L)
    }
    fun overview(p:NextProfile,m:JSONObject,initial:LocalDate){
        selectedDate=initial;val today=LocalDate.now(NEXT_ZONE);val dates=(listOf(today.minusDays(1),today,today.plusDays(1))+initial).distinct().sorted()
        val panel=AppDialogPanel(activity,"Датчик",p.label,prefix="sensor_overview");val header=SensorPanelHeader(activity,p.label,state(m),signalTime(m))
        panel.header.removeAllViews();panel.header.addView(header,LinearLayout.LayoutParams(-1,-2));panel.header.addView(panel.divider,LinearLayout.LayoutParams(-1,u.dp(1)).apply{topMargin=u.dp(9)})
        // UI227: the dialog owns a bounded viewport. Day changes replace only the
        // pane, never resize/recenter the entire window beneath a user's finger.
        val col=object:LinearLayout(activity){
            init{orientation=VERTICAL}
            override fun onMeasure(w:Int,h:Int){val limit=MeasureSpec.getSize(h).coerceAtMost(u.dp(640));super.onMeasure(w,MeasureSpec.makeMeasureSpec(limit,MeasureSpec.EXACTLY))}
        }
        val dayRow=MatchingLabelRow(activity,true,true).apply{orientation=LinearLayout.HORIZONTAL;background=u.bg(u.p.background,12);setPadding(u.dp(4),u.dp(4),u.dp(4),u.dp(4))}
        val stage=FrameLayout(activity).apply{clipChildren=true};var request=0;var dialog:AlertDialog?=null
        val buttons=mutableListOf<Button>()
        fun load(date:LocalDate,direction:Int=0){
            selectedDate=date;val token=++request;buttons.forEachIndexed{i,b->b.isSelected=dates[i]==date;b.background=u.bg(if(b.isSelected)u.p.track else u.p.background,10);b.setTextColor(if(b.isSelected)u.p.accent else u.p.muted)}
            val pane=u.column();u.add(pane,u.text(date.format(DateTimeFormatter.ofPattern("d MMMM yyyy 'р'.",Locale.forLanguageTag("uk"))),12f,u.p.muted).apply{gravity=Gravity.CENTER},0)
            val forecast=SensorSeriesView(activity,date,true);val history=SensorSeriesView(activity,date,false);val key="${m.getString("sensorId")}:${m.getLong("bindingEpoch")}:$date"
            viewports[key]?.let{(z,o)->forecast.zoom=z;history.zoom=z;forecast.offset=o;history.offset=o}
            forecast.changed={z,o->history.zoom=z;history.offset=o;history.invalidate();viewports[key]=z to o};history.changed={z,o->forecast.zoom=z;forecast.offset=o;forecast.invalidate();viewports[key]=z to o}
            val forecastNote=u.text("Поки немає надійних даних для прогнозу.",12f,u.p.muted);val historyNote=u.text("Підтверджених вимірів ще немає.",12f,u.p.muted)
            val wide=activity.resources.configuration.orientation==android.content.res.Configuration.ORIENTATION_LANDSCAPE
            val charts=LinearLayout(activity).apply{orientation=if(wide)LinearLayout.HORIZONTAL else LinearLayout.VERTICAL;isBaselineAligned=false}
            fun chart(title:String,plot:SensorSeriesView,note:TextView){
                val box=u.column(10).apply{background=u.bg(u.p.background,16).apply{setStroke(u.dp(1),u.p.track)}}
                u.add(box,u.text(title,14f,u.p.ink,true),0)
                box.addView(plot,LinearLayout.LayoutParams(-1,0,1f).apply{topMargin=u.dp(6)})
                u.add(box,note,4)
                charts.addView(box,LinearLayout.LayoutParams(if(wide)0 else -1,if(wide)-1 else 0,1f).apply{if(charts.childCount>0){if(wide)marginStart=u.dp(10)else topMargin=u.dp(10)}})
            }
            if(date>=today)chart("Прогноз",forecast,forecastNote)
            if(date<=today)chart("Історія вимірів",history,historyNote)
            pane.addView(charts,LinearLayout.LayoutParams(-1,0,1f).apply{topMargin=u.dp(8)})
            fun apply(value:JSONObject){val observation=SensorPolicy.observation(value,date);history.observation=observation;historyNote.visibility=if(observation.getJSONArray("intervals").length()>0)View.GONE else View.VISIBLE;val prediction=value.optJSONObject("prediction");if(prediction?.optString("availability")=="available"){forecast.observation=prediction;forecastNote.visibility=View.GONE};header.update(state(m),signalTime(m))}
            repo.cachedOverview(m,date)?.let(::apply)
            val old=stage.getChildAt(stage.childCount-1);for(i in 0 until stage.childCount)stage.getChildAt(i).animate().cancel();stage.removeAllViews()
            if(direction!=0&&old!=null&&NextMascot.animations(activity)&&stage.width>0){
                old.importantForAccessibility=View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS;old.setOnTouchListener{_,_->true}
                stage.addView(old,FrameLayout.LayoutParams(-1,-1));stage.addView(pane,FrameLayout.LayoutParams(-1,-1));pane.translationX=direction*stage.width.toFloat()
                old.animate().translationX(-direction*stage.width.toFloat()).setDuration(220).start()
                pane.animate().translationX(0f).setDuration(220).withEndAction{if(token==request)stage.removeView(old)}.start()
            }else stage.addView(pane,FrameLayout.LayoutParams(-1,-1))
            pane.postDelayed({if(token==request&&dialog?.isShowing==true)panel.content.sendAccessibilityEvent(android.view.accessibility.AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED)},280)
            async{try{val value=repo.overview(m,date);ui{if(token==request&&dialog?.isShowing==true)apply(value)}}catch(_:Exception){ui{if(token==request&&dialog?.isShowing==true&&repo.cachedOverview(m,date)==null){historyNote.text="Не вдалося завантажити дані.";historyNote.visibility=View.VISIBLE}}}}
        }
        for(date in dates){val label=when(date){today.minusDays(1)->"Вчора";today->"Сьогодні";today.plusDays(1)->"Завтра";else->date.format(DateTimeFormatter.ofPattern("dd.MM"))};val b=u.button(label){val direction=if(date>selectedDate)1 else -1;if(date!=selectedDate)load(date,direction)}.apply{setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX,minOf(u.dp(18).toFloat(),textSize));setPadding(u.dp(2),u.dp(6),u.dp(2),u.dp(6))};buttons+=b;dayRow.addView(b,LinearLayout.LayoutParams(0,-2,1f))}
        u.add(col,dayRow,0);col.addView(stage,LinearLayout.LayoutParams(-1,0,1f).apply{topMargin=u.dp(8)});panel.setBody(col,scroll=false)
        panel.footer(listOf(panel.button("Довідка","sensor_help").apply{gravity=Gravity.CENTER;setOnClickListener{help(p,m)}},panel.button("Закрити","sensor_close").apply{gravity=Gravity.CENTER;setOnClickListener{dialog?.dismiss()}}),horizontal=true)
        dialog=show(panel);dialog!!.setCanceledOnTouchOutside(true);dialog!!.setOnDismissListener{request++};load(initial)
    }
    private fun signalTime(m:JSONObject):String {val signal=repo.signal(m) ?:return "";val at=signal.optString("lastConfirmedAt");val instant=runCatching{wireInstant(at)}.getOrNull() ?:return "";return (if(SensorPolicy.signal(signal,Instant.now())=="unknown")"Останній сигнал о "else"Сигнал о ")+clock(instant)}
    private fun help(p:NextProfile,m:JSONObject){
        val panel=AppDialogPanel(activity,"Про датчик",p.label,prefix="sensor_help");val col=u.column();val date=selectedDate
        u.add(col,u.heading(date.format(DateTimeFormatter.ofPattern("d MMMM",Locale.forLanguageTag("uk")))),0)
        val observation=repo.cachedOverview(m,date)?.let{SensorPolicy.observation(it,date)};val summary=observation?.optJSONObject("summary")
        if(summary!=null&&summary.optLong("knownMs",0)>0){u.add(col,u.row(*listOf("Зі світлом" to "onMs","Без світла" to "offMs","Невідомо" to "unknownMs").map{(label,key)->u.column(8).apply{background=u.bg(u.p.background,10);u.add(this,u.text(label,11f,u.p.muted),0);u.add(this,u.text(durationText(summary.optLong(key,0)/60000),15f,u.p.ink,true),4)}}.toTypedArray()))}
        else u.add(col,u.text(if(date>LocalDate.now(NEXT_ZONE))"За майбутній день вимірів ще немає."else"Підтверджених вимірів ще немає."))
        fun fold(title:String,opened:Boolean,contents:View){u.add(col,u.divider(),10);val body=u.column();body.visibility=if(opened)View.VISIBLE else View.GONE;u.add(body,contents,0)
            val toggle=LinearLayout(activity).apply{orientation=LinearLayout.HORIZONTAL;gravity=Gravity.CENTER_VERTICAL;minimumHeight=u.dp(48);isClickable=true;isFocusable=true;contentDescription=title}
            val label=u.text(title,15f,u.p.ink,true).apply{importantForAccessibility=View.IMPORTANT_FOR_ACCESSIBILITY_NO};toggle.addView(label,LinearLayout.LayoutParams(0,-2,1f))
            val arrow=FrameLayout(activity).apply{importantForAccessibility=View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS}
            fun state(){arrow.removeAllViews();arrow.addView(PrototypeGlyph(activity,if(body.visibility==View.VISIBLE)"up"else"chevron"));androidx.core.view.ViewCompat.setStateDescription(toggle,if(body.visibility==View.VISIBLE)"Розгорнуто"else"Згорнуто")}
            toggle.addView(arrow,LinearLayout.LayoutParams(u.dp(48),u.dp(48)));toggle.setOnClickListener{body.visibility=if(body.visibility==View.VISIBLE)View.GONE else View.VISIBLE;state()};state();u.add(col,toggle,0);u.add(col,body,0)
        }
        fun example(title:String,mode:String,copy:String):View {
            val row=LinearLayout(activity).apply{orientation=LinearLayout.HORIZONTAL;gravity=Gravity.CENTER_VERTICAL}
            row.addView(SensorHelpSample(activity,mode),LinearLayout.LayoutParams(u.dp(if(mode=="current")70 else 44),u.dp(when(mode){"current"->44;"actual"->12;else->26})))
            val text=u.column();if(title.isNotEmpty())u.add(text,u.text(title,13f,u.p.ink,true),0);u.add(text,u.text(copy,12f,u.p.muted),2);row.addView(text,LinearLayout.LayoutParams(0,-2,1f).apply{marginStart=u.dp(12)});return row
        }
        val tile=u.column();u.add(tile,example("За графіком","plan","Колір показує офіційний план."),0);u.add(tile,example("За датчиком","actual","Зелений означає «є», кораловий «немає»."),10);u.add(tile,example("","current","Контур показує історію за хвилинами. Крапка лише на поточній годині показує свіжий стан датчика."),10)
        fold("Як читати плитку",true,tile)
        val prediction=u.column();u.add(prediction,example("Прогноз в огляді датчика","prediction","Пунктир показує орієнтовний прогноз за минулими вимірами."),0);u.add(prediction,example("Невідомо","unknown","Тут вимірів немає. Це не підтвердження відключення."),10)
        fold("Прогноз і невідомий час",false,prediction)
        fold("Що саме бачить датчик",false,u.text("Лише свою точку, а не весь будинок. Наприклад, розетка після UPS може показувати резервне живлення.",12f,u.p.muted))
        panel.setBody(col);panel.footer(listOf(panel.button("До огляду","help_overview").apply{gravity=Gravity.CENTER;setOnClickListener{overview(p,m,date)}}));show(panel).setCanceledOnTouchOutside(true)
    }
}

/** UI235 r3: two shared baselines, address ellipsis, independent state/signal right edges. */
private class SensorPanelHeader(c:Context,address:String,state:String,time:String):android.view.ViewGroup(c){
    private val u=NextUi(c)
    private val title=u.text("Датчик",18f,u.p.ink,true)
    private val detail=u.text(address,13f,u.p.muted).apply{maxLines=1;ellipsize=android.text.TextUtils.TruncateAt.END;contentDescription=address}
    private val status=u.text(state,13f,u.p.accent,true).apply{maxLines=1;ellipsize=android.text.TextUtils.TruncateAt.END;gravity=Gravity.END}
    private val signal=u.text(time,12f,u.p.muted).apply{maxLines=1;ellipsize=android.text.TextUtils.TruncateAt.END;gravity=Gravity.END}
    private var baseline1=0;private var baseline2=0
    init{
        listOf(title to 24,detail to 22,status to 18,signal to 16).forEach{(v,cap)->v.setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX,minOf(v.textSize,u.dp(cap).toFloat()));addView(v)}
        update(state,time)
    }
    fun update(state:String,time:String){status.text=state;status.setTextColor(when(state){"Світло є"->u.p.accent;"Світла немає"->u.p.emergency;else->u.p.muted});signal.text=time;requestLayout()}
    override fun onMeasure(w:Int,h:Int){val width=MeasureSpec.getSize(w);val right=(width*.43f).toInt();val left=width-right-u.dp(10);val unspecified=MeasureSpec.makeMeasureSpec(0,MeasureSpec.UNSPECIFIED);for(v in listOf(title,detail))v.measure(MeasureSpec.makeMeasureSpec(left,MeasureSpec.EXACTLY),unspecified);for(v in listOf(status,signal))v.measure(MeasureSpec.makeMeasureSpec(right,MeasureSpec.EXACTLY),unspecified);baseline1=maxOf(title.baseline,status.baseline);baseline2=baseline1+maxOf(title.measuredHeight-title.baseline,status.measuredHeight-status.baseline)+u.dp(3)+maxOf(detail.baseline,signal.baseline);setMeasuredDimension(width,baseline2+maxOf(detail.measuredHeight-detail.baseline,signal.measuredHeight-signal.baseline))}
    override fun onLayout(changed:Boolean,l:Int,t:Int,r:Int,b:Int){title.layout(0,baseline1-title.baseline,title.measuredWidth,baseline1-title.baseline+title.measuredHeight);detail.layout(0,baseline2-detail.baseline,detail.measuredWidth,baseline2-detail.baseline+detail.measuredHeight);status.layout(width-status.measuredWidth,baseline1-status.baseline,width,baseline1-status.baseline+status.measuredHeight);signal.layout(width-signal.measuredWidth,baseline2-signal.baseline,width,baseline2-signal.baseline+signal.measuredHeight)}
}
