package ua.svitlo.widget.next

import org.json.JSONObject
import java.time.Instant

/** A fresh authenticated server assertion, never a stored device-side purchase flag. */
data class MainAppSubscription(val active:Boolean,val validUntil:Instant?,val testAccess:Boolean) {
    companion object {
        const val POLICY="main_app_subscription_v1"
        fun parse(packet:JSONObject,now:Instant=Instant.now()):MainAppSubscription {
            require(strictLong(packet,"schemaVersion")==1L)
            val value=packet.getJSONObject("entitlement")
            require(value.getString("policy")==POLICY && value.get("ownerQrTransferGate")==true)
            require(strictLong(value,"maxSensorsPerAddress")==1L)
            val state=value.getString("status");require(state in setOf("active","inactive"))
            require(value.get("testAccess") is Boolean)
            val until=if(value.isNull("validUntil"))null else wireInstant(value.getString("validUntil"))
            if(state=="active")require(until!=null&&until>now&&strictLong(value,"maxAddresses")==10L)
            else require(until==null&&!value.getBoolean("testAccess")&&strictLong(value,"maxAddresses")==2L)
            return MainAppSubscription(state=="active",until,value.getBoolean("testAccess"))
        }
    }
    fun requireActive(now:Instant=Instant.now()) {
        if(!active)throw NextApiException(403,code="subscription_required")
        // A right that expired while waiting must be rechecked, not treated as paid.
        if(validUntil==null||validUntil<=now)throw NextApiException(503,code="subscription_check_unavailable")
    }
}

internal object SensorConnectFailure {
    fun message(error:Exception)=when {
        error is NextApiException&&error.status==403&&error.code=="subscription_required"->"Придбайте підписку"
        error is NextApiException&&error.status in setOf(403,404)->"Доступ відкликано"
        else->"Не вдалося завантажити дані."
    }
    fun needsInitialProfile(error:Exception)=error is NextApiException&&error.status==409&&error.code=="first_connection_requires_profile"
}

/** A late successful command cannot reopen owner controls after revocation. */
internal object SensorMembershipPolicy {
    fun confirmed(packet:JSONObject,current:List<JSONObject>):JSONObject {
        val membership=current.singleOrNull {
            it.getString("sensorId")==packet.getString("sensorId")&&
            it.getLong("bindingEpoch")==packet.getLong("bindingEpoch")&&
            it.getString("membershipId")==packet.getString("membershipId")&&
            it.getString("role")==packet.getString("role")&&
            it.getString("readerProfileId")==packet.getString("readerProfileId")
        }
        return membership ?:throw NextApiException(404,code="sensor_not_available")
    }
}

/** Server profile IDs are scoped to the current authenticated reader. A local
 * ID can survive session loss, but must never authorize a binding by itself. */
internal object SensorProfileBindingPolicy {
    fun ownedId(profile:NextProfile,owned:List<JSONObject>):String? {
        val matches=owned.filter { row->
            val address=row.optJSONObject("address") ?:return@filter false
            val line=address.optString("lineId").takeUnless{it.isBlank()||it=="null"}
            UUID_RE.matches(row.optString("id"))&&address.optString("canonicalAddressId")==profile.addressId&&line==profile.lineId
        }
        require(matches.size<=1){"Ambiguous owned server profile"}
        return matches.singleOrNull()?.getString("id")
    }
}
