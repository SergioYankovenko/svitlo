import {randomBytes,randomInt,createHmac,createCipheriv,createDecipheriv} from 'node:crypto';
import {tokenHash} from './service.js';
import {problem} from '../telemetry/validation.js';
import {phoneDay} from './phone-history.js';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const bad=()=>{throw problem(400,'invalid_phone_packet');};
const exact=(p,keys)=>{if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(p,k)))bad();};
const id=x=>{if(typeof x!=='string'||!uuid.test(x))bad();return x.toLowerCase();};
const epoch=x=>{if(!Number.isInteger(x)||x<1||x>999999999)bad();return x;};
const stamp=x=>{if(typeof x!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x)||!Number.isFinite(Date.parse(x))||new Date(x).toISOString()!==x)bad();return x;};
const integer=x=>{if(!Number.isSafeInteger(x)||x<0)bad();return x;};
export const phoneCapabilities={schemaVersion:1,testOnly:true,phoneEnrollment:true,ownerQr:true,transfer:true,historyDays:90,heartbeatSeconds:300,freshnessSeconds:900,batchVersion:3,maxEvents:50,maxBytes:16384,publicPilotReady:false};
export function externalPower(plugged){return Number.isInteger(plugged)&&plugged>=0?(plugged===0?'off':'on'):'unknown';}
export function normalizeManualCode(value){if(typeof value!=='string'||value.length>16)bad();const code=value.trim();if(!/^[0-9]{6}$/.test(code))bad();return code;}
export function validateQr(p){if(p?.kind==='phone_code'){exact(p,['version','kind','code']);if(p.version!==1)bad();return {version:1,kind:'phone_code',code:normalizeManualCode(p.code)};}exact(p,['version','kind','sensorId','proof']);if(p.version!==1||!['phone_owner','factory_owner','viewer_invite'].includes(p.kind))bad();
 const prefix={phone_owner:'sp',factory_owner:'so',viewer_invite:'si'}[p.kind];if(typeof p.proof!=='string'||!new RegExp('^'+prefix+'_[A-Za-z0-9_-]{43}$').test(p.proof))bad();return {...p,sensorId:id(p.sensorId)};}
export function validatePhoneBatch(p){exact(p,['schemaVersion','sensorId','bindingEpoch','streamId','events']);if(p.schemaVersion!==3||!Array.isArray(p.events)||p.events.length<1||p.events.length>50||Buffer.byteLength(JSON.stringify(p))>16384)bad();
 const events=p.events.map(e=>{exact(e,['eventId','sequence','eventType','powerState','observedAt','clockQuality','bootId','elapsedRealtimeMs','monitorId','coverage']);id(e.eventId);id(e.bootId);id(e.monitorId);integer(e.sequence);if(e.sequence<1)bad();integer(e.elapsedRealtimeMs);
  if(!['sample','heartbeat'].includes(e.eventType)||!['synchronized','unsynchronized'].includes(e.clockQuality)||!['on','off',null].includes(e.powerState)||e.eventType==='heartbeat'&&e.powerState!==null)bad();
  if(e.clockQuality==='synchronized')stamp(e.observedAt);else if(e.observedAt!==null)bad();
  if(e.coverage!==null){const c=e.coverage;exact(c,['startAt','endAt','startElapsedMs','endElapsedMs','powerState']);stamp(c.startAt);stamp(c.endAt);integer(c.startElapsedMs);integer(c.endElapsedMs);
   const duration=Date.parse(c.endAt)-Date.parse(c.startAt);if(e.clockQuality!=='synchronized'||e.eventType!=='sample'||!['on','off'].includes(c.powerState)||c.endAt!==e.observedAt||c.endElapsedMs!==e.elapsedRealtimeMs||duration<=0||duration>300000||c.startElapsedMs>=c.endElapsedMs||duration!==c.endElapsedMs-c.startElapsedMs)bad();}
  return {...e,eventId:e.eventId.toLowerCase(),bootId:e.bootId.toLowerCase(),monitorId:e.monitorId.toLowerCase()};});
 return {...p,sensorId:id(p.sensorId),bindingEpoch:epoch(p.bindingEpoch),streamId:id(p.streamId),events};
}
export class PhoneSensors{
 constructor({bridge,secret}){if(!/^[a-f0-9]{64}$/.test(secret||''))throw Error('Phone encryption key unavailable');this.bridge=bridge;this.key=Buffer.from(secret,'hex');}
 token(prefix){return prefix+'_'+randomBytes(32).toString('base64url');}
 manualHash(code){return createHmac('sha256',this.key).update('phone-manual-code-v1:'+normalizeManualCode(code)).digest('hex');}
 seal(value,scope){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.key,iv);c.setAAD(Buffer.from(scope));const ciphertext=Buffer.concat([c.update(value,'utf8'),c.final()]);return [iv,c.getAuthTag(),ciphertext].map(x=>x.toString('base64url')).join('.');}
 open(value,scope){try{const [iv,tag,body]=value.split('.').map(x=>Buffer.from(x,'base64url')),d=createDecipheriv('aes-256-gcm',this.key,iv);d.setAAD(Buffer.from(scope));d.setAuthTag(tag);return Buffer.concat([d.update(body),d.final()]).toString();}catch{throw problem(503,'phone_key_unavailable');}}
 async call(op,p){const r=(await this.bridge.query('select svitlo_sensors.phone_command($1,$2::jsonb) result',[op,JSON.stringify(p)])).rows[0].result;
  if(!r||!Number.isInteger(r.http))throw problem(503,'phone_unavailable');if(r.http>=400)throw Object.assign(problem(r.http,r.code,r.http===401||r.http===403?'owner':r.http===429?'rate':'schema'),r.http===429?{retryAfter:60}:{});const {http,...value}=r;return value;}
 async register(p){exact(p,['schemaVersion','registrationToken']);if(p.schemaVersion!==1||typeof p.registrationToken!=='string'||!/^sr_[A-Za-z0-9_-]{43}$/.test(p.registrationToken))bad();
  const registrationHash=tokenHash(p.registrationToken),controlToken='sd_'+createHmac('sha256',this.key).update('phone-control-v1:'+registrationHash).digest('base64url');
  const r=await this.call('register',{registrationHash,controlHash:tokenHash(controlToken)});return {...r,controlToken};}
 async control(header,p){if(typeof header!=='string'||!/^Bearer sd_[A-Za-z0-9_-]{43}$/.test(header))throw problem(401,'phone_control_unauthorized','owner');
  const rotate=p?.action==='rotate_owner_qr';exact(p,rotate?['schemaVersion','action','sensorId','requestId']:['schemaVersion','action','sensorId']);if(p.schemaVersion!==1||!['status','owner_qr','ingest_credentials','rotate_owner_qr'].includes(p.action))bad();
  const data={sensorId:id(p.sensorId),controlHash:tokenHash(header.slice(7))};if(rotate)data.requestId=id(p.requestId);return this.perform(p.action,data);}
 async reader(owner,p){if(!owner)throw problem(401,'sensor_session_required','owner');if(p.schemaVersion!==1)bad();
  if(p.action==='connect_qr'){const keys=['schemaVersion','action','requestId','qr'];if(p.profileId!==undefined)keys.push('profileId');exact(p,keys);const qr=validateQr(p.qr);if(qr.kind==='viewer_invite')return {viewerInvite:qr.proof,viewerSensorId:qr.sensorId,profileId:p.profileId,requestId:id(p.requestId)};
   if(qr.kind==='phone_code'){
    const data={requestId:id(p.requestId),codeHash:this.manualHash(qr.code)};if(p.profileId!==undefined)data.profileId=id(p.profileId);
    const r=(await this.bridge.query('select svitlo_sensors.phone_code_connect($1::jsonb) result',[JSON.stringify(data)])).rows[0].result;
    if(!r||!Number.isInteger(r.http))throw problem(503,'phone_unavailable');if(r.http>=400)throw Object.assign(problem(r.http,r.code,r.http===429?'rate':'schema'),r.http===429?{retryAfter:900}:{});const {http,...value}=r;return value;
   }
   const data={requestId:id(p.requestId),sensorId:qr.sensorId,kind:qr.kind,qrHash:tokenHash(qr.proof)};if(p.profileId!==undefined)data.profileId=id(p.profileId);return this.call('connect',data);}
  if(p.action==='relocate'){exact(p,['schemaVersion','action','requestId','sensorId','bindingEpoch','profileId','confirmed']);if(p.confirmed!==true)bad();const data={requestId:id(p.requestId),sensorId:id(p.sensorId),bindingEpoch:epoch(p.bindingEpoch),profileId:id(p.profileId),confirmed:true};const r=(await this.bridge.query('select svitlo_sensors.phone_relocate($1::jsonb) result',[JSON.stringify(data)])).rows[0].result;if(r.http>=400)throw problem(r.http,r.code);const {http,...value}=r;return value;}
  exact(p,['schemaVersion','action','requestId','sensorId','bindingEpoch']);if(p.action!=='owner_qr')bad();id(p.requestId);return this.perform('reader_qr',{sensorId:id(p.sensorId),bindingEpoch:epoch(p.bindingEpoch)});}
 async perform(action,data,attempt=0){try{let proof;if(['owner_qr','reader_qr','rotate_owner_qr'].includes(action)){proof=this.token('sp');data.qrHash=tokenHash(proof);data.qrCipher=this.seal(proof,'owner-qr:'+data.sensorId);
   const manual=String(randomInt(0,1000000)).padStart(6,'0');data.manualHash=this.manualHash(manual);data.manualCipher=this.seal(manual,'manual-code:'+data.sensorId);
  }
  if(action==='ingest_credentials'){proof=this.token('st');data.ingestHash=tokenHash(proof);data.ingestCipher=this.seal(proof,'ingest:'+data.sensorId);}
  let result;
  if(action==='rotate_owner_qr'){
   const r=(await this.bridge.query('select svitlo_sensors.phone_qr_rotate($1::jsonb) result',[JSON.stringify(data)])).rows[0].result;
   if(!r||!Number.isInteger(r.http))throw problem(503,'phone_unavailable');
   if(r.http>=400)throw Object.assign(problem(r.http,r.code,r.http===401||r.http===403?'owner':r.http===429?'rate':'schema'),r.http===429?{retryAfter:60}:{});
   const {http,...v}=r;result=v;
  }else if(action==='owner_qr'||action==='reader_qr'){
   const r=(await this.bridge.query('select svitlo_sensors.phone_qr_get($1,$2::jsonb) result',[action,JSON.stringify(data)])).rows[0].result;
   if(!r||!Number.isInteger(r.http))throw problem(503,'phone_unavailable');if(r.http>=400)throw Object.assign(problem(r.http,r.code,r.http===401||r.http===403?'owner':r.http===429?'rate':'schema'),r.http===429?{retryAfter:60}:{});const {http,...v}=r;result=v;
  }else result=await this.call(action,data);
  const {privateCipher,privateHash,manualCipher,manualHash,...value}=result;
  if(privateCipher){const qr=action!=='ingest_credentials',token=this.open(privateCipher,(qr?'owner-qr:':'ingest:')+data.sensorId);if(tokenHash(token)!==privateHash)throw problem(503,'phone_key_mismatch');if(qr)value.qr={version:1,kind:value.kind,sensorId:data.sensorId,proof:token};else value.ingestToken=token;}
  if(manualCipher){const manual=this.open(manualCipher,'manual-code:'+data.sensorId);if(this.manualHash(manual)!==manualHash)throw problem(503,'phone_key_mismatch');value.manualCode=normalizeManualCode(manual);}
  return value;
 }catch(e){if(e.code==='phone_manual_code_collision'&&attempt<7)return this.perform(action,data,attempt+1);throw e;}}
 async history(p){exact(p,['schemaVersion','action','sensorId','bindingEpoch','date']);if(p.schemaVersion!==1||typeof p.date!=='string'||!/^\d{4}-\d\d-\d\d$/.test(p.date)||!Number.isFinite(Date.parse(p.date+'T00:00:00Z'))||new Date(p.date+'T00:00:00Z').toISOString().slice(0,10)!==p.date)bad();const r=(await this.bridge.query('select svitlo_sensors.phone_history($1,$2,$3::date) result',[id(p.sensorId),epoch(p.bindingEpoch),p.date])).rows[0].result;if(r.http>=400)throw problem(r.http,r.code);const {http,...value}=r;return phoneDay(value);}
 async batch(header,p){if(typeof header!=='string'||!/^Bearer st_[A-Za-z0-9_-]{43}$/.test(header))throw problem(401,'sensor_ingest_unauthorized','owner');const packet=validatePhoneBatch(p);
  const r=(await this.bridge.query('select svitlo_sensors.phone_ingest($1::jsonb,$2) result',[JSON.stringify(packet),tokenHash(header.slice(7))])).rows[0].result;
  if(!r||!Number.isInteger(r.http))throw problem(503,'phone_unavailable');if(r.http>=400)throw Object.assign(problem(r.http,r.code,r.http===429?'rate':'schema'),r.http===429?{retryAfter:60}:{});const {http,...value}=r;return value;}
}
