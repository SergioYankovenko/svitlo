package ua.svitlo.widget

import android.app.Application
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.drawable.BitmapDrawable
import android.os.Bundle
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.util.Xml
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.RemoteViews
import android.widget.TextView
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.LooperMode
import org.xmlpull.v1.XmlPullParser
import ua.svitlo.widget.core.KYIV_ZONE
import ua.svitlo.widget.core.Category
import java.time.Instant
import java.time.format.DateTimeFormatter
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], qualifiers = "mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@LooperMode(LooperMode.Mode.PAUSED)
class WidgetRenderTest {
    private lateinit var context: Application

    @Before fun clearPrivateState() {
        context = RuntimeEnvironment.getApplication()
        listOf("svitlo_private", "svitlo_weather", "svitlo_runtime", "svitlo_official", "svitlo_profiles").forEach {
            context.getSharedPreferences(it, Context.MODE_PRIVATE).edit().clear().commit()
        }
    }

    @Test fun compactNormalDesignFitsPhoneWidthsAndUsesPortraitMaximumHeight() {
        seedConfirmedAddress()
        for (width in listOf(250, 320)) {
            val root = applyWidget(compact = true, width = width, height = 184, minimumHeight = 100)
            assertChartFits(root, R.id.widget_chart, minimumHeight = 40)
            assertFooterFits(root)
            assertSingleHeader(root)
            assertEquals(View.GONE, root.findViewById<View>(R.id.weather_next).visibility)
            assertNull(root.findViewById<View>(R.id.widget_tomorrow))
        }
    }





    @Test fun tallWidgetsUseTheirChartAreaWithoutEnlargingHeaderOrChartText() {
        seedConfirmedAddress()
        try {
            for (landscape in listOf(false, true)) {
                RuntimeEnvironment.setQualifiers(if (landscape) "land-mdpi" else "port-mdpi")
                for (font in listOf(1f, 1.5f, 2f)) {
                    RuntimeEnvironment.setFontScale(font)
                    for (compact in listOf(true)) for (height in listOf(400, 640, 800)) {
                        val root = applyWidget(compact, 320, height)
                        assertSingleHeader(root)
                        assertFooterFits(root)
                        visibleText(root).forEach { assertTextFits(root, it) }
                        val ids = if (compact) listOf(R.id.widget_chart) else listOf(R.id.widget_chart, R.id.widget_tomorrow)
                        for (id in ids) {
                            assertChartFits(root, id, 100)
                            val chart = root.findViewById<ImageView>(id)
                            val bitmap = (chart.drawable as BitmapDrawable).bitmap
                            val bandRows = (0 until bitmap.height).filter { y ->
                                // The band is opaque, including uncertainty hatching;
                                // surrounding title/axis rows remain mostly transparent.
                                (1..10).count { x -> android.graphics.Color.alpha(bitmap.getPixel(x * bitmap.width / 11, y)) >= 250 } >= 6
                            }
                            assertTrue("Tall widget chart must have a substantial visible band, not a tiny bitmap: " +
                                "widget=320x$height compact=$compact font=$font bandRows=${bandRows.size} bitmap=${bitmap.width}x${bitmap.height}",
                                bandRows.size >= bitmap.height * 0.55)
                            val titleRows = (0 until bandRows.first()).filter { y ->
                                (0 until bitmap.width).any { x -> android.graphics.Color.alpha(bitmap.getPixel(x, y)) > 100 }
                            }
                            assertTrue(titleRows.isNotEmpty())
                            val titleHeightOnScreen = (titleRows.last() - titleRows.first() + 1f) * chart.height / bitmap.height
                            assertTrue("Chart title must stay compact when the band grows: $titleHeightOnScreen px", titleHeightOnScreen <= 18f)
                        }
                    }
                }
            }
        } finally { RuntimeEnvironment.setFontScale(1f); RuntimeEnvironment.setQualifiers("port-mdpi") }
    }



    @Test fun compactFitsActualTwoRowMinimumWithVisibleTimelineAndRefresh() {
        seedConfirmedAddress()
        for (width in listOf(250, 320)) {
            val root = applyWidget(compact = true, width = width, height = 100)
            assertChartFits(root, R.id.widget_chart, minimumHeight = 30)
            assertFooterFits(root)
            assertEquals(View.GONE, root.findViewById<View>(R.id.widget_headline).visibility)
            assertEquals(View.GONE, root.findViewById<View>(R.id.widget_city).visibility)
            assertEquals(View.VISIBLE, root.findViewById<View>(R.id.weather_now).visibility)
        }
        assertEquals(100, declaredHeight(compact = true))
    }



    @Test fun tinyLayoutsKeepRefreshInstructionInTheSingleHeaderWhenDataIsStale() {
        seedConfirmedAddress(sourceAgeSeconds = 10_800)
        for (compact in listOf(true)) {
            val root = applyWidget(compact, 250, if (compact) 100 else 150)
            assertEquals("ϟ 3.2 · Оновіть графік", root.findViewById<TextView>(R.id.widget_title).text.toString())
            assertSingleHeader(root)
            assertSignalColor(root, Palette.app().muted)
        }
    }

    @Test @Config(qualifiers = "land-mdpi")
    fun landscapeUsesMinimumHeightInsteadOfPortraitMaximum() {
        seedConfirmedAddress()
        val root = applyWidget(compact = true, width = 320, height = 100, maximumHeight = 184)
        assertEquals(View.GONE, root.findViewById<View>(R.id.widget_headline).visibility)
        assertChartFits(root, R.id.widget_chart, minimumHeight = 30)
        assertFooterFits(root)
    }

    @Test fun bothWidgetsRouteHomeWeatherAndRefreshToDistinctActionsWithoutBinding() {
        for (compact in listOf(true)) {
            val root = applyWidget(compact, 320, declaredHeight(compact))
            assertTrue(root.performClick())
            val home = shadowOf(context).nextStartedActivity
            assertEquals(MainActivity::class.java.name, home.component?.className)
            assertEquals("home", home.getStringExtra("screen"))
            assertEquals(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP,
                home.flags and (Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))

            assertTrue(root.findViewById<View>(R.id.widget_weather).performClick())
            val forecast = shadowOf(context).nextStartedActivity
            assertEquals(MainActivity::class.java.name, forecast.component?.className)
            assertEquals("weather", forecast.getStringExtra("screen"))
            assertEquals(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP,
                forecast.flags and (Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))

            assertTrue(root.findViewById<View>(R.id.widget_refresh).performClick())
            val refresh = shadowOf(context).broadcastIntents.last { it.action == WidgetRenderer.REFRESH }
            assertEquals(SvitloWidget::class.java.name, refresh.component?.className)
            assertNull(OutageRepository(context).binding())
        }
    }

    @Test fun portraitFontAndPhoneWidthMatrixKeepsContentInsideBothWidgetSizes() {
        assertPhoneMatrix(landscape = false)
    }

    @Test fun landscapeFontAndPhoneWidthMatrixKeepsContentInsideBothWidgetSizes() {
        assertPhoneMatrix(landscape = true)
    }

    @Test fun oneRemoteViewsObjectSelectsCorrectLayoutWhenLauncherRotatesWithoutRerender() {
        seedConfirmedAddress()
        val manager = AppWidgetManager.getInstance(context)
        val id = 103
        shadowOf(manager).bindAppWidgetId(id, ComponentName(context, CompactWidget::class.java))
        manager.updateAppWidgetOptions(id, Bundle().apply {
            putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 320)
            putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, 443)
            putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 100)
            putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 184)
        })
        val views = WidgetRenderer.render(context, id, compact = true)
        val portrait = applyViews(views, 320, 184)
        assertSingleHeader(portrait)
        assertEquals(View.GONE, portrait.findViewById<View>(R.id.weather_next).visibility)
        assertEquals(View.VISIBLE, portrait.findViewById<View>(R.id.widget_legend).visibility)
        assertChartFits(portrait, R.id.widget_chart, 40)
        try {
            RuntimeEnvironment.setQualifiers("land-mdpi")
            val landscape = applyViews(views, 443, 100)
            assertSingleHeader(landscape)
            assertEquals(View.GONE, landscape.findViewById<View>(R.id.weather_next).visibility)
            assertEquals(View.VISIBLE, landscape.findViewById<View>(R.id.widget_legend).visibility)
            assertChartFits(landscape, R.id.widget_chart, 30)
            assertFooterFits(landscape)
        } finally {
            RuntimeEnvironment.setQualifiers("port-mdpi")
        }
        val portraitAgain = applyViews(views, 320, 184)
        assertSingleHeader(portraitAgain)
        assertEquals(View.GONE, portraitAgain.findViewById<View>(R.id.weather_next).visibility)
        assertEquals(View.VISIBLE, portraitAgain.findViewById<View>(R.id.widget_legend).visibility)
        assertChartFits(portraitAgain, R.id.widget_chart, 40)
    }

    @Test fun currentPlannedIntervalUsesHumanRestorationAndKeepsCachedTimesAccessibleWhenStale() {
        assertPlannedIntervalFits(upcoming = false)
    }

    @Test fun nextPlannedIntervalUsesHumanCountdownAndKeepsCachedTimesAccessibleWhenStale() {
        assertPlannedIntervalFits(upcoming = true)
    }

    private fun assertPlannedIntervalFits(upcoming: Boolean) {
        val now = Instant.parse("2026-10-23T08:20:00Z")
        val start = now.plusSeconds(if (upcoming) 3_600 else -3_600)
        val end = now.plusSeconds(if (upcoming) 7_200 else 3_600)
        val clock = DateTimeFormatter.ofPattern("HH:mm").withZone(KYIV_ZONE)
        try {
            for (stale in listOf(false, true)) for (fontScale in listOf(1f, 1.5f)) {
                seedEvent(Category.PLANNED, start, end, plannedEnd = true, sourceAgeSeconds = if (stale) 10_800 else 0)
                seedMatrixWeather(forecast = true)
                RuntimeEnvironment.setFontScale(fontScale)
                for (compact in listOf(true)) {
                    // Intermediate heights and enlarged fonts must retain the same
                    // human status without bringing back the removed second line.
                    for (height in if (compact) listOf(100, 160) else listOf(150, 240)) {
                        val root = applyWidget(compact, 320, height)
                        val title = root.findViewById<TextView>(R.id.widget_title)
                        assertSingleHeader(root)
                        if (stale) {
                            assertEquals("ϟ 3.2 · Оновіть графік", title.text.toString())
                            assertSignalColor(root, Palette.app().muted)
                        } else {
                            if (upcoming) {
                                val sameDay = start.atZone(KYIV_ZONE).toLocalDate() == now.atZone(KYIV_ZONE).toLocalDate()
                                assertTrue("Future outage needs a human countdown or explicit next day",
                                    title.text.contains(if (sameDay) "Відключення через " else "Відключення завтра о "))
                            } else {
                                assertTrue("A planned restoration must stay visibly approximate", title.text.startsWith("ϟ 3.2 · До відновлення ≈ "))
                                assertTrue(title.text.contains("До відновлення"))
                            }
                            assertSignalColor(root, Palette.app().hourly)
                        }
                        assertTrue("Cached exact start remains accessible", title.contentDescription.contains(clock.format(start)))
                        assertTrue("Cached exact end remains accessible", title.contentDescription.contains(clock.format(end)))
                        assertTextFits(root, title)
                        assertChartFits(root, R.id.widget_chart, if (compact) 30 else 35)
                        if (!compact) assertChartFits(root, R.id.widget_tomorrow, 35)
                    }
                }
            }
        } finally {
            RuntimeEnvironment.setFontScale(1f)
        }
    }

    @Test fun freshEmptyDayKeepsUnknownSignalInsteadOfFalsePower() {
        seedConfirmedAddress()
        for (compact in listOf(true)) {
            val root = applyWidget(compact, 320, if (compact) 184 else 260)
            assertEquals("ϟ 3.2 · Стан світла невідомий", root.findViewById<TextView>(R.id.widget_title).text.toString())
            assertSignalColor(root, Palette.app().muted)
        }
    }

    @Test fun publishedPastTodayEventUsesGreenOnlyWhenThereIsNoCurrentOrNextOutage() {
        val now = Instant.parse("2026-10-23T08:20:00Z")
        val today = now.atZone(KYIV_ZONE).toLocalDate().atStartOfDay(KYIV_ZONE).toInstant()
        // The official source has minute precision; a completed interval within
        // today cannot exist until the first full local minute has passed.
        org.junit.Assume.assumeTrue(now >= today.plusSeconds(60))
        seedEvent(Category.SCHEDULE, today, today.plusSeconds(60))
        for (compact in listOf(true)) {
            val root = applyWidget(compact, 320, if (compact) 184 else 260)
            assertEquals("ϟ 3.2 · Є світло за графіком", root.findViewById<TextView>(R.id.widget_title).text.toString())
            assertSignalColor(root, Palette.app().accent)
        }
    }

    @Test fun plannedAndHourlyOutagesColorOnlyLightningYellow() {
        val now = Instant.parse("2026-10-23T08:20:00Z")
        for (category in listOf(Category.PLANNED, Category.SCHEDULE)) {
            seedEvent(category, now.minusSeconds(3_600), now.plusSeconds(3_600))
            for (compact in listOf(true)) {
                val root = applyWidget(compact, 320, if (compact) 184 else 260)
                assertTrue(root.findViewById<TextView>(R.id.widget_title).text.contains("До відновлення "))
                assertSignalColor(root, Palette.app().hourly)
            }
        }
    }

    @Test fun activeAndUpcomingEmergencyHeadersColorOnlyLightningRed() {
        val now = Instant.parse("2026-10-23T08:20:00Z")
        for (upcoming in listOf(false, true)) {
            seedEvent(Category.EMERGENCY, now.plusSeconds(if (upcoming) 3_600 else -3_600), now.plusSeconds(7_200))
            for (compact in listOf(true)) {
                val root = applyWidget(compact, 320, if (compact) 184 else 260)
                val title = root.findViewById<TextView>(R.id.widget_title)
                assertTrue(title.text.contains(if (upcoming) "Відключення " else "До відновлення "))
                assertSignalColor(root, Palette.app().emergency)
            }
        }
    }

    @Suppress("DEPRECATION") // SDK 28 scales native text through scaledDensity.
    private fun assertPhoneMatrix(landscape: Boolean) {
        val failures = mutableListOf<String>()
        try {
            RuntimeEnvironment.setQualifiers(if (landscape) "land-mdpi" else "port-mdpi")
            for (fontScale in listOf(1f, 1.3f, 1.5f, 2f)) {
                RuntimeEnvironment.setFontScale(fontScale)
                assertEquals(fontScale, context.resources.configuration.fontScale, 0.001f)
                assertEquals("Native text must use the requested font scaling", fontScale,
                    context.resources.displayMetrics.scaledDensity / context.resources.displayMetrics.density, 0.001f)
                for (width in listOf(320, 393, 443)) for (compact in listOf(true)) {
                    val normal = if (compact) 184 else 260
                    val minimum = if (compact) 100 else 150
                    for (height in listOf(minimum, normal)) for (forecast in listOf(false, true)) {
                        seedConfirmedAddress(sourceAgeSeconds = if (forecast) 0 else 10_800)
                        seedMatrixWeather(forecast)
                        val root = applyWidget(compact, width, height,
                            minimumHeight = if (landscape) height else minimum,
                            maximumHeight = if (landscape) normal else height)
                        val label = "${if (landscape) "land" else "port"} font=$fontScale " +
                            "${if (compact) "compact" else "detailed"} ${width}x$height forecast=$forecast"
                        fun check(block: () -> Unit) {
                            try { block() } catch (failure: AssertionError) {
                                failures += "$label: ${failure.message}"
                            }
                        }
                        check { assertChartFits(root, R.id.widget_chart, if (compact) 30 else 35) }
                        if (!compact) check { assertChartFits(root, R.id.widget_tomorrow, 35) }
                        check { assertFooterFits(root) }
                        check { assertLegendBesideRefresh(root) }
                        check { assertEssentialControlsAndMeaning(root, stale = !forecast) }
                        visibleText(root).forEach { text -> check { assertTextFits(root, text) } }
                    }
                }
            }
        } finally {
            RuntimeEnvironment.setFontScale(1f)
            RuntimeEnvironment.setQualifiers("port-mdpi")
        }
        assertTrue("RemoteViews font/width matrix failures:\n${failures.joinToString("\n")}", failures.isEmpty())
    }

    private fun seedMatrixWeather(forecast: Boolean) {
        context.getSharedPreferences("svitlo_weather", Context.MODE_PRIVATE).edit().clear().commit()
        if (!forecast) return
        val now = Instant.parse("2026-10-23T08:20:00Z")
        val json = JSONObject(weatherFixture(now))
        json.getJSONObject("current").put("temperature_2m", -12.4)
        val repository = WeatherRepository(context, object : WeatherSource {
            override fun search(city: String, region: String) = "{}"
            override fun fetch(location: WeatherLocation) = json.toString()
        }) { now }
        repository.bindLocation(WeatherLocation("Тестове місто", "Тестова область", 49.0, 31.0),addressBased=true)
        assertTrue(repository.refresh())
    }

    private fun assertLegendBesideRefresh(root: ViewGroup) {
        val legendView = root.findViewById<View>(R.id.widget_legend)
        if (legendView.visibility == View.GONE) return
        val legend = bounds(root, legendView)
        val refresh = bounds(root, root.findViewById(R.id.widget_refresh))
        assertTrue("Legend must stay left of refresh, without overlap: legend=$legend refresh=$refresh", legend.right <= refresh.left)
        assertTrue("Legend and refresh must share a row: legend=$legend refresh=$refresh",
            legend.top < refresh.bottom && refresh.top < legend.bottom)
    }

    private fun assertEssentialControlsAndMeaning(root: ViewGroup, stale: Boolean) {
        for (id in listOf(R.id.weather_now, R.id.widget_title, R.id.widget_refresh)) {
            val view = root.findViewById<TextView>(id)
            assertEquals("Essential control must stay visible: ${context.resources.getResourceEntryName(id)}", View.VISIBLE, view.visibility)
            assertFalse(view.text.isNullOrBlank())
        }
        assertSingleHeader(root)
        val title = root.findViewById<TextView>(R.id.widget_title)
        assertTrue("The short state must not imply a guarantee of electricity",
            title.contentDescription.toString().contains("не гарантує"))
        val refresh = root.findViewById<TextView>(R.id.widget_refresh)
        assertTrue("Icon-only refresh needs an understandable accessible action",
            refresh.contentDescription.toString().contains("Оновити"))
        if (stale) {
            assertEquals("Stale data must request a refresh in the visible header",
                "ϟ 3.2 · Оновіть графік", title.text.toString())
        } else {
            assertEquals("An empty day cannot claim that electricity is available",
                "ϟ 3.2 · Стан світла невідомий", title.text.toString())
        }
        assertSignalColor(root, Palette.app().muted)
    }

    private fun assertSingleHeader(root: ViewGroup) {
        val title = root.findViewById<TextView>(R.id.widget_title)
        assertEquals(View.VISIBLE, title.visibility)
        assertTrue("Queue and status must share the same header: ${title.text}",
            title.text.startsWith("ϟ 3.2 · "))
        assertFalse(title.text.contains('\n'))
        assertEquals("Header must stay on one line", 1, title.maxLines)
        assertEquals("Measured header must stay on one line", 1, title.layout.lineCount)
        for (id in listOf(R.id.widget_city, R.id.widget_headline, R.id.widget_range, R.id.widget_kind)) {
            assertEquals("No separate address/status/interval line: ${context.resources.getResourceEntryName(id)}",
                View.GONE, root.findViewById<View>(id).visibility)
        }
        val density = context.resources.displayMetrics.density
        assertEquals("Keep generous left inset", (16 * density).toInt(), root.paddingLeft)
        assertEquals("Keep generous right inset", (16 * density).toInt(), root.paddingRight)
        val weather = root.findViewById<View>(R.id.widget_weather)
        assertEquals("Weather keeps its compact fixed column", (68 * density).toInt(), weather.width)
        val headerBounds = bounds(root, title)
        val weatherBounds = bounds(root, weather)
        assertTrue("Status must not overlap weather", headerBounds.right <= weatherBounds.left)
        assertTrue("Header must respect the left inset", headerBounds.left >= root.paddingLeft)
        assertTrue("Weather must respect the right inset", weatherBounds.right <= root.width - root.paddingRight)
        val compact = root.findViewById<View>(R.id.widget_tomorrow) == null
        val dense = root.height < (if (compact) 140 else 210) * density
        assertTrue("Header remains smaller even with large system fonts", title.textSize <= (if (dense) 14f else 16f) * density + 0.1f)
    }

    private fun assertSignalColor(root: ViewGroup, expectedColor: Int) {
        val text = root.findViewById<TextView>(R.id.widget_title).text
        assertTrue("Header needs a colored lightning span", text is Spanned)
        val spanned = text as Spanned
        val spans = spanned.getSpans(0, spanned.length, ForegroundColorSpan::class.java)
        assertEquals("Only the lightning glyph receives the signal color", 1, spans.size)
        assertEquals(expectedColor, spans.single().foregroundColor)
        assertEquals(0, spanned.getSpanStart(spans.single()))
        assertEquals(1, spanned.getSpanEnd(spans.single()))
        assertEquals('ϟ', spanned[0])
    }

    private fun assertTextFits(root: ViewGroup, text: TextView) {
        if (text.text.isNullOrEmpty()) return
        val name = context.resources.getResourceEntryName(text.id)
        val bounds = bounds(root, text)
        val layout = text.layout
        val detail = "$name text='${text.text}' bounds=$bounds textSize=${text.textSize} " +
            "lines=${layout?.lineCount} layoutHeight=${layout?.height} padding=${text.compoundPaddingTop + text.compoundPaddingBottom}"
        assertTrue("Text view outside widget: $detail", bounds.left >= 0 && bounds.top >= 0 &&
            bounds.right <= root.width && bounds.bottom <= root.height)
        assertNotNull("Text needs a measured native layout: $detail", layout)
        val contentHeight = text.height - text.compoundPaddingTop - text.compoundPaddingBottom
        assertTrue("Text clipped vertically: $detail available=$contentHeight", layout.height <= contentHeight)
        assertTrue("Text lines hidden by maxLines: $detail maxLines=${text.maxLines}",
            text.maxLines < 0 || layout.lineCount <= text.maxLines)
        val metrics = text.paint.fontMetricsInt
        assertTrue("Font glyph height cannot fit: $detail", metrics.descent - metrics.ascent <= contentHeight)
        val mustBeComplete = text.id in setOf(R.id.weather_now, R.id.weather_next, R.id.widget_title,
            R.id.widget_legend, R.id.widget_refresh)
        for (line in 0 until layout.lineCount) {
            assertTrue("Text extends horizontally outside layout: $detail line=$line " +
                "left=${layout.getLineLeft(line)} right=${layout.getLineRight(line)} width=${layout.width}",
                layout.getLineLeft(line) >= -0.5f && layout.getLineRight(line) <= layout.width + 0.5f)
            if (mustBeComplete) assertEquals("Essential text was ellipsized: $detail", 0, layout.getEllipsisCount(line))
        }
    }

    private fun visibleText(view: View): List<TextView> {
        if (view.visibility != View.VISIBLE) return emptyList()
        if (view is TextView) return listOf(view)
        return if (view is ViewGroup) (0 until view.childCount).flatMap { visibleText(view.getChildAt(it)) } else emptyList()
    }

    private fun bounds(root: ViewGroup, view: View): Rect = Rect().also {
        view.getDrawingRect(it)
        root.offsetDescendantRectToMyCoords(view, it)
    }

    private fun seedConfirmedAddress(sourceAgeSeconds: Long = 0) {
        val timestamp = Instant.parse("2026-10-23T08:20:00Z").minusSeconds(sourceAgeSeconds).atZone(KYIV_ZONE).format(DateTimeFormatter.ofPattern("HH:mm dd.MM.uuuu"))
        val response = """{"DATETIME":"$timestamp","DISCONNECTIONS":[],"DISCONN_QUEUQ":[{"QUEUE_INFO":"Графік погодинних відключень - 3 черга 2 підчерга"}]}"""
        val repository = OutageRepository(context, OutageSource { _, _, _, _ -> response }) { Instant.parse("2026-10-23T08:20:00Z").minusSeconds(sourceAgeSeconds) }
        val account = "12345678901"
        assertTrue(repository.bindConfirmed(account, "м. Приклад, вул. Тестова, 1", repository.prepare(account), "м. Приклад"))
        assertTrue(OfficialScheduleRepository(context,OfficialFeedSource{emptyList()}){Instant.parse("2026-10-23T08:20:00Z")}.refresh())
    }

    private fun seedEvent(category: Category, start: Instant, end: Instant,
        plannedEnd: Boolean = false, sourceAgeSeconds: Long = 0) {
        val format = DateTimeFormatter.ofPattern("HH:mm dd.MM.uuuu").withZone(KYIV_ZONE)
        val updated = format.format(Instant.parse("2026-10-23T08:20:00Z").minusSeconds(sourceAgeSeconds))
        val event = JSONObject().put("DATE_START", format.format(start)).put("DATE_STOP", format.format(end))
            .put("DATE_TIME", format.format(end) + if (plannedEnd) " (планово)" else "")
            .put("STATE_CHAR", "У роботі").put("DISCONN_TYPE", "Тестове відключення")
        val repository = OutageRepository(context, OutageSource { _, requested, _, _ ->
            JSONObject().put("DATETIME", updated)
                .put("DISCONNECTIONS", if (requested == category) JSONArray().put(event) else JSONArray())
                .put("DISCONN_QUEUQ", JSONArray().put(JSONObject()
                    .put("QUEUE_INFO", "Графік погодинних відключень - 3 черга 2 підчерга")))
                .toString()
        }) { Instant.parse("2026-10-23T08:20:00Z").minusSeconds(sourceAgeSeconds) }
        val account = "12345678901"
        assertTrue(repository.bindConfirmed(account, "Тестова адреса", repository.prepare(account), "Тестове місто"))
        assertTrue(OfficialScheduleRepository(context,OfficialFeedSource{emptyList()}){Instant.parse("2026-10-23T08:20:00Z")}.refresh())
    }

    private fun applyWidget(compact: Boolean, width: Int, height: Int, minimumHeight: Int = height, maximumHeight: Int = height): ViewGroup {
        val id = if (compact) 101 else 102
        val manager = AppWidgetManager.getInstance(context)
        shadowOf(manager).bindAppWidgetId(id, ComponentName(context, if (compact) CompactWidget::class.java else SvitloWidget::class.java))
        manager.updateAppWidgetOptions(id, Bundle().apply {
            putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, width)
            putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, width)
            putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, minimumHeight)
            putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, maximumHeight)
        })
        return applyViews(WidgetRenderer.render(context, id, compact,Instant.parse("2026-10-23T08:20:00Z")), width, height)
    }

    private fun applyViews(views: RemoteViews, width: Int, height: Int): ViewGroup {
        val view = views.apply(context, FrameLayout(context)) as ViewGroup
        view.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY))
        view.layout(0, 0, width, height)
        return view
    }

    private fun declaredHeight(compact: Boolean): Int {
        context.resources.getXml(if (compact) R.xml.compact_widget else R.xml.svitlo_widget).use { parser ->
            while (parser.eventType != XmlPullParser.START_TAG && parser.eventType != XmlPullParser.END_DOCUMENT) parser.next()
            check(parser.eventType == XmlPullParser.START_TAG) { "Widget provider metadata must have a root element" }
            val attributes = context.obtainStyledAttributes(Xml.asAttributeSet(parser), intArrayOf(android.R.attr.minHeight))
            return try { attributes.getDimensionPixelSize(0, 0) } finally { attributes.recycle() }
        }
    }

    private fun assertChartFits(root: ViewGroup, id: Int, minimumHeight: Int) {
        val chart = root.findViewById<ImageView>(id)
        assertNotNull("Chart bitmap must be supplied by RemoteViews", chart.drawable)
        assertEquals("Charts must retain their aspect ratio", ImageView.ScaleType.FIT_CENTER, chart.scaleType)
        assertTrue("Chart ${context.resources.getResourceEntryName(id)} at ${root.width}×${root.height} " +
            "has height ${chart.height}, below $minimumHeight; density=${context.resources.displayMetrics.density}; " +
            describe(root), chart.height >= minimumHeight)
        val bounds = Rect()
        chart.getDrawingRect(bounds)
        root.offsetDescendantRectToMyCoords(chart, bounds)
        assertTrue("Chart must remain inside widget", bounds.top >= 0 && bounds.bottom <= root.height)
        val drawable = chart.drawable
        val drawn = RectF(0f, 0f, drawable.intrinsicWidth.toFloat(), drawable.intrinsicHeight.toFloat())
        chart.imageMatrix.mapRect(drawn)
        assertTrue("Bitmap must fill the allocated chart width without stretching: drawn=$drawn view=${chart.width}x${chart.height}",
            kotlin.math.abs(drawn.width() - chart.width) <= 2f)
        assertTrue("Bitmap must fill the allocated chart height without letterboxing: drawn=$drawn view=${chart.width}x${chart.height}",
            kotlin.math.abs(drawn.height() - chart.height) <= 2f)
    }

    private fun assertFooterFits(root: ViewGroup) {
        val refresh = root.findViewById<View>(R.id.widget_refresh)
        val bounds = Rect()
        refresh.getDrawingRect(bounds)
        root.offsetDescendantRectToMyCoords(refresh, bounds)
        assertTrue("Refresh control must remain visible at ${root.width}×${root.height}: $bounds",
            bounds.top >= 0 && bounds.bottom <= root.height && bounds.right <= root.width)
        assertTrue(refresh.height > 0)
    }

    private fun describe(root: ViewGroup): String = (0 until root.childCount).joinToString("; ") { index ->
        val view = root.getChildAt(index)
        "${view.javaClass.simpleName}[${view.id}]=${view.measuredWidth}×${view.measuredHeight}, y=${view.top}"
    }
}
