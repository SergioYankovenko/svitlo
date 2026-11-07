package ua.svitlo.widget

import android.app.Instrumentation
import android.graphics.Bitmap
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject

object NativeLegendFit159 {
    fun verify(test:Instrumentation,activity:MainActivity):JSONObject {
        fun all(v:View):List<View> = listOf(v)+if(v is ViewGroup)(0 until v.childCount).flatMap{all(v.getChildAt(it))}else emptyList()
        val result=JSONObject();var error:Throwable?=null
        test.runOnMainSync{try{
            val flow=all(activity.window.decorView).single{it.tag=="schedule_legend"} as ViewGroup
            val rows=(0 until flow.childCount).map{flow.getChildAt(it) as LinearLayout}
            val labels=rows.map{it.getChildAt(1) as TextView}
            val metrics=activity.resources.displayMetrics
            val floor=TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP,11f,metrics)
            val maximum=TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP,14f,metrics)
            val tops=rows.map{it.top}.distinct()
            check(rows.size==3 && labels.all{it.lineCount==1 && it.textSize>=floor-.1f && it.textSize<=maximum+.1f && it.paint.measureText(it.text.toString())<=it.width+1})
            check(labels.map{it.textSize}.distinct().size==1)
            check(rows.all{it.right<=flow.width && it.bottom<=flow.height})
            if(activity.resources.configuration.fontScale<=1.01f && flow.width/metrics.density>=288)check(tops.size==1){"Ordinary phone legend wrapped before fitting: width=${flow.width/metrics.density}"}
            val bitmap=Bitmap.createBitmap(flow.width,flow.height,Bitmap.Config.ARGB_8888)
            flow.draw(android.graphics.Canvas(bitmap))
            java.io.File(test.targetContext.cacheDir,"legend159.png").outputStream().use{bitmap.compress(Bitmap.CompressFormat.PNG,100,it)}
            result.put("widthDp",flow.width/metrics.density).put("fontScale",activity.resources.configuration.fontScale)
                .put("textPx",labels.first().textSize).put("rows",tops.size).put("labels",JSONArray(labels.map{it.text.toString()}))
        }catch(e:Throwable){error=e}}
        error?.let{throw it};return result
    }
}
