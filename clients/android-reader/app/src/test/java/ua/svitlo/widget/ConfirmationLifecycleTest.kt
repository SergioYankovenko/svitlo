package ua.svitlo.widget

import android.content.Context
import android.app.Application
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import org.robolectric.shadows.ShadowAlertDialog
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import org.robolectric.android.controller.ActivityController
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
@LooperMode(LooperMode.Mode.PAUSED)
class ConfirmationLifecycleTest {
    private lateinit var context: Context
    private val firstAccount = "12345678901"
    private val secondAccount = "12345678902"
    private val response get() = """{"DATETIME":"${java.time.Instant.now().atZone(ua.svitlo.widget.core.KYIV_ZONE).format(java.time.format.DateTimeFormatter.ofPattern("HH:mm dd.MM.yyyy"))}","DISCONNECTIONS":[],"DISCONN_QUEUQ":[{"QUEUE_INFO":"Графік погодинних відключень: 3 черга 2 підчерга"}]}"""

    @Before fun clearPrivateState() {
        context = RuntimeEnvironment.getApplication()
        if(runCatching{androidx.work.WorkManager.getInstance(context)}.isFailure){val held=java.util.concurrent.Executor{}
            androidx.work.WorkManager.initialize(context,androidx.work.Configuration.Builder().setExecutor(held).setTaskExecutor(held).build())}
        // Robolectric does not automatically grant this manifest-declared signature permission.
        shadowOf(context as Application).grantPermissions(context.packageName + ".DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION")
        listOf("svitlo_private", "svitlo_weather", "svitlo_runtime").forEach {
            context.getSharedPreferences(it, Context.MODE_PRIVATE).edit().clear().commit()
        }
        check(OfficialScheduleRepository(context,OfficialFeedSource{emptyList()}).refresh())
    }

    @Test fun openingSetupAndShowingOfficialAddressNeverPersistsWithoutConfirmationClick() {
        val controller = newActivity()
        try {
            assertNull(OutageRepository(context).binding())
            showOfficialConfirmation(controller.get())
            assertNotNull(findConfirmationButton(controller.get().window.decorView))
            assertNull(OutageRepository(context).binding())
        } finally {
            controller.pause().stop().destroy()
        }
    }

    @Test fun destroyedActivityCannotPersistAnInFlightConfirmation() {
        finishOldConfirmationAfterDestroy(bindReplacement = false)
        assertNull(OutageRepository(context).binding())
        assertTrue(OutageRepository(context).snapshot().categories.isEmpty())
    }

    @Test fun cancellingInitialConfirmationFetchRejectsItsLateBindingResult(){
        val entered=CountDownLatch(1);val release=CountDownLatch(1)
        val controller=newActivity();val activity=controller.get()
        val repository=OutageRepository(context,OutageSource{_,_,_,_->
            entered.countDown();check(release.await(10,TimeUnit.SECONDS));response
        })
        MainActivity::class.java.getDeclaredField("repo").apply{isAccessible=true}.set(activity,repository)
        val executor=MainActivity::class.java.getDeclaredField("executor").apply{isAccessible=true}.get(activity) as ExecutorService
        try{
            showOfficialConfirmation(activity)
            findConfirmationButton(activity.window.decorView)!!.performClick()
            assertTrue(entered.await(5,TimeUnit.SECONDS))
            val progress=ShadowAlertDialog.getLatestAlertDialog()
            progress.onBackPressed();shadowOf(Looper.getMainLooper()).idle()
            assertFalse("Initial confirmation must remain cancelable while its preview loads",progress.isShowing)
            release.countDown()
            executor.submit{}.get(5,TimeUnit.SECONDS);shadowOf(Looper.getMainLooper()).idle()
            assertNull(repository.binding())
            assertTrue(repository.snapshot().categories.isEmpty())
        }finally{
            controller.pause().stop().destroy();release.countDown()
            executor.awaitTermination(5,TimeUnit.SECONDS)
        }
    }

    @Test fun lateConfirmationFromDestroyedActivityCannotOverwriteNewHousehold() {
        finishOldConfirmationAfterDestroy(bindReplacement = true)
        assertEquals(secondAccount, OutageRepository(context).binding()?.account)
        assertEquals("Друга підтверджена адреса", OutageRepository(context).binding()?.address)
    }
    @Test fun wholeConfirmationTimesOutAtSixtySecondsKeepsNameAndRejectsLateValidData(){
        val entered=CountDownLatch(1);val release=CountDownLatch(1)
        val controller=newActivity();val activity=controller.get()
        val repo=OutageRepository(context,OutageSource{_,_,_,_->
            entered.countDown()
            while(release.count>0)try{release.await(2,TimeUnit.SECONDS)}catch(_:InterruptedException){}
            response
        })
        MainActivity::class.java.getDeclaredField("repo").apply{isAccessible=true}.set(activity,repo)
        try{
            showOfficialConfirmation(activity)
            fun all(v:View):List<View> = listOf(v)+if(v is ViewGroup)(0 until v.childCount).flatMap{all(v.getChildAt(it))}else emptyList()
            val name=all(activity.window.decorView).filterIsInstance<android.widget.EditText>().single{it.tag=="profile_name"}
            name.setText("Тестова назва");findConfirmationButton(activity.window.decorView)!!.performClick()
            assertTrue(entered.await(2,TimeUnit.SECONDS));val progress=ShadowAlertDialog.getLatestAlertDialog()
            shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(59));assertTrue(progress.isShowing)
            shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(1));assertFalse(progress.isShowing)
            assertEquals("Тестова назва",name.text.toString());assertNotNull(findConfirmationButton(activity.window.decorView));assertNull(repo.binding())
            release.countDown();Thread.sleep(80);shadowOf(Looper.getMainLooper()).idle();assertNull(repo.binding())
        }finally{release.countDown();controller.pause().stop().destroy()}
    }

    private fun finishOldConfirmationAfterDestroy(bindReplacement: Boolean) {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val source = OutageSource { _, _, _, _ ->
            entered.countDown()
            // Simulate an HTTP request that does not stop immediately when interrupted.
            var waiting = true
            while (waiting) {
                try {
                    check(release.await(10, TimeUnit.SECONDS)) { "Test did not release pending request" }
                    waiting = false
                } catch (_: InterruptedException) {
                    // Android HTTP completion can arrive after Activity.onDestroy().
                }
            }
            response
        }
        val controller = newActivity()
        val activity = controller.get()
        val repository = OutageRepository(context, source)
        MainActivity::class.java.getDeclaredField("repo").apply { isAccessible = true }.set(activity, repository)
        val executor = MainActivity::class.java.getDeclaredField("executor").apply { isAccessible = true }
            .get(activity) as ExecutorService
        var destroyed = false
        try {
            showOfficialConfirmation(activity)
            assertTrue(findConfirmationButton(activity.window.decorView)!!.performClick())
            assertTrue("Confirmation must start its preview fetch", entered.await(5, TimeUnit.SECONDS))
            assertNull(repository.binding())
            controller.pause().stop().destroy()
            destroyed = true
            if (bindReplacement) {
                val replacement = OutageRepository(context, OutageSource { _, _, _, _ -> response })
                assertTrue(replacement.bindConfirmed(secondAccount, "Друга підтверджена адреса", replacement.prepare(secondAccount)))
            }
        } finally {
            if (!destroyed) controller.pause().stop().destroy()
            release.countDown()
            assertTrue("Old preview worker must finish", executor.awaitTermination(5, TimeUnit.SECONDS))
            shadowOf(Looper.getMainLooper()).idle()
        }
    }

    private fun newActivity(): ActivityController<MainActivity> =
        Robolectric.buildActivity(MainActivity::class.java).create().start().resume().visible()

    private fun showOfficialConfirmation(activity: MainActivity) {
        MainActivity::class.java.getDeclaredMethod("confirmAddress", String::class.java, String::class.java, String::class.java)
            .apply { isAccessible = true }.invoke(activity, firstAccount, "м. Приклад, вул. Тестова, 1", "м. Приклад")
    }

    private fun findConfirmationButton(view: View): Button? {
        if (view is Button && view.text.toString() == "Так") return view
        if (view is ViewGroup) for (index in 0 until view.childCount) {
            findConfirmationButton(view.getChildAt(index))?.let { return it }
        }
        return null
    }
}
