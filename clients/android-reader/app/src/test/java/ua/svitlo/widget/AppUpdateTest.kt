package ua.svitlo.widget

import android.app.NotificationManager
import android.content.Context
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.time.Instant
import ua.svitlo.widget.core.InboxHistory

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[28])
class AppUpdateTest {
    private val context:Context get()=RuntimeEnvironment.getApplication()
    private val now=Instant.parse("2026-10-24T10:00:00Z")
    private fun manifest(code:Long=11,name:String="1.4.1")=JSONObject().put("schema",1).put("packageId","ua.svitlo.widget")
        .put("versionCode",code).put("versionName",name).put("publishedAt","2026-10-24T09:00:00Z")
        .put("minSdk",26).put("apkUrl",AppUpdateRepository.SITE+"downloads/Svitlo-$name.apk").put("sha256","a".repeat(64))
    private fun repo(fetch:()->String={manifest().toString()},installed:Long=10)=AppUpdateRepository(context,fetch,{now},installed,28)
    @Before fun clear(){context.getSharedPreferences("svitlo_app_updates",0).edit().clear().commit();AppUpdateRepository(context).setEnabled(true);context.getSystemService(NotificationManager::class.java).cancelAll()}
    @Test fun usesNumericBuildCodeAndSuppressesInstalledOrOlder(){
        val updates=repo();assertTrue(updates.refresh());assertEquals(11L,updates.available()!!.code)
        assertNull(repo(installed=11).available());assertNull(repo(installed=12).available())
        assertTrue(repo({manifest(10,"9.0.0").toString()}).refresh(true));assertNull(updates.available())
    }
    @Test fun fetchIsThrottledAndFailurePreservesLastVerifiedRelease(){
        var calls=0;val updates=repo({calls++;manifest().toString()})
        assertTrue(updates.refresh());assertTrue(updates.refresh());assertEquals(1,calls)
        val offline=repo({throw java.io.IOException("offline")});assertFalse(offline.refresh(true))
        assertEquals(11L,offline.available()!!.code);assertTrue(offline.failed());assertEquals(now,offline.checkedAt())
    }
    @Test fun invalidManifestCannotReplaceVerifiedRelease(){
        val updates=repo();updates.refresh()
        val bad=listOf(manifest().put("apkUrl","https://evil.example/Svitlo-1.4.1.apk"),
            manifest().put("apkUrl",AppUpdateRepository.SITE+"downloads/../Svitlo-1.4.1.apk"),
            manifest().put("apkUrl",AppUpdateRepository.SITE+"downloads/Svitlo-1.4.1.apk?redirect=evil"),
            manifest().put("publishedAt","2026-10-25T09:00:00Z"),manifest().put("minSdk",35),
            manifest().put("packageId","other"),manifest().put("sha256","bad"),manifest().put("schema",2))
        bad.forEach{assertFalse(repo({it.toString()}).refresh(true));assertEquals(11L,updates.available()!!.code)}
        assertFalse(repo({"x".repeat(65537)}).refresh(true))
    }
    @Test fun notificationOnlyOncePerNewVersionAndSurvivesAddressCancellation(){
        val updates=repo();updates.refresh();val manager=context.getSystemService(NotificationManager::class.java)
        AppUpdateWorker.announce(context,updates);assertEquals(1,manager.activeNotifications.size);assertFalse(updates.needsNotification())
        manager.cancelAll();AppUpdateWorker.announce(context,repo());assertEquals(0,manager.activeNotifications.size)
        repo({manifest(12,"1.4.2").toString()}).refresh(true);AppUpdateWorker.announce(context,updates)
        assertEquals(1,manager.activeNotifications.size);ScheduleNotifications.cancel(context);assertEquals(1,manager.activeNotifications.size)
        AppUpdateWorker.announce(context,repo(installed=12));assertEquals(0,manager.activeNotifications.size)
    }
    @Test fun disabledChannelDoesNotConsumeAnnouncement(){
        val updates=repo();updates.refresh();updates.setEnabled(false);AppUpdateWorker.announce(context,updates)
        assertFalse(updates.needsNotification());updates.setEnabled(true);assertTrue(updates.needsNotification())
        val manager=context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(android.app.NotificationChannel("app_updates","Versions",NotificationManager.IMPORTANCE_NONE))
        AppUpdateWorker.announce(context,updates);assertTrue(updates.needsNotification());assertEquals(0,manager.activeNotifications.size)
    }
    @Test @Config(sdk=[33]) fun permissionDenialKeepsInAppUpdateAndCanNotifyAfterGrant(){
        val application=org.robolectric.Shadows.shadowOf(context as android.app.Application)
        application.denyPermissions(android.Manifest.permission.POST_NOTIFICATIONS)
        val updates=repo();updates.refresh();AppUpdateWorker.announce(context,updates)
        assertTrue(updates.needsNotification());assertNotNull(updates.available())
        assertEquals(0,context.getSystemService(NotificationManager::class.java).activeNotifications.size)
        application.grantPermissions(android.Manifest.permission.POST_NOTIFICATIONS)
        AppUpdateWorker.announce(context,updates);assertFalse(updates.needsNotification())
    }
    @Test fun feedUsesPublicationTimeAndExpiresAfterOneWeekWithoutLosingVerifiedMetadata(){
        val updates=repo();updates.refresh();val release=updates.available()!!
        assertEquals(release.publishedAt,release.change().at)
        assertEquals(1,InboxHistory.recent(listOf(release.change()),now).size)
        assertTrue(InboxHistory.recent(listOf(release.change()),now.plusSeconds(8*86400)).isEmpty())
        assertNotNull(updates.available())
    }
    @Test fun missingFileServerFailureOfflineAndMalformedJsonPreserveVerifiedRelease(){
        val updates=repo();assertTrue(updates.refresh());val expected=updates.available()
        val failures=listOf<()->String>({throw java.io.FileNotFoundException("HTTP 404")},
            {throw java.io.IOException("HTTP 503")},{throw java.net.UnknownHostException("offline")},
            {"<html>Not found</html>"},{"{broken json"})
        for(fetch in failures){
            assertFalse(repo(fetch).refresh(true));assertEquals(expected,updates.available())
            assertTrue(updates.failed());assertEquals(now,updates.checkedAt())
        }
    }
    @Test fun legacyReceivedViewedAndNotifiedAreSeparateAndSurviveRestart(){
        val updates=repo();assertTrue(updates.refresh());assertEquals(now,updates.receivedAt(11));assertFalse(updates.viewed(11));assertTrue(updates.needsNotification())
        updates.markViewed(11);assertTrue(repo().viewed(11));assertTrue(repo().needsNotification())
        AppUpdateWorker.announce(context,updates);assertFalse(repo().needsNotification());assertTrue(repo().viewed(11))
    }
}
