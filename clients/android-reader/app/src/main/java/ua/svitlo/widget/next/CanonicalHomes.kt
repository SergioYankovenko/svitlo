package ua.svitlo.widget.next
import org.json.JSONObject

/** Literal canonical IDs only; labels and house-number similarity never merge homes. */
object CanonicalHomes {
    /** Identity proof comes from resolve, never from an older schedule cache. */
    fun confirmed(result:JSONObject,addressId:String,now:Long=System.currentTimeMillis()):List<String>? {
        if(result.optJSONObject("address")?.optString("id")!=addressId)return null
        val r=result.optJSONObject("resolution")?:return null
        val lines=r.optJSONArray("lines")?.objects()?:return null
        if(lines.size>32||lines.any{!UUID_RE.matches(it.optString("id"))})return null
        val proof=r.optJSONObject("provenance")
        if(proof?.optBoolean("sourceUnavailable")==true){
            val saved=proof.optJSONObject("retainedIdentity")?:return null
            val checked=saved.optLong("checkedAt",0)
            if(proof.optString("source")!="dtek-address"||saved.optString("addressId")!=addressId||checked<=0||checked>now+300000||now-checked>7*86400000L)return null
            val raw=saved.optJSONArray("lineKeys")?:return null
            val keys=(0 until raw.length()).map{raw.optString(it)}
            if(keys.isEmpty()||keys.size>32||keys.distinct().size!=keys.size)return null
            return keys.map{key->lines.singleOrNull{line->line.optString("key")==key&&line.optJSONObject("provenance")?.let{it.optString("source")=="dtek-address"&&it.has("partial")&&!it.getBoolean("partial")}==true&&"GPV"+line.optString("groupCode")==key}?.getString("id")?:return null}
        }
        if(!r.optBoolean("complete")||r.optString("state") !in setOf("resolved","ambiguous","excluded"))return null
        val checked=r.optLong("checkedAt",0);if(checked<=0||checked>now+300000||now-checked>7*86400000L)return null
        val ids=lines.map{it.getString("id")};return ids.takeIf{it.distinct().size==it.size}
    }
    fun merge(old:List<NextProfile>,incoming:List<NextProfile>,homeLimit:Int):List<NextProfile> {
        require(homeLimit in setOf(2,10));require(incoming.isNotEmpty()&&incoming.size<=32)
        require(incoming.map{it.addressId}.distinct().size==1)
        require(incoming.map{it.lineId}.distinct().size==incoming.size)
        val homes=old.map{it.addressId}.toSet()
        require(incoming.first().addressId in homes||homes.size<homeLimit){"Досягнуто ліміт будинків підписки"}
        val next=old.toMutableList()
        for(p in incoming){val at=next.indexOfFirst{it.addressId==p.addressId&&it.lineId==p.lineId};if(at>=0)next[at]=p.copy(id=next[at].id,serverId=p.serverId?:next[at].serverId)else next.add(p)}
        require(next.size<=320);return next
    }
}
