package ua.svitlo.widget.next

import android.Manifest
import android.app.*
import android.content.*
import android.content.pm.PackageManager
import android.graphics.*
import android.os.*
import android.view.*
import android.widget.*
import com.google.zxing.*
import com.google.zxing.common.HybridBinarizer
import org.json.*
import ua.svitlo.widget.*
import java.time.*
import java.util.UUID

object SensorPolicy {
    fun signal(value:JSONObject?,now:Instant):String=runCatching{
        val s=value ?: return "unknown";val ttl=strictLong(s,"freshnessSeconds");require(ttl in 1..900)
        // Plan235 phone_signal omits clockQuality. Its fresh/null-reason projection is
        // produced only from trusted_sample, and is explicitly tagged with this coverage contract.
        val phoneProjection=!s.has("clockQuality")&&ttl==900L&&s.has("reason")&&s.isNull("reason")&&s.optJSONObject("coverage")?.optString("kind")=="explicit_only"&&s.optJSONObject("coverage")?.opt("continuous")==false
        require(s.optString("availability")=="available"&&s.optString("freshness")=="fresh"&&s.optString("transportState")=="online"&&(s.optString("clockQuality")=="synchronized"||phoneProjection))
        val at=wireInstant(s.getString("lastConfirmedAt"));val received=wireInstant(s.getString("lastReceivedAt"))
        require(at<=now.plusSeconds(5)&&received<=now.plusSeconds(5)&&at.plusSeconds(ttl)>now&&received.plusSeconds(ttl)>now);s.getString("powerState").takeIf{it=="on"||it=="off"} ?:"unknown"
    }.getOrDefault("unknown")
    fun qr(raw:String):JSONObject {
        require(raw.toByteArray().size<=1024)
        val value=raw.trim()
        if(Regex("^[0-9]{6}$").matches(value))return JSONObject().put("version",1).put("kind","phone_code").put("code",value)
        val q=JSONObject(value)
        if(q.optString("kind")=="phone_code"){
            require(q.keys().asSequence().toSet()==setOf("version","kind","code")&&q.get("version")==1)
            require(q.get("code") is String&&Regex("^[0-9]{6}$").matches(q.getString("code")))
            return q
        }
        require(q.keys().asSequence().toSet()==setOf("version","kind","sensorId","proof"));require(q.getInt("version")==1 && UUID_RE.matches(q.getString("sensorId")));val prefix=when(q.getString("kind")){"phone_owner"->"sp_";"factory_owner"->"so_";"viewer_invite"->"si_";else->error("Непідтримуваний QR")};require(Regex(prefix+"[A-Za-z0-9_-]{43}").matches(q.getString("proof")));return q
    }
    fun observation(o:JSONObject,date:LocalDate):JSONObject {
        require(strictLong(o,"overviewVersion")==1L&&o.getString("date")==date.toString()&&o.getString("timezone")=="Europe/Kyiv")
        val start=date.atStartOfDay(NEXT_ZONE).toInstant();val end=date.plusDays(1).atStartOfDay(NEXT_ZONE).toInstant()
        require(wireInstant(o.getString("dayStartUtc"))==start&&wireInstant(o.getString("dayEndUtc"))==end)
        // Server projection uses ECMAScript TimeClip milliseconds even when the
        // PostgreSQL asOf string retains microseconds. Match that documented precision.
        val asOf=wireInstant(o.getString("asOf")).truncatedTo(java.time.temporal.ChronoUnit.MILLIS);val through=asOf.coerceIn(start,end)
        val observation=o.getJSONObject("observation");require(observation.getString("semantics")=="explicit_coverage_only"&&observation.get("complete") is Boolean)
        val complete=observation.getBoolean("complete");val intervals=observation.getJSONArray("intervals").objects();require(intervals.size<=5000)
        var previous=start;var on=0L;var off=0L
        for(e in intervals){val a=wireInstant(e.getString("start"));val b=wireInstant(e.getString("end"));val state=e.getString("powerState");require(a>=previous&&b<=through&&a<b&&state in setOf("on","off"));val length=Duration.between(a,b).toMillis();if(state=="on")on+=length else off+=length;previous=b}
        val elapsed=Duration.between(start,through).toMillis();val known=on+off
        val summary=observation.getJSONObject("summary")
        require(strictLong(summary,"elapsedMs")==elapsed&&strictLong(summary,"futureMs")==Duration.between(through,end).toMillis()){ "Overview elapsed/future totals mismatch" }
        if(asOf<start)require(observation.isNull("through"))else require(wireInstant(observation.getString("through"))==through){ "Overview through precision mismatch" }
        if(complete){
            require(strictLong(summary,"knownMs")==known&&strictLong(summary,"unknownMs")==elapsed-known){ "Overview coverage totals mismatch" }
            if(known==0L)require(summary.isNull("onMs")&&summary.isNull("offMs"))else require(strictLong(summary,"onMs")==on&&strictLong(summary,"offMs")==off)
            val expected=if(known==0L)"unavailable"else if(known==elapsed)"available"else"partial"
            require(observation.getString("availability")==expected)
        }else require(intervals.isEmpty()&&listOf("onMs","offMs","knownMs","unknownMs").all(summary::isNull))
        val points=observation.getJSONArray("points").objects();require(points.size<=5000)
        for(point in points){val at=wireInstant(point.getString("at"));require(at>=start&&at<end&&at<=through&&point.getString("powerState") in setOf("on","off"))}
        return observation
    }
}

