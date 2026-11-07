package ua.svitlo.widget

import android.content.Context
import ua.svitlo.widget.core.*
import java.io.IOException
import java.net.SocketTimeoutException
import java.time.Instant
import java.util.concurrent.*

internal class SetupDataUnavailable(message:String):IOException(message)

/** Prepares an address without activating it. One deadline covers every prerequisite. */
internal class InitialScheduleLoader(
    private val prepare:()->PreparedData,
    private val registry:()->Unit,
    private val publications:()->Unit,
    private val preview:(PreparedData)->Snapshot,
    private val now:()->Instant={Instant.now()},
    private val timeoutMs:Long=60_000
) {
    fun load():PreparedData {
        val end=System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(timeoutMs)
        val pool=Executors.newFixedThreadPool(3)
        val data=pool.submit(Callable{prepare()})
        var queue:Future<Unit>?=null
        val feed=pool.submit(Callable{publications()})
        fun <T> await(task:Future<T>):T {
            val remaining=end-System.nanoTime()
            if(remaining<=0)throw SocketTimeoutException()
            return try{task.get(remaining,TimeUnit.NANOSECONDS)}
                catch(error:ExecutionException){throw error.cause ?: error}
                catch(error:TimeoutException){throw SocketTimeoutException()}
        }
        try {
            val prepared=await(data)
            if(prepared.failures.isNotEmpty())throw SourceException(prepared.failureReasons.values.firstOrNull() ?: SourceFailure.UNREACHABLE)
            val personal=Snapshot(prepared.categories.mapValues{it.value.snapshot})
            val apiQueue=personal.queueLabel()
            if(apiQueue==null){
                queue=pool.submit(Callable{registry()})
                try{await(queue)}catch(error:SourceException){if(!personal.apiHourlyExclusion(now()))throw error}
            }
            await(feed)
            if(Thread.currentThread().isInterrupted)throw InterruptedException()
            val snapshot=preview(prepared);val at=now()
            if(Category.entries.any{snapshot.categories[it]?.isFresh(at)!=true})throw SourceException(SourceFailure.UNREACHABLE)
            if(snapshot.queueLabel()==null && !snapshot.explicitHourlyExclusion())
                throw SetupDataUnavailable("Не вдалося уточнити чергу цієї адреси. Повторіть спробу.")
            if(snapshot.feedFailed || snapshot.conflictDates.isNotEmpty())
                throw SetupDataUnavailable("Не вдалося узгодити графік із офіційними публікаціями. Повторіть спробу.")
            return prepared
        } finally {listOfNotNull(data,queue,feed).forEach{it.cancel(true)};pool.shutdownNow()}
    }
    companion object {
        fun forAddress(context:Context,repo:OutageRepository,account:String,address:String,city:String,selection:DictionaryAddress?):InitialScheduleLoader {
            val app=context.applicationContext
            val binding=ConfirmedBinding(account,address,city,selection)
            return InitialScheduleLoader(
                prepare={repo.prepare(binding)},
                registry={selection?.let{
                    val registry=QueueRegistryRepository(app)
                    if(registry.cached(it)==null && !registry.excluded(it) && !registry.refresh(it,force=true))
                        throw SourceException(SourceFailure.UNREACHABLE)
                };Unit},
                publications={
                    val official=OfficialScheduleRepository(app);val cached=official.snapshot();val at=Instant.now()
                    val fresh=!cached.failed && cached.checkedAt?.let{it>=at.minusSeconds(3600) && it<=at.plusSeconds(300)}==true
                    if(!fresh && !official.refresh())throw SetupDataUnavailable("Не вдалося перевірити офіційні публікації. Повторіть спробу.")
                },
                preview={repo.profileSnapshot(binding,it)})
        }
    }
}
