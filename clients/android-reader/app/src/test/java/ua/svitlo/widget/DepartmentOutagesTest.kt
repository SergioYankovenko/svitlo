package ua.svitlo.widget

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import ua.svitlo.widget.core.*
import java.time.Instant
import java.time.LocalDate

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[28])
class DepartmentOutagesTest {
    private lateinit var context:Context
    private val address=DictionaryAddress("7","71","м. Приклад","72","вул. Тестова","4/4")
    private val now=Instant.parse("2026-10-23T07:00:00Z")
    private val date=LocalDate.of(2026,10,23)
    private fun response(html:String?=null)=JSONObject().put("DATETIME","10:00 23.10.2026").put("DISCONNECTIONS",JSONArray().apply{
        if(html!=null)put(JSONObject().put("ADDRESS",html).put("DATE_START","10:07 23.10.2026").put("DATE_STOP","11:11 23.10.2026").put("STATE_CHAR","Заплановано").put("DISCONN_TYPE","ГПВ"))
    }).toString()
    @Before fun setup(){context=RuntimeEnvironment.getApplication();listOf("svitlo_private","svitlo_profiles","svitlo_official","svitlo_weather").forEach{context.getSharedPreferences(it,0).edit().clear().commit()}}
    @Test fun exactDictionaryAddressUsesOnlyOfficialDepartmentParametersAndPreservesMinuteEndpoints(){
        val requests=mutableListOf<Map<String,String>>()
        val api=OutageApi{p->requests+=p;response("<strong>м. Приклад</strong><br>вул. Тестова 4, 4а, 4/4, 14")}
        val raw=api.fetchAddress(address,Category.SCHEDULE,date,date.plusDays(1))
        val parsed=OutageParser.parse(raw,Category.SCHEDULE,now)
        assertEquals(1,parsed.events.size);assertEquals("10:07",Presentation.time(parsed.events.single().start));assertEquals("11:11",Presentation.time(parsed.events.single().end))
        assertEquals(mapOf("op" to "disconn_by_dept","dept_id" to "7","disconn_selector" to "2","n_date" to "23.10.2026","k_date" to "24.10.2026"),requests.single())
        assertTrue(parsed.queueInfo.isEmpty());assertFalse(raw.contains("ADDRESS"))
    }
    @Test fun houseAndSettlementAreExactAndCannotMatchPrefixes(){
        for(html in listOf("<strong>м. Приклад</strong><br>вул. Тестова 4, 4а, 14", "<strong>с. Приклад</strong><br>вул. Тестова 4/4", "<strong>м. Приклад</strong><br>вул. Тестова Нова 4/4")){
            val raw=OutageApi{response(html)}.fetchAddress(address,Category.SCHEDULE,date,date)
            assertTrue(OutageParser.parse(raw,Category.SCHEDULE,now).events.isEmpty())
        }
    }
    @Test fun unknownRelevantHouseSyntaxAndMalformedEnvelopeFailInsteadOfReturningEmpty(){
        for(raw in listOf(response("<strong>м. Приклад</strong><br>вул. Тестова 1-9"),response("<strong>м. Приклад</strong><br>вул. Тестова всі будинки"),response("unstructured address"),"{}",response()+"junk")){
            assertThrows(IllegalArgumentException::class.java){OutageApi{raw}.fetchAddress(address,Category.SCHEDULE,date,date)}
        }
    }
    @Test fun htmlEntitiesCannotTurnAnExactStreetIntoAnEmptyMatch(){
        val selected=address.copy(street="вул. Пам’яті Героїв")
        val raw=OutageApi{response("<strong>м. Приклад</strong><br>вул. Пам&#8217;яті Героїв 4/4")}.fetchAddress(selected,Category.SCHEDULE,date,date)
        assertEquals(1,OutageParser.parse(raw,Category.SCHEDULE,now).events.size)
    }
    @Test fun accountlessPreviewRequiresConfirmationAndPersistsItsOwnIdentityWithoutFakeQueue(){
        val repo=OutageRepository(context,OutageApi{response()}){now}
        val prepared=repo.prepareAddress(address)
        assertNull(repo.binding())
        assertTrue(AddressProfiles(context).confirm("",address.label,prepared,address.city,"",true,address))
        assertEquals(address,repo.binding()?.dictionary);assertEquals("",repo.binding()?.account)
        assertNull(repo.snapshot().queueLabel());assertEquals(1440L,HourlySchedule.summary(date,repo.snapshot(),now).unknownMinutes)
        assertEquals(address,AddressProfiles(context).active()?.binding?.dictionary)
        assertFalse(repo.bindConfirmed("",address.copy(house="8").label,prepared,address.city,address.copy(house="8")))
    }
    @Test fun sourceFailureKeepsAccountlessCacheAndNeverMarksDayClear(){
        var failed=false
        val api=OutageApi{if(failed)throw java.io.IOException("offline")else response("<strong>м. Приклад</strong><br>вул. Тестова 4/4")}
        val repo=OutageRepository(context,api){now}
        assertTrue(repo.bindConfirmed("",address.label,repo.prepareAddress(address),address.city,address))
        val saved=repo.snapshot().categories
        failed=true;assertEquals(RefreshResult.PARTIAL_FAILURE,repo.refresh())
        assertEquals(saved,repo.snapshot().categories);assertEquals(Category.entries.toSet(),repo.snapshot().failures)
        assertFalse(repo.snapshot().checkedEmptyToday(date,now))
    }
    @Test fun accountlessProfileSwitchesCoexistWithLegacyAccountsWithoutCacheBleeding(){
        val repo=OutageRepository(context,OutageApi{response()}){now};val profiles=AddressProfiles(context)
        assertTrue(profiles.confirm("",address.label,repo.prepareAddress(address),address.city,"Дім",true,address));val home=profiles.active()!!
        val old=OutageRepository(context,OutageSource{_,_,_,_->response()}){now}
        assertTrue(profiles.confirm("12345678901","Інша адреса",old.prepare("12345678901"),"м. Інше","Робота",true))
        assertTrue(profiles.activate(home.id));assertEquals(address,repo.binding()?.dictionary);assertEquals(2,profiles.profiles().size)
    }
    @Test fun inFlightAddressRefreshCannotOverwriteAnotherAccountlessBinding(){
        lateinit var repo:OutageRepository;var switch=false
        val api=OutageApi{
            if(switch){switch=false;val replacement=address.copy(house="8");val fresh=OutageRepository(context,OutageApi{response()}){now};assertTrue(fresh.bindConfirmed("",replacement.label,fresh.prepareAddress(replacement),replacement.city,replacement))}
            response()
        }
        repo=OutageRepository(context,api){now};assertTrue(repo.bindConfirmed("",address.label,repo.prepareAddress(address),address.city,address))
        switch=true;assertEquals(RefreshResult.SUPERSEDED,repo.refresh());assertEquals("8",repo.binding()?.dictionary?.house)
    }
}
