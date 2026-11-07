package ua.svitlo.widget

import android.app.Application
import android.content.Context
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.TextView
import androidx.work.Configuration
import androidx.work.WorkManager
import org.json.*
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.*
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.*
import org.robolectric.android.controller.ActivityController
import org.robolectric.shadows.ShadowAlertDialog
import ua.svitlo.widget.core.*
import java.time.*
import java.time.format.DateTimeFormatter
import java.util.concurrent.*

/** Regression acceptance, unlike the archived 1.5.3 characterization tests. No live accounts/API. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk=[28])
@LooperMode(LooperMode.Mode.PAUSED)
class BogunaFallback154Test {
    private val context:Application get()=RuntimeEnvironment.getApplication()
    private val address=DictionaryAddress("18","801","м. Христинівка","11951","вул. І.Богуна","8/а")
    private val account="12345678901"
    private val now get()=Instant.now()
    private var controller:ActivityController<MainActivity>?=null
    private var personal=0;private var department=0
    private val callsLock=Any()
    @Before fun setup(){
        shadowOf(context).grantPermissions(context.packageName+".DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION")
        for(name in listOf("svitlo_private","svitlo_registry","svitlo_profiles","svitlo_weather","svitlo_runtime","svitlo_official","svitlo_inbox"))context.getSharedPreferences(name,0).edit().clear().commit()
        if(runCatching{WorkManager.getInstance(context)}.isFailure){val held=Executor{};WorkManager.initialize(context,Configuration.Builder().setExecutor(held).setTaskExecutor(held).build())}
        check(OfficialScheduleRepository(context,OfficialFeedSource{emptyList()}).refresh())
    }
    @After fun close(){ShadowAlertDialog.getLatestAlertDialog()?.dismiss();controller?.pause()?.stop()?.destroy()}
    private fun raw(category:Category,info:String?,events:JSONArray=JSONArray()):String=JSONObject()
        .put("DATETIME",now.atZone(KYIV_ZONE).format(DateTimeFormatter.ofPattern("HH:mm dd.MM.yyyy")))
        .put("DISCONNECTIONS",events).put("DISCONN_QUEUQ",JSONArray().apply{if(category==Category.SCHEDULE && info!=null)put(JSONObject().put("QUEUE_INFO",info))}).toString()
    private fun repository(info:String?=null)=OutageRepository(context,object:OutageSource{
        override fun fetch(account:String,category:Category,from:LocalDate,to:LocalDate):String{synchronized(callsLock){personal++};return raw(category,info)}
        override fun fetchAddress(address:DictionaryAddress,category:Category,from:LocalDate,to:LocalDate):String{synchronized(callsLock){department++};return raw(category,info)}
    })
    private fun registry(selection:DictionaryAddress=address,queue:String?=null){
        val value=if(queue==null)JSONObject().put("status","not_found").put("inclusion","not_in_queue").put("queue",JSONObject.NULL)
            else JSONObject().put("status","matched").put("source","official_registry").put("queue",queue).put("scope","house")
                .put("url","https://www.cherkasyoblenergo.com/test.pdf").put("page",1).put("version","fixture")
                .put("validUntil",now.atZone(KYIV_ZONE).toLocalDate().plusDays(30).toString()).put("checkedAt",now.toEpochMilli())
        assertTrue(QueueRegistryRepository(context,RegistrySource{actual->assertEquals(selection,actual);JSONObject().put("resolution",value)}).refresh(selection,true))
    }
    private fun all(v:View):List<View> = listOf(v)+if(v is ViewGroup)(0 until v.childCount).flatMap{all(v.getChildAt(it))}else emptyList()
    private fun field(activity:MainActivity,name:String,value:Any){MainActivity::class.java.getDeclaredField(name).apply{isAccessible=true}.set(activity,value)}
    private fun open(repo:OutageRepository,rows:String="""[{"LS":"12345678901","ADDRESS":"м. Христинівка, вул. І.Богуна, 8/а"}]"""):MainActivity {
        controller=Robolectric.buildActivity(MainActivity::class.java).create().start().resume().visible()
        val activity=controller!!.get();field(activity,"repo",repo)
        field(activity,"addressApi",AddressApi(OperatorTransport{params->assertEquals("ls_list_by_addr",params["op"]);assertEquals("8/а",params["house"]);rows}))
        field(activity,"department",AddressItem("18","Христинівська філія"));field(activity,"city",AddressItem("801",address.city))
        field(activity,"street",AddressItem("11951",address.street));field(activity,"house",address.house)
        MainActivity::class.java.getDeclaredMethod("verifyAddress").apply{isAccessible=true}.invoke(activity);drain(activity)
        return activity
    }
    private fun drain(activity:MainActivity){
        val executor=MainActivity::class.java.getDeclaredField("executor").apply{isAccessible=true}.get(activity) as ExecutorService
        executor.submit{}.get(8,TimeUnit.SECONDS);shadowOf(Looper.getMainLooper()).idle()
    }
    private fun confirm(activity:MainActivity){all(activity.window.decorView).filterIsInstance<Button>().single{it.tag=="confirm_yes"}.performClick();drain(activity)}
    @Test fun uniqueAccountExclusionPersistsExactKeyAndKeepsPersonalEndpointOnReopenAndRefresh(){
        registry();val repo=repository("Графік погодинних відключень: в чергу не включено")
        val activity=open(repo);assertNull(repo.binding());assertEquals(0,personal);confirm(activity)
        val binding=repo.binding()!!;assertEquals(account,binding.account);assertEquals(address,binding.dictionary);assertEquals(0x430,binding.dictionary!!.house.last().code)
        assertTrue(repo.snapshot().explicitHourlyExclusion());assertNull(repo.snapshot().queueLabel());assertEquals(3,personal);assertEquals(0,department)
        val reopened=OutageRepository(context);assertEquals(binding,reopened.binding());assertTrue(reopened.snapshot().explicitHourlyExclusion())
        val saved=AddressProfiles(context).saved().single();assertEquals(binding,saved.profile.binding);assertEquals(address,saved.data.dictionary);assertEquals(account,saved.data.account)
        assertEquals(RefreshResult.SUCCESS,repo.refresh());assertEquals(6,personal);assertEquals(0,department)
        assertTrue(MultiAddressRefresh.refresh(context,object:OutageSource{
            override fun fetch(account:String,category:Category,from:LocalDate,to:LocalDate)=raw(category,"Графік погодинних відключень: в чергу не включено")
            override fun fetchAddress(address:DictionaryAddress,category:Category,from:LocalDate,to:LocalDate):String=error("Must keep personal source")
        }))
        assertTrue(AddressProfiles(context).snapshots().single().second.explicitHourlyExclusion())
    }
    @Test fun uniqueAccountWithoutQueueUsesNumericAddressFallback(){
        registry(queue="3.2");val repo=repository();confirm(open(repo))
        assertEquals("3.2",repo.snapshot().queueLabel());assertEquals(address,repo.binding()!!.dictionary);assertEquals(3,personal);assertEquals(0,department)
    }
    @Test fun freshPersonalNumericAndNegativeEvidenceOverruleCatalogFallback(){
        registry(queue="2.1")
        val numeric=repository("Графік погодинних відключень: 3 черга 2 підчерга")
        val data=numeric.prepare(account,address);val binding=ConfirmedBinding(account,address.label,address.city,address)
        assertEquals("3.2",numeric.profileSnapshot(binding,data).queueLabel())
        val negative=repository("Графік погодинних відключень: в чергу не включено")
        val excluded=negative.profileSnapshot(binding,negative.prepare(binding))
        assertTrue(excluded.explicitHourlyExclusion());assertNull(excluded.queueLabel())
    }
    @Test fun emptyUnknownStaleOrOtherQueueTextNeverCountsAsPersonalHourlyExclusion(){
        for(info in listOf(null,"Графік аварійних відключень: в чергу не включено","Графік погодинних відключень: черга уточнюється")){
            val repo=repository(info);val data=repo.prepare(account,address)
            val snapshot=repo.profileSnapshot(ConfirmedBinding(account,address.label,address.city,address),data)
            assertFalse(snapshot.explicitHourlyExclusion());assertFalse(snapshot.apiHourlyExclusion(now))
        }
        val snapshot=Snapshot(mapOf(Category.SCHEDULE to OutageParser.parse(raw(Category.SCHEDULE,"Графік погодинних відключень: в чергу не включено"),Category.SCHEDULE,now.minusSeconds(9000))))
        assertFalse(snapshot.apiHourlyExclusion(now));assertFalse(snapshot.copy(failures=setOf(Category.SCHEDULE)).apiHourlyExclusion(now))
    }
    @Test fun noAccountUsesExactDepartmentAddressAndAmbiguousAccountsAreNotPicked(){
        registry();val repo=repository();confirm(open(repo,"[]"))
        assertEquals("",repo.binding()!!.account);assertEquals(address,repo.binding()!!.dictionary);assertEquals(0,personal);assertEquals(3,department)
        controller!!.pause().stop().destroy();controller=null;OutageRepository(context).clear();AddressProfiles(context).clear()
        val ambiguous=open(repo,"""[{"LS":"12345678901","ADDRESS":"A"},{"LS":"12345678902","ADDRESS":"B"}]""")
        assertNull(repo.binding());assertTrue(all(ambiguous.window.decorView).none{it.tag=="confirm_yes"});assertEquals(0,personal)
    }
    @Test fun hourlyExclusionKeepsPersonalPlannedAndOpenEmergencyEvents(){
        registry();val at=now
        val repo=OutageRepository(context,OutageSource{_,category,_,_->
            val events=JSONArray()
            if(category!=Category.SCHEDULE)events.put(JSONObject()
                .put("DATE_START",at.minusSeconds(1800).atZone(KYIV_ZONE).format(DateTimeFormatter.ofPattern("HH:mm dd.MM.yyyy")))
                .put("DATE_STOP",if(category==Category.EMERGENCY)""else at.plusSeconds(1800).atZone(KYIV_ZONE).format(DateTimeFormatter.ofPattern("HH:mm dd.MM.yyyy")))
                .put("DISCONN_TYPE",category.label).put("STATE_CHAR","Застосовано"))
            raw(category,"Графік погодинних відключень: в чергу не включено",events)
        })
        val data=InitialScheduleLoader.forAddress(context,repo,account,address.label,address.city,address).load()
        assertTrue(repo.bindConfirmed(account,address.label,data,address.city,address))
        val snapshot=repo.snapshot();assertTrue(snapshot.explicitHourlyExclusion());assertNull(snapshot.queueLabel())
        assertEquals(setOf(Category.PLANNED,Category.EMERGENCY),snapshot.allEvents().map{it.category}.toSet())
        assertFalse(snapshot.checkedEmptyToday(at.atZone(KYIV_ZONE).toLocalDate(),at));assertTrue(snapshot.openEmergency(at))
    }
    @Test fun explicitPersonalExclusionSurvivesRegistryFailureButCannotHidePublicationFailure(){
        val repo=repository("Графік погодинних відключень: в чергу не включено")
        val binding=ConfirmedBinding(account,address.label,address.city,address);val data=repo.prepare(binding)
        fun loader(failFeed:Boolean)=InitialScheduleLoader({data},{throw SourceException(SourceFailure.UNREACHABLE)},
            {if(failFeed)throw SetupDataUnavailable("publication unavailable")},{repo.profileSnapshot(binding,it)})
        assertEquals(data,loader(false).load())
        try{loader(true).load();fail("Publication failure must not become a checked empty day")}
        catch(expected:SetupDataUnavailable){assertEquals("publication unavailable",expected.message)}
    }
    @Test fun all1027SanitizedCandidateKeysKeepFallbackAndPersonalSource(){
        val cases=JSONArray(requireNotNull(javaClass.getResourceAsStream("/address-fallback-candidates.json")).bufferedReader().readText())
        assertEquals(1027,cases.length());var negatives=0;var numeric=0
        val repo=repository()
        for(i in 0 until cases.length()){
            val row=cases.getJSONObject(i);val key=DictionaryAddress(row.getString("department"),row.getString("city_id"),row.getString("city"),row.getString("street_id"),row.getString("street"),row.getString("house"))
            val queue=if(row.isNull("catalogQueue"))null else row.getString("catalogQueue")
            registry(key,queue)
            val data=InitialScheduleLoader.forAddress(context,repo,account,key.label,key.city,key).load()
            val snapshot=repo.profileSnapshot(ConfirmedBinding(account,key.label,key.city,key),data)
            assertEquals(key,data.dictionary);assertEquals(account,data.account);assertEquals(queue,snapshot.queueLabel())
            assertEquals(queue==null,snapshot.explicitHourlyExclusion());if(queue==null)negatives++ else numeric++
        }
        assertEquals(967,negatives);assertEquals(60,numeric);assertEquals(3081,personal);assertEquals(0,department);assertNull(repo.binding())
    }
}
