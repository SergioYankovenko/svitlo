/** Candidate adapter for SensorAccess.handle, after its existing session check.
 * Returns null for an unrelated action; errors use the existing problem helper.
 * No client claim, installation ID, payment token or test flag is accepted. */
export async function entitlementAction(bridge,owner,input,problem){
 if(input?.action!=='entitlement')return null;
 if(!owner)throw problem(401,'sensor_session_required','owner');
 if(!input||input.schemaVersion!==1||Object.keys(input).length!==2||!Object.hasOwn(input,'schemaVersion'))throw problem(400,'invalid_sensor_packet');
 const value=(await bridge.query('select svitlo_sensors.main_app_entitlement() result')).rows?.[0]?.result;
 if(!value||!Number.isInteger(value.http))throw problem(503,'subscription_check_unavailable');
 if(value.http!==200)throw problem(value.http,value.code);
 const {http,...body}=value;return body;
}
