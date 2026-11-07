package ua.svitlo.widget

import android.app.AlertDialog
import android.app.Instrumentation
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.GradientDrawable
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import org.json.JSONObject

object NativeAddressDialog155 {
    fun verify(test:Instrumentation,activity:MainActivity):JSONObject {
        fun main(action:()->Unit){var failure:Throwable?=null;test.runOnMainSync{try{action()}catch(e:Throwable){failure=e}};failure?.let{throw it}}
        fun all(view:View):List<View> = listOf(view)+if(view is ViewGroup)(0 until view.childCount).flatMap{all(view.getChildAt(it))}else emptyList()
        lateinit var dialog:AlertDialog
        main{dialog=MainActivity::class.java.getDeclaredMethod("manageAddressProfiles").apply{isAccessible=true}.invoke(activity) as AlertDialog}
        test.waitForIdleSync();SystemClock.sleep(150)
        val list=dialog.window!!.decorView.findViewWithTag<android.widget.ListView>("saved_addresses_list")
        fun capture(label:String){main{val root=dialog.window!!.decorView;val image=Bitmap.createBitmap(root.width,root.height,Bitmap.Config.ARGB_8888);root.draw(Canvas(image));java.io.File(test.targetContext.cacheDir,"address-dialog155-$label.png").outputStream().use{image.compress(Bitmap.CompressFormat.PNG,100,it)}}}
        try {
            val colors=Palette.app(activity)
            val active=AddressProfiles(activity).active()!!.id
            fun checkRows(){
                val root=dialog.window!!.decorView
                val divider=root.findViewWithTag<View>("saved_addresses_divider")
                check(divider.height>0 && divider.width>0)
                check(root.findViewWithTag<TextView>("saved_addresses_title").text.toString()=="Збережені адреси")
                check(all(root).filterIsInstance<TextView>().none{it.text.toString().contains("✓")})
                for(tag in listOf("managed_done","managed_add")){
                    val action=root.findViewWithTag<View>(tag)
                    val visible=android.graphics.Rect()
                    check(action.getGlobalVisibleRect(visible) && visible.height()==action.height){"Clipped dialog action: $tag, ${visible.height()}/${action.height}"}
                }
                for(index in 0 until list.childCount){
                    val row=list.getChildAt(index) as ViewGroup
                    if(row.tag?.toString()?.startsWith("managed_profile:")!=true)continue
                    val card=row.getChildAt(0) as ViewGroup
                    val isActive=row.tag=="managed_profile:$active"
                    check((card.background as GradientDrawable).color!!.defaultColor==if(isActive)colors.track else colors.background)
                    check(row.contentDescription.toString().contains("Керувати адресою"))
                    check(card.height>=48*activity.resources.displayMetrics.density)
                    all(card).filterIsInstance<TextView>().forEach{label->
                        check(label.layout!=null && label.layout.getEllipsisCount(label.layout.lineCount-1)==0)
                        check(label.bottom<=card.height-card.paddingBottom)
                    }
                }
            }
            main{checkRows();check(list.adapter.count==5)};capture("first")
            main{list.setSelection(4)};test.waitForIdleSync();SystemClock.sleep(100)
            main{checkRows();check(all(dialog.window!!.decorView).any{it.tag=="managed_profile:$active"})};capture("active")
            return JSONObject().put("addresses",5).put("title_divider",true).put("separate_colored_cards",true).put("active_highlight",true)
        }finally{main{dialog.dismiss()}}
    }
}
