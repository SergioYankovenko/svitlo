package ua.svitlo.widget

import android.app.Instrumentation
import android.graphics.Bitmap
import android.graphics.Canvas
import android.text.Spanned
import android.text.style.ImageSpan
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import org.json.JSONObject
import ua.svitlo.widget.core.OutageKind

/** Device-side rendering checks; compiled exclusively into the instrumentation APK. */
object NativeAppearance156 {
    fun verify(test:Instrumentation,activity:MainActivity):JSONObject {
        fun main(action:()->Unit){var failure:Throwable?=null;test.runOnMainSync{try{action()}catch(e:Throwable){failure=e}};failure?.let{throw it}}
        fun all(view:View):List<View> = listOf(view)+if(view is ViewGroup)(0 until view.childCount).flatMap{all(view.getChildAt(it))}else emptyList()
        fun views()=all(activity.window.decorView)
        fun bitmap(view:View):Bitmap=Bitmap.createBitmap(view.width,view.height,Bitmap.Config.ARGB_8888).also{view.draw(Canvas(it))}
        fun save(image:Bitmap,name:String){java.io.File(test.targetContext.cacheDir,"appearance156-$name.png").outputStream().use{image.compress(Bitmap.CompressFormat.PNG,100,it)}}
        val colors=Palette.app(activity)
        main {
            val tiles=views().filterIsInstance<HourTileView>()
            for((kind,color) in listOf(OutageKind.PLANNED to colors.planned,OutageKind.UNPLANNED to colors.unplanned)){
                val tile=tiles.first{it.hour.segments.all{part->part.kind==kind}}
                check(tile.contentDescription.toString().contains(kind.label))
                val image=bitmap(tile)
                check(image.getPixel(image.width/5,image.height/5)==color)
                val pixels=IntArray(image.width*image.height)
                image.getPixels(pixels,0,image.width,0,0,image.width,image.height)
                check(pixels.count{it==colors.outageInk(kind.category,kind)}>5)
                if(kind==OutageKind.UNPLANNED){
                    val inset=minOf(image.width,image.height)/8
                    check((inset until image.height-inset).sumOf{y->(inset until image.width-inset).count{x->image.getPixel(x,y)==colors.outageIcon}}>5)
                }
            }
            val share=views().filterIsInstance<Button>().single{it.tag=="share_schedule"}
            check(share.contentDescription.toString()=="Поділитись графіком")
            val label=share.text as Spanned
            val icon=label.getSpans(0,label.length,ImageSpan::class.java).single().drawable
            check(icon.bounds.height()>0)
            check(share.layout.height<=share.height-share.compoundPaddingTop-share.compoundPaddingBottom)
            repeat(share.layout.lineCount){check(share.layout.getLineWidth(it)<=share.width-share.compoundPaddingLeft-share.compoundPaddingRight+1)}
            val donate=views().filterIsInstance<Button>().single{it.tag=="donate_button"}
            val gap=(8*activity.resources.displayMetrics.density).toInt()
            val image=Bitmap.createBitmap(share.width,share.height+donate.height+gap,Bitmap.Config.ARGB_8888)
            val canvas=Canvas(image);canvas.drawColor(colors.background);share.draw(canvas)
            canvas.translate(0f,(share.height+gap).toFloat());donate.draw(canvas);save(image,"actions")
            views().filterIsInstance<Button>().single{it.text.toString()=="Опції"}.performClick()
        }
        test.waitForIdleSync()
        main {
            val samples=views().filterIsInstance<LegendSample>()
            check(samples.size==5)
            check(bitmap(samples[1]).getPixel(samples[1].width/5,samples[1].height/5)==colors.planned)
            check(bitmap(samples[2]).getPixel(samples[2].width/5,samples[2].height/5)==colors.unplanned)
            val unplanned=bitmap(samples[2])
            val darkGlyphPixels=(unplanned.height/4 until unplanned.height*3/4).sumOf{y->
                (unplanned.width/4 until unplanned.width*3/4).count{x->unplanned.getPixel(x,y)==colors.outageIcon}}
            check(darkGlyphPixels>5)
            val rows=samples.map{it.parent as View}
            val gap=(12*activity.resources.displayMetrics.density).toInt()
            val image=Bitmap.createBitmap(rows.maxOf{it.width},rows.sumOf{it.height}+gap*(rows.size-1),Bitmap.Config.ARGB_8888)
            val canvas=Canvas(image);canvas.drawColor(colors.background)
            rows.forEach{it.draw(canvas);canvas.translate(0f,(it.height+gap).toFloat())};save(image,"legend")
        }
        return JSONObject().put("planned",String.format("#%06X",colors.planned and 0xffffff))
            .put("unplanned",String.format("#%06X",colors.unplanned and 0xffffff)).put("share_accessible",true)
    }
}
