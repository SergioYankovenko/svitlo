package ua.svitlo.widget

import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import ua.svitlo.widget.core.Category
import ua.svitlo.widget.core.OutageParser
import java.util.Locale

/** Exact entries selected in the operator's dictionary, saved only after confirmation. */
data class DictionaryAddress(val departmentId:String,val cityId:String,val city:String,val streetId:String,val street:String,val house:String){
    val label:String get()="$city, $street, $house"
    fun isValid()=listOf(departmentId,cityId,city,streetId,street,house).all{it.isNotBlank() && it.length<=250}
    fun json():JSONObject=JSONObject().put("department",departmentId).put("cityId",cityId).put("city",city)
        .put("streetId",streetId).put("street",street).put("house",house)
    companion object{
        fun parse(value:JSONObject?):DictionaryAddress?=runCatching{
            value ?: return@runCatching null
            DictionaryAddress(value.getString("department"),value.getString("cityId"),value.getString("city"),value.getString("streetId"),value.getString("street"),value.getString("house")).also{require(it.isValid())}
        }.getOrNull()
    }
}

/** Official department responses contain many households; retain only exact selected-address rows. */
internal object DepartmentOutages {
    fun filter(raw:String,address:DictionaryAddress,category:Category):String{
        require(address.isValid())
        val tokener=JSONTokener(raw)
        val root=tokener.nextValue() as? JSONObject ?: throw IllegalArgumentException("Некоректна відповідь оператора")
        require(tokener.nextClean()=='\u0000')
        // Validate the source even if no address matches. Missing/malformed data is never empty success.
        OutageParser.parse(root.toString(),category)
        val rows=when(val source=root.get("DISCONNECTIONS")){
            is JSONArray->(0 until source.length()).map{source.getJSONObject(it)}
            is JSONObject->source.keys().asSequence().map{source.getJSONObject(it)}.toList()
            else->throw IllegalArgumentException("Некоректний перелік відключень")
        }
        val selected=JSONArray()
        rows.forEach{row->
            val html=row.opt("ADDRESS") as? String ?: throw IllegalArgumentException("Адреса події відсутня")
            if(matches(html,address))selected.put(JSONObject(row.toString()).apply{remove("ADDRESS")})
        }
        // This endpoint does not identify a household queue; never infer it from other addresses.
        return JSONObject().put("DATETIME",root.opt("DATETIME") ?: JSONObject.NULL)
            .put("DISCONNECTIONS",selected).put("DISCONN_QUEUQ",JSONArray()).toString()
    }
    private fun normalize(value:String):String = android.text.Html.fromHtml(value.replace("<","&lt;").replace(">","&gt;"),android.text.Html.FROM_HTML_MODE_LEGACY).toString()
        .replace('\u00a0',' ').replace('’','\'').replace('ʼ','\'')
        .lowercase(Locale.ROOT).trim().replace(Regex("\\s+")," ")
        .replace(Regex("^(місто|м\\.)\\s*"),"м ").replace(Regex("^(село|с\\.)\\s*"),"с ")
        .replace(Regex("^(вулиця|вул\\.)\\s*"),"вул ").replace(Regex("^(провулок|пров\\.)\\s*"),"пров ")
    private fun house(value:String)=normalize(value).replace(" ","")
    private fun matches(html:String,address:DictionaryAddress):Boolean{
        val parts=Regex("<strong\\b[^>]*>(.*?)</strong>",setOf(RegexOption.IGNORE_CASE,RegexOption.DOT_MATCHES_ALL)).findAll(html).toList()
        require(parts.isNotEmpty() && html.substring(0,parts.first().range.first).isBlank()){"Невідомий формат адрес події"}
        var matched=false
        parts.forEachIndexed{index,part->
            val settlement=normalize(part.groupValues[1]);require(!settlement.contains('<') && settlement.isNotBlank())
            val content=html.substring(part.range.last+1,parts.getOrNull(index+1)?.range?.first ?: html.length)
            val lines=content.split(Regex("<br\\s*/?>",RegexOption.IGNORE_CASE)).map(::normalize).filter{it.isNotBlank()}
            require(lines.none{it.contains('<') || it.contains('>')}){"Невідомий формат адрес події"}
            if(settlement!=normalize(address.city))return@forEachIndexed
            require(lines.isNotEmpty()){"Немає переліку будинків"}
            val prefix=normalize(address.street)+" "
            for(line in lines){
                if(line==normalize(address.street))throw IllegalArgumentException("Немає переліку будинків")
                if(!line.startsWith(prefix))continue
                val remainder=line.removePrefix(prefix)
                // A longer street name is distinct; numeric/unknown house lists need strict parsing.
                if(remainder.firstOrNull()?.isLetter()==true && remainder.any{it.isDigit()} &&
                    listOf("всі","усі","буд","вся","весь").none(remainder::startsWith))continue
                val houses=remainder.split(',').map(::house)
                require(houses.all{Regex("[0-9]+[\\p{L}]?(?:[/\\-][0-9\\p{L}]+)?").matches(it) && !Regex("[0-9]+-[0-9]+").matches(it)}){"Неоднозначний перелік будинків"}
                if(house(address.house) in houses)matched=true
            }
        }
        return matched
    }
}
