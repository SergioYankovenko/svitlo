package ua.svitlo.widget

/** Shared by Activity instances; debounce only an in-flight launcher confirmation. */
class WidgetPinGate {
    private data class Request(val at:Long,val token:String)
    private val pending=mutableMapOf<Boolean,Request>()
    private fun expire(now:Long){pending.entries.removeAll{now-it.value.at !in 0 until 120_000}}
    @Synchronized fun isPending(compact:Boolean,now:Long):Boolean {expire(now);return compact in pending}
    @Synchronized fun begin(compact:Boolean,now:Long):String? {
        expire(now)
        if(compact in pending)return null
        val token=java.util.UUID.randomUUID().toString()
        pending[compact]=Request(now,token);return token
    }
    @Synchronized fun launcherReturned(){pending.clear()}
    @Synchronized fun finish(compact:Boolean,token:String):Boolean {
        if(pending[compact]?.token!=token)return false
        pending.remove(compact);return true
    }
    @Synchronized fun hasPending()=pending.isNotEmpty()
}
