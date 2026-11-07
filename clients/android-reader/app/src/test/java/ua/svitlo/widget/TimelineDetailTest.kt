package ua.svitlo.widget

import android.app.Application
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Bundle
import android.os.Looper
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.Button
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
import ua.svitlo.widget.core.*
import java.time.Instant
import java.time.LocalDate
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], qualifiers = "w320dp-h568dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@LooperMode(LooperMode.Mode.PAUSED)
class TimelineDetailTest {
    private lateinit var context: Application
    private var controller: ActivityController<TimelineActivity>? = null
    private val date = LocalDate.of(2026, 10, 22)
    private val now = Instant.parse("2026-10-22T07:00:00Z")
    @Before fun setup() {
        context = RuntimeEnvironment.getApplication()
        shadowOf(context).grantPermissions(context.packageName + ".DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION")
        context.getSharedPreferences("svitlo_private", Context.MODE_PRIVATE).edit().clear().commit()
    }
    @After fun close() { controller?.pause()?.stop()?.destroy(); RuntimeEnvironment.setFontScale(1f) }

    @Test fun oneHourChartTapSelectsExactMinuteAndOriginalInterval() {
        val view = TimelineDetailView(context)
        val start = Instant.parse("2026-10-22T07:02:00Z")
        val event = Outage(Category.SCHEDULE, start, start.plusSeconds(300), false, "", "")
        val snapshot = complete(listOf(event))
        view.setViewport(TimelineViewport(date, TimelineZoom.HOUR, now))
        view.setData(snapshot, now)
        view.measure(exact(300), exact(180)); view.layout(0, 0, 300, 180)
        view.draw(Canvas(Bitmap.createBitmap(300, 180, Bitmap.Config.ARGB_8888)))
        val x = view.plotLeft + (view.plotRight - view.plotLeft) * (4f / 60)
        val down = MotionEvent.obtain(0, 0, MotionEvent.ACTION_DOWN, x, 70f, 0)
        val up = MotionEvent.obtain(0, 20, MotionEvent.ACTION_UP, x, 70f, 0)
        view.onTouchEvent(down); view.onTouchEvent(up); down.recycle(); up.recycle()
        assertEquals(now.plusSeconds(240), view.viewport.selectedAt)
        assertEquals(listOf(event), TimelineViewport.eventsAt(snapshot, view.viewport.selectedAt))
        assertTrue(view.contentDescription.toString().contains("10:04"))
    }

    @Test fun legacyTimelineIntentRedirectsToHomeWithRequestedDate() {
        val activity=open()
        val routed=shadowOf(activity).nextStartedActivity
        assertNotNull(routed)
        assertEquals(MainActivity::class.java.name,routed.component!!.className)
        assertEquals("home",routed.getStringExtra("screen"))
        assertEquals(date.toString(),routed.getStringExtra("date"))
        assertTrue(activity.isFinishing)
    }
    @Test fun savedLegacyTimelineDateRedirectsWithoutReopeningPreciseScreen() {
        val saved=Bundle().apply{putString("date",date.minusDays(2).toString());putString("zoom","HOUR")}
        controller=Robolectric.buildActivity(TimelineActivity::class.java,TimelineActivity.intent(context,date)).create(saved)
        val routed=shadowOf(controller!!.get()).nextStartedActivity
        assertNotNull(routed)
        assertEquals(date.minusDays(2).toString(),routed.getStringExtra("date"))
    }
    @Test fun remainingTimeUsesConnectedRestorationAndKeepsStaleUnknown() {
        val first = Outage(Category.SCHEDULE, now.minusSeconds(60), now.plusSeconds(600), false, "", "")
        val second = first.copy(category = Category.EMERGENCY, start = first.end!!, end = now.plusSeconds(901), plannedEnd = true)
        assertEquals("До ввімкнення залишилося ≈ 16 хв", Presentation.remainingTime(complete(listOf(first, second)), now))
        assertEquals("Час увімкнення невідомий", Presentation.remainingTime(complete(listOf(first.copy(end = null))), now))
        assertEquals("Оновіть графік — залишок часу невідомий", Presentation.remainingTime(complete(listOf(first)).copy(failures = setOf(Category.EMERGENCY)), now))
    }

    private fun open(): TimelineActivity {
        controller = Robolectric.buildActivity(TimelineActivity::class.java, TimelineActivity.intent(context, date)).create().start().resume().visible()
        return controller!!.get()
    }
    private fun complete(events: List<Outage>) = Snapshot(Category.entries.associateWith { category ->
        CategorySnapshot(category, now, now, events.filter { it.category == category }, testQueue(category))
    })
    private fun exact(size: Int) = View.MeasureSpec.makeMeasureSpec(size, View.MeasureSpec.EXACTLY)
    private fun descendants(view: View): List<View> = listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { descendants(view.getChildAt(it)) } else emptyList()
}
