package ua.svitlo.widget

import android.Manifest
import android.app.AlertDialog
import android.app.Application
import android.content.Context
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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.ExecutorService
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
@LooperMode(LooperMode.Mode.PAUSED)
@Suppress("DEPRECATION")
class AddressOnboardingTest {
    private lateinit var context: Context
    private var controller: ActivityController<MainActivity>? = null
    private val account = "12345678901"
    private val empty get() = """{"DATETIME":"${java.time.Instant.now().atZone(ua.svitlo.widget.core.KYIV_ZONE).format(java.time.format.DateTimeFormatter.ofPattern("HH:mm dd.MM.yyyy"))}","DISCONNECTIONS":[],"DISCONN_QUEUQ":[{"QUEUE_INFO":"Графік погодинних відключень: 3 черга 2 підчерга"}]}"""
    private val address = "м. Тестове, вул. Офіційна, 1"
    private val unique = """[{"LS":"$account","ADDRESS":"$address","NAME":"PRIVATE FIELD MUST NOT APPEAR"}]"""
    private val emptyCities = "Нічого не знайдено в цій філії. Змініть пошук або оберіть іншу філію."

    @Before fun prepareUnboundApplication() {
        context = RuntimeEnvironment.getApplication()
        shadowOf(context as Application).apply {
            grantPermissions(context.packageName + ".DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION")
            denyPermissions(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        }
        listOf("svitlo_private", "svitlo_weather", "svitlo_runtime", "svitlo_geo").forEach {
            context.getSharedPreferences(it, Context.MODE_PRIVATE).edit().clear().commit()
        }
        check(OfficialScheduleRepository(context,OfficialFeedSource{emptyList()}).refresh())
        if (runCatching { WorkManager.getInstance(context) }.isFailure) {
            val pending = java.util.ArrayDeque<Runnable>()
            val held = Executor { pending.add(it) }
            WorkManager.initialize(context, Configuration.Builder().setExecutor(held).setTaskExecutor(held).build())
        }
    }

    @After fun closeActivity() {
        ShadowAlertDialog.getLatestAlertDialog()?.dismiss()
        controller?.pause()?.stop()?.destroy()
    }
    @Test fun completedDraftShowsOnlyHouseSelectorWithoutSeparateVerificationButton(){
        val activity=openActivity()
        setCompleteDraft(activity){unique}
        assertNull(find<Button>(activity.window.decorView){it.text=="Перевірити адресу"})
        assertNotNull(find<Button>(activity.window.decorView){it.text=="Будинок 1"})
        assertNothingPersisted()
    }

    @Test fun addressOnlySetupResolvesAccountInternallyAndRequiresOfficialAddressConfirmation() {
        val requests = java.util.Collections.synchronizedList(mutableListOf<String>())
        val activity = openActivity(OutageSource { number, _, _, _ -> requests += number; empty })
        assertNull(find<EditText>(activity.window.decorView) { true })
        assertNotNull(button(activity, "1. Обрати філію"))
        assertNull(find<Button>(activity.window.decorView) { it.text == "Перевірити адресу" })
        setCompleteDraft(activity) { unique }
        verify(activity)
        drain(activity)
        assertTrue(activityText(activity).contains(address))
        assertFalse(activityText(activity).contains("PRIVATE FIELD"))
        assertTrue(requests.isEmpty())
        assertNothingPersisted()

        click(activity, "Так")
        drain(activity)

        assertEquals(listOf(account, account, account), requests)
        assertEquals(ConfirmedBinding(account, address, "м. Тестове",DictionaryAddress("a","a1","м. Тестове","s1","Вулиця Тестова","1")), OutageRepository(context).binding())
        assertNotNull(button(activity, "Опції"))
        assertNull(find<Button>(activity.window.decorView) { it.text == "Поки без погоди" })
    }

    @Test fun emptyOfficialResolutionOffersDictionaryAddressAndPersistsOnlyAfterYes() {
        val source=object:OutageSource{
            override fun fetch(account:String,category:ua.svitlo.widget.core.Category,from:java.time.LocalDate,to:java.time.LocalDate):String=error("No account query")
            override fun fetchAddress(address:DictionaryAddress,category:ua.svitlo.widget.core.Category,from:java.time.LocalDate,to:java.time.LocalDate)=empty
        }
        val activity=openActivity(source)
        setCompleteDraft(activity){"[]"};verify(activity);drain(activity)
        assertNotNull(button(activity,"Так"));assertNothingPersisted()
        assertFalse(activityText(activity).contains(account))
        click(activity,"Так");drain(activity)
        val binding=OutageRepository(context).binding()!!
        assertEquals("",binding.account);assertNotNull(binding.dictionary)
        assertEquals(binding.dictionary!!.label,binding.address)
    }
    @Test fun ambiguousHouseResponsesCannotReachConfirmation() {
        val activity = openActivity()
        for ((response, title) in listOf(
            """[{"LS":"12345678901","ADDRESS":"Спільна адреса"},{"LS":"12345678902","ADDRESS":"Спільна адреса"}]""" to "Адреса неоднозначна"
        )) {
            setCompleteDraft(activity) { response }
            verify(activity)
            drain(activity)
            assertTrue(dialogText(latestDialog()).contains(title))
            assertNull(find<Button>(activity.window.decorView) { it.text == "Так" })
            assertNothingPersisted()
            latestDialog().dismiss()
        }
    }

    @Test fun malformedResponsesOfferRetryAndSuccessfulRetryStillNeedsConfirmation() {
        var malformed = true
        var calls = 0
        val activity = openActivity()
        setCompleteDraft(activity) { calls++; if (malformed) "<html>unavailable</html>" else unique }
        verify(activity)
        drain(activity)
        assertEquals(1, calls)
        assertTrue(dialogText(latestDialog()).contains("Не вдалося отримати дані"))
        assertNull(find<Button>(activity.window.decorView) { it.text == "Перевірити адресу" })
        assertNothingPersisted()
        malformed = false
        latestDialog().getButton(AlertDialog.BUTTON_POSITIVE).performClick()
        drain(activity)
        assertEquals(2, calls)
        assertTrue(activityText(activity).contains(address))
        assertNotNull(button(activity, "Так"))
        assertNothingPersisted()
    }

    @Test fun networkFailuresOfferRetryWithoutSavingTheAddress() {
        var offline = true
        var calls = 0
        val activity = openActivity()
        setCompleteDraft(activity) {
            calls++
            if (offline) throw IOException("Synthetic offline")
            unique
        }
        verify(activity)
        drain(activity)
        assertTrue(dialogText(latestDialog()).contains("Не вдалося отримати дані"))
        assertNothingPersisted()
        offline = false
        latestDialog().getButton(AlertDialog.BUTTON_POSITIVE).performClick()
        drain(activity)
        assertEquals(2, calls)
        assertNotNull(button(activity, "Так"))
        assertNothingPersisted()
    }

    @Test fun responseForPreviousHouseCannotAdvanceAnEditedDraft() {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val activity = openActivity()
        setCompleteDraft(activity) { entered.countDown(); check(release.await(10, TimeUnit.SECONDS)); unique }
        try {
            verify(activity)
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            setField(activity, "house", "2")
        } finally { release.countDown() }
        drain(activity)
        assertEquals("2", field(activity, "house"))
        assertNull(find<Button>(activity.window.decorView) { it.text == "Так" })
        assertNothingPersisted()
    }

    @Test fun destroyedAddressRequestCannotPersistOrCompleteOldOnboarding() {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val activity = openActivity()
        setCompleteDraft(activity) {
            entered.countDown()
            var waiting = true
            while (waiting) {
                try { check(release.await(10, TimeUnit.SECONDS)); waiting = false }
                catch (_: InterruptedException) { /* HTTP may complete after Activity destruction. */ }
            }
            unique
        }
        val executor = executor(activity)
        try {
            verify(activity)
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            controller!!.pause().stop().destroy()
            controller = null
        } finally { release.countDown() }
        assertTrue(executor.awaitTermination(5, TimeUnit.SECONDS))
        shadowOf(Looper.getMainLooper()).idle()
        assertNothingPersisted()
        assertFalse(ShadowAlertDialog.getLatestAlertDialog()?.isShowing == true)
    }

    @Test fun backOnInitialAddressDialogCancelsAndIgnoresItsDelayedResponse() {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val activity = openActivity()
        setCompleteDraft(activity) { entered.countDown(); check(release.await(10, TimeUnit.SECONDS)); unique }
        try {
            verify(activity)
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            val progress = latestDialog()

            progress.onBackPressed()
            shadowOf(Looper.getMainLooper()).idle()

            assertFalse("Native Back must close the initial loading modal", progress.isShowing)
            assertEquals("1", field(activity, "house"))
            assertEquals("Cancel must release the screen for another action", false, field(activity, "busy"))
            assertNull(find<Button>(activity.window.decorView) { it.text == "Перевірити адресу" })
            assertNull(find<Button>(activity.window.decorView) { it.text == "Так" })
            assertNothingPersisted()
        } finally { release.countDown() }
        drain(activity)

        assertEquals("1", field(activity, "house"))
        assertNull(find<Button>(activity.window.decorView) { it.text == "Так" })
        assertEquals(false, field(activity, "busy"))
        assertNothingPersisted()
    }

    @Test fun branchChoiceAutomaticallyLoadsOnlyItsCitiesAndOffersScopedSearchAndBranchChange() {
        val directory = Directory()
        val activity = openAddressSetup(directory)
        assertTrue("Opening setup must not fetch every branch", directory.requests.isEmpty())
        click(activity, "1. Обрати філію")
        drain(activity)
        selectLatest("Філія А")
        drain(activity)
        var dialog = latestDialog()
        assertTrue(dialogText(dialog).contains("Населений пункт"))
        assertTrue(dialogText(dialog).contains("Філія А"))
        assertEquals(listOf("a"), directory.requests.filter { it["op"] == "city_list" }.map { it["dept_id"] })
        assertEquals(listOf("Альфа", "Берег"), listItems(dialog))
        query(dialog).setText("бер")
        assertEquals(listOf("Берег"), listItems(dialog))
        query(dialog).setText("Гамма")
        assertTrue(listItems(dialog).isEmpty())
        assertTrue("Empty search needs a useful branch-specific explanation", dialogText(dialog).contains(emptyCities))
        assertEquals("Змінити філію", find<Button>(dialog.window!!.decorView){it.tag=="address_picker_alternative"}!!.text.toString())

        find<Button>(dialog.window!!.decorView){it.tag=="address_picker_alternative"}!!.performClick()
        drain(activity)
        selectLatest("Філія Б")
        drain(activity)
        dialog = latestDialog()
        assertTrue(dialogText(dialog).contains("Населений пункт"))
        assertTrue(dialogText(dialog).contains("Філія Б"))
        assertEquals(listOf("Гамма"), listItems(dialog))
        assertEquals(listOf("a", "b"), directory.requests.filter { it["op"] == "city_list" }.map { it["dept_id"] })
        assertNothingPersisted()
    }

    @Test fun cityStreetHouseAdvanceAndHouseAutomaticallyVerifiesWithoutBinding() {
        val directory = Directory()
        val activity = openAddressSetup(directory)
        assertNull(find<Button>(activity.window.decorView) { it.text == "2. Населений пункт" })
        assertNull(find<Button>(activity.window.decorView) { it.text == "3. Вулиця" })
        assertNull(find<Button>(activity.window.decorView) { it.text == "4. Будинок" })
        assertNull(find<Button>(activity.window.decorView) { it.text == "Перевірити адресу" })

        selectCompleteAddress(activity)

        assertEquals(listOf("department_list", "city_list", "street_list", "house_list", "ls_list_by_addr"), directory.requests.map { it["op"] })
        assertEquals("a1", directory.requests.single { it["op"] == "street_list" }["city_id"])
        assertEquals("s1", directory.requests.single { it["op"] == "house_list" }["street_id"])
        assertNotNull(button(activity,"Так"))
        assertNotNull(find<EditText>(activity.window.decorView) { it.tag=="profile_name" })
        assertNothingPersisted()
    }

    @Test fun switchingBranchClearsCityStreetHouseAndRequiresFreshResolution() {
        val directory = Directory()
        val activity = openAddressSetup(directory)
        selectCompleteAddress(activity)
        click(activity,"Ні")
        repeat(3){click(activity,"Назад")}
        click(activity,"1. Обрати філію")
        drain(activity)
        selectLatest("Філія Б")
        drain(activity)
        find<Button>(latestDialog().window!!.decorView){it.tag=="address_picker_cancel"}!!.performClick()
        shadowOf(Looper.getMainLooper()).idle()

        assertNull(find<EditText>(activity.window.decorView) { true })
        assertTrue(button(activity, "2. Населений пункт").isEnabled)
        assertNull(find<Button>(activity.window.decorView) { it.text == "3. Вулиця" })
        assertNull(find<Button>(activity.window.decorView) { it.text == "4. Будинок" })
        assertNull(find<Button>(activity.window.decorView) { it.text == "Перевірити адресу" })
        assertNull(field(activity, "city"))
        assertNull(field(activity, "street"))
        assertNull(field(activity, "house"))
        assertNothingPersisted()
    }

    private fun openActivity(source: OutageSource = OutageSource { _, _, _, _ -> error("No account request expected") }): MainActivity {
        controller = Robolectric.buildActivity(MainActivity::class.java).create().start().resume().visible()
        return controller!!.get().also { setField(it, "repo", OutageRepository(context, source)) }
    }

    private fun openAddressSetup(directory: Directory): MainActivity {
        val activity = openActivity()
        setField(activity, "addressApi", AddressApi(OperatorTransport(directory::request)))
        return activity
    }

    private fun setCompleteDraft(activity: MainActivity, response: () -> String) {
        setField(activity, "addressApi", AddressApi(OperatorTransport { parameters ->
            assertEquals(mapOf("op" to "ls_list_by_addr", "street_id" to "s1", "house" to "1"), parameters)
            response()
        }))
        setField(activity, "department", AddressItem("a", "Філія А"))
        setField(activity, "city", AddressItem("a1", "м. Тестове"))
        setField(activity, "street", AddressItem("s1", "Вулиця Тестова"))
        setField(activity, "house", "1")
        MainActivity::class.java.getDeclaredMethod("setup").apply { isAccessible = true }.invoke(activity)
    }

    private fun selectCompleteAddress(activity: MainActivity) {
        click(activity, "1. Обрати філію")
        drain(activity)
        selectLatest("Філія А")
        drain(activity)
        selectLatest("Альфа")
        drain(activity)
        selectLatest("Вулиця Тестова")
        drain(activity)
        selectLatest("1")
        drain(activity)
    }

    private class Directory {
        val requests = mutableListOf<Map<String, String>>()
        fun request(parameters: Map<String, String>): String {
            requests += parameters.toMap()
            return when (parameters["op"]) {
                "department_list" -> """[{"ID":"a","NAME":"Філія А"},{"ID":"b","NAME":"Філія Б"}]"""
                "city_list" -> when (parameters["dept_id"]) {
                    "a" -> """[{"ID":"a1","NAME":"Альфа"},{"ID":"a2","NAME":"Берег"}]"""
                    "b" -> """[{"ID":"b1","NAME":"Гамма"}]"""
                    else -> error("A city request needs its selected branch")
                }
                "street_list" -> {
                    check(parameters["city_id"] == "a1")
                    """[{"ID":"s1","NAME":"Вулиця Тестова"}]"""
                }
                "house_list" -> {
                    check(parameters["street_id"] == "s1")
                    """[{"HOUSE":"1"},{"HOUSE":"2"}]"""
                }
                "ls_list_by_addr" -> """[{"LS":"12345678901","ADDRESS":"м. Тестове, вул. Офіційна, 1"}]"""
                else -> error("Unexpected directory request")
            }
        }
    }

    private fun assertNothingPersisted() {
        assertNull(OutageRepository(context).binding())
        assertTrue(OutageRepository(context).snapshot().categories.isEmpty())
        assertTrue(context.getSharedPreferences("svitlo_private", Context.MODE_PRIVATE).all.isEmpty())
        assertTrue(context.getSharedPreferences("svitlo_weather", Context.MODE_PRIVATE).all.isEmpty())
    }

    private fun latestDialog(): AlertDialog = ShadowAlertDialog.getLatestAlertDialog().also { assertTrue(it.isShowing) }
    private fun query(dialog: AlertDialog) = find<EditText>(dialog.window!!.decorView) { it.hint == "Пошук" }!!
    private fun list(dialog: AlertDialog) = find<ListView>(dialog.window!!.decorView) { true }!!
    private fun listItems(dialog: AlertDialog): List<String> = list(dialog).adapter.let { adapter ->
        (0 until adapter.count).map { adapter.getItem(it).toString() }
    }
    private fun selectLatest(label: String) {
        val dialog = latestDialog()
        val list = list(dialog)
        val index = listItems(dialog).indexOf(label)
        assertTrue("Expected chooser item: $label; actual=${listItems(dialog)}", index >= 0)
        list.performItemClick(null, index, index.toLong())
    }
    private fun button(activity: MainActivity, label: String): Button = find<Button>(activity.window.decorView) { it.text == label }
        ?: throw AssertionError("Expected action: $label")
    private fun verify(activity:MainActivity){
        MainActivity::class.java.getDeclaredMethod("verifyAddress").apply{isAccessible=true}.invoke(activity)
    }
    private fun click(activity: MainActivity, label: String) { assertTrue(button(activity, label).isEnabled); assertTrue(button(activity, label).performClick()) }
    private fun activityText(activity: MainActivity) = texts(activity.window.decorView).joinToString("\n")
    private fun dialogText(dialog: AlertDialog) = texts(dialog.window!!.decorView).joinToString("\n")
    private fun texts(view: View): List<String> {
        if (view.visibility != View.VISIBLE) return emptyList()
        if (view is TextView) return listOf(view.text.toString())
        return if (view is ViewGroup) (0 until view.childCount).flatMap { texts(view.getChildAt(it)) } else emptyList()
    }
    private fun field(activity: MainActivity, name: String): Any? = MainActivity::class.java.getDeclaredField(name)
        .apply { isAccessible = true }.get(activity)
    private fun setField(activity: MainActivity, name: String, value: Any) {
        MainActivity::class.java.getDeclaredField(name).apply { isAccessible = true }.set(activity, value)
    }
    private fun executor(activity: MainActivity) = field(activity, "executor") as ExecutorService
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
            val view = queue.removeFirst()
            if (view is T && predicate(view)) return view
            if (view is ViewGroup) for (index in 0 until view.childCount) queue.add(view.getChildAt(index))
        }
        return null
    }
}
