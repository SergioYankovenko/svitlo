package ua.svitlo.widget

import android.app.Instrumentation
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.util.SizeF
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import ua.svitlo.widget.core.*
import java.time.Instant

object NativeWidgetLegend158 {
    fun verify(test:Instrumentation,activity:MainActivity):JSONArray {
        val results=JSONArray();val now=Instant.now()
        val snapshot=OutageRepository(activity).snapshot()
        check(snapshot.allEvents().map(OutageKind::of).toSet().containsAll(listOf(OutageKind.HOURLY,OutageKind.PLANNED,OutageKind.UNPLANNED)))
        val kind=ScheduleLabels.currentOrNextKind(listOf(snapshot),now)
        check(kind!=null)
        for((index,dimensions) in listOf(Triple(414,640,1f),Triple(250,500,1f),Triple(320,640,2f)).withIndex()){
            var error:Throwable?=null
            test.runOnMainSync{try{
                val (width,height,font)=dimensions
                val config=Configuration(activity.resources.configuration).apply{fontScale=font}
                val context=activity.createConfigurationContext(config)
                val density=context.resources.displayMetrics.density
                val rv=DetailedWidget.render(context,SizeF(width.toFloat(),height.toFloat()),1f,now)
                val root=rv.apply(context,FrameLayout(context))
                root.measure(View.MeasureSpec.makeMeasureSpec((width*density).toInt(),View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec((height*density).toInt(),View.MeasureSpec.EXACTLY))
                root.layout(0,0,root.measuredWidth,root.measuredHeight)
                val legendId=if(root.findViewById<View>(R.id.detail_footer_row).visibility==View.VISIBLE)R.id.detail_legend else R.id.detail_legend_stacked
                run {
                    val label=root.findViewById<TextView>(legendId).text as Spanned
                    check(label.count{it=='■'}==2){"The legend must have one power and one outage swatch: $label"}
                    val off=label.toString().indexOf('■',1)
                    val color=label.getSpans(off,off+1,ForegroundColorSpan::class.java).single().foregroundColor
                    check(color==Palette.app().outage(kind!!.category,kind))
                }
                val image=Bitmap.createBitmap(root.width,root.height,Bitmap.Config.ARGB_8888)
                root.draw(Canvas(image))
                java.io.File(test.targetContext.cacheDir,"legend158-$index.png").outputStream().use{image.compress(Bitmap.CompressFormat.PNG,100,it)}
                results.put(JSONObject().put("width",width).put("height",height).put("fontScale",font).put("outageSwatches",1).put("kind",kind!!.name))
            }catch(e:Throwable){error=e}}
            error?.let{throw it}
        }
        return results
    }
}
