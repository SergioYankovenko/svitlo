package ua.svitlo.widget.next

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.Instant

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[28])
class MainAppSubscription170Test {
    private val now=Instant.parse("2026-11-05T10:00:00Z")
    private fun packet(active:Boolean=true,test:Boolean=true)=JSONObject().put("schemaVersion",1).put("entitlement",JSONObject()
        .put("policy",MainAppSubscription.POLICY).put("status",if(active)"active"else"inactive")
        .put("ownerQrTransferGate",true).put("testAccess",test&&active)
        .put("validUntil",if(active)now.plusSeconds(600).toString()else JSONObject.NULL)
        .put("maxAddresses",if(active)10 else 2).put("maxSensorsPerAddress",1))
    private fun reject(v:JSONObject){assertThrows(Exception::class.java){MainAppSubscription.parse(v,now)}}
    @Test fun oneSubscriptionCoversAllAllowedAddressesWithoutSensorServiceFlag(){
        val right=MainAppSubscription.parse(packet(),now);right.requireActive(now)
        assertTrue(right.active);assertTrue(right.testAccess)
        assertFalse(packet().getJSONObject("entitlement").has("sensorService"))
    }
    @Test fun verifiedPaidAndPrivateTestRightsUseSameGate(){for(test in listOf(false,true)){val right=MainAppSubscription.parse(packet(test=test),now);right.requireActive(now);assertEquals(test,right.testAccess)}}
    @Test fun noRightHasOnlyTheAgreedWarning(){val e=assertThrows(NextApiException::class.java){MainAppSubscription.parse(packet(false),now).requireActive(now)};assertEquals("Придбайте підписку",SensorConnectFailure.message(e))}
    @Test fun errorsAreNotMisreportedAsMissingSubscription(){for(e in listOf(java.io.IOException(),NextApiException(503),NextApiException(429),NextApiException(400,code="invalid_sensor_packet"))){assertEquals("Не вдалося завантажити дані.",SensorConnectFailure.message(e))}}
    @Test fun inactiveIsNotAServerErrorAndUnknownIsNotInactive(){reject(packet().apply{getJSONObject("entitlement").put("status","unknown")});assertFalse(MainAppSubscription.parse(packet(false),now).active)}
    @Test fun oldBackendCannotEnableTransfer(){reject(JSONObject().put("schemaVersion",1).put("entitlement","not_configured"));reject(packet().apply{getJSONObject("entitlement").put("ownerQrTransferGate",false)});reject(packet().apply{getJSONObject("entitlement").remove("ownerQrTransferGate")})}
    @Test fun malformedBooleanOrSchemaCannotEnableTransfer(){reject(packet().put("schemaVersion",2));reject(packet().put("schemaVersion","1"));reject(packet().apply{getJSONObject("entitlement").put("testAccess","true")});reject(packet().apply{getJSONObject("entitlement").put("ownerQrTransferGate","true")})}
    @Test fun rightNeedsAnActualUnexpiredServerDeadline(){for(value in listOf(JSONObject.NULL,now.toString(),now.minusSeconds(1).toString(),"tomorrow"))reject(packet().apply{getJSONObject("entitlement").put("validUntil",value)})}
    @Test fun expirationWhileWaitingRequiresRecheck(){val right=MainAppSubscription.parse(packet(),now);val e=assertThrows(NextApiException::class.java){right.requireActive(now.plusSeconds(600))};assertEquals(503,e.status);assertEquals("Не вдалося завантажити дані.",SensorConnectFailure.message(e))}
    @Test fun policyAndLimitsMustMatchApprovedModel(){reject(packet().apply{getJSONObject("entitlement").put("policy","per_sensor_v1")});reject(packet().apply{getJSONObject("entitlement").put("maxAddresses",11)});reject(packet().apply{getJSONObject("entitlement").put("maxSensorsPerAddress",2)})}
    @Test fun inactiveWireCannotPretendToBeAPrivateGrant(){reject(packet(false).apply{getJSONObject("entitlement").put("testAccess",true)});reject(packet(false).apply{getJSONObject("entitlement").put("validUntil",now.plusSeconds(60).toString())})}
    @Test fun onlyExplicitInitialBindingErrorAsksForProfile(){assertTrue(SensorConnectFailure.needsInitialProfile(NextApiException(409,code="first_connection_requires_profile")));for(e in listOf(NextApiException(409),NextApiException(403,code="first_connection_requires_profile"),NextApiException(409,code="profile_already_has_sensor")))assertFalse(SensorConnectFailure.needsInitialProfile(e))}
    private fun member()=JSONObject().put("sensorId","sensor").put("bindingEpoch",1).put("membershipId","owner-row").put("readerProfileId","profile").put("role","owner")
    @Test fun revokedLateConnectResponseCannotRestoreOwnerControls(){assertThrows(NextApiException::class.java){SensorMembershipPolicy.confirmed(member(),emptyList())}}
    @Test fun replacedRoleEpochMembershipOrProfileCannotReuseOldSuccess(){for((key,value)in listOf("role" to "viewer","bindingEpoch" to 2,"membershipId" to "new-row","readerProfileId" to "other-profile")){val current=member().put(key,value);assertThrows(NextApiException::class.java){SensorMembershipPolicy.confirmed(member(),listOf(current))}}}
    @Test fun currentServerMembershipSuppliesTheActualControlContext(){val current=member().put("accessRevision",9);assertSame(current,SensorMembershipPolicy.confirmed(member(),listOf(current)))}
    private val oldProfileId="10000000-0000-4000-8000-000000000001"
    private val currentProfileId="10000000-0000-4000-8000-000000000002"
    private val addressId="20000000-0000-4000-8000-000000000001"
    private fun localProfile(line:String?=null)=NextProfile("local","",addressId,line,"Адреса","Місто","Вулиця","1","operator",oldProfileId)
    private fun ownedProfile(id:String=currentProfileId,address:String=addressId,line:String?=null)=JSONObject().put("id",id).put("address",JSONObject().put("canonicalAddressId",address).put("lineId",line ?:JSONObject.NULL))
    @Test fun cachedServerIdFromAnOldSessionIsNotProofOfOwnership(){assertNull(SensorProfileBindingPolicy.ownedId(localProfile(),emptyList()))}
    @Test fun reauthenticatedReaderReusesItsOwnCanonicalProfileInsteadOfTheStaleId(){assertEquals(currentProfileId,SensorProfileBindingPolicy.ownedId(localProfile(),listOf(ownedProfile())))}
    @Test fun aCachedIdPointingAtAnotherAddressCannotBindTheWrongPoint(){assertNull(SensorProfileBindingPolicy.ownedId(localProfile(),listOf(ownedProfile(oldProfileId,address="20000000-0000-4000-8000-000000000002"))))}
    @Test fun ownedProfileNeedsTheSameExplicitLine(){assertNull(SensorProfileBindingPolicy.ownedId(localProfile("line-a"),listOf(ownedProfile(line="line-b"))));assertEquals(currentProfileId,SensorProfileBindingPolicy.ownedId(localProfile("line-a"),listOf(ownedProfile(line="line-a"))))}
    @Test fun nullLineRemainsDistinctFromAnExplicitGroup(){assertNull(SensorProfileBindingPolicy.ownedId(localProfile(),listOf(ownedProfile(line="line-a"))));assertNull(SensorProfileBindingPolicy.ownedId(localProfile("line-a"),listOf(ownedProfile())))}
    @Test fun ambiguousOwnedProfilesCannotBeGuessed(){assertThrows(IllegalArgumentException::class.java){SensorProfileBindingPolicy.ownedId(localProfile(),listOf(ownedProfile(),ownedProfile(oldProfileId)))}}
}
