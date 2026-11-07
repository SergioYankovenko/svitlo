package ua.svitlo.widget

import android.Manifest
import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.IOException
import java.time.Instant
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class) @Config(sdk=[28])
class RemoteMessages160Test {
    private val c:Context get()=RuntimeEnvironment.getApplication()
    private var at=Instant.now()
    private val manager get()=c.getSystemService(NotificationManager::class.java)
    private fun message(id:String="notice",type:String="service")=JSONObject().put("id",id).put("type",type).put("title","Службове повідомлення")
        .put("body","Технічні роботи завершено").put("publishedAt",at.minusSeconds(60).toString()).put("expiresAt",at.plusSeconds(86400).toString())
        .put("audience",JSONObject().put("kind","all")).apply{if(type=="app_update"){put("targetVersionCode",27);put("action",JSONObject().put("kind","open_url").put("url",RemoteMessageSchema.DOWNLOAD))}}
    private fun feed(vararg values:JSONObject)=JSONObject().put("schema",1).put("packageId","ua.svitlo.widget").put("generatedAt",at.toString())
        .put("messages",JSONArray(values.toList())).toString()
    private fun repo(raw:String=feed(message()),installed:Long=25,privateRaw:String=feed())=RemoteMessageRepository(c,{MessageResponse(200,raw,"tag")},PrivateMessageSource{_,_,_->privateRaw},{at},installed)
    @Before fun reset(){
        listOf("svitlo_remote_messages","svitlo_app_updates","svitlo_activity","svitlo_message_identity").forEach{c.getSharedPreferences(it,0).edit().clear().commit()}
        manager.cancelAll();manager.notificationChannels.forEach{manager.deleteNotificationChannel(it.id)}
    }
    @Test fun independentReceivedViewedAndPostedSurviveNewRepositoryAndAddressHistoryClear(){
        val r=repo();assertTrue(r.refresh().all{it.successful});assertNotNull(r.receivedAt("notice"));assertFalse(r.viewed("notice"));assertFalse(r.posted("notice"))
        r.markViewed("notice");assertTrue(repo().viewed("notice"));assertFalse(repo().posted("notice"))
        MessageNotifications.announce(c,repo());assertTrue(repo().posted("notice"));assertEquals(1,manager.activeNotifications.size)
        assertTrue(manager.activeNotifications.single().notification.timeoutAfter in 1..86_400_000L)
        InboxRepository(c).clearLocal();AddressProfiles(c).clear();manager.cancelAll()
        MessageNotifications.announce(c,repo());assertEquals(0,manager.activeNotifications.size);assertTrue(repo().viewed("notice"))
    }
    @Test fun releaseInstallUpgradeRemovesOldNotificationAndCardWithoutNetwork(){
        val r=repo(feed(message(type="app_update")));r.refresh();val legacy=AppUpdateRepository(c);legacy.setEnabled(true)
        MessageNotifications.announce(c,r,legacy);assertEquals(1,manager.activeNotifications.size)
        val upgraded=repo(installed=27);assertTrue(upgraded.visible().isEmpty());MessageNotifications.announce(c,upgraded,legacy)
        assertTrue(manager.activeNotifications.isEmpty());assertTrue(upgraded.posted("notice"))
    }
    @Test fun legacyReleaseHighWaterPreventsSecondNewProtocolAlert(){
        val legacy=AppUpdateRepository(c);legacy.setEnabled(true);legacy.markNotifiedCode(27)
        val r=repo(feed(message(type="app_update")));r.refresh();MessageNotifications.announce(c,r,legacy)
        assertTrue(r.posted("notice"));assertTrue(manager.activeNotifications.isEmpty())
    }
    @Test fun defaultReleasePreferenceIsOffUntilUserActionButDoesNotHideCards(){
        assertFalse(AppUpdateRepository(c).enabled());val r=repo(feed(message(type="app_update")));r.refresh()
        MessageNotifications.announce(c,r);assertEquals(1,r.visible().size);assertFalse(r.posted("notice"));assertTrue(manager.activeNotifications.isEmpty())
    }
    @Test @Config(sdk=[33]) fun permissionDeniedKeepsCardThenPermissionGrantDeliversOnce(){
        shadowOf(c as Application).denyPermissions(Manifest.permission.POST_NOTIFICATIONS)
        val r=repo();r.refresh();MessageNotifications.announce(c,r);assertFalse(r.posted("notice"));assertEquals(1,r.visible().size)
        shadowOf(c as Application).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        MessageNotifications.announce(c,r);assertTrue(r.posted("notice"));assertEquals(1,manager.activeNotifications.size)
        manager.cancelAll();MessageNotifications.announce(c,repo());assertTrue(manager.activeNotifications.isEmpty())
    }
    @Test fun blockedChannelAndGlobalBlockDoNotConsumeNotice(){
        val r=repo();r.refresh();manager.createNotificationChannel(NotificationChannel(MessageNotifications.SERVICE_CHANNEL,"Service",NotificationManager.IMPORTANCE_NONE))
        MessageNotifications.announce(c,r);assertFalse(r.posted("notice"));assertTrue(manager.activeNotifications.isEmpty())
        shadowOf(manager).setNotificationsEnabled(false);MessageNotifications.announce(c,r);assertFalse(r.posted("notice"))
    }
    @Test fun stableTagsAvoidJavaHashCollisions(){
        val r=repo(feed(message("Aa"),message("BB")));r.refresh();MessageNotifications.announce(c,r)
        assertEquals("Aa".hashCode(),"BB".hashCode());assertEquals(2,manager.activeNotifications.size)
        assertEquals(setOf("remote:Aa","remote:BB"),manager.activeNotifications.map{it.tag}.toSet())
    }
    @Test fun futureExpiredAndSevenDayOldMessagesNeverDisplay(){
        val expired=message("expired").put("expiresAt",at.toString())
        val future=message("future").put("publishedAt",at.plusSeconds(60).toString())
        val old=message("old").put("publishedAt",at.minusSeconds(7*86400).toString())
        val r=repo(feed(expired,future,old));r.refresh();assertTrue(r.visible().isEmpty());MessageNotifications.announce(c,r);assertTrue(manager.activeNotifications.isEmpty())
    }
    @Test fun versionAndPrivateAudienceAreCheckedWithoutQueue(){
        val id=MessageInstallation(c).id()
        val range=message("range").put("audience",JSONObject().put("kind","versions").put("minVersionCode",25).put("maxVersionCode",25))
        val excluded=message("excluded").put("audience",JSONObject().put("kind","versions").put("minVersionCode",26))
        val own=message("own").put("audience",JSONObject().put("kind","installation").put("installationId",id))
        val foreign=message("foreign").put("audience",JSONObject().put("kind","installation").put("installationId","00000000-0000-4000-8000-000000000001"))
        val r=repo(feed(range,excluded),privateRaw=feed(own,foreign));r.refresh();assertEquals(setOf("range","own"),r.visible().map{it.id}.toSet())
        assertNull(OutageRepository(c).binding())
    }
    @Test fun invalidPublicPrivateAudienceAndUnsafeActionCannotReplaceVerifiedCache(){
        repo().refresh();at=at.plusSeconds(86400)
        val bad=listOf(message().put("audience",JSONObject().put("kind","installation").put("installationId",MessageInstallation(c).id())),
            message().put("action",JSONObject().put("kind","open_url").put("url","https://evil.example/")),message().put("title","x".repeat(121)),
            message().put("extra","hidden"),message().put("targetVersionCode","27"))
        val prefs=c.getSharedPreferences("svitlo_remote_messages",0);val good=prefs.getString("public:cache",null)
        bad.forEach{prefs.edit().remove("public:retry_at").remove("public:success").commit();assertFalse(repo(feed(it)).refresh().first().successful);assertEquals(good,prefs.getString("public:cache",null))}
    }
    @Test fun invalidJsonOfflineAndServerErrorsPreserveLastGoodData(){
        val r=repo();r.refresh();val good=c.getSharedPreferences("svitlo_remote_messages",0).getString("public:cache",null);at=at.plusSeconds(86400)
        val invalid=repo("{broken");assertFalse(invalid.refresh().first().successful)
        assertEquals(good,c.getSharedPreferences("svitlo_remote_messages",0).getString("public:cache",null))
    }
    @Test fun rewrittenIdIsRejectedWithoutResettingReadOrPostedState(){
        val r=repo();r.refresh();r.markViewed("notice");r.markPosted("notice");at=at.plusSeconds(86400)
        val altered=repo(feed(message().put("body","Changed same ID")));assertFalse(altered.refresh().first().successful)
        assertTrue(altered.viewed("notice"));assertTrue(altered.posted("notice"))
    }
    @Test fun oneSuccessfulRequestPerDayIncluding304AndRestart(){
        var calls=0;val source:(String?)->MessageResponse={tag->calls++;if(calls==1)MessageResponse(200,feed(message()),"etag")else{assertEquals("etag",tag);MessageResponse(304)}}
        fun r()=RemoteMessageRepository(c,source,PrivateMessageSource{_,_,_->feed()},{at},25)
        r().refresh();repeat(5){r().refresh()};assertEquals(1,calls)
        at=at.plusSeconds(86400);assertTrue(r().refresh().first().successful);assertEquals(2,calls);r().refresh();assertEquals(2,calls)
    }
    @Test fun simultaneousChecksUseOneNetworkPairAndKeepIdSecretAcrossRestarts(){
        val calls=java.util.concurrent.atomic.AtomicInteger();val seen=mutableSetOf<Pair<String,String>>()
        val pool=Executors.newFixedThreadPool(6)
        try{
            val jobs=(1..12).map{pool.submit{RemoteMessageRepository(c,{calls.incrementAndGet();MessageResponse(200,feed())},PrivateMessageSource{id,proof,_->seen+=id to proof;calls.incrementAndGet();feed()},{at},25).refresh()}}
            jobs.forEach{it.get(10,TimeUnit.SECONDS)};assertEquals(2,calls.get());assertEquals(1,seen.size)
            assertEquals(36,seen.single().first.length);assertEquals(64,seen.single().second.length);assertNotEquals(seen.single().first,seen.single().second)
        }finally{pool.shutdownNow()}
    }
    @Test fun readingCacheDoesNotWaitForBackgroundNetwork(){
        repo().refresh();at=at.plusSeconds(86400);val entered=CountDownLatch(1);val release=CountDownLatch(1);val pool=Executors.newSingleThreadExecutor()
        val r=RemoteMessageRepository(c,{entered.countDown();check(release.await(5,TimeUnit.SECONDS));MessageResponse(200,feed())},PrivateMessageSource{_,_,_->feed()},{at},25)
        try{val job=pool.submit{r.refresh()};assertTrue(entered.await(2,TimeUnit.SECONDS));val began=System.nanoTime();r.visible();assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-began)<500);release.countDown();job.get(5,TimeUnit.SECONDS)}finally{release.countDown();pool.shutdownNow()}
    }
    @Test fun failureRecoveryUsesMinuteBackoffInsteadOfDay(){
        var calls=0;var online=false
        val r=RemoteMessageRepository(c,{calls++;if(!online)throw IOException("offline");MessageResponse(200,feed(message()))},PrivateMessageSource{_,_,_->feed()},{at},25)
        assertTrue(r.refresh().first().retry);online=true;at=at.plusSeconds(59);r.refresh();assertEquals(1,calls)
        at=at.plusSeconds(1);assertTrue(r.refresh().first().successful);assertEquals(2,calls);assertEquals(1,r.visible().size)
    }
    @Test fun rateLimitHonorsRetryAfterAndFailureBudgetIsFinite(){
        var calls=0
        val r=RemoteMessageRepository(c,{calls++;throw MessageHttpError(429,"3600")},PrivateMessageSource{_,_,_->feed()},{at},25)
        var result=r.refresh().first();assertEquals(at.plusSeconds(3600).toEpochMilli(),result.nextAttempt)
        at=at.plusSeconds(3599);r.refresh();assertEquals(1,calls)
        for(i in 2..5){at=Instant.ofEpochMilli(result.nextAttempt);result=r.refresh().first()}
        assertEquals(5,calls);assertFalse(result.retry);assertEquals(androidx.work.ListenableWorker.Result.failure(),MessageWorker.completion(listOf(result),4))
    }
    @Test fun retryAfterSupportsHttpDateAndRejectsMalformedValues(){
        val date="Thu, 29 Oct 2026 12:00:00 GMT"
        assertEquals(Instant.parse("2026-10-29T12:00:00Z").toEpochMilli(),MessageFetchGate.retryAfter(date,at))
        assertEquals(0,MessageFetchGate.retryAfter("not a date",at))
    }
    @Test fun invalid304CannotBecomeSuccessfulAndPermanent4xxDoesNotLoop(){
        val r=RemoteMessageRepository(c,{MessageResponse(304)},PrivateMessageSource{_,_,_->throw SupabaseHttpFailure(403)},{at},25)
        val result=r.refresh();assertTrue(result.none{it.successful || it.retry});assertTrue(r.visible().isEmpty())
    }
}
