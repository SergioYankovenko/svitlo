package ua.svitlo.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.graphics.*
import android.net.Uri
import android.os.Build
import android.util.SizeF
import android.util.TypedValue
import android.view.View
import android.widget.*
import android.text.SpannableString
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.text.style.BackgroundColorSpan
import android.text.style.AbsoluteSizeSpan
import ua.svitlo.widget.core.*
import java.time.*
import java.time.format.DateTimeFormatter
import kotlin.math.*

internal object DetailedWidget {
    private val colors=Palette.app()
    data class Row(val profile:AddressProfile,val snapshot:Snapshot)
    data class Metrics(val stacked:Boolean,val metadata:Int,val minimum:Int)
    fun rows(context:Context,now:Instant)=AddressProfiles(context).snapshots(now).map{Row(it.first,it.second)}
    private fun dp(context:Context,value:Float)=(value*context.resources.displayMetrics.density).roundToInt()
    private fun measure(context:Context,rv:RemoteViews,width:Int,height:Int?=null):View {
        val view=rv.apply(context,FrameLayout(context))
        view.measure(View.MeasureSpec.makeMeasureSpec(width.coerceAtLeast(1),View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(height ?: 0,if(height==null)View.MeasureSpec.UNSPECIFIED else View.MeasureSpec.EXACTLY))
        view.layout(0,0,view.measuredWidth,view.measuredHeight);return view
    }
    fun status(snapshot:Snapshot,now:Instant):String {
        if(!snapshot.isCompleteAndFresh(now))return if(snapshot.openEmergency(now))"Час відновлення уточнюється"else"Стан невідомий"
        val active=snapshot.allEvents().filter{it.start<=now && (it.end==null || it.end>now)}
        if(active.isNotEmpty()) {
            var end=active.mapNotNull{it.end}.maxOrNull()
            var approximate=active.any{it.plannedEnd}
            if(active.any{it.end==null})return "Час відновлення уточнюється"
            for(event in snapshot.allEvents()) {
                if(event.start<=now)continue
                if(event.start>end!!)break
                if(event.end==null)return "Час відновлення уточнюється"
                end=maxOf(end,event.end);approximate=approximate || event.plannedEnd
            }
            return "Увімкнуть світло ${if(approximate)"≈ "else""}${whenTime(end!!,now)}"
        }
        val next=Timeline.nextOutage(snapshot,now)
        if(next!=null)return "Вимкнуть світло ${whenTime(next.start,now)}"
        return if(snapshot.knownDay(now.atZone(KYIV_ZONE).toLocalDate(),now))"Без відключень до кінця дня"else"Стан невідомий"
    }
    private fun whenTime(at:Instant,now:Instant):String {
        val date=at.atZone(KYIV_ZONE).toLocalDate();val today=now.atZone(KYIV_ZONE).toLocalDate()
        return when(date){today->"о ";today.plusDays(1)->"завтра о ";else->"${date.format(DateTimeFormatter.ofPattern("dd.MM"))} о "}+Presentation.time(at)
    }
    fun header(snapshot:Snapshot,now:Instant):String {
        val kind=ScheduleLabels.contextKind(now.atZone(KYIV_ZONE).toLocalDate(),snapshot,now)
        return kind?.label ?: if(snapshot.isCompleteAndFresh(now) && snapshot.knownDay(now.atZone(KYIV_ZONE).toLocalDate(),now))"Без відключень"else"Стан невідомий"
    }
    private fun pending(context:Context,profile:AddressProfile?,screen:String,date:LocalDate):PendingIntent {
        val intent=Intent(context,MainActivity::class.java).setAction("ua.svitlo.widget.OPEN_PROFILE")
            .setData(Uri.parse("svitlo://widget/${profile?.id ?: "active"}/$screen/$date"))
            .putExtra("screen",screen).putExtra("date",date.toString()).putExtra("profile_id",profile?.id)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(context,0,intent,PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
    fun render(context:Context,size:SizeF,resolution:Float,now:Instant,widgetId:Int=AppWidgetManager.INVALID_APPWIDGET_ID):RemoteViews {
        val sizing=WidgetSizing.forSize(size)
        val rv=RemoteViews(context.packageName,if(sizing.short)R.layout.widget_detailed_compact else R.layout.widget_detailed)
        fun text(id:Int,sp:Float,floor:Float)=rv.setTextViewTextSize(id,TypedValue.COMPLEX_UNIT_PX,sizing.textPx(context,sp,floor))
        text(R.id.detail_heading,20f,14f);text(R.id.detail_weather,24f,16f)
        text(R.id.detail_empty,14f,11f)
        for(id in listOf(R.id.detail_legend,R.id.detail_legend_stacked,R.id.detail_refresh,R.id.detail_refresh_stacked))text(id,12f,10f)
        val profiles=rows(context,now);val binding=OutageRepository(context).binding();val active=profiles.firstOrNull{it.profile.binding==binding}?.profile
        val paged=profiles.size>WidgetPages.SIZE
        val page=WidgetPages.page(context,widgetId,profiles.size)
        val visible=profiles.drop(page*WidgetPages.SIZE).take(WidgetPages.SIZE)
        val snapshot=profiles.firstOrNull{it.profile.id==active?.id}?.snapshot ?: Snapshot(emptyMap(),Category.entries.toSet())
        val day=now.atZone(KYIV_ZONE).toLocalDate()
        val heading="Мої адреси · ${profiles.size}"
        rv.setTextViewText(R.id.detail_heading,heading)
        rv.setContentDescription(R.id.detail_heading,"Мої адреси. Збережено: ${profiles.size}. Відкрити застосунок")
        rv.setOnClickPendingIntent(R.id.detail_heading,pending(context,active,"home",day))
        val weather=WeatherRepository(context).snapshotFor(active?.binding)
        val weatherText=weather?.let{"${WeatherDisplay.icon(it.weatherCode,it.isDay)} ${WeatherDisplay.temperature(it.temperatureC)}${if(!it.isFresh(now))" !"else""}"} ?: "—°"
        rv.setTextViewText(R.id.detail_weather,weatherText)
        rv.setContentDescription(R.id.detail_weather,"Погода активної адреси. $weatherText"+if(weather?.isFresh(now)==false)". Дані застарілі"else"")
        rv.setOnClickPendingIntent(R.id.detail_weather,pending(context,active,"weather",day))
        val refresh=PendingIntent.getBroadcast(context,2,Intent(context,SvitloWidget::class.java).setAction(WidgetRenderer.REFRESH),PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        rv.setOnClickPendingIntent(R.id.detail_refresh,refresh)
        val refreshText=if(RefreshWorker.running(context))"↻ Триває…"else if(!RefreshWorker.online(context))"↻ Без мережі"else"↻ Оновити"
        rv.setTextViewText(R.id.detail_refresh,if(sizing.short)"↻"else refreshText);rv.setContentDescription(R.id.detail_refresh,"$refreshText. Оновити всі адреси та погоду активної адреси")
        // Explicit resets also handle RemoteViews.reapply after 5→4 addresses or resize.
        rv.setViewVisibility(R.id.detail_footer_row,View.VISIBLE)
        rv.setViewVisibility(R.id.detail_legend_stacked,View.GONE)
        rv.setViewVisibility(R.id.detail_refresh_stacked,View.GONE)
        rv.setViewVisibility(R.id.detail_refresh,if(paged)View.GONE else View.VISIBLE)
        rv.setViewVisibility(R.id.detail_pager,if(paged)View.VISIBLE else View.GONE)
        for((view,target) in listOf(R.id.detail_previous to page-1,R.id.detail_next to page+1)){
            val enabled=paged && target in 0 until WidgetPages.count(profiles.size)
            rv.setBoolean(view,"setEnabled",enabled)
            rv.setInt(view,"setImageAlpha",if(enabled)255 else 64)
            val label=if(view==R.id.detail_previous)"Попередні адреси"else"Наступні адреси"
            rv.setContentDescription(view,"$label. Сторінка ${page+1} із ${WidgetPages.count(profiles.size)}")
            val intent=Intent(context,SvitloWidget::class.java).setAction(WidgetRenderer.PAGE)
                .setData(Uri.parse("svitlo://widget/$widgetId/page/$target"))
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID,widgetId).putExtra("page",target)
            rv.setOnClickPendingIntent(view,if(enabled)PendingIntent.getBroadcast(context,0,intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)else null)
        }
        val contextKind=ScheduleLabels.currentOrNextKind(visible.map{it.snapshot},now)
        val legendKind=contextKind ?: OutageKind.HOURLY
        val legend=WidgetStyle.legend(listOf(legendKind.category),listOf(legendKind))
        rv.setTextViewText(R.id.detail_legend,legend)
        val footerPaint=Paint().apply{textSize=sizing.textPx(context,12f,10f)}
        if(!paged && !sizing.short && footerPaint.measureText(legend.toString())+footerPaint.measureText(refreshText)+dp(context,8f)>dp(context,size.width-24)){
            rv.setViewVisibility(R.id.detail_footer_row,View.GONE)
            rv.setViewVisibility(R.id.detail_legend_stacked,View.VISIBLE);rv.setTextViewText(R.id.detail_legend_stacked,legend)
            rv.setViewVisibility(R.id.detail_refresh_stacked,View.VISIBLE);rv.setTextViewText(R.id.detail_refresh_stacked,refreshText)
            rv.setOnClickPendingIntent(R.id.detail_refresh_stacked,refresh)
            rv.setContentDescription(R.id.detail_refresh_stacked,"$refreshText. Оновити всі адреси та погоду активної адреси")
        }
        val legendDescription="Світло є. Світла немає: "+(contextKind?.label ?: "зразок позначення")+". Штрихування — невідомі дані"
        rv.setContentDescription(R.id.detail_legend,legendDescription);rv.setContentDescription(R.id.detail_legend_stacked,legendDescription)
        val width=dp(context,size.width);val height=dp(context,size.height)
        val skeleton=measure(context,rv,width,height)
        val body=skeleton.findViewById<View>(R.id.detail_body)
        val inner=body.width.coerceAtLeast(1)
        // Each responsive size shares the renderer's bitmap budget; no full-widget bitmap.
        val scale=resolution.coerceIn(.1f,2f)/context.resources.displayMetrics.density
        val axisText=sizing.textPx(context,11f,9f)
        val axisHeight=Paint().apply{textSize=axisText}.fontMetrics.let{ceil(it.descent-it.ascent).toInt()+dp(context,3f)}
        rv.setInt(R.id.detail_axis,"setMaxHeight",axisHeight)
        rv.setImageViewBitmap(R.id.detail_axis,axis(context,inner,axisHeight,scale,day,axisText))
        // Account for scaled axis text when choosing rows, before any bitmap allocations.
        // The empty skeleton has no axis bitmap yet, so reserve its final height.
        val available=(body.height-axisHeight).coerceAtLeast(1)
        rv.removeAllViews(R.id.detail_rows)
        rv.setViewVisibility(R.id.detail_rows,View.VISIBLE)
        rv.setViewVisibility(R.id.detail_list,View.GONE)
        rv.setViewVisibility(R.id.detail_empty,View.GONE)
        rv.setTextViewText(R.id.detail_empty,"Додайте адресу")
        rv.setViewVisibility(R.id.detail_axis,View.VISIBLE)
        if(profiles.isEmpty()) {
            rv.setViewVisibility(R.id.detail_empty,View.VISIBLE)
            rv.setOnClickPendingIntent(R.id.detail_empty,pending(context,null,"home",day));return rv
        }
        // Reserve four slots even on the final partial page. Arrows, axis and row
        // heights stay put while paging; larger widgets still display four per page.
        val metrics=profiles.map{metrics(context,it,inner,now,sizing)}
        val slots=minOf(WidgetPages.SIZE,profiles.size)
        val rowHeight=available/slots
        if(metrics.any{it.minimum>rowHeight}) {
            // A launcher can shrink below four readable touch targets. Never show
            // clipped scales or silently reintroduce the rejected scrolling list.
            rv.setViewVisibility(R.id.detail_rows,View.GONE)
            rv.setViewVisibility(R.id.detail_empty,View.VISIBLE)
            rv.setTextViewText(R.id.detail_empty,"Збільште віджет, щоб бачити графіки")
            rv.setOnClickPendingIntent(R.id.detail_empty,null)
            rv.setViewVisibility(R.id.detail_axis,View.GONE)
            return rv
        }
        visible.forEachIndexed{i,row->
            rv.addView(R.id.detail_rows,row(context,row,inner,rowHeight,scale,now,i==0,i==visible.lastIndex,false,
                metrics[page*WidgetPages.SIZE+i],sizing))
        }
        return rv
    }
    private fun base(context:Context,row:Row,stacked:Boolean,now:Instant,sizing:WidgetSizing):RemoteViews {
        val rv=RemoteViews(context.packageName,if(stacked)R.layout.widget_address_stacked else R.layout.widget_address_row)
        rv.setTextViewTextSize(R.id.address_name,TypedValue.COMPLEX_UNIT_PX,sizing.textPx(context,14f,11f))
        rv.setTextViewTextSize(R.id.address_queue,TypedValue.COMPLEX_UNIT_PX,sizing.textPx(context,14f,11f))
        rv.setTextViewTextSize(R.id.address_action,TypedValue.COMPLEX_UNIT_PX,sizing.textPx(context,12f,10f))
        fun backed(value:String)=SpannableString(value).apply{setSpan(BackgroundColorSpan(colors.surface),0,length,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)}
        rv.setTextViewText(R.id.address_name,backed(row.profile.name.ifBlank{row.profile.binding.address}))
        val queue=row.snapshot.queueLabel()?.let{"ϟ $it · "} ?: "ϟ "
        rv.setTextViewText(R.id.address_queue,backed(queue).apply{
            setSpan(ForegroundColorSpan(WidgetStyle.signalColor(row.snapshot,now)),0,1,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        })
        rv.setViewVisibility(R.id.address_queue,View.VISIBLE)
        rv.setTextViewText(R.id.address_action,backed(status(row.snapshot,now)))
        return rv
    }
    fun metrics(context:Context,row:Row,width:Int,now:Instant,sizing:WidgetSizing=WidgetSizing()):Metrics {
        val paint=Paint().apply{textSize=sizing.textPx(context,12f,10f)}
        val actionWidth=ceil(paint.measureText(status(row.snapshot,now))).toInt()
        val stacked=actionWidth+dp(context,maxOf(40f,72f*sizing.factor)+8f)>width
        fun textHeight(text:String,sp:Float,floor:Float,limit:Int,single:Boolean):Int {
            val view=TextView(context).apply{this.text=text;setTextSize(TypedValue.COMPLEX_UNIT_PX,sizing.textPx(context,sp,floor));if(single)maxLines=1}
            view.measure(View.MeasureSpec.makeMeasureSpec(limit.coerceAtLeast(1),View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(0,View.MeasureSpec.UNSPECIFIED))
            return view.measuredHeight
        }
        val name=textHeight(rowLabel(row),14f,11f,if(stacked)width else width-actionWidth-dp(context,8f),true)
        val action=textHeight(status(row.snapshot,now),12f,10f,if(stacked)width else actionWidth,false)
        val meta=if(stacked)name+action else maxOf(name,action)
        return Metrics(stacked,meta,maxOf(dp(context,48f),meta+dp(context,16f)))
    }
    private fun rowLabel(row:Row)=(row.snapshot.queueLabel()?.let{"ϟ $it · "} ?: "ϟ ")+row.profile.name.ifBlank{row.profile.binding.address}
    fun row(context:Context,row:Row,width:Int,height:Int,scale:Float,now:Instant,first:Boolean,last:Boolean,collection:Boolean,layout:Metrics?=null,sizing:WidgetSizing=WidgetSizing()):RemoteViews {
        val metrics=layout ?: metrics(context,row,width,now,sizing);val rv=base(context,row,metrics.stacked,now,sizing)
        val paint=Paint().apply{textSize=sizing.textPx(context,12f,10f)}
        val nameGroupWidth=if(metrics.stacked)width else width-ceil(paint.measureText(status(row.snapshot,now))).toInt()-dp(context,8f)
        paint.textSize=sizing.textPx(context,14f,11f)
        val queueWidth=paint.measureText(row.snapshot.queueLabel()?.let{"ϟ $it · "} ?: "ϟ ")
        rv.setInt(R.id.address_name,"setMaxWidth",(nameGroupWidth-ceil(queueWidth).toInt()).coerceAtLeast(1))
        val gap=dp(context,4f);val tail=dp(context,4f)
        val bar=(height-metrics.metadata-gap-tail).coerceAtLeast(dp(context,8f))
        rv.setInt(R.id.address_chart,"setMinimumHeight",bar);rv.setInt(R.id.address_chart,"setMaxHeight",bar)
        // LayoutParams height is controlled through setInt on the content's minimum height;
        // image adjusts its bounds to the exact bitmap ratio, preserving a shared time coordinate.
        rv.setInt(R.id.address_row,"setMinimumHeight",height)
        val unit=context.resources.displayMetrics.density*scale
        rv.setImageViewBitmap(R.id.address_chart,track(width,bar,scale,row.snapshot,now,unit))
        rv.setImageViewBitmap(R.id.address_marker,marker(width,height,scale,now,if(first)metrics.metadata+gap else 0,if(last)height-tail else height,first,unit))
        val label="${row.profile.name.ifBlank{row.profile.binding.address}}. ${row.profile.binding.address}. "+
            (row.snapshot.queueLabel()?.let{"Черга $it. "} ?: "Черга невідома. ")+status(row.snapshot,now)+". Графік на сьогодні. Відкрити цю адресу"
        rv.setContentDescription(R.id.address_row,label)
        val date=now.atZone(KYIV_ZONE).toLocalDate()
        if(collection)rv.setOnClickFillInIntent(R.id.address_row,Intent().setData(Uri.parse("svitlo://profile/${row.profile.id}/$date"))
            .putExtra("profile_id",row.profile.id).putExtra("screen","graph").putExtra("date",date.toString()))
        else rv.setOnClickPendingIntent(R.id.address_row,pending(context,row.profile,"graph",date))
        return rv
    }
    private fun bitmap(width:Int,height:Int,scale:Float)=Bitmap.createBitmap((width*scale).roundToInt().coerceAtLeast(1),(height*scale).roundToInt().coerceAtLeast(1),Bitmap.Config.ARGB_8888)
    private fun markerX(width:Float,now:Instant):Float {
        val day=now.atZone(KYIV_ZONE).toLocalDate();val from=day.atStartOfDay(KYIV_ZONE).toInstant();val to=day.plusDays(1).atStartOfDay(KYIV_ZONE).toInstant()
        return (Duration.between(from,now).toMillis().toDouble()/Duration.between(from,to).toMillis()*width).toFloat().coerceIn(0f,width)
    }
    private fun marker(width:Int,height:Int,scale:Float,now:Instant,top:Int,bottom:Int,dot:Boolean,unit:Float):Bitmap {
        val bitmap=bitmap(width,height,scale);val canvas=Canvas(bitmap);val p=Paint(Paint.ANTI_ALIAS_FLAG).apply{color=colors.ink;strokeWidth=2*unit}
        val x=markerX(bitmap.width.toFloat(),now);canvas.drawLine(x,top*scale,x,bottom*scale,p)
        if(dot)canvas.drawCircle(x,top*scale,3*unit,p)
        return bitmap
    }
    private fun track(width:Int,height:Int,scale:Float,snapshot:Snapshot,now:Instant,unit:Float):Bitmap {
        val bitmap=bitmap(width,height,scale);val canvas=Canvas(bitmap);val p=Paint(Paint.ANTI_ALIAS_FLAG)
        val w=bitmap.width.toFloat();val h=bitmap.height.toFloat();val day=now.atZone(KYIV_ZONE).toLocalDate()
        canvas.clipPath(Path().apply{addRoundRect(RectF(0f,0f,w,h),5*unit,5*unit,Path.Direction.CW)})
        val bins=Timeline.bins(day,snapshot,now)
        bins.forEachIndexed{i,bin->
            val left=i*w/bins.size;val right=(i+1)*w/bins.size
            p.isAntiAlias=false
            p.color=if(bin.category==null && !bin.uncertain)WidgetStyle.power else colors.outage(bin.category,bin.kind)
            canvas.drawRect(left,0f,right+.5f,h,p)
            if(bin.uncertain){p.isAntiAlias=true;p.color=colors.muted;p.alpha=90;p.strokeWidth=.8f*unit
                val saved=canvas.save();canvas.clipRect(left,0f,right,h);var x=left-h
                while(x<right){canvas.drawLine(x,h,x+h,0f,p);x+=5*unit};canvas.restoreToCount(saved);p.alpha=255}
        }
        p.color=colors.ink;p.strokeWidth=2*unit;val x=markerX(w,now);canvas.drawLine(x,0f,x,h,p)
        return bitmap
    }
    private fun axis(context:Context,width:Int,height:Int,scale:Float,date:LocalDate,textPx:Float):Bitmap {
        val bitmap=bitmap(width,height,scale);val canvas=Canvas(bitmap)
        val p=Paint(Paint.ANTI_ALIAS_FLAG).apply{color=colors.muted;textSize=textPx*scale}
        val from=date.atStartOfDay(KYIV_ZONE).toInstant();val to=date.plusDays(1).atStartOfDay(KYIV_ZONE).toInstant()
        for(hour in listOf(0,6,12,18,24)) {
            val at=if(hour==24)to else date.atTime(hour,0).atZone(KYIV_ZONE).toInstant()
            val x=(Duration.between(from,at).toMillis().toDouble()/Duration.between(from,to).toMillis()*bitmap.width).toFloat()
            val label=hour.toString().padStart(2,'0');val left=(x-p.measureText(label)/2).coerceIn(0f,(bitmap.width-p.measureText(label)).coerceAtLeast(0f))
            canvas.drawText(label,left,-p.ascent(),p)
        }
        return bitmap
    }
}

/** Android collection only for the exceptional overflow case. No HTTP or activation here. */
class AddressWidgetService:RemoteViewsService() {
    override fun onGetViewFactory(intent:Intent):RemoteViewsFactory=object:RemoteViewsFactory {
        private var data=emptyList<DetailedWidget.Row>();private var now=Instant.now()
        private val width=intent.getIntExtra("row_width",300).coerceIn(80,4000)
        private val scale=intent.getFloatExtra("row_resolution",1f).coerceIn(.05f,2f)
        private val sizing=WidgetSizing(intent.getFloatExtra("text_factor",1f).coerceIn(.35f,1f))
        override fun onCreate(){}
        override fun onDataSetChanged(){now=Instant.now();data=DetailedWidget.rows(this@AddressWidgetService,now)}
        override fun onDestroy(){data=emptyList()}
        override fun getCount()=data.size
        override fun getViewAt(position:Int):RemoteViews? {
            val row=data.getOrNull(position) ?: return null
            val context=this@AddressWidgetService
            val layout=DetailedWidget.metrics(context,row,width,now,sizing)
            return DetailedWidget.row(context,row,width,layout.minimum,scale,now,position==0,position==data.lastIndex,true,layout,sizing)
        }
        override fun getLoadingView():RemoteViews?=null
        override fun getViewTypeCount()=2
        override fun getItemId(position:Int)=data.getOrNull(position)?.profile?.id?.hashCode()?.toLong() ?: position.toLong()
        override fun hasStableIds()=true
    }
}
