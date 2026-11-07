package ua.svitlo.widget

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import ua.svitlo.widget.core.*
import java.time.Instant

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[28])
class AddressProfilesTest {
    private lateinit var context:Context
    private val now=Instant.parse("2026-10-23T04:00:00Z")
    private val first="12345678901";private val second="12345678902"
    private fun repo(queue:String="3 черга 2 підчерга")=OutageRepository(context,OutageSource{_,_,_,_->
        """{"DATETIME":"07:00 23.10.2026","DISCONNECTIONS":[],"DISCONN_QUEUQ":[{"QUEUE_INFO":"Графік погодинних відключень - $queue"}]}"""}){now}
    private fun add(account:String,name:String,queue:String="3 черга 2 підчерга"){
        assertTrue(AddressProfiles(context).confirm(account,"Тестова адреса $name",repo(queue).prepare(account),"м. Приклад",name,true))
    }
    @Before fun setup(){context=RuntimeEnvironment.getApplication();listOf("svitlo_private","svitlo_profiles","svitlo_weather","svitlo_geo","svitlo_inbox").forEach{context.getSharedPreferences(it,0).edit().clear().commit()};OfficialScheduleRepository(context).clear()}
    @Test fun upgradeMigratesConfirmedBindingToOneNamedHome(){
        val repo=repo();assertTrue(repo.bindConfirmed(first,"Перша адреса",repo.prepare(first),"м. Приклад"))
        val profiles=AddressProfiles(context);assertEquals(1,profiles.profiles().size);assertEquals("Мій дім",profiles.active()!!.name)
        assertEquals(first,profiles.active()!!.binding.account)
    }
    @Test fun namedProfilesArePersistedAndSwitchRestoresOnlyTheirQueueAndCachedTimestamps(){
        add(first,"Мій дім");val home=AddressProfiles(context).active()!!
        add(second,"Робота","2 черга 1 підчерга")
        val profiles=AddressProfiles(context);assertEquals(2,profiles.profiles().size);assertEquals("Робота",profiles.active()!!.name)
        assertTrue(profiles.activate(home.id));assertEquals(first,repo().binding()!!.account);assertEquals("3.2",repo().snapshot().queueLabel())
        assertEquals(now,repo().snapshot().categories[Category.SCHEDULE]!!.fetchedAt)
    }
    @Test fun renamingDoesNotChangeBindingAndActiveProfileCannotBeRemoved(){
        add(first,"Дім");val profiles=AddressProfiles(context);val id=profiles.active()!!.id
        assertTrue(profiles.rename(id,"Батьки"));assertEquals("Батьки",AddressProfiles(context).active()!!.name)
        assertEquals(first,repo().binding()!!.account);assertFalse(profiles.remove(id));assertTrue(profiles.rename(id," "))
        assertEquals("",AddressProfiles(context).active()!!.name)
    }
    @Test fun unnamedNewAddressSurvivesReloadAndKeepsExistingNamedProfile(){
        add(first,"Дім");val home=AddressProfiles(context).active()!!
        assertTrue(AddressProfiles(context).confirm(second,"Друга адреса",repo().prepare(second),name=" ",add=true))
        val saved=AddressProfiles(context)
        assertEquals("",saved.active()!!.name);assertEquals(2,saved.profiles().size)
        assertTrue(saved.activate(home.id));assertEquals("Дім",saved.active()!!.name)
    }
    @Test fun deletingInactiveProfileKeepsActiveAddress(){
        add(first,"Дім");val home=AddressProfiles(context).active()!!;add(second,"Робота")
        val profiles=AddressProfiles(context);assertTrue(profiles.remove(home.id));assertEquals(1,profiles.profiles().size)
        assertEquals(second,repo().binding()!!.account);assertFalse(profiles.activate(home.id))
    }
    @Test fun invalidConfirmationCannotAddProfileOrReplaceActiveHousehold(){
        add(first,"Дім");val profiles=AddressProfiles(context)
        assertFalse(profiles.confirm(second,"",repo().prepare(second),name="Робота",add=true))
        assertFalse(profiles.confirm(second,"Інша адреса",repo().prepare(first),name="Робота",add=true))
        assertEquals(first,repo().binding()!!.account);assertEquals(1,profiles.profiles().size)
    }
    @Test fun switchClearsPreviousWeatherAndLocationEvidence(){
        add(first,"Дім");val home=AddressProfiles(context).active()!!;add(second,"Робота")
        context.getSharedPreferences("svitlo_weather",0).edit().putString("location","old-place").commit()
        context.getSharedPreferences("svitlo_geo",0).edit().putString("history","old-evidence").commit()
        assertTrue(AddressProfiles(context).activate(home.id))
        assertFalse(context.getSharedPreferences("svitlo_weather",0).contains("location"));assertFalse(context.getSharedPreferences("svitlo_geo",0).contains("history"))
    }
    @Test fun clearRemovesAllProfilesWithoutResurrectingDeletedBinding(){
        add(first,"Дім");add(second,"Робота");repo().clear();AddressProfiles(context).clear()
        assertTrue(AddressProfiles(context).profiles().isEmpty());assertNull(AddressProfiles(context).active())
    }
    @Test fun failedProfileCommitCannotLeaveAnAddressThatWasReportedAsUnsaved(){
        add(first,"Дім")
        val backing=context.getSharedPreferences("svitlo_profiles",0)
        var failOnce=true
        val failing=object:SharedPreferences by backing{
            override fun edit():SharedPreferences.Editor {
                val editor=backing.edit();var newProfile=false
                return object:SharedPreferences.Editor by editor{
                    override fun putString(key:String,value:String?):SharedPreferences.Editor=also{
                        if(key=="profiles" && value?.contains(second)==true)newProfile=true
                        editor.putString(key,value)
                    }
                    override fun commit():Boolean{val committed=editor.commit();return if(newProfile && failOnce){failOnce=false;false}else committed}
                }
            }
        }
        val wrapped=object:ContextWrapper(context){
            override fun getApplicationContext():Context=this
            override fun getSharedPreferences(name:String,mode:Int)=if(name=="svitlo_profiles")failing else super.getSharedPreferences(name,mode)
        }
        assertFalse(AddressProfiles(wrapped).confirm(second,"Інша адреса",repo().prepare(second),name="Робота",add=true))
        assertEquals(1,AddressProfiles(context).profiles().size);assertEquals(first,repo().binding()!!.account)
    }
    @Test fun processDeathBetweenProfileStageAndBindingCommitRecoversAtCapacity(){
        repeat(10){add((12345678000L+it).toString(),"Адреса $it")}
        val profiles=AddressProfiles(context);val active=profiles.active()!!
        val prefs=context.getSharedPreferences("svitlo_profiles",0)
        val rows=JSONArray(prefs.getString("profiles","[]"))
        for(index in 0 until rows.length())if(rows.getJSONObject(index).getString("id")==active.id){
            rows.getJSONObject(index).put("account","12345679999").put("address","Перервана заміна")
        }
        prefs.edit().putString("profiles",rows.toString()).commit()
        assertNotNull(AddressProfiles(context).active())
        assertEquals(active.binding,AddressProfiles(context).active()!!.binding)
        assertEquals(10,AddressProfiles(context).profiles().size)
    }
}
