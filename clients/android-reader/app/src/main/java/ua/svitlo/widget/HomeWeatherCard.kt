package ua.svitlo.widget

import android.content.Context
import android.graphics.drawable.GradientDrawable
import android.text.SpannableString
import android.text.Spanned
import android.text.method.LinkMovementMethod
import android.text.style.URLSpan
import android.view.Gravity
import android.view.View
import android.widget.*
import ua.svitlo.widget.core.*
import java.time.Instant

/** Retains the card, scroll and overlapping hours while background results arrive. */
internal class HomeWeatherCard(context:Context,private val colors:Palette):LinearLayout(context) {
    private fun dp(n:Int)=(n*resources.displayMetrics.density).toInt()
    private fun label(parent:LinearLayout,size:Int,bold:Boolean=false,color:Int=colors.ink)=TextView(context).apply{
        textSize=size.toFloat();setTextColor(color)
        if(bold)typeface=android.graphics.Typeface.create("sans-serif-medium",android.graphics.Typeface.NORMAL)
        parent.addView(this,LayoutParams(-1,-2))
    }
    private fun line(parent:LinearLayout,size:Int,bold:Boolean=false,color:Int=colors.ink)=TextSizing.singleLine(label(parent,size,bold,color),size)
    private val heading=LinearLayout(context).apply{orientation=HORIZONTAL;gravity=Gravity.CENTER_VERTICAL}
    private val temperature:TextView
    private val place:TextView
    private val condition:TextView
    private val notice:TextView
    private val hours=LinearLayout(context).apply{orientation=HORIZONTAL}
    val forecastScroll=HorizontalScrollView(context).apply{tag="weather_hours";isHorizontalScrollBarEnabled=false;addView(hours)}
    private val hourViews=linkedMapOf<Instant,LinearLayout>()
    init {
        tag="home_weather";orientation=VERTICAL;setPadding(dp(18),dp(18),dp(18),dp(18))
        background=GradientDrawable().apply{setColor(this@HomeWeatherCard.colors.surface);cornerRadius=dp(22).toFloat();setStroke(dp(1),this@HomeWeatherCard.colors.track)}
        line(this,12,true,colors.muted).text="СЬОГОДНІ"
        addView(heading,LayoutParams(-1,-2))
        temperature=line(heading,44,true,colors.accent).apply{tag="weather_temperature";layoutParams=LayoutParams(0,-2,1f)}
        val location=LinearLayout(context).apply{orientation=VERTICAL};heading.addView(location,LayoutParams(0,-2,1.3f))
        place=line(location,19,true)
        condition=line(location,16)
        notice=label(this,12,false,colors.muted).apply{tag="weather_notice";visibility=GONE}
        addView(forecastScroll,LayoutParams(-1,-2).apply{topMargin=dp(12)})
        label(this,11,false,colors.muted).apply{
            tag="weather_attribution";minHeight=dp(36);gravity=Gravity.CENTER_VERTICAL
            val value=SpannableString("Open-Meteo · CC BY 4.0 · GeoNames")
            listOf("Open-Meteo" to "https://open-meteo.com/","CC BY 4.0" to "https://creativecommons.org/licenses/by/4.0/","GeoNames" to "https://www.geonames.org/").forEach{(name,url)->
                val start=value.toString().indexOf(name);value.setSpan(URLSpan(url),start,start+name.length,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
            text=value;setLinkTextColor(colors.muted);movementMethod=LinkMovementMethod.getInstance()
        }
    }
    private fun TextView.show(value:String){if(text.toString()!=value)text=value}
    fun update(binding:ConfirmedBinding,snapshot:WeatherSnapshot?,error:String?,now:Instant){
        temperature.show(snapshot?.let{WeatherDisplay.temperature(it.temperatureC)} ?: "—°")
        place.show(snapshot?.location?.name ?: binding.city)
        condition.show(snapshot?.let{"${WeatherDisplay.icon(it.weatherCode,it.isDay)}  ${WeatherDisplay.description(it.weatherCode)}"}
            ?: if(error!=null)"Погода недоступна"else"Дані ще завантажуються")
        val messages=when {
            snapshot==null->listOf(error ?: "Автоматично для підтвердженої адреси")
            else->listOfNotNull(if(!snapshot.isFresh(now))"Збережений прогноз застарів"else null,
                if(error!=null)"Збережений прогноз · оновлення недоступне"else null)
        }
        notice.show(messages.joinToString("\n"));notice.visibility=if(messages.isEmpty())GONE else VISIBLE
        val forecast=snapshot?.nextHours(now,24).orEmpty()
        val times=forecast.map{it.time}.toSet()
        hourViews.keys.filter{it !in times}.toList().forEach{time->hours.removeView(hourViews.remove(time))}
        forecast.forEachIndexed{index,hour->
            val item=hourViews.getOrPut(hour.time){
                LinearLayout(context).apply{
                    orientation=VERTICAL;gravity=Gravity.CENTER;setPadding(dp(12),dp(10),dp(12),dp(10))
                    background=GradientDrawable().apply{setColor(this@HomeWeatherCard.colors.background);cornerRadius=dp(16).toFloat()}
                    importantForAccessibility=View.IMPORTANT_FOR_ACCESSIBILITY_YES;tag="weather_hour:${hour.time}"
                    line(this,13,false,colors.muted).gravity=Gravity.CENTER
                    line(this,25).gravity=Gravity.CENTER
                    line(this,17,true).gravity=Gravity.CENTER
                }
            }
            if(item.parent==null)hours.addView(item,index,LayoutParams(dp((80*resources.configuration.fontScale.coerceAtLeast(1f)).toInt()),-2).apply{marginEnd=dp(6)})
            else if(hours.indexOfChild(item)!=index){hours.removeView(item);hours.addView(item,index)}
            val description="${Presentation.time(hour.time)}, ${WeatherDisplay.description(hour.weatherCode)}, ${WeatherDisplay.temperature(hour.temperatureC)}"
            if(item.contentDescription!=description)item.contentDescription=description
            listOf(Presentation.time(hour.time),WeatherDisplay.icon(hour.weatherCode,hour.isDay),WeatherDisplay.temperature(hour.temperatureC)).forEachIndexed{i,value->(item.getChildAt(i) as TextView).show(value)}
        }
        forecastScroll.visibility=if(forecast.isEmpty())GONE else VISIBLE
    }
}
