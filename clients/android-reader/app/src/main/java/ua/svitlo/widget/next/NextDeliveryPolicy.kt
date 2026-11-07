package ua.svitlo.widget.next

import java.time.*
import java.time.format.DateTimeFormatter

internal object NextDeliveryPolicy {
    fun retryAfter(header:String?,now:Instant=Instant.now()):Long {val seconds=header?.trim()?.toLongOrNull() ?:runCatching{Duration.between(now,ZonedDateTime.parse(header,DateTimeFormatter.RFC_1123_DATE_TIME).toInstant()).seconds}.getOrDefault(0);return seconds.coerceIn(0,86400)}
    fun transition(before:String,after:String,transport:String):String?=when{before in setOf("on","off")&&after in setOf("on","off")&&before!=after->after;before in setOf("on","off")&&after=="unknown"&&transport=="offline"->"lost";else->null}
    fun title(type:String)=when(type){"on"->"Світло з’явилося";"off"->"Світло зникло";else->"Зв’язок із датчиком втрачено"}
    fun body(type:String)=if(type=="lost")"Перевір пристрій і з’єднання"else"За даними датчика"
}
