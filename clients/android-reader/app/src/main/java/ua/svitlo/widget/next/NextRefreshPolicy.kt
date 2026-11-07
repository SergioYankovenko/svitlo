package ua.svitlo.widget.next

/** Server deadlines drive visible refresh. Attempts never consume a successful
 * cache window; errors use a persisted, bounded retry cadence. */
internal object NextRefreshPolicy {
    /** Freshness controls display trust; refreshAfter controls the next read
     * during an upstream cooldown. An expired table is not permission to
     * repeatedly bypass the server's future retry deadline. */
    fun deadline(refreshAfter:Long,freshUntil:Long,now:Long)=if(freshUntil>now)minOf(refreshAfter,freshUntil)else refreshAfter
    fun due(now:Long,deadlines:List<Long?>,retryAt:Long,rateLimitAt:Long,force:Boolean=false):Boolean {
        if(deadlines.isEmpty()||now<rateLimitAt)return false
        if(force)return true
        return now>=retryAt&&deadlines.any{it==null||it<=now}
    }
    fun backoff(failures:Int)=listOf(30_000L,60_000L,180_000L,600_000L,3_600_000L)[(failures-1).coerceIn(0,4)]
}
