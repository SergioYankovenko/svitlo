package ua.svitlo.widget.next

import android.Manifest
import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import ua.svitlo.widget.AppUpdateRepository
import ua.svitlo.widget.MessageHttpError
import java.time.Instant

/** Local Android service/shadow checks; these are not device permission tests. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk=[33],application=Application::class)
class NextNotices170Test {
    private val app get()=RuntimeEnvironment.getApplication()
    private val manager get()=app.getSystemService(NotificationManager::class.java)
    private val receipts get()=app.getSharedPreferences("next_notices",Context.MODE_PRIVATE)
    private fun grant(){shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)}
    @Test fun deniedPermissionKeepsCardAndDoesNotConsumeSystemReceipt(){
        shadowOf(app).denyPermissions(Manifest.permission.POST_NOTIFICATIONS)
        NextNotices.put(app,"qa-one","Заголовок","Текст",enabled=true)
        assertEquals(1,NextNotices.items(app).size);assertFalse(receipts.getBoolean("shown-qa-one",false));assertTrue(manager.activeNotifications.isEmpty())
        grant();NextNotices.retryPending(app)
        assertTrue(receipts.getBoolean("shown-qa-one",false));assertEquals(1,manager.activeNotifications.size)
    }
    @Test fun blockedChannelDoesNotClaimDelivery(){
        grant();manager.createNotificationChannel(NotificationChannel("svitlo_next_events","QA",NotificationManager.IMPORTANCE_NONE))
        NextNotices.put(app,"qa-blocked","Заголовок","Текст",enabled=true)
        assertEquals(1,NextNotices.items(app).size);assertFalse(receipts.getBoolean("shown-qa-blocked",false));assertTrue(manager.activeNotifications.isEmpty())
    }
    @Test fun duplicateFetchAndRepositoryReopenKeepOneStableNotification(){
        grant();repeat(3){NextNotices.put(app,"qa-stable","Заголовок","Текст",enabled=true);NextRepository(app);NextNotices.retryPending(app)}
        assertEquals(1,NextNotices.items(app).size);assertEquals(listOf("qa-stable".hashCode()),manager.activeNotifications.map{it.id})
        NextNotices.markViewed(app);assertTrue(receipts.getLong("viewedAt",0)>0);assertTrue(receipts.getBoolean("shown-qa-stable",false))
    }
    @Test fun sevenDayLimitUsesPublicationRatherThanNewFetchTime(){
        grant();NextNotices.put(app,"qa-old","Заголовок","Текст",enabled=true,at=System.currentTimeMillis()-8*86400000L)
        assertTrue(NextNotices.items(app).isEmpty());assertTrue(manager.activeNotifications.isEmpty())
    }
    @Test fun installedVersionRemovesObsoleteCardAndSystemNotification(){
        grant();val id="version-${ua.svitlo.widget.BuildConfig.VERSION_CODE}"
        NextNotices.put(app,id,"Версія","Текст",enabled=true);assertEquals(1,manager.activeNotifications.size)
        NextNotices.retryPending(app);assertTrue(NextNotices.items(app).isEmpty());assertTrue(manager.activeNotifications.isEmpty())
    }
    @Test fun versionFetchFailureRetainsCacheAndReturnsRetryWithoutAnyAddress(){
        val now=Instant.now();var fail=false
        val raw=JSONObject().put("schema",1).put("packageId","ua.svitlo.widget").put("versionCode",1000).put("versionName","1.9.9").put("publishedAt",now.minusSeconds(60).toString()).put("minSdk",26).put("apkUrl","https://sergioyankovenko.github.io/svitlo/downloads/Svitlo-1.9.9.apk").put("sha256","a".repeat(64)).toString()
        val update=AppUpdateRepository(app,{if(fail)throw MessageHttpError(503)else raw},{now},26,33)
        assertTrue(NextWork.checkVersion(app,update).successful);assertTrue(NextNotices.items(app).isEmpty());assertEquals("1.9.9",update.available()?.name)
        fail=true;update.refreshResult(force=true)
        val result=NextWork.checkVersion(app,update)
        assertFalse(result.successful);assertTrue(result.retry);assertTrue(result.nextAttempt>now.toEpochMilli());assertTrue(NextNotices.items(app).isEmpty());assertEquals("1.9.9",update.available()?.name)
    }
}
