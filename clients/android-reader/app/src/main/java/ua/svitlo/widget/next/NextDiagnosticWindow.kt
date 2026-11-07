package ua.svitlo.widget.next

import android.app.AlertDialog
import android.graphics.Typeface
import android.os.*
import android.view.Gravity
import android.widget.*
import org.json.*
import ua.svitlo.widget.AppDialogPanel
import java.time.*
import java.time.format.DateTimeFormatterBuilder
import java.util.UUID

/** BE-04: preview first, explicit send, two attempts, same immutable packet; no deferred queue. */
internal class NextDiagnosticWindow(private val a:NextActivity,private val repo:NextRepository,stage:String,code:String,private val async:((()->Unit)->Unit),private val ui:((()->Unit)->Unit)){
    private val u=NextUi(a);private var dialog:AlertDialog?=null;private var cancelled=false;private var attempts=0;private var pending=false;private var retryAt=0L
    private val packet=JSONObject().put("schemaVersion",1).put("reportId",UUID.randomUUID().toString()).put("client",JSONObject().put("target","android").put("version","1.7.0")).put("occurredAt",DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(Instant.now())).put("stage",stage.takeIf{it in setOf("city","street","house","submit")} ?:"submit").put("code",code.takeIf{it in setOf("empty","temporary","timeout","offline")} ?:"temporary").put("events",JSONArray().put(JSONObject().put("name","lookup_failed").put("code",code.takeIf{it in setOf("empty","temporary","timeout","offline")} ?:"temporary")))
    private fun show(panel:AppDialogPanel){val prior=dialog;dialog=null;prior?.setOnDismissListener(null);prior?.dismiss();dialog=panel.show().also{d->SensorWindows.register(a,d);d.setOnDismissListener{cancelled=true}}}
    fun open(){val panel=AppDialogPanel(a,"Повідомити про помилку",prefix="diagnostic_preview");val col=u.column();u.add(col,u.text("Ці технічні дані допоможуть команді «Світло» перевірити помилку. Адреси, GPS та дані облікового запису не додаються."),0);u.add(col,u.text(packet.toString(2),12f,u.p.muted).apply{typeface=Typeface.MONOSPACE;setTextIsSelectable(true)},12);panel.setBody(col);panel.footer(listOf(panel.button("Скасувати","diagnostic_cancel",cancel=true).apply{gravity=Gravity.CENTER;setOnClickListener{cancel()}},panel.button("Надіслати","diagnostic_send").apply{gravity=Gravity.CENTER;setOnClickListener{send()}}),horizontal=true);show(panel)}
    private fun cancel(){cancelled=true;dialog?.dismiss();dialog=null}
    private fun send(){
        if(cancelled||pending||attempts>=2||SystemClock.elapsedRealtime()<retryAt)return
        pending=true;attempts++
        val panel=AppDialogPanel(a,"Перевірка звіту",prefix="diagnostic_sending");panel.setBody(u.text("Надсилаю…"));panel.footer(listOf(panel.button("Скасувати","diagnostic_stop",cancel=true).apply{setOnClickListener{cancel()}}));show(panel)
        async{try{val response=repo.api.owned("/api/v1/diagnostic-reports",packet);require(response.getString("reportId")==packet.getString("reportId")&&UUID_RE.matches(response.getString("receiptId")));ui{pending=false;if(!cancelled)result(true)}}catch(e:Exception){ui{pending=false;if(!cancelled){if(e is NextApiException&&e.status==429)retryAt=SystemClock.elapsedRealtime()+e.retryAfter.coerceAtLeast(30)*1000;result(false)}}}}
    }
    private fun result(success:Boolean){
        val panel=AppDialogPanel(a,if(success)"Звіт перевірено"else"Не вдалося надіслати",prefix="diagnostic_result")
        panel.setBody(PrototypeScenes.conversation(a,if(success)"Дякую, що допомагаєш покращувати «Світло»!"else"Не зміг надіслати звіт. Спробуємо ще раз?","mascot-technician.webp"))
        if(success)panel.footer(listOf(panel.button("Зрозуміло","diagnostic_done").apply{gravity=Gravity.CENTER;setOnClickListener{cancel()}}))
        else{val retry=panel.button("Спробувати ще","diagnostic_retry").apply{gravity=Gravity.CENTER;isEnabled=attempts<2&&SystemClock.elapsedRealtime()>=retryAt;setOnClickListener{send()}};panel.footer(listOf(panel.button("Скасувати","diagnostic_cancel",cancel=true).apply{gravity=Gravity.CENTER;setOnClickListener{cancel()}},retry),horizontal=true);val delay=retryAt-SystemClock.elapsedRealtime();if(delay>0&&attempts<2)Handler(Looper.getMainLooper()).postDelayed({if(!cancelled&&dialog?.isShowing==true)retry.isEnabled=true},delay)}
        show(panel)
    }
}
