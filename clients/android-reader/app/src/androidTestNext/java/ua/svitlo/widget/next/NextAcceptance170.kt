package ua.svitlo.widget.next

import android.app.*
import android.content.*
import android.graphics.Rect
import android.os.*
import android.view.*
import android.view.accessibility.AccessibilityNodeInfo
import org.json.*
import ua.svitlo.widget.AppAppearance
import java.io.File
import java.time.*

/** Test APK only. Touches are injected through Instrumentation into the real native windows. */
class NextAcceptance170:Instrumentation(){
    private lateinit var args:Bundle
    private val checks=JSONArray()
    private fun passed(name:String){checks.put(JSONObject().put("name",name).put("pass",true))}
    override fun onCreate(arguments:Bundle?){super.onCreate(arguments);args=arguments ?:Bundle();start()}
    override fun onStart(){val result=Bundle();try{
        check(targetContext.packageName=="ua.svitlo.widget.next.qa")
        if(args.containsKey("light"))AppAppearance.setLight(targetContext,args.getString("light")=="true")
        when(args.getString("mode","live")){"live"->live();"layout"->layout();"sensor"->sensor();"subscription"->subscription();"subscription-identity"->subscriptionIdentity();"subscription-live"->subscriptionLive();"guide"->guide();"draft"->draft();"widgets"->widgets();"support"->support();"preferences"->preferences();"publication"->publication();"kyiv-live"->kyivLive();else->error("Unknown mode")}
        result.putString("result","PASS")
    }catch(e:Throwable){runCatching{screenshot("failure170");if(args.getString("mode","live")=="live")File(targetContext.filesDir,"failureNodes170.json").writeText(JSONArray(nodes().map{JSONObject().put("class",it.className).put("description",it.contentDescription).put("visible",it.isVisibleToUser).put("editable",it.isEditable)}).toString(2))};result.putString("result","FAIL");result.putString("failure",e.javaClass.simpleName+": "+e.message+" "+e.stackTrace.filter{it.className.contains("NextAcceptance170")}.take(5).joinToString());checks.put(JSONObject().put("pass",false).put("error",e.javaClass.simpleName+": "+e.message))}
        val report=JSONObject().put("sdk",Build.VERSION.SDK_INT).put("mode",args.getString("mode","live")).put("checks",checks)
        File(targetContext.filesDir,"acceptance170.json").writeText(report.toString(2));result.putString("checks",checks.toString());finish(if(result.getString("result")=="PASS")Activity.RESULT_OK else Activity.RESULT_CANCELED,result)
    }
    private fun root()=uiAutomation.rootInActiveWindow
    private fun descendants(n:AccessibilityNodeInfo?):List<AccessibilityNodeInfo>{if(n==null||!n.refresh())return emptyList();return listOf(n)+(0 until n.childCount).flatMap{descendants(n.getChild(it))}}
    private fun nodes():List<AccessibilityNodeInfo>{val info=uiAutomation.serviceInfo;if(info.flags and android.accessibilityservice.AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS==0){info.flags=info.flags or android.accessibilityservice.AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;uiAutomation.serviceInfo=info};val windows=uiAutomation.windows.sortedByDescending{it.layer}.mapNotNull{it.root}.filter{it.packageName?.toString()==targetContext.packageName};return if(windows.isEmpty())descendants(root())else windows.flatMap(::descendants)}
    private fun node(label:String):AccessibilityNodeInfo?=nodes().firstOrNull{it.isVisibleToUser&&(it.text?.toString()==label||it.contentDescription?.toString()==label)}
    private fun await(label:String,timeout:Long=30000):AccessibilityNodeInfo {val end=SystemClock.elapsedRealtime()+timeout;while(SystemClock.elapsedRealtime()<end){node(label)?.let{return it};SystemClock.sleep(150)};error("Native element not found: $label")}
    private fun reveal(label:String){for(i in 0..29){if(node(label)!=null)return;nodes().firstOrNull{it.isScrollable&&it.isVisibleToUser}?.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD);SystemClock.sleep(250)};await(label,2000)}
    private fun tap(label:String){
        runCatching{uiAutomation.waitForIdle(200,2000)}
        var candidate=node(label)
        for(i in 0..10){if(candidate!=null)break;nodes().firstOrNull{it.isScrollable&&it.isVisibleToUser}?.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD);SystemClock.sleep(150);candidate=node(label)}
        var n=candidate ?:await(label);var fresh=false
        // Accessibility can replace its cached tree after a native layout event.
        // Reacquire the same semantic target; never substitute performClick.
        for(attempt in 0..9){if(n.refresh()&&n.isVisibleToUser){fresh=true;break};SystemClock.sleep(80);n=node(label) ?:continue}
        check(fresh){"Stale element: $label"};val r=Rect();n.getBoundsInScreen(r);check(r.width()>0&&r.height()>0)
        val now=SystemClock.uptimeMillis();sendPointerSync(MotionEvent.obtain(now,now,MotionEvent.ACTION_DOWN,r.exactCenterX(),r.exactCenterY(),0));sendPointerSync(MotionEvent.obtain(now,now+70,MotionEvent.ACTION_UP,r.exactCenterX(),r.exactCenterY(),0));waitForIdleSync();SystemClock.sleep(420)
    }
    private fun enter(hint:String,value:String){await(hint);val n=nodes().firstOrNull{it.isVisibleToUser&&it.isEditable&&(it.text?.toString()==hint||it.contentDescription?.toString()==hint)} ?:error("Editable field missing: $hint");check(n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT,Bundle().apply{putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,value)})){"Set text failed: $hint"};SystemClock.sleep(500)}
    private fun screenshot(name:String){uiAutomation.takeScreenshot()?.let{b->File(targetContext.filesDir,"$name.png").outputStream().use{b.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it)};b.recycle()}}
    private fun launch():Activity=startActivitySync(Intent(targetContext,NextActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    /** Own disposable QA session only. Its random subject is written into this
     * app's private storage for encrypted admin handoff, never the public receipt. */
    private fun subscriptionIdentity(){
        val repo=NextRepository(targetContext)
        try{repo.api.sensors("list")}catch(e:NextApiException){if(e.status!=401)throw e;repo.api.sensors("list")}
        val id=repo.api.vault.read("subject") ?:error("QA reader session has no subject")
        check(UUID_RE.matches(id));File(targetContext.filesDir,"subscription-qa-subject.txt").writeText(id)
        passed("Authenticated native QA reader prepared for an explicit admin test grant; no grant/profile mutation")
    }
    /** Two explicit QA readers and one host-created disposable producer only.
     * QR proof arrives through app-private stdin handoff and is consumed here. */
    private fun subscriptionLive(){
        val repo=NextRepository(targetContext);val stage=args.getString("stage","status")
        check(repo.api.call("/readyz").getString("scope")=="isolated-staging")
        if(stage=="status"){
            val right=repo.ownerSubscription();right.requireActive()
            check(right.testAccess);passed("Live authenticated native main-app test grant is active under server transfer gate");return
        }
        if(stage=="restore"){
            val backup=repo.api.vault.read("subscription-live-backup")?.let(::JSONObject)
            if(backup!=null){val edit=repo.prefs.edit().clear();for(key in backup.keys()){val item=backup.getJSONObject(key);when(item.getString("type")){"string"->edit.putString(key,item.getString("value"));"boolean"->edit.putBoolean(key,item.getBoolean("value"));"int"->edit.putInt(key,item.getInt("value"));"long"->edit.putLong(key,item.getLong("value"));"float"->edit.putFloat(key,item.getDouble("value").toFloat());"set"->edit.putStringSet(key,(0 until item.getJSONArray("value").length()).map{item.getJSONArray("value").getString(it)}.toSet())}};edit.commit()}
            val members=repo.loadMemberships()
            val baseline=repo.api.vault.read("subscription-live-owned-baseline")?.let(::JSONArray)?.objects()?.map{it.getString("id")}.orEmpty()
            val fixture=repo.api.vault.read("subscription-live-member")?.let(::JSONObject)
            if(fixture!=null){
                val id=fixture.getString("readerProfileId")
                if(id !in baseline){
                    check(members.none{it.optString("readerProfileId")==id}){"Fixture profile still has an active sensor"}
                    val owned=repo.api.owned("/api",JSONObject().put("action","bootstrap")).getJSONArray("profiles").objects().singleOrNull{it.getString("id")==id}
                    if(owned!=null){check(owned.getJSONObject("address").getString("canonicalAddressId")==fixture.getString("canonicalAddressId"));repo.api.owned("/api",JSONObject().put("action","delete").put("id",id))}
                    passed("Only newly created own QA fixture profile removed after its sensor was disconnected")
                }
            }
            repo.api.vault.write("subscription-live-backup",null);repo.api.vault.write("subscription-live-member",null);repo.api.vault.write("subscription-live-owned-baseline",null)
            passed("Own QA local state restored; current server memberships revalidated");return
        }
        if(stage=="connect"||stage=="unpaid"){
            val right=repo.ownerSubscription();if(stage=="connect")right.requireActive()else check(!right.active)
            val file=File(targetContext.filesDir,"subscription-live-qr.json")
            val raw=try{check(file.length() in 1..1024);file.readText()}finally{file.delete()}
            val qr=SensorPolicy.qr(raw);check(qr.getString("kind")=="phone_owner")
            check(qr.getString("sensorId")==args.getString("sensorId"))
            if(repo.api.vault.read("subscription-live-backup")==null){val backup=JSONObject();for((key,value)in repo.prefs.all){val type=when(value){is String->"string";is Boolean->"boolean";is Int->"int";is Long->"long";is Float->"float";is Set<*>->"set";else->continue};backup.put(key,JSONObject().put("type",type).put("value",if(value is Set<*>)JSONArray(value.toList())else value))};repo.api.vault.write("subscription-live-backup",backup.toString())}
            val p=repo.active() ?:error("A previously accepted own QA address is required")
            if(repo.api.vault.read("subscription-live-owned-baseline")==null){
                val owned=repo.api.owned("/api",JSONObject().put("action","bootstrap")).getJSONArray("profiles").objects()
                repo.api.vault.write("subscription-live-owned-baseline",JSONArray(owned.map{JSONObject().put("id",it.getString("id"))}).toString())
            }
            repo.prefs.edit().putString("tour","deferred").commit()
            var a:Activity?=null
            try{
                a=launch();tap("Опції");tap("Підключити датчик");tap("Ввести код");enter("Код датчика",raw);tap("Перевірити")
                if(stage=="unpaid"){
                    await("Придбайте підписку");check(node("Підтвердити точку")==null);tap("Скасувати")
                    // Exercise server enforcement independently of the UI preflight.
                    try{repo.api.sensors("connect_qr",JSONObject().put("requestId",java.util.UUID.randomUUID().toString()).put("qr",qr));error("Unpaid reader bypassed server gate")}
                    catch(e:NextApiException){check(e.status==403&&e.code=="subscription_required")}
                    passed("Live inactive native reader sees the agreed warning; direct authenticated mutation also denied by server");return
                }
                if(args.getString("initial","false")=="true"){await("Підтвердити точку");tap("Підключити")}
                await("Налаштування датчика",60000)
                val m=repo.loadMemberships().single{it.getString("sensorId")==qr.getString("sensorId")};check(m.getString("role")=="owner")
                repo.api.vault.write("subscription-live-member",m.toString())
                val summary=JSONObject().put("sensorId",m.getString("sensorId")).put("bindingEpoch",m.getLong("bindingEpoch")).put("measurementPointId",m.getString("measurementPointId")).put("role",m.getString("role")).put("initial",args.getString("initial","false")=="true")
                File(targetContext.filesDir,"subscription-live-result.json").writeText(summary.toString())
                passed(if(args.getString("initial","false")=="true")"Live native initial point confirmation and subscribed owner binding"else"Live native bound-owner QR takeover opens settings without another confirmation")
            }finally{runOnMainSync{a?.finish()};waitForIdleSync()}
            return
        }
        val m=JSONObject(repo.api.vault.read("subscription-live-member") ?:error("No own QA fixture membership"))
        check(m.getString("sensorId")==args.getString("sensorId"))
        val fields=JSONObject().put("sensorId",m.getString("sensorId")).put("bindingEpoch",m.getLong("bindingEpoch"))
        when(stage){
            "read"->{
                val day=LocalDate.now(NEXT_ZONE);repo.refreshSensors()
                val packet=repo.overview(m,day);val observation=SensorPolicy.observation(packet,day)
                val intervals=observation.getJSONArray("intervals").objects()
                check(intervals.isNotEmpty()&&observation.getJSONObject("summary").getLong("knownMs")>=1000){"Synthetic exact coverage is absent"}
                check(repo.cachedOverview(m,day)!=null)
                val normalized=intervals.joinToString("\n"){listOf(it.getString("start"),it.getString("end"),it.getString("powerState")).joinToString("|")}
                val hash=java.security.MessageDigest.getInstance("SHA-256").digest(normalized.toByteArray(Charsets.UTF_8)).joinToString(""){"%02x".format(it.toInt()and 255)}
                File(targetContext.filesDir,"subscription-live-history.json").writeText(JSONObject().put("sha256",hash).put("intervalCount",intervals.size).toString())
                passed("Live native owner reads nonempty exact coverage, caches it and records a normalized history hash")
            }
            "revoked"->{try{repo.overview(m,LocalDate.now(NEXT_ZONE));error("Revoked reader retained history access")}catch(e:NextApiException){check(e.status==403||e.status==404)};check(repo.memberships().none{it.getString("sensorId")==m.getString("sensorId")});check(repo.cachedOverview(m,LocalDate.now(NEXT_ZONE))==null);passed("Live takeover denies old reader and purges its cached signal/history/membership")}
            "disconnect"->{repo.api.sensors("disconnect",fields.put("requestId",java.util.UUID.randomUUID().toString()).put("confirmed",true));repo.loadMemberships();passed("Only host-created own QA fixture disconnected after acceptance")}
            else->error("Unknown live subscription stage")
        }
    }
    /** Native scanner pointer checks with controlled server outcomes. No remote
     * subscription or sensor is changed; the original vault/prefs are restored. */
    private fun subscription(){
        val repo=NextRepository(targetContext);val saved=repo.prefs.all.toMap()
        val vaultKeys=listOf("pilot","memberships","pending-sensor-command");val vault=vaultKeys.associateWith{repo.api.vault.read(it)}
        val p=NextProfile(java.util.UUID.randomUUID().toString(),"QA",java.util.UUID.randomUUID().toString(),null,"Тестова адреса","Тестове місто","Тестова вулиця","1","qa-fixture")
        val qr=JSONObject().put("version",1).put("kind","factory_owner").put("sensorId",java.util.UUID.randomUUID().toString()).put("proof","so_"+"A".repeat(43)).toString()
        val worker=java.util.concurrent.Executors.newSingleThreadExecutor();var a:NextActivity?=null
        var calls=0;val ids=mutableListOf<String>();var grant:()->MainAppSubscription={MainAppSubscription(false,null,false)}
        var transport:(String,JSONObject)->JSONObject={_,_->error("No command expected")}
        fun begin(){runOnMainSync{SensorScreens(a!!,repo,NextUi(a!!),{block->worker.submit{block()}},{block->a?.runOnUiThread{block()}},{error("No successful mutation expected")},{grant()},{action,body->calls++;ids+=body.getString("requestId");transport(action,body)}).hub(p)};tap("Ввести код");enter("Код датчика",qr)}
        try{
            vaultKeys.forEach{repo.api.vault.write(it,null)}
            repo.prefs.edit().clear().putString("profiles",JSONArray().put(p.json()).toString()).putString("active",p.id).putString("tour","deferred").putBoolean("preferencesComplete",true).commit()
            a=launch() as NextActivity
            begin();tap("Перевірити");await("Придбайте підписку");check(calls==0);check(node("Підтвердити точку")==null)
            // FLAG_SECURE must stay enabled. Draw only this synthetic manual-code
            // fixture's native decor for visual QA, not an OS screenshot or QR.
            runOnMainSync{
                val field=SensorWindows::class.java.getDeclaredField("dialogs").apply{isAccessible=true}
                val registered=field.get(SensorWindows) as Map<*,*>
                val d=(registered[a] as Set<*>).filterIsInstance<AlertDialog>().last{it.isShowing}
                check(d.window!!.attributes.flags and android.view.WindowManager.LayoutParams.FLAG_SECURE!=0)
                val view=d.window!!.decorView
                for(tag in listOf("sensor_check","sensor_scan_cancel")){
                    val button=view.findViewWithTag<android.widget.Button>(tag)
                    check(button.paint.measureText(button.text.toString())<=button.width-button.compoundPaddingLeft-button.compoundPaddingRight+1){"Scanner action clipped: $tag"}
                    check(button.height>=NextUi(a!!).dp(48))
                }
                val b=android.graphics.Bitmap.createBitmap(view.width,view.height,android.graphics.Bitmap.Config.ARGB_8888)
                view.draw(android.graphics.Canvas(b));File(targetContext.filesDir,"subscription-native-decor.png").outputStream().use{b.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it)};b.recycle()
            }
            tap("Перевірити");await("Придбайте підписку");check(calls==0);tap("Скасувати")
            passed("Missing subscription: exact warning in the same scanner, zero owner mutations, touch retry/cancel")
            if(args.getString("full","true")=="true"){
                grant={MainAppSubscription(true,Instant.now().plusSeconds(600),true)}
                transport={_,_->throw NextApiException(403,code="subscription_required")}
                begin();tap("Перевірити");await("Придбайте підписку");check(calls==1);tap("Скасувати")
                passed("Subscription revoked between preflight and command: same warning, no extra transfer confirmation")
                grant={throw java.io.IOException("controlled outage")}
                val before=calls;begin();tap("Перевірити");await("Не вдалося завантажити дані.");check(calls==before);check(node("Придбайте підписку")==null);tap("Скасувати")
                passed("Unavailable subscription check is a retryable error, never a fabricated unpaid status")
                grant={MainAppSubscription(true,Instant.now().plusSeconds(600),true)}
                transport={_,body->check(!body.has("profileId"));throw NextApiException(409,code="first_connection_requires_profile")}
                begin();tap("Перевірити");await("Підтвердити точку");tap("Скасувати")
                passed("Only explicit unbound-device response opens the original initial point confirmation")
                transport={_,_->throw java.io.IOException("controlled timeout")}
                begin();tap("Перевірити");await("Не вдалося завантажити дані.");val request=ids.last();tap("Перевірити");await("Не вдалося завантажити дані.");check(ids.last()==request);tap("Скасувати")
                passed("Temporary owner-command failure reuses its persisted requestId on real touch retry")
                val entered=java.util.concurrent.CountDownLatch(1);val release=java.util.concurrent.CountDownLatch(1)
                grant={entered.countDown();check(release.await(10,java.util.concurrent.TimeUnit.SECONDS));MainAppSubscription(true,Instant.now().plusSeconds(600),true)}
                val count=calls;begin();tap("Перевірити");check(entered.await(3,java.util.concurrent.TimeUnit.SECONDS));tap("Скасувати");release.countDown();SystemClock.sleep(650);check(calls==count);check(node("Підключення")==null)
                passed("Cancel during preflight prevents submission after its late response")
                val called=java.util.concurrent.CountDownLatch(1);val response=java.util.concurrent.CountDownLatch(1)
                grant={MainAppSubscription(true,Instant.now().plusSeconds(600),true)}
                transport={_,_->called.countDown();check(response.await(10,java.util.concurrent.TimeUnit.SECONDS));throw NextApiException(503)}
                begin();tap("Перевірити");check(called.await(3,java.util.concurrent.TimeUnit.SECONDS));tap("Скасувати");response.countDown();SystemClock.sleep(650);check(node("Не вдалося завантажити дані.")==null);check(node("Налаштування датчика")==null)
                passed("Late command response cannot reopen scanner, error or settings after cancellation")
            }
        }finally{
            worker.shutdownNow();runOnMainSync{a?.finish()};waitForIdleSync();SystemClock.sleep(250)
            val edit=repo.prefs.edit().clear();for((key,value)in saved)when(value){is String->edit.putString(key,value);is Boolean->edit.putBoolean(key,value);is Int->edit.putInt(key,value);is Long->edit.putLong(key,value);is Float->edit.putFloat(key,value);is Set<*>->edit.putStringSet(key,value.filterIsInstance<String>().toSet())};edit.commit()
            vault.forEach{(key,value)->repo.api.vault.write(key,value)}
        }
    }
    /** Read-only wire replay in this QA app. No real profiles or hardware are
     * changed; the original private prefs and pilot credential are restored. */
    private fun publication(){
        val repo=NextRepository(targetContext);val saved=repo.prefs.all.toMap();val pilot=repo.api.vault.read("pilot");var a:Activity?=null
        val date=LocalDate.now(NEXT_ZONE);val anchor=LocalDate.of(2026,11,4)
        val shift=Duration.between(anchor.atStartOfDay(NEXT_ZONE),date.atStartOfDay(NEXT_ZONE)).toMillis()
        val now=Instant.now().toEpochMilli()
        fun replay(name:String):JSONObject {
            val o=JSONObject(context.assets.open("kyiv03/$name.json").bufferedReader().use{it.readText()})
            fun walk(value:JSONObject){for(key in value.keys().asSequence().toList()){when(val child=value.get(key)){
                is JSONObject->walk(child)
                is JSONArray->(0 until child.length()).mapNotNull{child.optJSONObject(it)}.forEach(::walk)
                is Number->when(key){"start","end"->value.put(key,child.toLong()+shift);"checkedAt","sourceUpdatedAt"->value.put(key,now-1000);"freshUntil","refreshAfter"->value.put(key,now+120000)}
                is String->if(key in setOf("date","fromDate","toDate"))value.put(key,LocalDate.parse(child).plusDays(java.time.temporal.ChronoUnit.DAYS.between(anchor,date)).toString())
            }}}
            walk(o);return o
        }
        try{
            repo.api.vault.write("pilot",null)
            for((index,name)in listOf("deg25-emergency","deg25a-emergency","mrii15b-emergency","deg25-applies-control","deg25-missing-control","degraded-conflict").withIndex()){
                val wire=replay(if(name=="degraded-conflict")"deg25-emergency"else name)
                if(name=="degraded-conflict"){wire.put("supportState","degraded");wire.getJSONArray("lines").getJSONObject(0).getJSONObject("categories").getJSONObject("hourly").getJSONArray("days").getJSONObject(0).getJSONObject("applicability").put("state","conflict")}
                val snapshot=Universal.parse(wire);val p=NextProfile("publication-$index","KYIV-03 QA",snapshot.addressId,null,"м. Київ · контроль джерела","м. Київ","","", "ua-kyiv-dtek")
                repo.prefs.edit().putString("profiles",JSONArray().put(p.json()).toString()).putString("active",p.id).putBoolean("privacy",true).putBoolean("preferencesComplete",true).putBoolean("supportHintSeen",true).putString("tour","deferred").remove("journeyDraft").commit();repo.remember(snapshot)
                a=launch();await("Світло");SystemClock.sleep(350)
                val plan=repo.snapshot(p)!!.day(date,null)
                check(repo.active()?.lineId==null);check(repo.snapshot(p)!!.line(null)!=null)
                fun views(v:View):List<View> =listOf(v)+if(v is ViewGroup)(0 until v.childCount).flatMap{views(v.getChildAt(it))}else emptyList()
                val tiles=mutableListOf<NextHourView>();runOnMainSync{tiles+=views(a!!.window.decorView).filterIsInstance<NextHourView>()}
                check(tiles.size==24){"Expected real 24 native tiles: $name, ${tiles.size}"}
                if(name!="deg25-missing-control")check(tiles.any{t->t.hour.parts.any{it.kind==Kind.HOURLY&&!it.unknown}}){"Published plan lost from native tiles: $name"}
                if(name!="deg25-applies-control"){
                    check(!plan.timerAllowed&&plan.totals().unknown==1440L)
                    await("Дані графіка уточнюються")
                    check(nodes().none{it.isVisibleToUser&&it.text?.toString()?.let{s->s.startsWith("До відключення")||s.startsWith("До відновлення")}==true})
                }else check(plan.timerAllowed&&!plan.known)
                screenshot("publication-$name")
                val widget=NextWidgetPainter.picture(targetContext,repo,listOf(p),1,false,320,200)
                check(widget.rows.single().contains(if(plan.timerAllowed)"графіком"else"Стан невідомий")||plan.timerAllowed)
                widget.bitmap.recycle()
                runOnMainSync{a?.finish()};a=null
                // Restart from the same saved null-line profile, without reselection.
                if(name=="mrii15b-emergency"){a=launch();await("Дані графіка уточнюються");check(repo.active()?.id==p.id&&repo.active()?.lineId==null);runOnMainSync{a?.finish()};a=null}
                passed("Native KYIV-03 replay $name: tiles/status/widgets, stored null-line identity retained")
            }
        }finally{
            runOnMainSync{a?.finish()};waitForIdleSync();val edit=repo.prefs.edit().clear()
            for((key,value)in saved)when(value){is String->edit.putString(key,value);is Boolean->edit.putBoolean(key,value);is Int->edit.putInt(key,value);is Long->edit.putLong(key,value);is Float->edit.putFloat(key,value);is Set<*>->edit.putStringSet(key,value.filterIsInstance<String>().toSet())}
            edit.commit();repo.api.vault.write("pilot",pilot)
        }
    }
    /** Real HTTPS universal reads only. This deliberately does not save a
     * profile, alter a reader session, or turn stale upstream data into PASS. */
    private fun kyivLive(){
        val repo=NextRepository(targetContext);check(repo.api.ready());val ready=repo.api.call("/readyz");check(ready.getString("scope")=="isolated-staging")
        val expected=listOf("deg25-emergency" to "22.1","deg25a-emergency" to "14.1","mrii15b-emergency" to "21.1").associate{(file,group)->JSONObject(context.assets.open("kyiv03/$file.json").bufferedReader().use{it.readText()}).getString("addressId") to group}
        val before=repo.profiles().map{it.json().toString()};val date=LocalDate.now(NEXT_ZONE)
        val response=repo.api.snapshots(expected.keys.toList(),date,date.plusDays(1));val results=response.getJSONArray("results").objects()
        check(results.size==3&&results.map{it.getJSONObject("snapshot").getString("addressId")}.toSet()==expected.keys)
        for(row in results){
            check(row.getString("status")=="snapshot");val parsed=Universal.parse(row.getJSONObject("snapshot"));val plan=parsed.day(date,null)
            check(parsed.line(null)?.group==expected[parsed.addressId]);check(plan.fresh&&plan.publicationAvailable){"Current upstream publication unavailable: ${expected[parsed.addressId]}, ${plan.state}"}
            check(plan.planEvents.any{it.kind==Kind.HOURLY});if(plan.applicability!="reported")check(!plan.timerAllowed)
            passed("Live HTTPS universal snapshot: group ${expected[parsed.addressId]}, fresh dated plan, applicability ${plan.applicability}, no guessed line")
        }
        check(before==repo.profiles().map{it.json().toString()});passed("Saved profiles and null-line identity unchanged; no server profile writes")
        File(targetContext.filesDir,"kyiv-live-wire.json").writeText(JSONObject().put("verifiedAt",Instant.now().toString()).put("release",ready.optString("release")).put("response",response).toString(2))
    }
    private fun live(){
        val repo=NextRepository(targetContext);check(repo.api.ready())
        check(repo.api.call("/readyz").getString("scope")=="isolated-staging");passed("Trusted HTTPS private staging")
        val city=repo.api.search("cities",null,"Христинівка").getJSONArray("items").objects().single{it.getString("label")=="м. Христинівка"}
        val streets=repo.api.search("streets",city.getString("id"),"Богуна").getJSONArray("items").objects()
        val street=streets.first{it.getString("label").contains("Богуна")}
        val houses=repo.api.search("houses",street.getString("id"),"8").getJSONArray("items").objects()
        val house=houses.first{it.optString("house")=="8/а"||it.getString("label")=="8/а"}
        passed("Real city street house catalog, Cyrillic 8/а")
        check(repo.profiles().isEmpty()){"Fresh isolated QA installation required"}
        repo.prefs.edit().putBoolean("privacy",false).remove("journeyDraft").commit()
        val a=launch();await("Додати мою адресу");screenshot("native-welcome");tap("Додати мою адресу");await("Розумію");screenshot("native-privacy");tap("Розумію");screenshot("native-city")
        enter("Населений пункт","Христинівка");tap(city.getString("label"))
        enter("Вулиця","Богуна");tap(street.getString("label"))
        enter("Будинок","8");tap(house.getString("label"))
        tap("Продовжити");await("Нагадувати про відключення?",60000);tap("Готово")
        check(repo.profiles().size==1);val p=repo.active()!!;check(p.addressId==house.getString("id"));check(repo.snapshot(p)!=null)
        passed("Native real touch city → street → house → confirmed profile")
        check(!repo.prefs.getBoolean("before",false)&&!repo.prefs.getBoolean("restore",false));passed("Reminders initially off")
        screenshot("live-home")
        // Private transport authenticates as a new staging reader, never an old production identity.
        val list=repo.api.sensors("list");check(list.getJSONArray("sensors").length()==0);check(repo.api.vault.read("cookie")!=null);passed("Native reader cookie and CSRF contract")
        val before=repo.snapshot(p)!!.revision
        repo.refresh(force=true);check(repo.snapshot(p)!=null);passed("Live snapshot refresh retains confirmed profile")
        runOnMainSync{a.finish()};val reopened=launch();check(repo.active()?.id==p.id);await("Світло");passed("Profile and snapshot retained across activity restart")
        tap("Повідомлення");await("Світло");passed("Messages independent of provider and sensor")
        tap("Опції");await("Вигляд");tap("Початок і кінець");passed("Appearance uses real touches")
        screenshot("live-options");runOnMainSync{reopened.finish()}
    }
    private fun layout(){
        val prefs=targetContext.getSharedPreferences("next_state",0)
        prefs.edit().putBoolean("preferencesComplete",true).putString("tour","deferred").commit()
        AppAppearance.setLight(targetContext,args.getString("light")=="true");AppAppearance.setBulbs(targetContext,args.getString("bulbs")=="true");AppAppearance.setTwoRows(targetContext,args.getString("rows")=="true")
        val a=launch();await("Світло");SystemClock.sleep(500);screenshot("layout-home")
        args.getString("width")?.toIntOrNull()?.let{check(a.resources.configuration.screenWidthDp==it)}
        args.getString("font")?.toFloatOrNull()?.let{check(kotlin.math.abs(a.resources.configuration.fontScale-it)<.01f)}
        fun audit(page:String){var error:Throwable?=null;runOnMainSync{try{
            val dm=a.resources.displayMetrics
            fun walk(v:View,inHorizontalScroll:Boolean=false){
                val horizontal=inHorizontalScroll||v is android.widget.HorizontalScrollView
                if(v.isShown&&v.getGlobalVisibleRect(Rect())&&!horizontal){
                    val xy=IntArray(2);v.getLocationOnScreen(xy)
                    check(xy[0]>=-2&&xy[0]+v.width<=dm.widthPixels+2){"$page horizontal overflow: ${v.javaClass.simpleName}"}
                    if(v is android.widget.Button){val l=v.layout;check(l==null||(0 until l.lineCount).all{l.getEllipsisCount(it)==0}){"$page truncated action: ${v.text}"};check(v.height>=48*dm.density-2){"$page small touch target: ${v.text}"}}
                }
                if(v is ViewGroup)for(i in 0 until v.childCount)walk(v.getChildAt(i),horizontal)
            }
            walk(a.window.decorView)
            val nav=listOf("nav_home","nav_messages","nav_options").mapNotNull{a.window.decorView.findViewWithTag<android.widget.TextView>(it)}
            check(nav.size==3&&nav.map{it.textSize.toInt()}.distinct().size==1){"Navigation type sizes diverged"}
        }catch(e:Throwable){error=e}};error?.let{throw it}}
        fun pageAudit(page:String){audit(page);repeat(7){nodes().firstOrNull{it.isScrollable&&it.isVisibleToUser}?.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD);SystemClock.sleep(80);audit(page)};screenshot("layout-$page-bottom")}
        pageAudit("home");passed("Native home: full scroll, horizontal bounds, complete action labels and 48dp targets")
        tap("Опції");await("Вигляд");screenshot("layout-options");pageAudit("options")
        tap("Повідомлення");await("Світло");audit("messages")
        tap("Головна");await("Світло");passed("Three native navigation tabs: touch, same actual type size, no ellipsis")
        passed("Configuration: width=${a.resources.configuration.screenWidthDp}dp fontScale=${a.resources.configuration.fontScale} theme=${args.getString("light")} bulbs=${args.getString("bulbs")} rows=${args.getString("rows")}")
        runOnMainSync{a.finish()}
    }
    private fun guide(){
        val repo=NextRepository(targetContext);check(repo.profiles().isNotEmpty());repo.refresh(force=true)
        repo.prefs.edit().putBoolean("preferencesComplete",true).putString("tour","deferred").putBoolean("supportHintSeen",true).remove("journeyDraft").commit()
        val a=launch();tap("Опції");tap("Як користуватися додатком");await("Додай ще одну адресу");screenshot("guide-first")
        var steps=0
        while(repo.prefs.getString("tour",null)=="active"&&steps<8){
            SystemClock.sleep(300)
            val next=node("Далі")
            if(next!=null)tap("Далі")else tap("Зрозуміло")
            steps++
        }
        check(repo.prefs.getString("tour",null)=="completed");check(steps in 3..6);await("Обрати адресу: ${repo.active()!!.label}")
        passed("Native opt-in guide: $steps conditional steps and completion returns Home")
        runOnMainSync{a.finish()}
    }
    private fun preferences(){
        val repo=NextRepository(targetContext);check(repo.profiles().isNotEmpty())
        val keys=listOf("journeyDraft","preferencesComplete","tour","before","restore","emergency","changes","lead")
        val saved=keys.associateWith{repo.prefs.all[it]};val range=AppAppearance.twoRows(targetContext);var a:Activity?=null
        fun draft(){repo.prefs.edit().putString("tour","deferred").putString("journeyDraft",JSONObject().put("phase","preferences").put("queries",JSONObject()).put("range",!range).put("choice",JSONObject.NULL).toString()).commit()}
        try{
            draft();a=launch();reveal("Як показувати час?");screenshot("preferences-native")
            runOnMainSync{
                val actual=a!!.resources.configuration;val metrics=a!!.resources.displayMetrics;val view=a!!.window.decorView
                if(args.containsKey("expectedWidth"))check(actual.screenWidthDp==args.getString("expectedWidth")!!.toInt()){"Native width differs from requested test width"}
                if(args.containsKey("expectedFont"))check(kotlin.math.abs(actual.fontScale-args.getString("expectedFont")!!.toFloat())<.01f)
                File(targetContext.filesDir,"preferences-geometry.json").writeText(JSONObject().put("screenWidthDp",actual.screenWidthDp).put("screenHeightDp",actual.screenHeightDp).put("fontScale",actual.fontScale.toDouble()).put("density",metrics.density.toDouble()).put("decorWidth",view.width).put("decorHeight",view.height).toString())
                val bitmap=android.graphics.Bitmap.createBitmap(view.width,view.height,android.graphics.Bitmap.Config.ARGB_8888)
                view.draw(android.graphics.Canvas(bitmap));File(targetContext.filesDir,"preferences-decor.png").outputStream().use{bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it)};bitmap.recycle()
            }
            tap(if(range)"Лише початок години"else"Інтервал часу");tap("Ні, поки що")
            check(AppAppearance.twoRows(targetContext)==range);for(key in listOf("before","restore","emergency","changes"))check(repo.prefs.all[key]==saved[key])
            tap("Пропустити");await("Додати адресу");check(AppAppearance.twoRows(targetContext)==range)
            runOnMainSync{a!!.finish()};SystemClock.sleep(400)
            draft();a=launch();reveal("Як показувати час?");tap("Ні, поки що");tap("Готово");await("Додати адресу")
            check(AppAppearance.twoRows(targetContext)!=range);for(key in listOf("before","restore","emergency","changes"))check(!repo.prefs.getBoolean(key,true));check(repo.prefs.getInt("lead",0)==30)
            passed("Native onboarding preferences: visual time examples, draft-only choice, Skip preserves saved settings, Done commits defaults")
        }finally{runOnMainSync{a?.finish()};waitForIdleSync();AppAppearance.setTwoRows(targetContext,range);val edit=repo.prefs.edit();for((key,value)in saved){when(value){is String->edit.putString(key,value);is Boolean->edit.putBoolean(key,value);is Int->edit.putInt(key,value);null->edit.remove(key)}};edit.commit()}
    }
    private fun draft(){
        val repo=NextRepository(targetContext);val count=repo.profiles().size;check(count==1)
        val city=repo.api.search("cities",null,"Христинівка").getJSONArray("items").objects().single{it.getString("label")=="м. Христинівка"}
        val street=repo.api.search("streets",city.getString("id"),"Богуна").getJSONArray("items").objects().first{it.getString("label").contains("Богуна")}
        repo.prefs.edit().putString("tour","deferred").putBoolean("supportHintSeen",true).commit()
        var a=launch();tap("Додати адресу");enter("Населений пункт","Христинівка")
        val monitor=addMonitor(NextActivity::class.java.name,null,false);runOnMainSync{a.recreate()}
        a=waitForMonitorWithTimeout(monitor,7000) ?:error("Recreated activity missing");removeMonitor(monitor)
        await("Населений пункт");check(nodes().any{it.isEditable&&it.text?.toString()=="Христинівка"});tap("м. Христинівка")
        enter("Вулиця","Богуна");tap(street.getString("label"))
        enter("Будинок","8");tap("8/а");await("Показати графік")
        tap("Повернутись до графіка");await("Світло");check(repo.profiles().size==count&&repo.prefs.getString("journeyDraft",null)==null)
        passed("Native wizard query survives activity recreation; Cyrillic house selection and cancel preserve existing profile")
        tap("Додати адресу");enter("Населений пункт","Христинівка");val second=addMonitor(NextActivity::class.java.name,null,false);runOnMainSync{a.recreate()};a=waitForMonitorWithTimeout(second,7000) ?:error("Second recreation missing");removeMonitor(second);await("Населений пункт")
        sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);SystemClock.sleep(400);await("Додати адресу");check(repo.prefs.getString("journeyDraft",null)==null)
        passed("Hardware Back cancels the restored wizard and removes its private draft")
        runOnMainSync{a.finish()}
    }
    /** Eligibility is seeded only in the isolated QA installation and restored. */
    private fun support(){
        val repo=NextRepository(targetContext);val keys=listOf("tour","supportDays","supportClicked","supportHintSeen")
        val before=keys.associateWith{repo.prefs.all[it]};val today=LocalDate.now(NEXT_ZONE);var a:Activity?=null
        try{
            repo.prefs.edit().putString("tour","deferred").putString("supportDays",JSONArray(listOf(today.minusDays(2).toString(),today.minusDays(1).toString())).toString()).putBoolean("supportClicked",false).putBoolean("supportHintSeen",false).commit()
            a=launch();await("Світло")
            repeat(8){nodes().firstOrNull{it.isScrollable&&it.isVisibleToUser}?.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD);SystemClock.sleep(200)}
            await("Зрозуміло");check(repo.prefs.getBoolean("supportHintSeen",false));screenshot("support-passive")
            val layer=a!!.window.decorView.findViewWithTag<View>("support_hint");check(layer!=null)
            nodes().firstOrNull{it.isScrollable&&it.isVisibleToUser}?.performAction(AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD);SystemClock.sleep(250)
            check(a!!.window.decorView.findViewWithTag<View>("support_hint")!=null){"Passive support hint disappeared during scroll"}
            tap("Зрозуміло");check(a!!.window.decorView.findViewWithTag<View>("support_hint")==null)
            tap("Опції");await("Вигляд");passed("Native passive support hint: third distinct day, one display, scrolling remains available, dismiss and navigation work")
        }finally{runOnMainSync{a?.finish()};val edit=repo.prefs.edit();for((key,value)in before){when(value){is String->edit.putString(key,value);is Boolean->edit.putBoolean(key,value);null->edit.remove(key)}};edit.commit()}
    }
    /** Synthetic local profiles for host geometry only. No catalog/provider calls,
     * existing launcher widgets or production application data are modified. */
    private fun widgets(){
        val repo=NextRepository(targetContext);val saved=repo.prefs.getString("profiles","[]");val active=repo.prefs.getString("active",null);val pilot=repo.api.vault.read("pilot")
        val fixtures=(1..5).map{n->NextProfile(java.util.UUID.randomUUID().toString(),"QA адреса $n",java.util.UUID.randomUUID().toString(),null,"Тестова адреса $n","","","","qa-fixture")}
        val host=android.appwidget.AppWidgetHost(targetContext,1700);val manager=android.appwidget.AppWidgetManager.getInstance(targetContext);val ids=mutableListOf<Int>();var a:Activity?=null;var dialog:Dialog?=null
        fun shell(command:String){uiAutomation.executeShellCommand(command).use{fd->android.os.ParcelFileDescriptor.AutoCloseInputStream(fd).use{it.readBytes()}}}
        try{
            repo.api.vault.write("pilot",null)
            val edit=repo.prefs.edit().putString("profiles",JSONArray(fixtures.map{it.json()}).toString()).putString("active",fixtures[0].id).putString("tour","deferred").putBoolean("supportHintSeen",true)
            fixtures.forEach{edit.putLong("weather-at-${it.id}",System.currentTimeMillis())};edit.commit()
            val user=android.os.Process.myUid()/100000
            shell("appwidget grantbind --package ${targetContext.packageName} --user $user")
            host.startListening();a=launch();await("Світло")
            for(detailed in listOf(true,false)){
                if(!detailed)repo.select(fixtures[1].id)
                val id=host.allocateAppWidgetId();ids+=id;val component=ComponentName(targetContext,if(detailed)NextDetailedWidget::class.java else NextCompactWidget::class.java)
                val options=Bundle().apply{putInt(android.appwidget.AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH,320);putInt(android.appwidget.AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH,320);putInt(android.appwidget.AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT,if(detailed)340 else 180);putInt(android.appwidget.AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT,if(detailed)340 else 180)}
                check(manager.bindAppWidgetIdIfAllowed(id,component,options)){"QA host bind denied"}
                lateinit var widget:android.appwidget.AppWidgetHostView
                runOnMainSync{
                    widget=host.createView(targetContext,id,manager.getAppWidgetInfo(id))
                    val holder=android.widget.FrameLayout(a!!);val density=a!!.resources.displayMetrics.density
                    holder.addView(widget,android.widget.FrameLayout.LayoutParams((320*density).toInt(),((if(detailed)340 else 180)*density).toInt()))
                    dialog=Dialog(a!!).apply{requestWindowFeature(Window.FEATURE_NO_TITLE);setContentView(holder);window?.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(android.graphics.Color.TRANSPARENT));window?.decorView?.setPadding(0,0,0,0);show();window?.setLayout((320*density).toInt(),((if(detailed)340 else 180)*density).toInt())}
                    NextWidgets.render(targetContext,manager,id,detailed)
                }
                SystemClock.sleep(700)
                fun view(idValue:Int)=widget.findViewById<View>(idValue) ?:error("RemoteViews child missing")
                fun hit(v:View){val r=Rect();check(v.getLocalVisibleRect(r)&&r.width()>0&&r.height()>0);val location=IntArray(2);v.getLocationOnScreen(location);r.offset(location[0],location[1]);val now=SystemClock.uptimeMillis();sendPointerSync(MotionEvent.obtain(now,now,MotionEvent.ACTION_DOWN,r.exactCenterX(),r.exactCenterY(),0));sendPointerSync(MotionEvent.obtain(now,now+70,MotionEvent.ACTION_UP,r.exactCenterX(),r.exactCenterY(),0));waitForIdleSync();SystemClock.sleep(500)}
                val firstHeight=view(ua.svitlo.widget.R.id.next_widget_row0).height
                if(detailed){
                    check(view(ua.svitlo.widget.R.id.next_widget_prev).visibility==View.VISIBLE)
                    val touches=mutableListOf<Int>()
                    runOnMainSync{view(ua.svitlo.widget.R.id.next_widget_next).setOnTouchListener{_,event->touches+=event.actionMasked;false}}
                    screenshot("widget-detailed-before-page")
                    hit(view(ua.svitlo.widget.R.id.next_widget_next))
                    screenshot("widget-detailed-after-page")
                    check(targetContext.getSharedPreferences("next_widget_pages",0).getInt("page-$id",0)==1){"Native pager did not advance; touches=$touches, next clickable=${view(ua.svitlo.widget.R.id.next_widget_next).isClickable}, enabled=${view(ua.svitlo.widget.R.id.next_widget_next).isEnabled}"}
                    check(view(ua.svitlo.widget.R.id.next_widget_row1).visibility==View.INVISIBLE)
                    check(view(ua.svitlo.widget.R.id.next_widget_row0).height==firstHeight)
                    check(!view(ua.svitlo.widget.R.id.next_widget_next).isEnabled)
                    screenshot("widget-detailed-host");hit(view(ua.svitlo.widget.R.id.next_widget_row0));check(repo.active()?.id==fixtures[4].id)
                }else{
                    check(view(ua.svitlo.widget.R.id.next_widget_prev).visibility==View.GONE)
                    check(view(ua.svitlo.widget.R.id.next_widget_row1).visibility==View.GONE)
                    screenshot("widget-compact-host");hit(view(ua.svitlo.widget.R.id.next_widget_row0));check(repo.active()?.id==fixtures[1].id)
                }
                runOnMainSync{dialog?.dismiss();dialog=null}
                passed(if(detailed)"Native AppWidgetHost: five profiles, paging, fixed final-page slot and exact profile PendingIntent"else"Native AppWidgetHost: compact active profile, no paging and exact profile PendingIntent")
            }
            for(light in listOf(false,true)){AppAppearance.setLight(targetContext,light);for((w,h)in listOf(180 to 160,320 to 240,414 to 320,600 to 240))for(detailed in listOf(false,true)){val picture=NextWidgetPainter.picture(targetContext,repo,if(detailed)fixtures.take(4)else fixtures.take(1),5,detailed,w,h);check(picture.bitmap.byteCount<=900*600*4);check(picture.bitmap.getPixel(picture.bitmap.width/2,4)==ua.svitlo.widget.WidgetStyle.palette().surface);picture.bitmap.recycle()}}
            passed("Widget renderer: fixed dark in both app themes, eight size/type combinations, bounded bitmap memory")
        }finally{
            runOnMainSync{dialog?.dismiss();a?.finish()};ids.forEach{host.deleteAppWidgetId(it)};host.stopListening();host.deleteHost()
            val edit=repo.prefs.edit().putString("profiles",saved).putString("active",active);fixtures.forEach{edit.remove("weather-at-${it.id}")};edit.commit();repo.api.vault.write("pilot",pilot)
            shell("appwidget revokebind --package ${targetContext.packageName} --user ${android.os.Process.myUid()/100000}");NextWidgets.scheduleTick(targetContext)
        }
    }
    /** Own isolated QA producer only. Synthetic telemetry is explicitly test evidence, not hardware evidence. */
    private fun sensor(){
        val repo=NextRepository(targetContext);check(repo.api.call("/readyz").getString("scope")=="isolated-staging")
        val p=repo.active() ?:error("Run live catalog acceptance first")
        fun nativePost(path:String,body:JSONObject,bearer:String?=null):JSONObject{
            check(path in setOf("/api/v1/sensor-devices/register","/api/v1/sensor-devices/control","/api/v1/sensor-events"))
            val conn=java.net.URL(NextApi.BASE+path).openConnection() as javax.net.ssl.HttpsURLConnection
            try{conn.instanceFollowRedirects=false;conn.connectTimeout=12000;conn.readTimeout=25000;conn.requestMethod="POST";conn.doOutput=true;conn.setRequestProperty("Content-Type","application/json");conn.setRequestProperty("X-Svitlo-Pilot-Key",repo.api.vault.read("pilot"));bearer?.let{conn.setRequestProperty("Authorization","Bearer $it")};val bytes=body.toString().toByteArray();conn.setFixedLengthStreamingMode(bytes.size);conn.outputStream.use{it.write(bytes)};if(conn.responseCode!=200){val error=runCatching{JSONObject(conn.errorStream.bufferedReader().use{it.readText()})}.getOrDefault(JSONObject());val code=(error.optJSONObject("error")?.optString("code") ?:error.optString("code")).takeIf{it.matches(Regex("[a-z_0-9]{1,80}"))}.orEmpty();error("QA endpoint $path HTTP ${conn.responseCode} $code")};return JSONObject(conn.inputStream.bufferedReader().use{it.readText()})}finally{conn.disconnect()}
        }
        fun newRegistration()=("sr_"+android.util.Base64.encodeToString(ByteArray(32).also{java.security.SecureRandom().nextBytes(it)},android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING)).also{repo.api.vault.write("qa-registration",it)}
        fun register(token:String)=nativePost("/api/v1/sensor-devices/register",JSONObject().put("schemaVersion",1).put("registrationToken",token))
        var device=register(repo.api.vault.read("qa-registration") ?:newRegistration())
        val prior=nativePost("/api/v1/sensor-devices/control",JSONObject().put("schemaVersion",1).put("action","status").put("sensorId",device.getString("sensorId")),device.getString("controlToken"))
        if(prior.optString("status")=="disabled")device=register(newRegistration())
        check(device.getBoolean("isTest"));val id=device.getString("sensorId");val control=device.getString("controlToken")
        repo.loadMemberships().find{it.getString("sensorId")==id}?.let{repo.api.sensors("disconnect",JSONObject().put("requestId",java.util.UUID.randomUUID().toString()).put("sensorId",id).put("bindingEpoch",it.getLong("bindingEpoch")).put("confirmed",true));repo.loadMemberships()}
        check(repo.member(p)==null){"Test address has another sensor; refusing to alter it"}
        fun control(action:String)=nativePost("/api/v1/sensor-devices/control",JSONObject().put("schemaVersion",1).put("action",action).put("sensorId",id),control)
        val qr=control("owner_qr").getJSONObject("qr")
        uiAutomation.executeShellCommand("pm grant ${targetContext.packageName} android.permission.CAMERA").close()
        repo.prefs.edit().putString("tour","deferred").commit();val a=launch();tap("Опції");tap("Підключити датчик");tap("Ввести код");enter("Код датчика",qr.toString());tap("Перевірити");tap("Підключити");await("Налаштування датчика",30000)
        val membership=repo.loadMemberships().single{it.getString("sensorId")==id};check(membership.getString("role")=="owner");check(!repo.prefs.getBoolean("sensor-notify-${p.id}",false));passed("Native manual QR → explicit check → confirmed point → real owner binding")
        try{
            val key=control("ingest_credentials");SystemClock.sleep(1500);val boot=java.util.UUID.randomUUID().toString();val monitor=java.util.UUID.randomUUID().toString();val base=Instant.now().truncatedTo(java.time.temporal.ChronoUnit.MILLIS)
            var sequence=repo.prefs.getLong("qa-sequence",0)
            fun send(at:Instant,state:String,start:Instant?){SystemClock.sleep(1500);sequence++;repo.prefs.edit().putLong("qa-sequence",sequence).commit();val elapsed=Duration.between(base,at).toMillis()+1000;val event=JSONObject().put("eventId",java.util.UUID.randomUUID().toString()).put("sequence",sequence).put("eventType","sample").put("powerState",state).put("observedAt",java.time.format.DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(at)).put("clockQuality","synchronized").put("bootId",boot).put("monitorId",monitor).put("elapsedRealtimeMs",elapsed).put("coverage",if(start==null)JSONObject.NULL else JSONObject().put("startAt",java.time.format.DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(start)).put("endAt",java.time.format.DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(at)).put("startElapsedMs",Duration.between(base,start).toMillis()+1000).put("endElapsedMs",elapsed).put("powerState",state));nativePost("/api/v1/sensor-events",JSONObject().put("schemaVersion",3).put("sensorId",id).put("bindingEpoch",key.getLong("bindingEpoch")).put("streamId",key.getString("streamId")).put("events",JSONArray().put(event)),key.getString("ingestToken"))}
            send(base,"on",null);SystemClock.sleep(250);val second=Instant.now().truncatedTo(java.time.temporal.ChronoUnit.MILLIS);send(second,"on",base);SystemClock.sleep(250);send(Instant.now().truncatedTo(java.time.temporal.ChronoUnit.MILLIS),"off",null)
            repo.refreshSensors();val signal=repo.signal(membership);check(SensorPolicy.signal(signal,Instant.now())=="off"){"Signal: "+listOf("powerState","availability","freshness","transportState","clockQuality","freshnessSeconds","lastConfirmedAt","lastReceivedAt").joinToString{it+"="+signal?.optString(it)}+"; now="+Instant.now()+"; clockField="+signal?.has("clockQuality")+"; nullReason="+signal?.isNull("reason")+"; coverage="+signal?.optJSONObject("coverage")?.let{it.optString("kind")+":"+it.opt("continuous")}};val overview=repo.overview(membership,LocalDate.now(NEXT_ZONE));val observed=SensorPolicy.observation(overview,LocalDate.now(NEXT_ZONE));check(observed.getJSONArray("intervals").length()>0){"Declared QA interval missing"};check(observed.getJSONObject("summary").getLong("unknownMs")>0){"Unknown elapsed coverage was filled"};passed("Synthetic QA producer: current off, explicit on interval, gaps remain unknown")
            tap("До огляду");await("Прогноз");await("Історія вимірів");screenshot("sensor-overview");tap("Вчора");await("Історія вимірів");tap("Завтра");await("Прогноз");tap("Сьогодні");tap("Довідка");await("Як читати плитку");tap("Прогноз і невідомий час");tap("Що саме бачить датчик");screenshot("sensor-help");tap("До огляду");tap("Закрити");passed("Native sensor day tabs, forecast/history distinction, independent help folds")
        }finally{repo.api.sensors("disconnect",JSONObject().put("requestId",java.util.UUID.randomUUID().toString()).put("sensorId",id).put("bindingEpoch",membership.getLong("bindingEpoch")).put("confirmed",true));repo.loadMemberships();check(repo.cachedOverview(membership,LocalDate.now(NEXT_ZONE))==null);passed("Own QA disconnect clears revoked measurement cache");runOnMainSync{a.finish()}}
    }
}
