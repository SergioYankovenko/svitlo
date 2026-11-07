package ua.svitlo.widget

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.drawable.Drawable
import android.text.SpannableString
import android.text.Spanned
import android.text.style.ImageSpan
import android.widget.Button

/** Inline artwork keeps the icon and label centered together, including wrapped labels. */
internal object ShareButtonIcon {
    fun apply(button:Button,color:Int) {
        val label=button.text.toString()
        val icon=button.resources.getDrawable(R.drawable.ic_share_outline,null).mutate().apply {
            setTint(color)
            val size=(button.textSize*1.2f).toInt().coerceAtLeast(1)
            setBounds(0,0,size,size)
        }
        button.text=SpannableString("\uFFFC\u00a0$label").apply {
            setSpan(CenteredIcon(icon),0,1,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        button.contentDescription=label // Decorative icon must not become a separate spoken action.
    }
    private class CenteredIcon(icon:Drawable):ImageSpan(icon) {
        override fun draw(canvas:Canvas,text:CharSequence,start:Int,end:Int,x:Float,top:Int,y:Int,bottom:Int,paint:Paint) {
            val saved=canvas.save()
            canvas.translate(x,y+(paint.fontMetrics.ascent+paint.fontMetrics.descent)/2-drawable.bounds.height()/2f)
            drawable.draw(canvas)
            canvas.restoreToCount(saved)
        }
    }
}
