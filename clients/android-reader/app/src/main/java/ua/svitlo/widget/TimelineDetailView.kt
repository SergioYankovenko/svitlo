package ua.svitlo.widget

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import ua.svitlo.widget.core.*
import java.time.Instant
import java.time.LocalDate
import kotlin.math.abs
import kotlin.math.roundToLong

/** A bounded, exact-time chart. The adjacent native controls provide alternatives to gestures. */
class TimelineDetailView(context: Context) : View(context) {
    var viewport = TimelineViewport(LocalDate.now(KYIV_ZONE))
        private set
    var onViewportChanged: ((TimelineViewport) -> Unit)? = null
    private var snapshot = Snapshot(emptyMap())
    private var now = Instant.now()
    private val palette = Palette.of(context)
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val density = resources.displayMetrics.density
    val plotLeft: Float get() = 12 * density
    val plotRight: Float get() = (width - 12 * density).coerceAtLeast(plotLeft + 1)
    private var downX = 0f
    private var downY = 0f
    private var downViewport = viewport
    private var dragging = false
    private val slop = ViewConfiguration.get(context).scaledTouchSlop

    init {
        isFocusable = true
        isClickable = true
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
        setBackgroundColor(palette.surface)
    }

    fun setViewport(value: TimelineViewport) {
        viewport = value
        updateDescription()
        invalidate()
        onViewportChanged?.invoke(value)
    }

    fun setData(value: Snapshot, at: Instant) {
        snapshot = value
        now = at
        updateDescription()
        invalidate()
    }

    private fun updateDescription() {
        val events = TimelineViewport.eventsAt(snapshot, viewport.selectedAt)
        contentDescription = "Графік, масштаб ${viewport.zoom.label}. Вибрано ${TimelineViewport.describeTime(viewport.selectedAt)}. " +
            if (events.isEmpty()) "У цей час немає опублікованого інтервалу." else events.joinToString { it.category.label }
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        setMeasuredDimension(resolveSize((320 * density).toInt(), widthMeasureSpec),
            resolveSize((176 * density).toInt(), heightMeasureSpec))
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val left = plotLeft
        val right = plotRight
        val top = 43 * density
        val bottom = 100 * density
        fun x(at: Instant) = left + viewport.fractionAt(at).toFloat() * (right - left)
        paint.typeface = Typeface.DEFAULT
        paint.textSize = 12 * density
        paint.color = palette.muted
        paint.textAlign = Paint.Align.LEFT
        val endLabel = if (viewport.end == viewport.dayEnd) "24:00" else Presentation.time(viewport.end)
        canvas.drawText("${Presentation.time(viewport.start)} — $endLabel · ${viewport.zoom.label}", left, 23 * density, paint)
        for (segment in viewport.segments(snapshot, now)) {
            val a = x(segment.start)
            val b = x(segment.end)
            paint.color = palette.outage(segment.category,segment.kind)
            canvas.drawRect(a, top, b, bottom, paint)
            if (segment.uncertain) {
                val save = canvas.save()
                canvas.clipRect(a, top, b, bottom)
                paint.color = palette.muted
                paint.alpha = 90
                paint.strokeWidth = density
                var hatch = a - (bottom - top)
                while (hatch < b) {
                    canvas.drawLine(hatch, bottom, hatch + bottom - top, top, paint)
                    hatch += 9 * density
                }
                paint.alpha = 255
                canvas.restoreToCount(save)
            }
        }
        var labelEnd = left - 8 * density
        for (tick in viewport.ticks()) {
            val at = x(tick.at)
            paint.color = palette.muted
            paint.strokeWidth = density
            paint.alpha = if (tick.major) 150 else 65
            canvas.drawLine(at, top, at, bottom + if (tick.major) 8 * density else 4 * density, paint)
            paint.alpha = 255
            val label = tick.label ?: continue
            val size = paint.measureText(label)
            val labelStart = (at - size / 2).coerceIn(left, (right - size).coerceAtLeast(left))
            if (labelStart >= labelEnd + 5 * density) {
                canvas.drawText(label, labelStart, 130 * density, paint)
                labelEnd = labelStart + size
            }
        }
        if (now >= viewport.start && now <= viewport.end) {
            paint.color = palette.accent
            paint.strokeWidth = 2 * density
            canvas.drawLine(x(now), top - 7 * density, x(now), bottom + 3 * density, paint)
        }
        if (viewport.selectedAt >= viewport.start && viewport.selectedAt <= viewport.end) {
            val cursor = x(viewport.selectedAt)
            paint.color = palette.ink
            paint.strokeWidth = 2 * density
            canvas.drawLine(cursor, top - 12 * density, cursor, bottom + 12 * density, paint)
            canvas.drawCircle(cursor, top - 12 * density, 4 * density, paint)
        }
        paint.color = palette.muted
        canvas.drawText("Торкніться часу · проведіть для зсуву", left, 157 * density, paint)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = event.x; downY = event.y; downViewport = viewport; dragging = false
                parent?.requestDisallowInterceptTouchEvent(true)
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                if (!dragging && abs(event.y - downY) > slop && abs(event.y - downY) > abs(event.x - downX)) {
                    parent?.requestDisallowInterceptTouchEvent(false)
                }
                if (abs(event.x - downX) > slop) dragging = true
                if (dragging) setViewport(downViewport.pan(-(event.x - downX).toDouble() / (plotRight - plotLeft)))
                return true
            }
            MotionEvent.ACTION_UP -> {
                parent?.requestDisallowInterceptTouchEvent(false)
                if (!dragging) {
                    val at = viewport.instantAt(((event.x - plotLeft) / (plotRight - plotLeft)).toDouble())
                    val minute = Instant.ofEpochMilli((at.toEpochMilli() / 60_000.0).roundToLong() * 60_000)
                    setViewport(viewport.select(minute.coerceIn(viewport.start, viewport.end)))
                    performClick()
                }
                return true
            }
            MotionEvent.ACTION_CANCEL -> { parent?.requestDisallowInterceptTouchEvent(false); return true }
        }
        return super.onTouchEvent(event)
    }

    override fun performClick(): Boolean { super.performClick(); return true }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_DPAD_LEFT || keyCode == KeyEvent.KEYCODE_DPAD_RIGHT) {
            setViewport(viewport.select(viewport.selectedAt.plusSeconds(if (keyCode == KeyEvent.KEYCODE_DPAD_LEFT) -300 else 300)))
            return true
        }
        return super.onKeyDown(keyCode, event)
    }
}
