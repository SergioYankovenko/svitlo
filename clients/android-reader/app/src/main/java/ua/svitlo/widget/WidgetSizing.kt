package ua.svitlo.widget

import android.content.Context
import android.util.SizeF
import android.util.TypedValue
import kotlin.math.min

/** Scale the composition, not just the bars. SP still follows Android's font settings. */
internal data class WidgetSizing(val factor:Float=1f,val short:Boolean=false) {
    fun textPx(context:Context,preferredSp:Float,minimumDp:Float):Float {
        val metrics=context.resources.displayMetrics
        return TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP,preferredSp*factor,metrics)
            .coerceAtLeast(minimumDp*metrics.density)
    }
    companion object {
        fun forSize(size:SizeF)=WidgetSizing(min(1f,min(size.width/360f,size.height/320f)).coerceAtLeast(.35f),size.height<320f)
    }
}
