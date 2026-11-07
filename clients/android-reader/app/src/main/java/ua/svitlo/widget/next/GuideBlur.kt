package ua.svitlo.widget.next

import android.content.Context
import android.graphics.*
import android.view.View
import kotlin.math.roundToInt

/** UI185/221 local backdrop. Captured UI pixels stay in memory and are destroyed
 * with the hint; no screenshot file, telemetry, permission or network transfer. */
internal class GuideBlur(c:Context,root:View,private val dim:Float=.72f):View(c){
    private val u=NextUi(c);private val paint=Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private var bitmap:Bitmap?=null
    var region=RectF();var clearBelow=Float.MAX_VALUE
    init{
        importantForAccessibility=IMPORTANT_FOR_ACCESSIBILITY_NO
        if(root.width>0&&root.height>0){
            val w=(root.width/6f).roundToInt().coerceAtLeast(1);val h=(root.height/6f).roundToInt().coerceAtLeast(1)
            val source=Bitmap.createBitmap(w,h,Bitmap.Config.ARGB_8888);root.draw(Canvas(source).apply{scale(w.toFloat()/root.width,h.toFloat()/root.height)})
            val pixels=IntArray(w*h);val temporary=IntArray(w*h);source.getPixels(pixels,0,w,0,0,w,h)
            fun pass(horizontal:Boolean){for(y in 0 until h)for(x in 0 until w){var r=0;var g=0;var b=0;for(i in -2..2){val at=if(horizontal)y*w+(x+i).coerceIn(0,w-1)else (y+i).coerceIn(0,h-1)*w+x;val color=pixels[at];r+=Color.red(color);g+=Color.green(color);b+=Color.blue(color)};temporary[y*w+x]=Color.rgb(r/5,g/5,b/5)};temporary.copyInto(pixels)}
            pass(true);pass(false);source.setPixels(pixels,0,w,0,0,w,h);pixels.fill(0);temporary.fill(0);bitmap=source
        }
    }
    override fun onDraw(c:Canvas){val b=bitmap ?:return;if(region.isEmpty)return;val save=c.saveLayer(region,null);c.clipRect(region);c.clipRect(0f,0f,width.toFloat(),clearBelow);val level=(255*(1-dim)).roundToInt().coerceIn(0,255);paint.colorFilter=LightingColorFilter(Color.rgb(level,level,level),0);c.drawBitmap(b,null,RectF(0f,0f,width.toFloat(),height.toFloat()),paint);paint.colorFilter=null;paint.color=u.p.surface;paint.alpha=30;c.drawOval(region,paint);paint.alpha=255;paint.shader=RadialGradient(region.centerX(),region.centerY(),region.width()/2,intArrayOf(Color.WHITE,Color.WHITE,Color.TRANSPARENT),floatArrayOf(0f,.45f,1f),Shader.TileMode.CLAMP);paint.xfermode=PorterDuffXfermode(PorterDuff.Mode.DST_IN);c.drawRect(region,paint);paint.shader=null;paint.xfermode=null;c.restoreToCount(save)}
    override fun onDetachedFromWindow(){bitmap?.recycle();bitmap=null;super.onDetachedFromWindow()}
}
