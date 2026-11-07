package ua.svitlo.widget

import android.content.Context
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.FutureTask
import java.util.concurrent.ExecutionException

/** One cycle, exact request keys, including failures. Filtering happens after shared department HTTP. */
internal class CycleOperatorTransport(private val delegate:OperatorTransport):OperatorTransport {
    private val requests=ConcurrentHashMap<Map<String,String>,FutureTask<String>>()
    fun clear(){requests.clear()}
    override fun request(parameters:Map<String,String>):String {
        val task=FutureTask{delegate.request(parameters)}
        val shared=requests.putIfAbsent(parameters.toMap(),task) ?: task.also{it.run()}
        return try{shared.get()}catch(error:ExecutionException){throw error.cause ?: error}
    }
}

internal object MultiAddressRefresh {
    fun detailedInstalled(context:Context)=AppWidgetManager.getInstance(context)
        .getAppWidgetIds(ComponentName(context,SvitloWidget::class.java)).isNotEmpty()
    fun refresh(context:Context,source:OutageSource?=null):Boolean {
        val transport=if(source==null)CycleOperatorTransport(OperatorHttp(context))else null
        val profiles=AddressProfiles(context);val repo=OutageRepository(context,source ?: OutageApi(transport!!))
        val active=repo.binding();val token=repo.generationToken()
        val targets=profiles.saved().filter{detailedInstalled(context) || it.profile.binding==active}
        var ok=true
        // Each preparation has at most three parallel category requests; profiles share the cycle transport.
        // Complete each department once, then release its potentially large HTTP bodies.
        // UI order is independent of fetch order; retaining ten department feeds can exhaust the heap.
        val groups=targets.groupBy{val b=it.profile.binding;if(b.account.isNotEmpty())"account:${b.account}"else "dept:${b.dictionary!!.departmentId}"}
        for(group in groups.values)try{for(target in group){
            if(Thread.currentThread().isInterrupted)throw InterruptedException()
            val binding=target.profile.binding
            val prepared=repo.prepare(binding)
            val stored=profiles.storeRefresh(target,prepared,if(binding==active)token else null)
            if(!stored || prepared.failures.isNotEmpty())ok=false
            if(stored)binding.dictionary?.let{address->
                val registry=QueueRegistryRepository(context)
                if(registry.cached(address)==null && !registry.excluded(address))registry.refresh(address)
            }
        }}finally{transport?.clear()}
        return ok
    }
}
