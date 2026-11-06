import {createHash,createHmac,randomUUID} from 'node:crypto';
import {problem} from '../telemetry/validation.js';
import {phoneForecast} from './prediction.js';
import {buildDayOverview} from './history.js';
import {entitlementAction} from './entitlement-handler.mjs';
export const sensorLimits={maxSensors:10,inviteSeconds:900,maxPending:5,maxViewers:20};
export const sensorCapabilities={schemaVersion:1,available:true,foundationOnly:true,testOnly:true,requiresSession:true,requiresOwnedServerProfile:true,limits:sensorLimits,ingest:true,signal:true,observations:true,overview:true,prediction:false,transfer:false,recovery:false};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const shape={notice_get:['sensorId','bindingEpoch'],notice_set:['sensorId','bindingEpoch','enabled'],list:[],get:['sensorId','bindingEpoch'],signal:['sensorId','bindingEpoch'],overview:['sensorId','bindingEpoch','date'],members:['sensorId','bindingEpoch'],claim:['requestId','claimToken','profileId'],invite_create:['requestId','sensorId','bindingEpoch'],invite_inspect:['inviteToken'],invite_accept:['requestId','inviteToken','profileId'],invite_revoke:['requestId','sensorId','bindingEpoch','inviteId'],member_revoke:['requestId','sensorId','bindingEpoch','membershipId'],leave:['requestId','sensorId','bindingEpoch','membershipId'],link:['requestId','sensorId','bindingEpoch','profileId'],disconnect:['requestId','sensorId','bindingEpoch','confirmed']};
export const tokenHash=token=>createHash('sha256').update(token).digest('hex');
export function validateSensor(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||input.schemaVersion!==1||typeof input.action!=='string'||!Object.hasOwn(shape,input.action))throw problem(400,'invalid_sensor_packet');
 const fields=shape[input.action];if(Object.keys(input).some(k=>!['schemaVersion','action',...fields].includes(k))||fields.some(k=>!Object.hasOwn(input,k)))throw problem(400,'invalid_sensor_packet');
 const result={};for(const key of fields){const value=input[key];
  if(key==='enabled'){if(typeof value!=='boolean')throw problem(400,'invalid_sensor_preference');result[key]=value;}
  else if(key.endsWith('Id')){if(typeof value!=='string'||!uuid.test(value))throw problem(400,'invalid_sensor_id');result[key]=value.toLowerCase();}
  else if(key==='bindingEpoch'){if(!Number.isInteger(value)||value<1||value>999999999)throw problem(400,'invalid_sensor_epoch');result[key]=value;}
  else if(key==='date'){if(typeof value!=='string'||!/^\d{4}-\d\d-\d\d$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00.000Z'))||new Date(value+'T00:00:00.000Z').toISOString().slice(0,10)!==value)throw problem(400,'invalid_sensor_date');result[key]=value;}
  else if(key==='confirmed'){if(value!==true)throw problem(409,'explicit_disconnect_confirmation_required');result[key]=true;}
  else if(key==='claimToken'||key==='inviteToken'){if(typeof value!=='string'||!(key==='claimToken'?/^sc_[A-Za-z0-9_-]{43}$/:/^si_[A-Za-z0-9_-]{43}$/).test(value))throw problem(400,'invalid_sensor_proof');result[key==='claimToken'?'claimHash':'inviteHash']=tokenHash(value);}
 }
 return {action:input.action,data:result};
}
export class SensorAccess {
 constructor({bridge,db,secret,phone}){Object.assign(this,{bridge,db,secret,phone});this.forecasts=new Map();}
 inviteToken(owner,data,nonce){return 'si_'+createHmac('sha256',this.secret).update(JSON.stringify(['sensor-viewer-invite-v1',owner,data.sensorId,data.bindingEpoch,data.requestId,nonce])).digest('base64url');}
 async handle(owner,input){
  if(!owner)throw problem(401,'sensor_session_required','owner');
  if(input?.action==='entitlement')return entitlementAction(this.bridge,owner,input,problem);
  if(this.phone&&['connect_qr','owner_qr','relocate'].includes(input?.action)){const value=await this.phone.reader(owner,input);if(value.viewerInvite){if(!value.profileId)throw problem(409,'viewer_requires_profile');const inspection=await this.handle(owner,{schemaVersion:1,action:'invite_inspect',inviteToken:value.viewerInvite});if(inspection.invitation.sensorId!==value.viewerSensorId)throw problem(409,'viewer_sensor_mismatch');return this.handle(owner,{schemaVersion:1,action:'invite_accept',requestId:value.requestId,profileId:value.profileId,inviteToken:value.viewerInvite});}return value;}
  if(this.phone&&input?.action==='history')return {schemaVersion:1,overview:await this.phone.history(input)};
  if(this.phone&&input?.action==='overview'){const s=await this.handle(owner,{schemaVersion:1,action:'get',sensorId:input.sensorId,bindingEpoch:input.bindingEpoch});if(['phone','factory'].includes(s.sensor.sourceKind)){const overview=await this.phone.history({...input,action:'history'});let forecasts={};const cacheKey=JSON.stringify([owner,input.sensorId,input.bindingEpoch,input.date,new Date().toISOString().slice(0,10)]),cached=this.forecasts.get(cacheKey);if(cached&&cached.until>Date.now())forecasts=cached.value;else{try{forecasts=await phoneForecast(this.phone,input);}catch(error){if(error.status===401||error.status===403)throw error;}if(this.forecasts.size>=64)this.forecasts.delete(this.forecasts.keys().next().value);this.forecasts.set(cacheKey,{until:Date.now()+900000,value:forecasts});}return {schemaVersion:1,overview:{...overview,forecasts,capabilities:{...overview.capabilities,prediction:Object.keys(forecasts).length>0}}};}}
  const {action,data}=validateSensor(input);
  if(action==='notice_get'||action==='notice_set'){const value=(await this.bridge.query('select svitlo_vps.sensor_notice_settings($1,$2,$3) result',[data.sensorId,data.bindingEpoch,action==='notice_set'?data.enabled:null])).rows[0].result;if(value.http!==200)throw problem(value.http,value.code);return {enabled:value.enabled};}
  if(action==='invite_create'){data.nonce=randomUUID();data.tokenHash=tokenHash(this.inviteToken(owner,data,data.nonce));}
  const result=(action==='overview'?await this.bridge.query('select svitlo_sensors.day_source($1,$2,$3) result',[data.sensorId,data.bindingEpoch,data.date]):action==='signal'?await this.bridge.query(this.phone?'select svitlo_sensors.phone_signal($1,$2) result':'select svitlo_sensors.signal($1,$2) result',[data.sensorId,data.bindingEpoch]):await this.bridge.query('select svitlo_sensors.command($1,$2::jsonb) result',[action,JSON.stringify(data)])).rows[0].result;
  if(!result||!Number.isInteger(result.http))throw problem(503,'sensor_unavailable');
  if(result.http>=400)throw Object.assign(problem(result.http,result.code,result.http===403?'owner':result.http===429?'rate':'schema'),result.http===429?{retryAfter:60}:{});
  if(action==='overview')return {schemaVersion:1,overview:buildDayOverview(result.source)};
  const {http,privateNonce,privateHash,...value}=result;
  if(action==='invite_create'){
   const token=this.inviteToken(owner,data,privateNonce);if(tokenHash(token)!==privateHash)throw problem(503,'sensor_invite_key_mismatch');value.invitation.inviteToken=token;
  }
  return value;
 }
}
