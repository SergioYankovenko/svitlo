package ua.svitlo.widget

import android.app.AlertDialog
import android.app.Application
import android.content.Context
import android.graphics.Rect
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.ListView
import android.widget.TextView
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
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.LooperMode
import org.robolectric.shadows.ShadowAlertDialog

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], qualifiers = "w320dp-h568dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@LooperMode(LooperMode.Mode.PAUSED)
class ChooserLayoutTest {
    private lateinit var context: Application
    private var controller: ActivityController<MainActivity>? = null
    private val emptyMessage = "Нічого не знайдено в цій філії. Змініть пошук або оберіть іншу філію."

    @Before fun prepareUnboundApp() {
        context = RuntimeEnvironment.getApplication()
        shadowOf(context).grantPermissions(context.packageName + ".DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION")
        if(runCatching{androidx.work.WorkManager.getInstance(context)}.isFailure){
            val held=java.util.concurrent.Executor{}
            androidx.work.WorkManager.initialize(context,androidx.work.Configuration.Builder().setExecutor(held).setTaskExecutor(held).build())
        }
        listOf("svitlo_private", "svitlo_weather", "svitlo_runtime", "svitlo_geo").forEach {
            context.getSharedPreferences(it, Context.MODE_PRIVATE).edit().clear().commit()
        }
    }

    @After fun closeDialogAndActivity() {
        ShadowAlertDialog.getLatestAlertDialog()?.dismiss()
        controller?.pause()?.stop()?.destroy()
        RuntimeEnvironment.setFontScale(1f)
    }

    @Test fun emptyCitySearchAndBothActionsFitAboveKeyboardAtFont150Percent() {
        assertEmptyChooserFits(fontScale = 1.5f)
    }

    @Test fun emptyCitySearchAndBothActionsFitAboveKeyboardAtFont200Percent() {
        assertEmptyChooserFits(fontScale = 2f)
    }

    @Suppress("DEPRECATION") // SDK 28 native text uses scaledDensity.
    private fun assertEmptyChooserFits(fontScale: Float) {
        RuntimeEnvironment.setFontScale(fontScale)
        assertEquals(fontScale, context.resources.configuration.fontScale, 0.001f)
        assertEquals(fontScale, context.resources.displayMetrics.scaledDensity /
            context.resources.displayMetrics.density, 0.001f)
        controller = Robolectric.buildActivity(MainActivity::class.java).create().start().resume().visible()
        val activity = controller!!.get()
        val label: (AddressItem) -> String = { it.name }
        val alternative: () -> Unit = {}
        val selected: (AddressItem) -> Unit = { error("Filtering must not select an address") }
        val headingText = "Населений пункт"
        val branchText = "Тестова міська електрична філія з довгою назвою"
        MainActivity::class.java.declaredMethods.single { it.name == "choose" }.apply { isAccessible = true }
            .invoke(activity, "$headingText · $branchText",
                listOf(AddressItem("one", "Тестове місто"), AddressItem("two", "Інше село")), label,
                emptyMessage, "Змінити філію", alternative, selected)
        val dialog = ShadowAlertDialog.getLatestAlertDialog()
        assertTrue(dialog.isShowing)
        val decor = dialog.window!!.decorView as ViewGroup
        val query = find<EditText>(decor) { it.hint == "Пошук" }!!
        val heading = find<TextView>(decor) { it.text.toString() == headingText }!!
        val branch = find<TextView>(decor) { it.text.toString() == branchText }!!
        shadowOf(Looper.getMainLooper()).idle()
        val list = find<ListView>(decor) { true }!!
        assertEquals("The initial chooser must contain matching settlements", 2, list.adapter.count)

        // Reproduce the measured 288dp × 224dp dialog viewport left above the
        // IME on the 320dp phone, without pretending Robolectric opens a real IME.
        val density = context.resources.displayMetrics.density
        val width = (288 * density).toInt()
        val height = (224 * density).toInt()
        dialog.window!!.setLayout(width, height)
        fun measureViewport() {
            repeat(3) {
                decor.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY))
                decor.layout(0, 0, width, height)
                decor.viewTreeObserver.dispatchOnGlobalLayout()
            }
        }
        val cancel = find<TextView>(decor){it.tag=="address_picker_cancel"}!!
        val changeBranch = find<TextView>(decor){it.tag=="address_picker_alternative"}!!
        assertEquals("Скасувати", cancel.text.toString())
        assertEquals("Змінити філію", changeBranch.text.toString())
        val content = decor.findViewById<ViewGroup>(android.R.id.content) ?: decor
        val viewport = Rect(0, 0, width, height)
        val failures = mutableListOf<String>()
        val sharedText = listOf("heading" to heading, "branch context" to branch,
            "search field" to query, "cancel" to cancel, "change branch" to changeBranch)
        fun assertPhase(name: String, result: View, resultText: TextView? = null) {
            val contentBounds = bounds(decor, content)
            assertTrue("Dialog content must fit its visible window: content=$contentBounds viewport=$viewport",
                viewport.contains(contentBounds))
            val text = sharedText + if (resultText == null) emptyList() else listOf("empty search" to resultText)
            for ((label, view) in text) {
                try { assertTextVisible(decor, view, "$name/$label", contentBounds, fontScale) }
                catch (failure: AssertionError) { failures += failure.message.orEmpty() }
            }
            val controls = sharedText.map { it.second } + result
            for (first in controls.indices) for (second in first + 1 until controls.size) {
                val a = bounds(decor, controls[first])
                val b = bounds(decor, controls[second])
                if (Rect.intersects(a, b)) failures += "$name controls overlap: '$first'=$a '$second'=$b"
            }
        }

        measureViewport()
        val listBounds = bounds(decor, list)
        val contentBefore = bounds(decor, content)
        if (list.visibility != View.VISIBLE || list.height < (30 * density).toInt() || list.width <= 0) {
            failures += "Results need a usable viewport >=30dp: bounds=$listBounds visibility=${list.visibility}"
        }
        if (!contentBefore.contains(listBounds)) failures += "Results exceed content: bounds=$listBounds content=$contentBefore"
        assertPhase("results", list)

        query.setText("zz")
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals("The test must reach the empty-search state", 0, list.adapter.count)
        measureViewport()
        val empty = find<TextView>(decor) { it.text.toString() == emptyMessage }!!
        assertPhase("empty", empty, empty)
        assertTrue("Chooser font=$fontScale viewport=$viewport content=${bounds(decor, content)}\n${failures.joinToString("\n")}", failures.isEmpty())
    }

    private fun assertTextVisible(root: ViewGroup, view: TextView, name: String, content: Rect, scale: Float) {
        val bounds = bounds(root, view)
        val layout = view.layout
        val detail = "$name font=$scale bounds=$bounds content=$content lines=${layout?.lineCount} " +
            "layoutHeight=${layout?.height} viewHeight=${view.height} text='${view.text}'"
        assertEquals("Control must remain visible: $detail", View.VISIBLE, view.visibility)
        assertTrue("Control needs actual visible area: $detail", bounds.width() > 0 && bounds.height() > 0)
        assertTrue("Control lies outside actual dialog content: $detail", content.contains(bounds))
        assertNotNull("Text needs a native measured layout: $detail", layout)
        val availableHeight = view.height - view.compoundPaddingTop - view.compoundPaddingBottom
        assertTrue("Text is clipped vertically: $detail available=$availableHeight", layout.height <= availableHeight)
        assertTrue("Lines exceed the visible maximum: $detail", view.maxLines < 0 || layout.lineCount <= view.maxLines)
        for (line in 0 until layout.lineCount) {
            if(view.ellipsize!=android.text.TextUtils.TruncateAt.END)
                assertEquals("Essential action or message was ellipsized: $detail", 0, layout.getEllipsisCount(line))
            assertTrue("Text exceeds its available width: $detail", layout.getLineLeft(line) >= -0.5f &&
                layout.getLineRight(line) <= layout.width + 0.5f)
        }
    }

    private fun bounds(root: ViewGroup, view: View): Rect = Rect().also {
        view.getDrawingRect(it)
        root.offsetDescendantRectToMyCoords(view, it)
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
