package ua.svitlo.widget

import android.app.PendingIntent
import android.app.AlarmManager
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Paint
import android.graphics.Typeface
import android.os.Bundle
import android.os.Build
import android.os.SystemClock
import android.text.SpannableString
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.util.TypedValue
import android.util.SizeF
import android.view.View
import android.widget.RemoteViews
import android.widget.FrameLayout
import android.widget.ImageView
import ua.svitlo.widget.core.*
import java.time.Instant
import kotlin.math.roundToInt
import kotlin.math.sqrt
import kotlin.math.floor

open class SvitloWidget:AppWidgetProvider() {
    private fun redrawAsync(context:Context){val pending=goAsync();WidgetRenderer.enqueueUpdate(context){pending?.finish()}}
    override fun onUpdate(context:Context, manager:AppWidgetManager, ids:IntArray) { redrawAsync(context); RefreshWorker.schedule(context) }
    override fun onAppWidgetOptionsChanged(context:Context, manager:AppWidgetManager, id:Int, options:Bundle) { redrawAsync(context) }
    override fun onReceive(context:Context, intent:Intent) {
        super.onReceive(context,intent)
        if(intent.action==WidgetRenderer.REFRESH) RefreshWorker.request(context)
        if(intent.action==WidgetRenderer.TICK) redrawAsync(context)
        if(intent.action==WidgetRenderer.PAGE) {
            val id=intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID,AppWidgetManager.INVALID_APPWIDGET_ID)
            val ids=AppWidgetManager.getInstance(context).getAppWidgetIds(ComponentName(context,SvitloWidget::class.java))
            if(id in ids){
                WidgetPages.select(context,id,intent.getIntExtra("page",0),AddressProfiles(context).profiles().size)
                redrawAsync(context)
            }
        }
    }
    // Deletion broadcasts can arrive after a new pin request has already begun.
    // They belong to widget IDs, not to that request's confirmation token.
    override fun onDeleted(context:Context,ids:IntArray){WidgetPages.remove(context,ids)}
    override fun onDisabled(context:Context){redrawAsync(context)}
}
class CompactWidget:SvitloWidget()

object WidgetRenderer {
    const val REFRESH="ua.svitlo.widget.REFRESH"
    const val TICK="ua.svitlo.widget.TICK"
    const val PAGE="ua.svitlo.widget.PAGE"
    private val renderExecutor=java.util.concurrent.Executors.newSingleThreadExecutor()
    private val queueLock=Any()
    private var renderRunning=false
    private var renderAgain=false
    private val completions=mutableListOf<()->Unit>()
    /** Native measurements and bitmap preparation must not block Activity/receiver frames. */
    fun enqueueUpdate(context:Context,complete:()->Unit={}){
        val app=context.applicationContext
        synchronized(queueLock){
            completions+=complete;renderAgain=true
            if(renderRunning)return
            renderRunning=true
        }
        renderExecutor.execute {
            while(true){
                synchronized(queueLock){renderAgain=false}
                try{updateAll(app)}catch(error:RuntimeException){android.util.Log.w("SvitloWidget","Widget redraw failed: ${error.javaClass.simpleName}")}
                val callbacks=synchronized(queueLock){
                    if(renderAgain)null else completions.toList().also{completions.clear();renderRunning=false}
                } ?: continue
                callbacks.forEach{runCatching(it)};break
            }
        }
    }
    // Binding changes publish on the main thread while the worker can also redraw.
    // Finish an older render+publish pass before the newer binding publishes its own.
    @Synchronized
    fun updateAll(context:Context) {
        val manager=AppWidgetManager.getInstance(context)
        var count=0
        for((klass,compact) in listOf(SvitloWidget::class.java to false,CompactWidget::class.java to true)) {
            val ids=manager.getAppWidgetIds(ComponentName(context,klass))
            count+=ids.size
            ids.forEach { id ->
                manager.updateAppWidget(id, render(context,id,compact))
            }
        }
        // Local redraw only: an inexact, non-wakeup alarm does not fetch data or wake a sleeping phone.
        val alarm=context.getSystemService(AlarmManager::class.java)
        val pending=PendingIntent.getBroadcast(context,3,Intent(context,SvitloWidget::class.java).setAction(TICK),PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        if(count>0) alarm.set(AlarmManager.ELAPSED_REALTIME,SystemClock.elapsedRealtime()+60_000-(System.currentTimeMillis()%60_000),pending) else alarm.cancel(pending)
    }
    fun render(context:Context,id:Int,compact:Boolean,at:Instant=Instant.now()):RemoteViews {
        val options=AppWidgetManager.getInstance(context).getAppWidgetOptions(id)
        val normalHeight=if(compact)184 else 260
        fun option(key:String,default:Int)=options.getInt(key,default).takeIf{it>0} ?: default
        val portrait=SizeF(option(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH,300).toFloat(),
            option(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT,normalHeight).toFloat())
        val landscape=SizeF(option(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH,300).toFloat(),
            option(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT,normalHeight).toFloat())
        @Suppress("DEPRECATION")
        val responsive=if(Build.VERSION.SDK_INT>=31) options.getParcelableArrayList<SizeF>(AppWidgetManager.OPTION_APPWIDGET_SIZES)
            .orEmpty().filter{it.width.isFinite() && it.height.isFinite() && it.width>0 && it.height>0}.distinct().take(16) else emptyList()
        val sizes=responsive.ifEmpty{listOf(landscape,portrait)}
        // Android limits RemoteViews bitmap memory against the screen area. Share
        // one screen's pixel budget across every advertised size/orientation.
        val metrics=context.resources.displayMetrics
        val budget=(metrics.widthPixels.toDouble()*metrics.heightPixels).coerceAtLeast(1.0)
        val resolution=minOf(2.0,sqrt(budget/sizes.sumOf{it.width.toDouble()*it.height})).toFloat()
        if(Build.VERSION.SDK_INT>=31 && responsive.isNotEmpty()) {
            return RemoteViews(responsive.associateWith{renderSize(context,it,compact,resolution,at,id)})
        }
        // The launcher can rotate without a provider callback. Supply both layouts
        // so it can choose the correct height immediately in either orientation.
        fun oriented(orientation:Int,size:SizeF):RemoteViews {
            val config=Configuration(context.resources.configuration).apply{this.orientation=orientation}
            return renderSize(context.createConfigurationContext(config),size,compact,resolution,at,id)
        }
        return RemoteViews(oriented(Configuration.ORIENTATION_LANDSCAPE,landscape),oriented(Configuration.ORIENTATION_PORTRAIT,portrait))
    }
    private fun renderSize(context:Context,size:SizeF,compact:Boolean,resolution:Float,now:Instant,id:Int):RemoteViews {
        if(!compact)return DetailedWidget.render(context,size,resolution,now,id)
        val repo=OutageRepository(context,now={now}); val binding=repo.binding(); val snapshot=repo.snapshot()
        val weather=WeatherRepository(context).let{runCatching{it.discardTravelLocation()};it.snapshotFor(binding)}; val colors=WidgetStyle.palette()
        val rv=RemoteViews(context.packageName,if(compact) R.layout.widget_compact else R.layout.widget_svitlo)
        rv.setInt(R.id.widget_root,"setBackgroundResource",R.drawable.widget_dark_bg)
        listOf(R.id.widget_title,R.id.weather_now,R.id.widget_refresh).forEach{rv.setTextColor(it,colors.ink)}
        listOf(R.id.weather_next,R.id.widget_legend).forEach{rv.setTextColor(it,colors.muted)}
        val normalHeight=if(compact)184 else 260
        val availableHeight=size.height
        val availableWidth=size.width
        val fontScale=context.resources.configuration.fontScale.coerceAtLeast(1f)
        val tight=availableHeight<normalHeight*fontScale
        val dense=tight && availableHeight<(if(compact)140 else 210)
        val simplified=fontScale>=1.25f || dense
        val paddingDp=16
        val verticalPaddingDp=if(dense)4 else 8
        fun dp(value:Int)=(value*context.resources.displayMetrics.density).toInt()
        fun text(view:Int,value:CharSequence)=rv.setTextViewText(view,value)
        // RemoteViews cannot use a custom layout. Fit single-line values using the
        // actual Android font conversion (including Android 14+ nonlinear scaling).
        fun fitText(view:Int,value:String,preferredSp:Float,maxFontDp:Float,widthDp:Float){
            val metrics=context.resources.displayMetrics
            val paint=Paint(Paint.ANTI_ALIAS_FLAG).apply{typeface=Typeface.DEFAULT_BOLD}
            var low=1f;var high=preferredSp
            repeat(16){
                val sp=(low+high)/2f
                paint.textSize=TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP,sp,metrics)
                if(paint.textSize<=maxFontDp*metrics.density && paint.measureText(value)<=(widthDp-3).coerceAtLeast(1f)*metrics.density)low=sp else high=sp
            }
            rv.setTextViewTextSize(view,TypedValue.COMPLEX_UNIT_SP,low)
        }
        val flags=Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        val open=PendingIntent.getActivity(context,0,Intent(context,MainActivity::class.java).putExtra("screen","home").addFlags(flags),PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val forecast=PendingIntent.getActivity(context,1,Intent(context,MainActivity::class.java).putExtra("screen","weather").addFlags(flags),PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val refresh=PendingIntent.getBroadcast(context,2,Intent(context,SvitloWidget::class.java).setAction(REFRESH),PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        rv.setOnClickPendingIntent(R.id.widget_root,open); rv.setOnClickPendingIntent(R.id.widget_weather,forecast); rv.setOnClickPendingIntent(R.id.widget_refresh,refresh)
        val status=if(binding==null) "Оберіть адресу" else Presentation.widgetStatus(snapshot,now)
        val signal=if(binding==null) Presentation.WidgetSignal.UNKNOWN else Presentation.widgetSignal(snapshot,now)
        val queue=snapshot.queueLabel()
        val widgetTitle="ϟ "+(queue?.let{"$it · "} ?: "")+status
        val signalColor=when(signal){
            Presentation.WidgetSignal.POWER->colors.accent
            Presentation.WidgetSignal.PLANNED->colors.hourly
            Presentation.WidgetSignal.EMERGENCY->colors.emergency
            Presentation.WidgetSignal.UNKNOWN->colors.muted
        }
        text(R.id.widget_title,SpannableString(widgetTitle).apply{
            setSpan(ForegroundColorSpan(signalColor),0,1,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        })
        val event=Timeline.nextOutage(snapshot,now)
        rv.setContentDescription(R.id.widget_title,(queue?.let{"Черга $it. "} ?: "")+status+". "+
            (if(binding==null) "Підтвердьте адресу в застосунку." else Presentation.headline(snapshot,now)+". "+Presentation.range(event,now)+".")+ 
            " Графік не гарантує фактичної наявності світла. Натисніть для подробиць.")
        listOf(R.id.widget_city,R.id.widget_headline,R.id.widget_range,R.id.widget_kind).forEach{rv.setViewVisibility(it,View.GONE)}
        val currentWeather=weather?.let { "${WeatherDisplay.icon(it.weatherCode,it.isDay)} ${WeatherDisplay.temperature(it.temperatureC)}${if(!it.isFresh(now)) " !" else ""}" } ?: "—°"
        val nextWeather=if(weather!=null && !weather.isFresh(now)) "Дані застарілі" else weather?.nextHours(now,1)?.firstOrNull()?.let { "${Presentation.time(it.time)}  ${WeatherDisplay.temperature(it.temperatureC)}" } ?: "Дані недоступні"
        text(R.id.weather_now,currentWeather)
        text(R.id.weather_next,nextWeather)
        val showWeather=true
        rv.setViewVisibility(R.id.widget_weather,if(showWeather)View.VISIBLE else View.GONE)
        rv.setInt(R.id.widget_refresh,"setHeight",dp(if(dense)24 else 48))
        rv.setViewPadding(R.id.widget_root,dp(paddingDp),dp(verticalPaddingDp),dp(paddingDp),dp(verticalPaddingDp))
        rv.setViewVisibility(R.id.weather_next,View.GONE)
        fitText(R.id.widget_title,widgetTitle,16f,if(dense)14f else 16f,(availableWidth-paddingDp*2-if(showWeather)68 else 0).toFloat())
        val sizing=WidgetSizing.forSize(size)
        rv.setTextViewTextSize(R.id.widget_legend,TypedValue.COMPLEX_UNIT_PX,sizing.textPx(context,12f,10f))
        rv.setTextViewTextSize(R.id.widget_refresh,TypedValue.COMPLEX_UNIT_PX,sizing.textPx(context,12f,10f))
        rv.setTextColor(R.id.widget_refresh,colors.accent)
        fitText(R.id.weather_now,currentWeather,16f,if(dense)14f else 16f,62f)
        fitText(R.id.weather_next,nextWeather,10f,10f,62f)
        val today=now.atZone(KYIV_ZONE).toLocalDate()
        fun chartIntent(day:java.time.LocalDate,request:Int)=PendingIntent.getActivity(context,request,
            Intent(context,MainActivity::class.java).putExtra("screen","graph").putExtra("date",day.toString()).addFlags(flags),PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        rv.setOnClickPendingIntent(R.id.widget_chart,if(binding==null)open else chartIntent(today,4))
        rv.setContentDescription(R.id.widget_chart,"Сьогодні. Поділки щогодини. Натисніть, щоб збільшити графік.")
        if(!compact){
            val published=binding!=null && HomeSchedule.published(today.plusDays(1),snapshot)
            rv.setOnClickPendingIntent(R.id.widget_tomorrow,if(published)chartIntent(today.plusDays(1),5)else null)
            // A disabled clickable child consumes the touch; it cannot fall through to widget_root.
            rv.setBoolean(R.id.widget_tomorrow,"setEnabled",published)
            rv.setContentDescription(R.id.widget_tomorrow,if(published)"Завтра. Поділки щогодини. Натисніть, щоб збільшити графік."else"Завтра. Графік не сформовано")
        }
        val legendEvents=snapshot.allEvents().filter{it.overlaps(today.atStartOfDay(KYIV_ZONE).toInstant(),today.plusDays(1).atStartOfDay(KYIV_ZONE).toInstant())}
        val legend=WidgetStyle.legend(legendEvents.map{it.category},legendEvents.map(OutageKind::of))
        text(R.id.widget_legend,legend)
        rv.setContentDescription(R.id.widget_legend,"Світло є. Світла немає. Кольори відповідають видам відключень. Штрихування — невизначені дані")
        val refreshLabel=if(RefreshWorker.running(context)) "↻ Триває…" else if(!RefreshWorker.online(context)) "↻ Без мережі" else "↻ Оновити"
        text(R.id.widget_refresh,if(dense)"↻"else refreshLabel)
        rv.setContentDescription(R.id.widget_refresh,refreshLabel+". Оновити графіки та погоду")
        // Measure the final native text and weighted chart slots, including the
        // actual font scaling. This detached skeleton has no bitmaps or callbacks
        // into render(), and can also be built by RefreshWorker off the UI thread.
        val skeleton=rv.apply(context,FrameLayout(context))
        val density=context.resources.displayMetrics.density
        val measuredWidth=(availableWidth*density).roundToInt().coerceAtLeast(1)
        val measuredHeight=(availableHeight*density).roundToInt().coerceAtLeast(1)
        skeleton.measure(View.MeasureSpec.makeMeasureSpec(measuredWidth,View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(measuredHeight,View.MeasureSpec.EXACTLY))
        skeleton.layout(0,0,measuredWidth,measuredHeight)
        val charts=if(compact)listOf(R.id.widget_chart to today) else listOf(R.id.widget_chart to today,R.id.widget_tomorrow to today.plusDays(1))
        for((viewId,day) in charts){
            val chart=skeleton.findViewById<ImageView>(viewId)
            val widthDp=chart.measuredWidth/density
            val heightDp=chart.measuredHeight/density
            // Round the shorter dimension first, then derive its partner from
            // the measured aspect ratio. Independent rounding magnifies a half
            // pixel error across a very wide or tall chart. Keep budget headroom.
            val targetScale=minOf(resolution*0.98f,999f/widthDp.coerceAtLeast(1f))
            val bitmapWidth:Int
            val bitmapHeight:Int
            val scale:Float
            if(widthDp<=heightDp){
                bitmapWidth=floor(widthDp*targetScale).toInt().coerceAtLeast(1)
                scale=bitmapWidth/widthDp.coerceAtLeast(1f)
                bitmapHeight=(heightDp*scale).roundToInt().coerceAtLeast(1)
            }else{
                bitmapHeight=floor(heightDp*targetScale).toInt().coerceAtLeast(1)
                scale=bitmapHeight/heightDp.coerceAtLeast(1f)
                bitmapWidth=(widthDp*scale).roundToInt().coerceIn(1,1000)
            }
            rv.setImageViewBitmap(viewId,ChartPainter.draw(bitmapWidth,
                day,snapshot,now,colors,condensed=dense,height=bitmapHeight,pixelsPerDp=scale,unpublishedLabel=day==today.plusDays(1) && !HomeSchedule.published(day,snapshot),powerColor=WidgetStyle.power,showDate=false))
        }
        return rv
    }
}
