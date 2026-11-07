package ua.svitlo.widget

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.view.View
import kotlin.math.cos
import kotlin.math.sin

/** Decorative vectors stay crisp without depending on a device's emoji font. */
internal class SummaryIconView(context: Context, private val sun: Boolean, color: Int): View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        this.color = color
        style = Paint.Style.STROKE
        strokeWidth = resources.displayMetrics.density * 1.6f
        strokeCap = Paint.Cap.ROUND
    }

    init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val cx = width / 2f; val cy = height / 2f
        val unit = minOf(width, height) / 28f
        if (sun) {
            canvas.drawCircle(cx, cy, 4f * unit, paint)
            repeat(8) { index ->
                val angle = index * Math.PI / 4
                val x = cos(angle).toFloat(); val y = sin(angle).toFloat()
                canvas.drawLine(cx + x * 7f * unit, cy + y * 7f * unit,
                    cx + x * 9f * unit, cy + y * 9f * unit, paint)
            }
        } else {
            canvas.drawCircle(cx, cy, 8f * unit, paint)
            canvas.drawLine(cx, cy, cx, cy - 4f * unit, paint)
            canvas.drawLine(cx, cy, cx + 3f * unit, cy + 2f * unit, paint)
        }
    }
}
