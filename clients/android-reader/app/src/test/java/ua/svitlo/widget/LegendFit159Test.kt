package ua.svitlo.widget

import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import org.junit.Assert.*
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import ua.svitlo.widget.core.Category

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[28],qualifiers="mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class LegendFit159Test {
    private val context get()=RuntimeEnvironment.getApplication()
    private val labels=listOf("Світло є","Світла немає","Поточна година")
    @After fun reset(){RuntimeEnvironment.setFontScale(1f);RuntimeEnvironment.setQualifiers("mdpi")}
    private fun make(widthDp:Int):LegendFlow {
        val d=context.resources.displayMetrics.density
        fun dp(value:Int)=(value*d).toInt()
        val flow=LegendFlow(context)
        labels.forEachIndexed{index,label->
            val row=LinearLayout(context).apply{orientation=LinearLayout.HORIZONTAL;minimumHeight=dp(30);contentDescription=label}
            row.addView(LegendSample(context,Palette.app(),if(index==1)Category.SCHEDULE else null,current=index==2),LinearLayout.LayoutParams(dp(20),dp(20)))
            row.addView(TextView(context).apply{text=label;textSize=14f;maxLines=1},LinearLayout.LayoutParams(-2,-2).apply{marginStart=dp(6)})
            flow.addView(row)
        }
        flow.measure(View.MeasureSpec.makeMeasureSpec(dp(widthDp),View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(0,View.MeasureSpec.UNSPECIFIED))
        flow.layout(0,0,flow.measuredWidth,flow.measuredHeight)
        return flow
    }
    @Test fun ordinaryPhoneLegendShrinksTogetherBeforeMovingToAnotherRow(){
        val flow=make(288)
        val rows=(0 until flow.childCount).map{flow.getChildAt(it) as LinearLayout}
        assertEquals(rows.joinToString{row->"${row.width}px/${(row.getChildAt(1) as TextView).textSize}sp"},1,rows.map{it.top}.distinct().size)
        val sizes=rows.map{(it.getChildAt(1) as TextView).textSize}
        assertEquals(1,sizes.distinct().size);assertTrue(sizes.first()<14f);assertTrue(sizes.first()>=11f)
        assertTrue(rows.all{it.getChildAt(0).width in 15..20})
    }
    @Test fun generousWidthRestoresOriginalTextAndIconSizes(){
        val flow=make(450)
        for(i in 0 until flow.childCount){val row=flow.getChildAt(i) as LinearLayout
            assertEquals(14f,(row.getChildAt(1) as TextView).textSize,0.01f);assertEquals(20,row.getChildAt(0).width)}
    }
    @Test fun largeFontsAndDensitiesKeepCompleteLabelsReadableAndSeparated(){
        for(density in listOf("mdpi","xhdpi","420dpi"))for(font in listOf(1f,1.5f,2f)){
            RuntimeEnvironment.setQualifiers("w360dp-h780dp-$density");RuntimeEnvironment.setFontScale(font)
            val flow=make(288);val d=flow.resources.displayMetrics.density
            var previous:View?=null
            for(i in 0 until flow.childCount){val row=flow.getChildAt(i) as LinearLayout;val text=row.getChildAt(1) as TextView
                assertEquals(labels[i],text.text.toString());assertEquals(1,text.lineCount)
                val floor=android.util.TypedValue.applyDimension(android.util.TypedValue.COMPLEX_UNIT_SP,11f,flow.resources.displayMetrics)
                assertTrue(text.textSize>=floor-.1f);assertTrue(row.right<=flow.width)
                assertTrue(text.paint.measureText(text.text.toString())<=text.width+1)
                previous?.let{if(it.top==row.top)assertTrue(row.left-it.right>=16*d-1)else assertTrue(row.top-it.bottom>=10*d-1)}
                previous=row
            }
        }
    }
}
