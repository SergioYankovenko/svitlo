package ua.svitlo.widget

import android.Manifest
import android.app.AlertDialog
import android.app.Application
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.ListView
import android.widget.TextView
import androidx.work.Configuration
import androidx.work.WorkManager
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import org.robolectric.shadows.ShadowAlertDialog
import java.io.IOException
import java.time.Instant
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.ExecutorService
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
@LooperMode(LooperMode.Mode.PAUSED)
@Suppress("DEPRECATION")
class AccountChangeTest {
    private lateinit var context: Context
    private lateinit var repo: OutageRepository
    private lateinit var weather: WeatherRepository
    private lateinit var oldOutage: Map<String, *>
    private lateinit var oldWeather: Map<String, *>
    private lateinit var oldGeo: Map<String, *>
    private var controller: ActivityController<MainActivity>? = null
    private val oldAccount = "12345678901"
    private val newAccount = "12345678902"
    private val newAddress = "м. Нове тестове, вул. Прикладна, 2"
    private val raw get() = """{"DATETIME":"${Instant.now().atZone(ua.svitlo.widget.core.KYIV_ZONE).format(java.time.format.DateTimeFormatter.ofPattern("HH:mm dd.MM.yyyy"))}","DISCONNECTIONS":[],"DISCONN_QUEUQ":[{"QUEUE_INFO":"Графік погодинних відключень: 3 черга 2 підчерга"}]}"""

    @Before fun seedConfirmedHousehold() {
        context = RuntimeEnvironment.getApplication()
        shadowOf(context as Application).apply {
            grantPermissions(context.packageName + ".DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION")
            denyPermissions(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        }
        listOf("svitlo_private", "svitlo_weather", "svitlo_runtime", "svitlo_geo").forEach {
            prefs(it).edit().clear().commit()
        }
        check(OfficialScheduleRepository(context,OfficialFeedSource{emptyList()}).refresh())
        if (runCatching { WorkManager.getInstance(context) }.isFailure) {
            // WorkManager is unrelated to verification; hold queued network work.
            val pending = java.util.ArrayDeque<Runnable>()
            val executor = Executor { pending.add(it) }
            WorkManager.initialize(context, Configuration.Builder().setExecutor(executor)
                .setTaskExecutor(executor).build())
        }
        repo = OutageRepository(context, OutageSource { _, _, _, _ -> raw })
        assertTrue(repo.bindConfirmed(oldAccount, "м. Старе тестове, вул. Прикладна, 1",
            repo.prepare(oldAccount), "м. Старе тестове"))
        weather = WeatherRepository(context, object : WeatherSource {
            override fun search(city: String, region: String) = """{"results":[]}"""
            override fun fetch(location: WeatherLocation) = weatherFixture(Instant.now())
        })
        weather.bindLocation(WeatherLocation("Старе тестове", "Тестова область", 49.0, 30.0),addressBased=true)
        assertTrue(weather.refresh())
        prefs("svitlo_geo").edit().putBoolean("enabled",false).commit()
        oldOutage = prefs("svitlo_private").all.toMap()
        oldWeather = prefs("svitlo_weather").all.toMap()
        oldGeo = prefs("svitlo_geo").all.toMap()
    }

    @After fun closeActivity() {
        ShadowAlertDialog.getLatestAlertDialog()?.dismiss()
        controller?.pause()?.stop()?.destroy()
    }

    @Test fun separateChangeActionStartsBlankDraftAndCancelKeepsSavedData() {
        val activity = openChange()
        assertNull(find<EditText>(activity.window.decorView) { true })
        assertNotNull(find<Button>(activity.window.decorView) { it.text == "1. Обрати філію" })
        assertNull(find<Button>(activity.window.decorView) { it.text == "2. Населений пункт" })
        assertHouseholdUnchanged()

        click(activity, "Скасувати зміну")

        assertHome(activity)
        assertHouseholdUnchanged()
    }

    @Test fun backFromDraftKeepsCurrentAccountAndWeather() {
        val activity = openChange()
        setDraft(activity)
        activity.onBackPressed()
        assertNotNull(find<Button>(activity.window.decorView) { it.text == "4. Будинок" })
        assertHouseholdUnchanged()
        click(activity,"Скасувати зміну")
        assertHome(activity)
        MainActivity::class.java.getDeclaredMethod("startAccountChange").apply { isAccessible = true }.invoke(activity)
        assertNotNull(find<Button>(activity.window.decorView) { it.text == "1. Обрати філію" })
        assertNull(find<Button>(activity.window.decorView) { it.text == "Перевірити адресу" })
    }

    @Test fun incompleteAddressNeverRequestsVerificationOrChangesSavedData() {
        val activity = openChange()
        setField(activity, "addressApi", AddressApi(OperatorTransport { error("Incomplete address must not be requested") }))
        assertNull(find<Button>(activity.window.decorView) { it.text == "Перевірити адресу" })
        MainActivity::class.java.getDeclaredMethod("verifyAddress").apply { isAccessible = true }.invoke(activity)
        assertHouseholdUnchanged()
        assertNull(find<EditText>(activity.window.decorView) { true })
    }

    @Test fun ambiguousOfficialAccountsPreserveOldBindingAndCaches() {
        val activity = openChange()
        setDraft(activity, """[{"LS":"12345678902","ADDRESS":"Спільна тестова адреса"},{"LS":"12345678903","ADDRESS":"Спільна тестова адреса"}]""")
        verify(activity)
        drain(activity)
        assertTrue(ShadowAlertDialog.getLatestAlertDialog().isShowing)
        assertNotNull(find<TextView>(ShadowAlertDialog.getLatestAlertDialog().window!!.decorView) { it.text == "Адреса неоднозначна" })
        assertHouseholdUnchanged()
    }

    @Test fun failedVerificationPreservesOldBindingAndCaches() {
        val activity = openChange()
        setDraft(activity)
        setField(activity, "addressApi", AddressApi(OperatorTransport { throw IOException("Synthetic offline") }))
        verify(activity)
        drain(activity)
        assertTrue(ShadowAlertDialog.getLatestAlertDialog().isShowing)
        assertHouseholdUnchanged()
    }

    @Test fun officialAddressAndNegativeConfirmationDoNotReplaceCurrentData() {
        val activity = openChange()
        verifyDraft(activity)
        assertHouseholdUnchanged()
        click(activity, "Ні")
        assertNotNull(find<View>(activity.window.decorView) { it.tag == "home_schedule" })
        assertHouseholdUnchanged()
    }

    @Test fun positiveConfirmationReplacesAccountClearsOldWeatherAndKeepsBothWidgets() {
        val activity = openChange()
        val manager = AppWidgetManager.getInstance(context)
        val compact = ComponentName(context, CompactWidget::class.java)
        val detailed = ComponentName(context, SvitloWidget::class.java)
        shadowOf(manager).bindAppWidgetId(101, compact)
        shadowOf(manager).bindAppWidgetId(102, detailed)
        verifyDraft(activity)
        assertHouseholdUnchanged()

        click(activity, "Так")
        drain(activity)

        assertEquals(ConfirmedBinding(newAccount, newAddress, "м. Нове тестове",DictionaryAddress("1","2","м. Нове тестове","3","вул. Прикладна","2")), repo.binding())
        assertNotEquals(oldOutage["generation"], prefs("svitlo_private").getString("generation", null))
        assertNull(weather.location())
        assertNull(weather.snapshot())
        assertFalse(prefs("svitlo_geo").contains("history"))
        assertFalse(prefs("svitlo_geo").contains("last_check"))
        assertFalse(prefs("svitlo_geo").contains("snooze_until"))
        assertArrayEquals(intArrayOf(101), manager.getAppWidgetIds(compact))
        assertArrayEquals(intArrayOf(102), manager.getAppWidgetIds(detailed))
        assertNull(find<Button>(activity.window.decorView) { it.text == "Поки без погоди" })
        assertHome(activity)
    }

    @Test fun failedWeatherCommitsAfterAddressConfirmationStillOpenHomeAndKeepNewBinding() {
        val activity = openChange()
        val locality = "м. Христинівка"
        val officialAddress = "$locality, вул. Синтетична, 2"
        setDraft(activity, """[{"LS":"$newAccount","ADDRESS":"$officialAddress"}]""")
        setField(activity, "city", AddressItem("2", locality))
        MainActivity::class.java.getDeclaredMethod("setup").apply { isAccessible = true }.invoke(activity)
        verify(activity)
        drain(activity)
        assertHouseholdUnchanged()

        // Android can update the in-memory preferences before reporting a disk failure.
        val backing = prefs("svitlo_weather")
        var failedCommits = 0
        val failing = object : SharedPreferences by backing {
            override fun edit(): SharedPreferences.Editor {
                val editor = backing.edit()
                return object : SharedPreferences.Editor by editor {
                    override fun clear(): SharedPreferences.Editor = also { editor.clear() }
                    override fun putString(key: String, value: String?): SharedPreferences.Editor =
                        also { editor.putString(key, value) }
                    override fun commit(): Boolean {
                        editor.commit()
                        failedCommits++
                        return false
                    }
                }
            }
        }
        WeatherRepository::class.java.getDeclaredField("prefs").apply { isAccessible = true }.set(weather, failing)

        click(activity, "Так")
        drain(activity)

        assertEquals("Exercise both clearing the old weather and binding its new locality", 2, failedCommits)
        assertEquals(ConfirmedBinding(newAccount, officialAddress, locality,DictionaryAddress("1","2",locality,"3","вул. Прикладна","2")), repo.binding())
        assertNotEquals(oldOutage["generation"], prefs("svitlo_private").getString("generation", null))
        assertEquals(AddressWeather.knownLocation(locality), weather.location())
        assertNull("The old household forecast must not survive the in-memory clear", weather.snapshot())
        assertHome(activity)
        assertFalse(activity.isFinishing)
    }

    @Test fun backDuringPendingConfirmationCannotReplaceCurrentData() {
        val activity = openChange()
        verifyDraft(activity)
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        setField(activity, "repo", OutageRepository(context, OutageSource { _, _, _, _ ->
            entered.countDown()
            check(release.await(5, TimeUnit.SECONDS))
            raw
        }))
        try {
            click(activity, "Так")
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            // Dispatch Back to the modal users actually see, not directly to Activity.
            ShadowAlertDialog.getLatestAlertDialog().onBackPressed()
            shadowOf(Looper.getMainLooper()).idle()
            assertHome(activity)
            assertHouseholdUnchanged()
            assertFalse("Cancel must immediately release the UI", MainActivity::class.java.getDeclaredField("busy")
                .apply { isAccessible = true }.getBoolean(activity))
            click(activity, "Опції")
            assertNull(find<Button>(activity.window.decorView) { it.text == "Видалити збережені дані" })
            click(activity, "Головна")
        } finally { release.countDown() }
        drain(activity)
        assertHome(activity)
        assertHouseholdUnchanged()
    }

    @Test fun staleAddressChooserCannotReopenDraftAfterWidgetNavigation() {
        val activity = openChange()
        setField(activity, "addressApi", AddressApi(OperatorTransport {
            """[{"ID":"1","NAME":"Тестова філія"}]"""
        }))
        click(activity, "1. Обрати філію")
        drain(activity)
        val dialog = ShadowAlertDialog.getLatestAlertDialog()
        val list = find<ListView>(dialog.window!!.decorView) { true }!!

        controller!!.newIntent(Intent(context, MainActivity::class.java))
        list.performItemClick(null, 0, 0)

        assertHome(activity)
        assertHouseholdUnchanged()
    }

    @Test fun confirmationCannotReplaceAnotherHouseholdSavedWhilePreviewWasPending() {
        val activity = openChange()
        verifyDraft(activity)
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        setField(activity, "repo", OutageRepository(context, OutageSource { _, _, _, _ ->
            entered.countDown()
            check(release.await(5, TimeUnit.SECONDS))
            raw
        }))
        try {
            click(activity, "Так")
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            assertTrue(repo.bindConfirmed("12345678903", "Інша підтверджена адреса",
                repo.prepare("12345678903"), "м. Інше тестове"))
        } finally { release.countDown() }
        drain(activity)
        assertEquals("12345678903", repo.binding()!!.account)
        assertEquals(oldWeather, prefs("svitlo_weather").all)
        assertHome(activity)
    }

    @Test fun destroyingPendingAccountChangeCannotOverwriteExistingHousehold() {
        val activity = openChange()
        verifyDraft(activity)
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        setField(activity, "repo", OutageRepository(context, OutageSource { _, _, _, _ ->
            entered.countDown()
            var waiting = true
            while (waiting) {
                try { check(release.await(5, TimeUnit.SECONDS)); waiting = false }
                catch (_: InterruptedException) { /* Simulate an HTTP response arriving after destroy. */ }
            }
            raw
        }))
        val executor = executor(activity)
        try {
            click(activity, "Так")
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            controller!!.pause().stop().destroy()
            controller = null
        } finally { release.countDown() }
        assertTrue(executor.awaitTermination(5, TimeUnit.SECONDS))
        shadowOf(Looper.getMainLooper()).idle()
        assertHouseholdUnchanged()
    }

    private fun openChange(): MainActivity {
        controller = Robolectric.buildActivity(MainActivity::class.java).create().start().resume().visible()
        val activity = controller!!.get()
        setField(activity, "repo", repo)
        setField(activity, "weather", weather)
        MainActivity::class.java.getDeclaredMethod("startAccountChange").apply { isAccessible = true }.invoke(activity)
        return activity
    }

    private fun setDraft(activity: MainActivity, response: String = """[{"LS":"$newAccount","ADDRESS":"$newAddress"}]""") {
        setField(activity, "addressApi", AddressApi(OperatorTransport { parameters ->
            assertEquals("ls_list_by_addr", parameters["op"])
            response
        }))
        setField(activity, "department", AddressItem("1", "Тестова філія"))
        setField(activity, "city", AddressItem("2", "м. Нове тестове"))
        setField(activity, "street", AddressItem("3", "вул. Прикладна"))
        setField(activity, "house", "2")
        MainActivity::class.java.getDeclaredMethod("setup").apply { isAccessible = true }.invoke(activity)
    }

    private fun verifyDraft(activity: MainActivity) {
        setDraft(activity)
        verify(activity)
        drain(activity)
        assertNotNull(find<Button>(activity.window.decorView) { it.text == "Так" })
    }

    private fun assertHouseholdUnchanged() {
        assertEquals(oldOutage, prefs("svitlo_private").all)
        assertEquals(oldWeather, prefs("svitlo_weather").all)
        assertEquals(oldGeo, prefs("svitlo_geo").all)
    }

    private fun assertHome(activity: MainActivity) {
        assertNotNull(find<Button>(activity.window.decorView) { it.text == "Опції" })
    }

    private fun prefs(name: String) = context.getSharedPreferences(name, Context.MODE_PRIVATE)
    private fun verify(activity:MainActivity){
        MainActivity::class.java.getDeclaredMethod("verifyAddress").apply{isAccessible=true}.invoke(activity)
    }
    private fun click(activity: MainActivity, label: String) {
        val button = find<Button>(activity.window.decorView) { it.text == label }
        assertNotNull("Expected action: $label", button)
        assertTrue(button!!.performClick())
    }
    private fun setField(activity: MainActivity, name: String, value: Any) {
        MainActivity::class.java.getDeclaredField(name).apply { isAccessible = true }.set(activity, value)
    }
    private fun executor(activity: MainActivity) = MainActivity::class.java.getDeclaredField("executor")
        .apply { isAccessible = true }.get(activity) as ExecutorService
    private fun drain(activity: MainActivity) {
        repeat(3) {
            executor(activity).submit {}.get(5, TimeUnit.SECONDS)
            shadowOf(Looper.getMainLooper()).idle()
        }
    }
    private inline fun <reified T: View> find(root: View, predicate: (T) -> Boolean): T? {
        val queue = java.util.ArrayDeque<View>()
        queue.add(root)
        while (queue.isNotEmpty()) {
            val item = queue.removeFirst()
            if (item is T && predicate(item)) return item
            if (item is ViewGroup) for (i in 0 until item.childCount) queue.add(item.getChildAt(i))
        }
        return null
    }
}
