package ua.svitlo.widget

import android.app.Instrumentation
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import org.json.*
import ua.svitlo.widget.core.*
import java.time.Instant
import java.time.format.DateTimeFormatter
import java.util.concurrent.atomic.AtomicInteger

/** Only synthetic personal data and local registry evidence; no live provider lookups. */
object NativeBoguna154 {
    fun verify(test:Instrumentation,activity:MainActivity):JSONObject {
        val context=test.targetContext
        val address=DictionaryAddress("18","801","м. Христинівка","11951","вул. І.Богуна","8/а")
        val calls=AtomicInteger()
        val repository=OutageRepository(context,OutageSource{account,category,_,_->
            check(account=="12345678999");calls.incrementAndGet()
            JSONObject().put("DATETIME",Instant.now().atZone(KYIV_ZONE).format(DateTimeFormatter.ofPattern("HH:mm dd.MM.yyyy")))
                .put("DISCONNECTIONS",JSONArray()).put("DISCONN_QUEUQ",JSONArray().apply{if(category==Category.SCHEDULE)put(JSONObject().put("QUEUE_INFO","Графік погодинних відключень: в чергу не включено"))}).toString()
        })
        check(QueueRegistryRepository(context,RegistrySource{key->check(key==address);JSONObject().put("resolution",JSONObject()
            .put("status","not_found").put("inclusion","not_in_queue").put("queue",JSONObject.NULL))}).refresh(address,true))
        fun main(action:()->Unit){var error:Throwable?=null;test.runOnMainSync{try{action()}catch(e:Throwable){error=e}};error?.let{throw it}}
        fun field(name:String,value:Any){MainActivity::class.java.getDeclaredField(name).apply{isAccessible=true}.set(activity,value)}
        fun all(v:View):List<View> = listOf(v)+if(v is ViewGroup)(0 until v.childCount).flatMap{all(v.getChildAt(it))}else emptyList()
        val old=repository.binding()
        main{
            field("repo",repository);field("addingProfile",true);field("changingAccount",true)
            field("department",AddressItem("18","Христинівська філія"));field("city",AddressItem("801",address.city))
            field("street",AddressItem("11951",address.street));field("house",address.house)
            field("addressApi",AddressApi(OperatorTransport{params->check(params["street_id"]=="11951" && params["house"]=="8/а")
                """[{"LS":"12345678999","ADDRESS":"м. Христинівка, вул. І.Богуна, 8/а"}]"""}))
            MainActivity::class.java.getDeclaredMethod("verifyAddress").apply{isAccessible=true}.invoke(activity)
        }
        for(i in 0 until 50){if(all(activity.window.decorView).any{it.tag=="confirm_yes"})break;SystemClock.sleep(100);test.waitForIdleSync()}
        check(repository.binding()==old && calls.get()==0)
        main{(all(activity.window.decorView).single{it.tag=="confirm_yes"} as Button).performClick()}
        for(i in 0 until 80){if(repository.binding()?.account=="12345678999")break;SystemClock.sleep(100);test.waitForIdleSync()}
        val binding=repository.binding()!!;check(binding.account=="12345678999" && binding.dictionary==address)
        val snapshot=repository.snapshot();check(snapshot.explicitHourlyExclusion() && snapshot.queueLabel()==null);check(calls.get()==3)
        main{check(all(activity.window.decorView).any{it.tag=="home_schedule"})}
        return JSONObject().put("confirmed",true).put("personal_category_requests",calls.get()).put("dictionary_retained",true)
            .put("queue",JSONObject.NULL).put("excluded",true)
    }
}
