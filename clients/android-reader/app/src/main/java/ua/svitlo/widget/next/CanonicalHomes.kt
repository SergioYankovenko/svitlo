package ua.svitlo.widget.next

/** Literal canonical IDs only; labels and house-number similarity never merge homes. */
object CanonicalHomes {
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
