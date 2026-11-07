package ua.svitlo.widget

import android.content.Context
import org.json.JSONObject
import java.time.Instant
import java.time.LocalTime
import ua.svitlo.widget.core.KYIV_ZONE

data class ServiceNotice(val until:Instant,val publishedAt:Instant,val url:String)

/** Conservative: no inferred maintenance from a timeout or unrelated business-customer portal. */
class ServiceNotices(context:Context){
    private val prefs=context.applicationContext.getSharedPreferences("svitlo_service_notices",Context.MODE_PRIVATE)
    fun update(articles:List<OfficialArticle>,now:Instant){
        val notice=articles.mapNotNull{parse(it,now)}.maxByOrNull{it.publishedAt}
        val raw=notice?.let{JSONObject().put("until",it.until.toString()).put("published",it.publishedAt.toString()).put("url",it.url).put("checked",now.toString()).toString()}
        prefs.edit().putString("notice",raw).commit()
    }
    fun current(now:Instant):ServiceNotice?=runCatching{
        val raw=JSONObject(prefs.getString("notice",null) ?: return null)
        val checked=Instant.parse(raw.getString("checked"));val until=Instant.parse(raw.getString("until"))
        if(checked<now.minusSeconds(7200) || checked>now.plusSeconds(300) || until<=now)return null
        ServiceNotice(until,Instant.parse(raw.getString("published")),raw.getString("url"))
    }.getOrNull()
    companion object {
        fun candidate(title:String)=title.contains("техніч",true) && (title.contains("робот",true) || title.contains("кабінет",true))
        fun parse(article:OfficialArticle,now:Instant):ServiceNotice?=runCatching{
            val text=OfficialScheduleParser.plain(article.title+" "+article.content).lowercase()
            if(!candidate(article.title) || text.contains("непобут") || text.contains("завершено") || text.contains("відновлено"))return null
            if(!text.contains("api_new/disconn.php") && !(text.contains("кабінет") && text.contains("побутов")))return null
            val today=now.atZone(KYIV_ZONE).toLocalDate()
            if(article.publishedAt>now || article.publishedAt.atZone(KYIV_ZONE).toLocalDate()!=today)return null
            val date=today.format(java.time.format.DateTimeFormatter.ofPattern("dd.MM.yyyy"))
            if(!text.contains(date))return null
            val range=Regex("з\\s*(\\d{1,2}:\\d{2}).{0,100}?до\\s*(\\d{1,2}:\\d{2})").find(text) ?: return null
            fun at(value:String)=today.atTime(LocalTime.parse(value.padStart(5,'0'))).let{local->
                val offsets=KYIV_ZONE.rules.getValidOffsets(local);require(offsets.size==1);local.atOffset(offsets.single()).toInstant()}
            val start=at(range.groupValues[1]);val end=at(range.groupValues[2])
            if(start>now || end<=now || end<=start)return null
            val uri=java.net.URI(article.sourceUrl);require(uri.scheme=="https" && uri.host=="www.cherkasyoblenergo.com" && uri.rawUserInfo==null)
            ServiceNotice(end,article.publishedAt,article.sourceUrl)
        }.getOrNull()
    }
}
