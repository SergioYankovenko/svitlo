package ua.svitlo.widget.next

import org.json.JSONObject
import ua.svitlo.widget.*
import java.time.Instant

/** Settlement-only geocoding. Ambiguous names never fall back to population ordering. */
object NextWeather {
    fun fetch(profile:NextProfile):String? {
        val source=OpenMeteoSource()
        val region=when(profile.operatorId){"ua-cherkasy"->AddressWeather.REGION;"ua-kyiv-region-dtek"->"Київська область";else->""}
        val known=if(profile.operatorId=="ua-cherkasy")AddressWeather.knownLocation(profile.city)else null
        val location=known ?: run {
            val native=WeatherParser.locations(source.search(profile.city,region),region)
            if(native.any{AddressWeather.matches(profile.city,it)})AddressWeather.uniqueLocation(profile.city,native)
            else AddressWeather.uniqueLocation(profile.city,WeatherParser.locations(source.search(AddressWeather.latinName(profile.city),region),region))
        } ?: return null
        val raw=source.fetch(location)
        WeatherParser.parse(raw,location,Instant.now())
        return JSONObject(raw).put("locationName",location.name).toString()
    }
}
