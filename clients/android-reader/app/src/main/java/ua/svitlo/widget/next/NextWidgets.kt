package ua.svitlo.widget.next

import android.app.*
import android.appwidget.*
import android.content.*
import android.graphics.*
import android.os.Bundle
import android.view.*
import android.widget.*
import androidx.work.*
import ua.svitlo.widget.*
import ua.svitlo.widget.R
import java.time.*
import kotlin.math.*

object NextWidgets {
    private val rows=intArrayOf(R.id.next_widget_row0,R.id.next_widget_row1,R.id.next_widget_row2,R.id.next_widget_row3)
    fun pin(c:Activity,detailed:Boolean){
        val repo=NextRepository(c);val profiles=if(detailed)repo.profiles().take(4)else listOfNotNull(repo.active())
        val image=NextWidgetPainter.picture(c,repo,profiles,repo.profiles().size,detailed,360,if(detailed)320 else 170).bitmap
        val panel=AppDialogPanel(c,if(detailed)"Детальний віджет"else"Компактний віджет",prefix="next_widget_preview")
        val preview=ImageView(c).apply{setImageBitmap(image);adjustViewBounds=true;contentDescription=if(detailed)"Детальний віджет. Мої адреси"else"Компактний віджет. Активна адреса"}
        panel.setBody(preview)
        lateinit var dialog:AlertDialog
        val manager=AppWidgetManager.getInstance(c);val component=ComponentName(c,if(detailed)NextDetailedWidget::class.java else NextCompactWidget::class.java)
        panel.footer(listOf(panel.button("Закрити","widget_preview_close").apply{gravity=Gravity.CENTER;setOnClickListener{dialog.dismiss()}},panel.button(if(manager.getAppWidgetIds(component).isEmpty())"Додати віджет"else"Додати повторно","widget_preview_add").apply{gravity=Gravity.CENTER;setOnClickListener{dialog.dismiss();requestPin(c,detailed)}}),horizontal=c.resources.configuration.fontScale<1.5f)
        dialog=panel.show();dialog.setOnDismissListener{preview.setImageDrawable(null);image.recycle()}
    }
    private fun requestPin(c:Activity,detailed:Boolean){val manager=AppWidgetManager.getInstance(c);if(!manager.isRequestPinAppWidgetSupported){Toast.makeText(c,"Додайте віджет через меню головного екрана Android",Toast.LENGTH_LONG).show();return};val component=ComponentName(c,if(detailed)NextDetailedWidget::class.java else NextCompactWidget::class.java);val state=c.getSharedPreferences("next_widget_pages",Context.MODE_PRIVATE)
        fun request(){val now=android.os.SystemClock.elapsedRealtime();val key="pin-${component.className}";val previous=state.getLong(key,0);if(previous>0&&now-previous in 0..15000){Toast.makeText(c,"Запит додавання вже надіслано",Toast.LENGTH_SHORT).show();return};state.edit().putLong(key,now).commit();val callback=PendingIntent.getBroadcast(c,component.className.hashCode(),Intent(c,if(detailed)NextDetailedWidget::class.java else NextCompactWidget::class.java).setAction("ua.svitlo.next.PINNED"),PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE);if(manager.requestPinAppWidget(component,null,callback))Toast.makeText(c,"Запит на додавання передано головному екрану",Toast.LENGTH_LONG).show()else{state.edit().remove(key).commit();Toast.makeText(c,"Головний екран не прийняв запит",Toast.LENGTH_LONG).show()}}
        if(manager.getAppWidgetIds(component).isEmpty())request()else{val panel=AppDialogPanel(c,"Перевірте головні екрани",prefix="next_widget_pin");panel.setBody(TextView(c).apply{text="Android уже має цей віджет «Світло». Він може бути на іншому екрані. Додавайте повторно лише якщо не можете його знайти, інакше з’явиться копія.";textSize=14f;setTextColor(Palette.app(c).ink)});lateinit var d:AlertDialog;panel.footer(listOf(panel.button("Закрити","next_pin_close").apply{gravity=Gravity.CENTER;setOnClickListener{d.dismiss()}},panel.button("Додати повторно","next_pin_again").apply{gravity=Gravity.CENTER;setOnClickListener{d.dismiss();request()}}),horizontal=true,proportional=true);d=panel.show()}
    }
    fun update(c:Context){val manager=AppWidgetManager.getInstance(c);for(detailed in listOf(true,false)){val component=ComponentName(c,if(detailed)NextDetailedWidget::class.java else NextCompactWidget::class.java);for(id in manager.getAppWidgetIds(component))runCatching{render(c,manager,id,detailed)}};scheduleTick(c)}
    fun scheduleTick(c:Context){
        val manager=AppWidgetManager.getInstance(c);val alarms=c.getSystemService(AlarmManager::class.java)
        val intent=Intent(c,NextDetailedWidget::class.java).setAction("ua.svitlo.next.TICK")
        val exists=listOf(NextDetailedWidget::class.java,NextCompactWidget::class.java).any{manager.getAppWidgetIds(ComponentName(c,it)).isNotEmpty()}
        val pending=PendingIntent.getBroadcast(c,170,intent,(if(exists)PendingIntent.FLAG_UPDATE_CURRENT else PendingIntent.FLAG_NO_CREATE) or PendingIntent.FLAG_IMMUTABLE) ?:return
        if(!exists){alarms.cancel(pending);pending.cancel();return}
        val at=android.os.SystemClock.elapsedRealtime()+60000-System.currentTimeMillis()%60000
        // Only cached rendering. Android may defer this non-wakeup tick in idle;
        // it does not cause a network request or request an exact-alarm grant.
        if(android.os.Build.VERSION.SDK_INT<31||alarms.canScheduleExactAlarms())alarms.setExact(AlarmManager.ELAPSED_REALTIME,at,pending)else alarms.set(AlarmManager.ELAPSED_REALTIME,at,pending)
    }
    fun render(c:Context,manager:AppWidgetManager,id:Int,detailed:Boolean){
        val repo=NextRepository(c);val all=repo.profiles();val preferences=c.getSharedPreferences("next_widget_pages",Context.MODE_PRIVATE)
        val maxPage=(all.size-1).coerceAtLeast(0)/4;val page=preferences.getInt("page-$id",0).coerceIn(0,maxPage)
        preferences.edit().putInt("page-$id",page).apply()
        val profiles=if(detailed)all.drop(page*4).take(4)else listOfNotNull(repo.active())
        val options=manager.getAppWidgetOptions(id);val landscape=c.resources.configuration.orientation==android.content.res.Configuration.ORIENTATION_LANDSCAPE
        val width=options.getInt(if(landscape)AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH else AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH,300).coerceIn(180,800)
        val height=options.getInt(if(landscape)AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT else AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT,if(detailed)300 else 160).coerceIn(if(detailed)160 else 90,800)
        val picture=NextWidgetPainter.picture(c,repo,profiles,all.size,detailed,width-8,height-8)
        val today=LocalDate.now(NEXT_ZONE).toString();val views=RemoteViews(c.packageName,R.layout.next_widget)
        views.setImageViewBitmap(R.id.next_widget_image,picture.bitmap)
        val intent=Intent(c,NextActivity::class.java).putExtra("profile",profiles.firstOrNull()?.id).putExtra("date",today)
        views.setOnClickPendingIntent(R.id.next_widget_image,PendingIntent.getActivity(c,id,intent,PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        val density=c.resources.displayMetrics.density
        views.setViewPadding(R.id.next_widget_rows,0,(picture.topDp*density).roundToInt(),0,(picture.bottomDp*density).roundToInt())
        for((i,row)in rows.withIndex()){
            views.setViewVisibility(row,if(profiles.getOrNull(i)!=null)View.VISIBLE else if(detailed)View.INVISIBLE else View.GONE)
            profiles.getOrNull(i)?.let{profile->
                views.setContentDescription(row,picture.rows[i])
                val open=Intent(c,NextActivity::class.java).setData(android.net.Uri.parse("svitlo-next://widget/$id/row/$i")).putExtra("profile",profile.id).putExtra("date",today)
                views.setOnClickPendingIntent(row,PendingIntent.getActivity(c,id*31+i,open,PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
            }
        }
        val paging=detailed&&all.size>4
        views.setViewVisibility(R.id.next_widget_prev,if(paging)View.VISIBLE else View.GONE)
        views.setTextViewText(R.id.next_widget_next,if(paging)"›"else"↻ Оновити")
        views.setTextViewTextSize(R.id.next_widget_next,android.util.TypedValue.COMPLEX_UNIT_DIP,if(paging)24f else 11f)
        views.setBoolean(R.id.next_widget_prev,"setEnabled",page>0)
        views.setBoolean(R.id.next_widget_next,"setEnabled",!paging||page<maxPage)
        // View.setAlpha is not a RemoteViews method on API26. Text color alpha
        // preserves the disabled optical state without replacing the whole widget
        // with Android's error view on older hosts.
        val accent=WidgetStyle.palette().accent
        views.setTextColor(R.id.next_widget_prev,androidx.core.graphics.ColorUtils.setAlphaComponent(accent,if(page>0)255 else 89))
        views.setTextColor(R.id.next_widget_next,androidx.core.graphics.ColorUtils.setAlphaComponent(accent,if(!paging||page<maxPage)255 else 89))
        views.setContentDescription(R.id.next_widget_next,if(paging)"Наступні адреси"else"Оновити")
        for((control,delta)in listOf(R.id.next_widget_prev to -1,R.id.next_widget_next to 1)){
            val event=Intent(c,if(detailed)NextDetailedWidget::class.java else NextCompactWidget::class.java).setAction(if(paging)"ua.svitlo.next.PAGE"else"ua.svitlo.next.REFRESH").putExtra("widget",id).putExtra("delta",delta)
            views.setOnClickPendingIntent(control,PendingIntent.getBroadcast(c,id*53+delta,event,PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        }
        manager.updateAppWidget(id,views)
    }

}
open class NextDetailedWidget:AppWidgetProvider(){open val detailed=true
    override fun onUpdate(c:Context,m:AppWidgetManager,ids:IntArray){ids.forEach{NextWidgets.render(c,m,it,detailed)};NextWork.schedule(c)}
    override fun onAppWidgetOptionsChanged(c:Context,m:AppWidgetManager,id:Int,o:Bundle){NextWidgets.render(c,m,id,detailed)}
    override fun onDeleted(c:Context,ids:IntArray){val p=c.getSharedPreferences("next_widget_pages",Context.MODE_PRIVATE);val edit=p.edit();ids.forEach{edit.remove("page-$it")};edit.commit();NextWidgets.scheduleTick(c)}
    override fun onReceive(c:Context,i:Intent){
        super.onReceive(c,i)
        when(i.action){
            "ua.svitlo.next.TICK"->NextWidgets.update(c)
            "ua.svitlo.next.PAGE"->{
                val id=i.getIntExtra("widget",-1);val manager=AppWidgetManager.getInstance(c)
                if(manager.getAppWidgetInfo(id)?.provider!=ComponentName(c,javaClass))return
                val p=c.getSharedPreferences("next_widget_pages",Context.MODE_PRIVATE);val pages=(NextRepository(c).profiles().size-1).coerceAtLeast(0)/4
                p.edit().putInt("page-$id",(p.getInt("page-$id",0)+i.getIntExtra("delta",0)).coerceIn(0,pages)).commit();NextWidgets.render(c,manager,id,detailed)
            }
            "ua.svitlo.next.REFRESH"->WorkManager.getInstance(c).enqueueUniqueWork("next-manual",ExistingWorkPolicy.KEEP,OneTimeWorkRequestBuilder<NextRefreshWorker>().setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build())
            "ua.svitlo.next.PINNED"->{c.getSharedPreferences("next_widget_pages",Context.MODE_PRIVATE).edit().remove("pin-${javaClass.name}").commit();NextWidgets.update(c);Toast.makeText(c,"Віджет додано",Toast.LENGTH_SHORT).show()}
        }
    }
}
class NextCompactWidget:NextDetailedWidget(){override val detailed=false}
