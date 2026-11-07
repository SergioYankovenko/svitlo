package ua.svitlo.widget.next

import android.content.Context
import android.graphics.*
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import androidx.core.graphics.PathParser

/** Same 24-unit paths as UI254 native-ui.js; no emoji substitutes for product icons. */
internal class PrototypeGlyph(c:Context,private val name:String,private val ink:Int=NextUi(c).p.accent,private val mark:String="",private val opticalOffsetDp:Int=0):View(c){
    private val u=NextUi(c);private val paint=Paint(Paint.ANTI_ALIAS_FLAG)
    init{minimumWidth=u.dp(48);minimumHeight=u.dp(48)}
    override fun onMeasure(w:Int,h:Int){setMeasuredDimension(resolveSize(u.dp(48),w),resolveSize(u.dp(48),h))}
    override fun getAccessibilityClassName():CharSequence=if(isClickable)"android.widget.Button"else"android.widget.ImageView"
    override fun onDraw(canvas:Canvas){
        val size=u.dp(24).toFloat();val save=canvas.save();canvas.translate((width-size)/2+u.dp(opticalOffsetDp),(height-size)/2);canvas.scale(size/24,size/24)
        paint.color=ink;paint.style=Paint.Style.STROKE;paint.strokeWidth=1.8f;paint.strokeCap=Paint.Cap.ROUND;paint.strokeJoin=Paint.Join.ROUND
        fun path(d:String){canvas.drawPath(PathParser.createPathFromPathData(d),paint)}
        when(name){
            "settings"->{path("M4 7H9M15 7H20M4 17H13M19 17H20");canvas.drawCircle(12f,7f,3f,paint);canvas.drawCircle(16f,17f,3f,paint)}
            "access"->{canvas.drawCircle(10f,6f,4f,paint);path("M10 22H5a3 3 0 0 1-3-3 7 7 0 0 1 7-7h3a7 7 0 0 1 2.5.5");paint.style=Paint.Style.FILL;canvas.drawCircle(18f,18f,5f,paint);paint.style=Paint.Style.STROKE;paint.color=u.p.background;path("M18 15.5v5M15.5 18h5")}
            "edit"->path("M14 5L19 10M4 16L3 21L8 20L21 7L17 3Z")
            "sensor"->path("M8 3V8M16 3V8M6 8H18V13A6 6 0 0 1 6 13ZM12 19V22")
            "house"->path("M3 10.5L12 3L21 10.5M5 9V21H19V9M9 21V14H15V21")
            "chevron"->path("M6 9L12 15L18 9")
            "up"->path("M6 15L12 9L18 15")
            "plus"->path("M12 4V20M4 12H20")
            "bell","bell-off"->{path("M18 8A6 6 0 0 0 6 8C6 15 3 15 3 17H21C21 15 18 15 18 8M10 21H14M12 2V1");if(name=="bell-off")path("M3 3L21 21")}
        }
        if(mark.isNotEmpty()){paint.style=Paint.Style.FILL;paint.color=u.p.surface;canvas.drawCircle(20f,20f,5f,paint);paint.color=ink;paint.textSize=10f;paint.textAlign=Paint.Align.CENTER;canvas.drawText(mark,20f,23.5f,paint)}
        canvas.restoreToCount(save)
    }
}
