package ua.svitlo.widget

import android.content.Context
import android.widget.LinearLayout
import android.view.View

/** Wrap complete controls instead of squeezing their text. */
class AdaptiveActionRow(context:Context):LinearLayout(context){
    override fun onMeasure(w:Int,h:Int){
        val available=MeasureSpec.getSize(w)-paddingLeft-paddingRight
        var wanted=0
        for(i in 0 until childCount){val child=getChildAt(i);child.measure(MeasureSpec.makeMeasureSpec(0,MeasureSpec.UNSPECIFIED),MeasureSpec.makeMeasureSpec(0,MeasureSpec.UNSPECIFIED));wanted+=child.measuredWidth}
        orientation=if(wanted>available)VERTICAL else HORIZONTAL
        super.onMeasure(w,h)
    }
}
