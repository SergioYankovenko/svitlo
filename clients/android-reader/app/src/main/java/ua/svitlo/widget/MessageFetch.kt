package ua.svitlo.widget

import android.content.SharedPreferences
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.URL
import java.time.Instant
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import javax.net.ssl.HttpsURLConnection

internal class MessageHttpError(val status:Int,val retryAfter:String?=null):IOException("HTTP $status")
internal data class MessageResponse(val status:Int,val body:String="",val etag:String?=null)
internal data class MessageRefresh(val successful:Boolean,val retry:Boolean=false,val nextAttempt:Long=0,val attempted:Boolean=false)

/** Persisted successful interval and a separate, finite failure budget. Shared by foreground/background. */
internal class MessageFetchGate(private val prefs:SharedPreferences,private val now:()->Instant,private val prefix:String="") {
    private fun key(name:String)=prefix+name
    fun attemptedAt()=prefs.getLong(key("attempt"),0)
    fun succeededAt()=prefs.getLong(key("success"),0)
    fun failed()=prefs.getBoolean(key("failed"),false)
    fun due():Boolean {
        val at=now().toEpochMilli()
        val next=prefs.getLong(key("retry_at"),0)
        if(next>0)return at>=next
        val success=succeededAt()
        // A pre-upgrade failed attempt must not consume the successful daily window.
        return success==0L || at-success>=DAY
    }
    fun waiting()=MessageRefresh(!failed(),failed() && prefs.getBoolean(key("retryable"),false),prefs.getLong(key("retry_at"),0))
    fun begin(){check(prefs.edit().putLong(key("attempt"),now().toEpochMilli()).commit())}
    fun success(editor:SharedPreferences.Editor):MessageRefresh {
        check(editor.putLong(key("success"),now().toEpochMilli()).putBoolean(key("failed"),false)
            .remove(key("retry_at")).remove(key("retryable")).remove(key("failures")).commit())
        return MessageRefresh(true,attempted=true)
    }
    fun failure(error:Exception):MessageRefresh {
        val at=now().toEpochMilli()
        val transient=error is IOException && (error !is MessageHttpError || error.status==429 || error.status==408 || error.status in 500..599)
        val previous=prefs.getInt(key("failures"),0)
        val reset=prefs.getLong(key("retry_at"),0)<=at && !prefs.getBoolean(key("retryable"),false)
        val count=(if(reset)0 else previous)+1
        val retry=transient && count<=DELAYS.size
        val backoff=if(retry)DELAYS[count-1]else DAY
        val server=(error as? MessageHttpError)?.retryAfter?.let{retryAfter(it,now())} ?: 0L
        val next=maxOf(at+backoff,server)
        check(prefs.edit().putBoolean(key("failed"),true).putInt(key("failures"),count)
            .putBoolean(key("retryable"),retry).putLong(key("retry_at"),next).commit())
        return MessageRefresh(false,retry,next,true)
    }
    companion object {
        const val DAY=86_400_000L
        private val DELAYS=longArrayOf(60_000L,300_000L,1_800_000L,7_200_000L)
        internal fun retryAfter(value:String,now:Instant):Long=runCatching{
            val seconds=value.trim().toLongOrNull()
            if(seconds!=null){require(seconds>=0);Math.addExact(now.toEpochMilli(),Math.multiplyExact(seconds,1000))}
            else ZonedDateTime.parse(value,DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli()
        }.getOrDefault(0L).coerceAtLeast(0)
    }
}

internal object MessageHttp {
    fun get(url:String,etag:String?=null):MessageResponse {
        val c=URL(url).openConnection() as HttpsURLConnection
        c.instanceFollowRedirects=false;c.connectTimeout=10_000;c.readTimeout=15_000;c.useCaches=false
        c.setRequestProperty("Accept","application/json")
        etag?.takeIf{it.length<=256 && !it.contains('\r') && !it.contains('\n')}?.let{c.setRequestProperty("If-None-Match",it)}
        return try {
            val status=c.responseCode
            if(status==304)MessageResponse(304,etag=etag)
            else {
                if(status!=200)throw MessageHttpError(status,c.getHeaderField("Retry-After"))
                val bytes=ByteArrayOutputStream();val buffer=ByteArray(4096)
                c.inputStream.use{stream->while(true){val n=stream.read(buffer);if(n<0)break;require(bytes.size()+n<=65_536);bytes.write(buffer,0,n)}}
                MessageResponse(200,String(bytes.toByteArray(),Charsets.UTF_8),c.getHeaderField("ETag")?.takeIf{it.length<=256})
            }
        }finally{c.disconnect()}
    }
}
