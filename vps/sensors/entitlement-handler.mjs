/** Candidate adapter for SensorAccess.handle, after its existing session check.
 * Returns null for an unrelated action; errors use the existing problem helper.
 * No client claim, installation ID, payment token or test flag is accepted. */
export async function entitlementAction(bridge,owner,input,problem){
 if(input?.action!=='entitlement')return null;
 if(!owner)throw problem(401,'sensor_session_required','owner');
 if(!input||input.schemaVersion!==1||Object.keys(input).length!==2||!Object.hasOwn(input,'schemaVersion'))throw problem(400,'invalid_sensor_packet');
 let value;
 try{value=(await bridge.query('select svitlo_sensors.main_app_entitlement() result')).rows?.[0]?.result;}
 catch{throw problem(503,'subscription_check_unavailable');}
 if(value?.http===401&&value.code==='sensor_session_required')throw problem(401,value.code,'owner');
 const e=value?.entitlement;
 if(value?.http!==200||value.schemaVersion!==1||!e||Array.isArray(e)||e.policy!=='main_app_subscription_v1'||e.ownerQrTransferGate!==true||
  !['active','inactive'].includes(e.status)||typeof e.testAccess!=='boolean'||e.maxSensorsPerAddress!==1||
  (e.status==='active'?(e.maxAddresses!==10||typeof e.validUntil!=='string'||!Number.isFinite(Date.parse(e.validUntil))||Date.parse(e.validUntil)<=Date.now()):
   (e.maxAddresses!==2||e.validUntil!==null||e.testAccess!==false)))throw problem(503,'subscription_check_unavailable');
 return {schemaVersion:1,entitlement:{policy:e.policy,ownerQrTransferGate:true,status:e.status,validUntil:e.validUntil,testAccess:e.testAccess,maxAddresses:e.maxAddresses,maxSensorsPerAddress:1}};
}
