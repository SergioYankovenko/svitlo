package ua.svitlo.widget

import android.graphics.Color
import android.text.SpannableString
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import ua.svitlo.widget.core.Category
import ua.svitlo.widget.core.Snapshot
import ua.svitlo.widget.core.OutageKind
import java.time.Instant

/** Widget-only colors: changing the supply band must not recolor the application UI. */
internal object WidgetStyle {
    val power=Color.rgb(82,109,76)
    fun palette()=Palette.app()
    fun signalColor(snapshot:Snapshot,now:Instant):Int=when(Presentation.widgetSignal(snapshot,now)){
        Presentation.WidgetSignal.POWER->palette().accent
        Presentation.WidgetSignal.PLANNED->palette().hourly
        Presentation.WidgetSignal.EMERGENCY->palette().emergency
        Presentation.WidgetSignal.UNKNOWN->palette().muted
    }
    fun legend(categories:List<Category>,kinds:List<OutageKind> = emptyList()):SpannableString {
        val colors=palette()
        val swatches=if(kinds.isEmpty())categories.distinct().sortedBy{it.priority}.ifEmpty{listOf(Category.SCHEDULE)}.map(colors::category)
            else kinds.distinct().sortedBy{it.category.priority}.map{colors.outage(it.category,it)}
        val label=SpannableString("■\u00a0Світло\u00a0є   ${swatches.joinToString(""){"■"}}\u00a0Світла\u00a0немає")
        label.setSpan(ForegroundColorSpan(power),0,1,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        val start=label.toString().indexOf('■',1)
        swatches.forEachIndexed{i,color->label.setSpan(ForegroundColorSpan(color),start+i,start+i+1,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)}
        return label
    }
}
