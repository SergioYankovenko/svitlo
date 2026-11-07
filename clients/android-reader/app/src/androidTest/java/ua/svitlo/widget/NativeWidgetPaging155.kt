package ua.svitlo.widget

import android.app.Instrumentation
import android.appwidget.*
import android.content.ComponentName
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.*
import org.json.JSONObject

/** Real RemoteViews host and PendingIntent broadcasts; QA package with isolated fixtures only. */
object NativeWidgetPaging155 {
    fun verify(test:Instrumentation,activity:MainActivity,args:Bundle):JSONObject {
        val context=test.targetContext
        val profiles=AddressProfiles(context).profiles();val count=profiles.size
        val original=AddressProfiles(context).active()!!.id
        fun main(action:()->Unit){var failure:Throwable?=null;test.runOnMainSync{try{action()}catch(e:Throwable){failure=e}};failure?.let{throw it}}
        fun all(v:View):List<View> = listOf(v)+if(v is ViewGroup)(0 until v.childCount).flatMap{all(v.getChildAt(it))}else emptyList()
        fun views()=all(activity.window.decorView)
        fun view(id:Int)=views().single{it.id==id}
        fun waitFor(check:()->Boolean){repeat(80){var ready=false;main{ready=check()};if(ready)return;SystemClock.sleep(75);test.waitForIdleSync()};error("Widget host update timed out")}
        fun capture(label:String){main{val root=activity.window.decorView;val image=Bitmap.createBitmap(root.width,root.height,Bitmap.Config.ARGB_8888);root.draw(Canvas(image));java.io.File(context.cacheDir,"paging155-$label.png").outputStream().use{image.compress(Bitmap.CompressFormat.PNG,100,it)}}}
        val manager=AppWidgetManager.getInstance(context)
        val host=AppWidgetHost(activity,155);host.deleteHost()
        val appContent=(activity.findViewById<ViewGroup>(android.R.id.content)).getChildAt(0)
        val component=ComponentName(context,SvitloWidget::class.java)
        var widgetId=0;var otherId=0
        val height=args.getString("height")?.toInt() ?: 640
        var width=0
        try {
            main{
                host.startListening()
                widgetId=host.allocateAppWidgetId();otherId=host.allocateAppWidgetId()
                check(manager.bindAppWidgetIdIfAllowed(widgetId,component));check(manager.bindAppWidgetIdIfAllowed(otherId,component))
                val padding=AppWidgetHostView.getDefaultPaddingForWidget(activity,component,null)
                val density=activity.resources.displayMetrics.density
                width=((activity.resources.displayMetrics.widthPixels-padding.left-padding.right)/density).toInt()
                val options=Bundle().apply{
                    putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH,width);putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH,width)
                    putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT,height);putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT,height)
                }
                manager.updateAppWidgetOptions(widgetId,options);manager.updateAppWidgetOptions(otherId,options)
                val hostView=host.createView(activity,widgetId,manager.getAppWidgetInfo(widgetId))
                activity.setContentView(FrameLayout(activity).apply{addView(hostView,FrameLayout.LayoutParams(-1,(height*density).toInt()+padding.top+padding.bottom))})
                manager.updateAppWidget(widgetId,WidgetRenderer.render(context,widgetId,false))
            }
            test.waitForIdleSync();SystemClock.sleep(200)
            waitFor{(views().firstOrNull{it.id==R.id.detail_heading} as? TextView)?.text?.toString()=="Мої адреси · $count"
                && view(R.id.widget_root).height>0 && !view(R.id.widget_root).isLayoutRequested && view(R.id.detail_footer).height>0}
            main{
                check((view(R.id.detail_heading) as TextView).text.toString()=="Мої адреси · $count")
                check((view(R.id.detail_heading) as TextView).compoundDrawablesRelative[0]!=null)
                check(view(R.id.detail_list).visibility==View.GONE)
                val root=view(R.id.widget_root);val footer=view(R.id.detail_footer)
                check(footer.top>=0 && footer.bottom<=root.height-root.paddingBottom){"Footer ${footer.top}..${footer.bottom}, root ${root.height}, padding ${root.paddingBottom}"}
                check(view(R.id.detail_pager).visibility==if(count>4)View.VISIBLE else View.GONE)
                check(view(R.id.detail_refresh).visibility==if(count>4)View.GONE else View.VISIBLE)
            }
            val hint=args.getString("hint")=="true"
            if(hint){
                main{check(view(R.id.detail_empty).visibility==View.VISIBLE);check((view(R.id.detail_empty) as TextView).text.startsWith("Збільште"));check(views().none{it.id==R.id.address_row})}
                capture("resize")
                return JSONObject().put("resize_hint",true).put("width",width).put("height",height)
            }
            fun expected(page:Int)=profiles.drop(page*4).take(4).map{it.name}
            fun names()=views().filterIsInstance<TextView>().filter{it.id==R.id.address_name}.map{it.text.toString()}
            fun ready(page:Int)=names()==expected(page) && !view(R.id.widget_root).isLayoutRequested && views().filter{it.id==R.id.address_row}.all{it.height>0}
            waitFor{ready(0)}
            capture("first")
            val rowHeights=mutableSetOf<Int>()
            for(page in 0 until WidgetPages.count(count)){
                if(page>0){main{check(view(R.id.detail_next).performClick())};waitFor{ready(page)}}
                // Host callbacks can reapply a page between two UI-thread calls.
                // Inspect a completed layout atomically with its readiness predicate.
                waitFor{
                    if(!ready(page))return@waitFor false
                    val rows=views().filter{it.id==R.id.address_row}
                    check(rows.size==minOf(4,count-page*4)){"Page $page has ${rows.size} rows, names=${names()}"}
                    val body=view(R.id.detail_body)
                    rows.forEach{check(it.top>=0 && it.bottom<=body.height){"Row ${it.top}..${it.bottom}, body ${body.height}"};check(it.height>=48*activity.resources.displayMetrics.density){"Row height ${it.height}"};rowHeights+=it.height;check(it.contentDescription.toString().contains("Відкрити цю адресу"))}
                    check(view(R.id.detail_previous).isEnabled==(page>0))
                    check(view(R.id.detail_next).isEnabled==(page+1<WidgetPages.count(count)))
                    if(count>4)check(view(R.id.detail_next).width>=48*activity.resources.displayMetrics.density)
                    true
                }
                check(WidgetPages.page(context,widgetId,count)==page)
                check(WidgetPages.page(context,otherId,count)==0)
                check(AddressProfiles(context).active()!!.id==original)
                capture("page${page+1}")
            }
            check(rowHeights.size==1){"Page rows changed height: $rowHeights"}
            if(count>4){
                repeat(WidgetPages.count(count)-1){step->
                    main{check(view(R.id.detail_previous).performClick())}
                    val page=WidgetPages.count(count)-2-step;waitFor{ready(page)}
                }
                // Repeated taps on the same absolute target must remain within bounds.
                main{repeat(3){view(R.id.detail_next).performClick()}}
                waitFor{ready(1)}
                check(WidgetPages.page(context,widgetId,count)==1)
            }
            val target=profiles[if(count>4)4 else 0]
            main{
                views().first{it.id==R.id.address_row}.performClick()
                // This fixture temporarily hosts RemoteViews inside the Activity.
                // A real launcher leaves the app's cached content intact; restore
                // it before delivering onNewIntent, including the already-active case.
                (appContent.parent as? ViewGroup)?.removeView(appContent)
                activity.setContentView(appContent)
            }
            waitFor{AddressProfiles(context).active()?.id==target.id && views().any{it.tag=="home_schedule"}}
            check(OutageRepository(context).binding()==target.binding)
            return JSONObject().put("pages",WidgetPages.count(count)).put("visited_addresses",count)
                .put("width",width).put("height",height).put("independent_widget_state",true)
                .put("stable_row_heights",true).put("correct_profile_route",true)
        }catch(error:Throwable){capture("failure");throw error}
        finally{main{host.stopListening();host.deleteHost();WidgetPages.remove(context,intArrayOf(widgetId,otherId))}}
    }
}
