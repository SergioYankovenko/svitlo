package ua.svitlo.widget

import ua.svitlo.widget.core.*
import java.time.Instant
import java.time.LocalTime

/** Only explicit operational statements for Cherkasy are accepted; explainers and
 * national roundups are not commands. Emergency queue numbers are not GPV subqueues. */
object EmergencyParser {
    private val emergency=Regex("\\bгав\\b|(?:графік[а-яіїєґ]*\\s+)?аварійн[а-яіїєґ]*\\s+відключ",RegexOption.IGNORE_CASE)
    private val hourly=Regex("\\bгпв\\b|погодинн[а-яіїєґ]*\\s+(?:графік|відключ)",RegexOption.IGNORE_CASE)
    private val conditional=Regex("якщо|у разі|можуть|можлив|ймовір|за потреби|під час|що таке|чому|не скасован|не припинен",RegexOption.IGNORE_CASE)
    private val stopped=Regex("скасовано|скасовані|припинено|припинені|не діють|не діє|не застосовуються|не застосовується|призупинено|призупинені",RegexOption.IGNORE_CASE)
    private val started=Regex("застосован[оі]|застосовуються|застосовується|введен[оі]|діють|діє|продовжують діяти|продовжує діяти|відновлено|відновлені",RegexOption.IGNORE_CASE)
    private val clock=Regex("(?:^|\\s)(?:з|із|о|від)\\s*(\\d{1,2}):(\\d{2})")
    private val endClock=Regex("\\bдо\\s*(\\d{1,2}):(\\d{2})")
    private val foreign=Regex("київ|харків|одес|полтав|сумсь|дніпр|львів|житомир|черніг|миколаїв|херсон|вінниць|терноп|рівнен|волин|запоріз|донець|луган",RegexOption.IGNORE_CASE)
    fun isCandidate(title:String)=emergency.containsMatchIn(title) ||
        (hourly.containsMatchIn(title) && Regex("ді[єю]|скас|призуп|віднов",RegexOption.IGNORE_CASE).containsMatchIn(title))

    fun parse(article:OfficialArticle):List<EmergencyNotice> {
        val title=OfficialScheduleParser.plain(article.title)
        val body=OfficialScheduleParser.plain(article.content)
        val full="$title\n$body"
        // A publication about another region, emergency maintenance or an explanation is
        // deliberately not inferred to be a region-wide regime for the active household.
        if(!Regex("черкаськ[а-яіїєґ]*\\s+област",RegexOption.IGNORE_CASE).containsMatchIn(full))return emptyList()
        val publication=article.publishedAt.atZone(KYIV_ZONE).toLocalDate()
        val titleDates=OfficialScheduleParser.dates(title,publication)
        val defaultDates=if(titleDates.isNotEmpty())titleDates else OfficialScheduleParser.dates(body,publication)
        if(defaultDates.size>1)return emptyList()
        val defaultDate=defaultDates.singleOrNull() ?: publication
        val sentences=body.split(Regex("(?<=[.!?])\\s+|\\n+")).map(String::trim).filter(String::isNotBlank)
        val result=mutableListOf<EmergencyNotice>()
        for((index,line) in sentences.withIndex()){
            if(conditional.containsMatchIn(line) || foreign.containsMatchIn(line))continue
            val isEmergency=emergency.containsMatchIn(line)
            val isHourly=hourly.containsMatchIn(line)
            if(!isEmergency && !isHourly)continue
            // Mixed commands need separate clauses; do not assign one verb to both subjects.
            if(isEmergency && isHourly)continue
            if(Regex("не\\s+(?:будуть|буде)|не\\s+введен|не\\s+застосован",RegexOption.IGNORE_CASE).containsMatchIn(line))continue
            val stop=stopped.containsMatchIn(line)
            val start=started.containsMatchIn(line)
            if(!stop && !start)continue
            val dates=OfficialScheduleParser.dates(line,publication)
            if(dates.size>1)continue
            val date=dates.singleOrNull() ?: if(line.contains("завтра",true))publication.plusDays(1) else defaultDate
            val time=clock.find(line)
            val effective=if(time!=null)at(date,time.groupValues[1],time.groupValues[2]) ?: continue
                else if(date==publication)article.publishedAt else continue // no invented start hour
            // Future conditional notices are ignored. An explicit dated command is scheduled.
            if(effective<article.publishedAt.minusSeconds(172800) || effective>article.publishedAt.plusSeconds(172800))continue
            val end=endClock.find(line)?.let{at(date,it.groupValues[1],it.groupValues[2]) ?: return@let null}
            if(end!=null && end<=effective)continue
            val queues=if(isHourly && Regex("(?:під)?черг",RegexOption.IGNORE_CASE).containsMatchIn(line))
                Regex("(?<!\\d)[1-6]\\.[12](?!\\d)").findAll(line).map{it.value}.toSet() else emptySet()
            // A scoped emergency queue (1..10) cannot be mapped to an hourly subgroup (1.1..6.2).
            if(isEmergency && Regex("(?:для|лише|тільки)\\s+(?:\\d|черг)",RegexOption.IGNORE_CASE).containsMatchIn(line))continue
            result+=EmergencyNotice("${article.sourceUrl}#$index",article.publishedAt,effective,
                if(isEmergency)!stop else null,if(isHourly)if(stop)HourlyValidity.SUSPENDED else HourlyValidity.ACTIVE else null,
                queues,end,article.sourceUrl)
        }
        // The following sentence often says "Також продовжують діяти ГПВ". It applies
        // from the command in the same bulletin, not the several-minutes-later publication.
        if(result.none{it.active!=null} && !isCandidate(title))return emptyList()
        val command=result.firstOrNull{it.active==true}
        return result.map{if(command!=null && it.active==null && it.effectiveAt==article.publishedAt)
            it.copy(effectiveAt=command.effectiveAt) else it}
    }
    private fun at(date:java.time.LocalDate,hour:String,minute:String):Instant?=runCatching{
        val h=hour.toInt();val m=minute.toInt()
        val local=if(h==24 && m==0)date.plusDays(1).atStartOfDay()else date.atTime(LocalTime.of(h,m))
        require(KYIV_ZONE.rules.getValidOffsets(local).size==1)
        local.atZone(KYIV_ZONE).toInstant()
    }.getOrNull()
}
