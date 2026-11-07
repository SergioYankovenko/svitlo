package ua.svitlo.widget

import android.graphics.text.LineBreaker
import android.content.Context
import android.text.Layout
import android.text.TextPaint
import android.util.TypedValue
import android.widget.LinearLayout
import android.widget.TextView

/** Body text keeps the user's font scale. Rows fit labels within readable bounds. */
internal object TextSizing {
    fun singleLine(view: TextView, maximum: Int, unit: Int = TypedValue.COMPLEX_UNIT_SP): TextView = view.apply {
        // Seed the intrinsic size too: native dialog button bars measure before autosizing.
        setAutoSizeTextTypeWithDefaults(TextView.AUTO_SIZE_TEXT_TYPE_NONE)
        setTextSize(unit, maximum.toFloat())
        maxLines = Int.MAX_VALUE
        setHorizontallyScrolling(false)
        ellipsize = null
        breakStrategy = LineBreaker.BREAK_STRATEGY_SIMPLE
        hyphenationFrequency = Layout.HYPHENATION_FREQUENCY_NONE
    }
}

/** Related labels use the largest size that fits every member of their row. */
internal open class MatchingLabelRow(context: Context, private val matchChildren: Boolean = false,
    private val singleLineLabels:Boolean=false, private val minimumButtonDp:Float=12f): LinearLayout(context) {
    init { isBaselineAligned=false }
    private data class Label(val view: TextView, val maximum: Float)
    private data class Group(val labels: List<Label>, val sizeLimit: (() -> Float)? = null)
    private val groups = mutableListOf<Group>()
    private val children = linkedMapOf<TextView, Label>()

    private fun label(view: TextView): Label {
        val maximum = view.autoSizeMaxTextSize.takeIf { it > 0 }?.toFloat() ?: view.textSize
        view.setAutoSizeTextTypeWithDefaults(TextView.AUTO_SIZE_TEXT_TYPE_NONE)
        return Label(view, maximum)
    }

    fun matchLabels(vararg views: TextView, sizeLimit: (() -> Float)? = null) {
        groups += Group(views.map(::label), sizeLimit)
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        if (matchChildren) for (index in 0 until childCount) {
            (getChildAt(index) as? TextView)?.let { children.getOrPut(it) { label(it) } }
        }
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
        var changed = false
        val measuredGroups = if (matchChildren) groups + Group(children.values.toList()) else groups
        for ((group, limit) in measuredGroups.filter { it.labels.isNotEmpty() }) {
            val maximum=group.minOf { it.maximum }
            val buttons=group.all{it.view is android.widget.Button}
            // Keep navigation on one line and action labels on whole words. At large
            // system fonts this can reduce them further within the row-specific readable bound.
            val floor=(if(buttons)minOf(maximum,minimumButtonDp*resources.displayMetrics.density)else maximum*0.85f).toInt().coerceAtLeast(1)
            var low = floor
            var high = minOf(maximum, limit?.invoke() ?: Float.MAX_VALUE).toInt().coerceAtLeast(floor)
            // Hinting rounds glyph advances differently at each size: a scaled estimate can overflow.
            while (low < high) {
                val candidate = (low + high + 1) / 2
                val fits = group.all { (view, _) ->
                    val available = view.measuredWidth - view.compoundPaddingLeft - view.compoundPaddingRight
                    val paint = TextPaint(view.paint).apply { textSize = candidate.toFloat() }
                    val required=if(buttons && !singleLineLabels)view.text.toString().split(Regex("\\s+"))
                        .maxOfOrNull{Layout.getDesiredWidth(it,paint)} ?: 0f else Layout.getDesiredWidth(view.text,paint)
                    available <= 0 || kotlin.math.ceil(required) <= available
                }
                if (fits) low = candidate else high = candidate - 1
            }
            val size = low.toFloat()
            for ((view, _) in group) if (kotlin.math.abs(view.textSize - size) > 0.1f) {
                view.setTextSize(TypedValue.COMPLEX_UNIT_PX, size)
                changed = true
            }
        }
        if (changed) super.onMeasure(widthMeasureSpec, heightMeasureSpec)
        if(matchChildren && orientation==HORIZONTAL){
            for(index in 0 until childCount){
                val child=getChildAt(index);val lp=child.layoutParams as LayoutParams
                child.measure(MeasureSpec.makeMeasureSpec(child.measuredWidth,MeasureSpec.EXACTLY),
                    MeasureSpec.makeMeasureSpec((measuredHeight-paddingTop-paddingBottom-lp.topMargin-lp.bottomMargin).coerceAtLeast(0),MeasureSpec.EXACTLY))
            }
        }
    }
}
