package ua.svitlo.widget

import android.Manifest
import android.app.Activity
import android.app.Instrumentation
import android.app.NotificationManager
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

/** Controlled-source native end-to-end flow, exclusively in the separate QA APK. */
internal object NativeMessages160 {
    fun run(test:Instrumentation,args:Bundle):String {
        val c=test.targetContext;check(c.packageName.endsWith(".qa"))
        listOf("svitlo_private","svitlo_profiles","svitlo_inbox","svitlo_official","svitlo_remote_messages","svitlo_app_updates","svitlo_activity","svitlo_message_identity").forEach{c.getSharedPreferences(it,0).edit().clear().commit()}
        AppAppearance.setLight(c,args.getString("light")=="true")
        val manager=c.getSystemService(NotificationManager::class.java);manager.cancelAll()
        if(Build.VERSION.SDK_INT>=33)check(!ScheduleNotifications.notificationPermission(c)){"Driver must revoke permission BEFORE instrumentation starts"}
        var at=Instant.now();val published=at.minusSeconds(60).toString();val expires=at.plusSeconds(3600).toString()
        val identity=MessageInstallation(c);val installation=identity.id()
        fun message(id:String,type:String="service")=JSONObject().put("id",id).put("type",type).put("title",if(type=="app_update")"Вийшла нова версія 1.6.1"else"Технічні роботи")
            .put("body",if(type=="app_update")"Оновіть застосунок, коли вам зручно"else"Оновлення даних тимчасово недоступне. Графік із кешу залишається доступним.")
            .put("publishedAt",published).put("expiresAt",expires).put("audience",JSONObject().put("kind","all"))
            .apply{if(type=="app_update"){put("targetVersionCode",26);put("action",JSONObject().put("kind","open_url").put("url",RemoteMessageSchema.DOWNLOAD))}}
        fun feed(values:List<JSONObject>)=JSONObject().put("schema",1).put("packageId","ua.svitlo.widget").put("generatedAt",at.toString()).put("messages",JSONArray(values)).toString()
        val public=feed(listOf(message("native-service"),message("native-update","app_update")))
        val private=feed(listOf(message("native-private").put("audience",JSONObject().put("kind","installation").put("installationId",installation))))
        var calls=0;var online=false
        val repo=RemoteMessageRepository(c,{calls++;if(!online)throw MessageHttpError(503,"60");MessageResponse(200,public)},PrivateMessageSource{id,proof,code->
            check(id==installation && proof.length==64 && code==25L);private
        },{at},25)
        check(repo.refresh().first().retry);online=true;at=at.plusSeconds(60);check(repo.refresh().all{it.successful});check(calls==2)
        c.getSharedPreferences("svitlo_activity",0).edit().putLong("attempt",System.currentTimeMillis()).commit()
        val legacy=AppUpdateRepository(c);legacy.setEnabled(true)
        c.getSharedPreferences("svitlo_app_updates",0).edit().putLong("success",System.currentTimeMillis()).commit()
        MessageNotifications.announce(c,repo,legacy)
        if(Build.VERSION.SDK_INT>=33){check(!repo.posted("native-service"));check(manager.activeNotifications.isEmpty())}
        var activity:Activity?=null
        fun main(action:()->Unit){var error:Throwable?=null;test.runOnMainSync{try{action()}catch(e:Throwable){error=e}};error?.let{throw it}}
        fun all(v:View):List<View> = listOf(v)+if(v is ViewGroup)(0 until v.childCount).flatMap{all(v.getChildAt(it))}else emptyList()
        fun capture(name:String){main{val root=activity!!.window.decorView;val bitmap=Bitmap.createBitmap(root.width,root.height,Bitmap.Config.ARGB_8888);root.draw(Canvas(bitmap));java.io.File(c.cacheDir,"messages160-$name.png").outputStream().use{bitmap.compress(Bitmap.CompressFormat.PNG,100,it)}}}
        try {
            activity=test.startActivitySync(Intent(c,MainActivity::class.java).putExtra("screen","inbox").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            test.waitForIdleSync();SystemClock.sleep(150)
            capture("inbox-initial")
            main{
                val views=all(activity!!.window.decorView)
                check(views.count{it is android.widget.LinearLayout && it.tag?.toString()?.startsWith("remote_message:")==true}==3)
                check(views.any{it.tag=="bottom_navigation"});check(OutageRepository(c).binding()==null)
                check(views.none{it.tag?.toString()?.startsWith("message_permission")==true})
                val update=views.single{it.tag=="remote_message:native-update"}
                check(all(update).filterIsInstance<TextView>().map{it.text.toString()}.let{it.any{line->line.startsWith("Оновлено · ")} && "Вийшла нова версія 1.6.1" in it && "Оновіть застосунок, коли вам зручно" in it && "Завантажити" in it})
            }
            capture("inbox-denied")
            if(Build.VERSION.SDK_INT>=33){
                main{all(activity!!.window.decorView).single{it.tag=="navigation:settings"}.performClick()};test.waitForIdleSync()
                main{all(activity!!.window.decorView).single{it.tag=="notification_app_versions"}.performClick()};test.waitForIdleSync()
                main{all(activity!!.window.decorView).single{it.tag=="notification_app_versions"}.performClick()}
                var allowed=false
                repeat(30){
                    if(!allowed){
                        val root=test.uiAutomation.rootInActiveWindow
                        val allow=listOf("com.android.permissioncontroller:id/permission_allow_button","com.google.android.permissioncontroller:id/permission_allow_button")
                            .flatMap{root?.findAccessibilityNodeInfosByViewId(it).orEmpty()}.firstOrNull()
                        if(allow!=null)allowed=allow.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK)
                        if(!allowed)SystemClock.sleep(100)
                    }
                }
                check(allowed){"Android notification permission dialog was not shown after user action"}
                test.waitForIdleSync();check(ScheduleNotifications.notificationPermission(c))
            }
            MessageNotifications.announce(c,repo,legacy);check(repo.posted("native-service"))
            repeat(20){if(manager.activeNotifications.size!=3)SystemClock.sleep(100)}
            check(manager.activeNotifications.size==3){"Expected 3 system notifications; got ${manager.activeNotifications.size}"}
            check(manager.activeNotifications.all{it.notification.timeoutAfter in 1..3_600_000L})
            val notification=manager.activeNotifications.single{it.tag=="remote:native-private"}
            notification.notification.contentIntent.send();test.waitForIdleSync();SystemClock.sleep(120);check(repo.viewed("native-private"))
            capture("inbox-granted")
            main{all(activity!!.window.decorView).single{it.tag=="navigation:settings"}.performClick()};test.waitForIdleSync()
            main{val views=all(activity!!.window.decorView);check(views.count{it.tag?.toString()?.startsWith("notification_")==true && it is android.widget.Switch}==6)}
            capture("settings")
            main{activity!!.finish()};test.waitForIdleSync()
            activity=test.startActivitySync(Intent(c,MainActivity::class.java).putExtra("screen","inbox").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));test.waitForIdleSync()
            manager.cancelAll();MessageNotifications.announce(c,RemoteMessageRepository(c),legacy);check(manager.activeNotifications.isEmpty())
            check(repo.refresh().all{it.successful});check(calls==2)
            at=at.plusSeconds(8*86400);check(repo.visible().isEmpty())
            return JSONObject().put("sdk",Build.VERSION.SDK_INT).put("passed",true).put("cards",3).put("publicAttempts",calls)
                .put("nativeNotificationChannels",2).put("withoutAddress",true).put("permissionGrant",Build.VERSION.SDK_INT>=33)
                .put("restartNoDuplicates",true).put("systemPendingIntentOpenedInbox",true).put("sevenDayExpiry",true).toString()
        }finally{main{activity?.finish()};manager.cancelAll()}
    }
}
