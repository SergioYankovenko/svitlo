package ua.svitlo.widget.next
import org.junit.Test
import org.junit.Assert.*
class CanonicalHomesTest {
    private fun p(home:String,line:String)=NextProfile("$home-$line","",home,line,home,"","","","op")
    @Test fun thirtyTwoLinesUseOneHouse(){val old=(1..32).map{p("home",it.toString())};val next=CanonicalHomes.merge(old,listOf(p("other","1")),2);assertEquals(33,next.size);assertEquals(2,next.map{it.addressId}.distinct().size)}
    @Test fun groupIsAtomicAndExistingIdsRemain(){val old=listOf(p("h","1"));val next=CanonicalHomes.merge(old,listOf(p("h","1").copy(id="new"),p("h","2")),2);assertEquals("h-1",next[0].id);assertEquals(2,next.size)}
    @Test(expected=IllegalArgumentException::class) fun freeThirdHouseRejected(){CanonicalHomes.merge(listOf(p("h1","1"),p("h2","1")),listOf(p("h3","1")),2)}
}
