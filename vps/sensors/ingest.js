import {tokenHash} from './service.js';
import {problem} from '../telemetry/validation.js';
const fields=['schemaVersion','sensorId','bindingEpoch','streamId','eventId','sequence','eventType','powerState','observedAt','clockQuality'];
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const ingestCapabilities={schemaVersion:1,protocolVersions:[1,2],testOnly:true,signal:true,history:true,overview:true,historyDays:7,maxDayEvents:5000,maxCoverageSeconds:180,prediction:false,hardwareEnrolled:false,maxBytes:2048,packetEvents:1,recommendedHeartbeatSeconds:60,freshnessSeconds:180,sequencePersistsAcrossBoot:true,clockRequiredForPower:true};
const canonicalTime=t=>typeof t==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(t)&&Number.isFinite(Date.parse(t))&&new Date(t).toISOString()===t;
export function ingestProof(header){if(typeof header!=='string'||!/^Bearer st_[A-Za-z0-9_-]{43}$/.test(header))throw problem(401,'sensor_ingest_unauthorized','owner');return tokenHash(header.slice(7));}
export function validateIngest(p){
 const allowed=p?.schemaVersion===2?[...fields,'coverage']:fields;
 if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).length!==allowed.length||allowed.some(k=>!Object.hasOwn(p,k))||Object.keys(p).some(k=>!allowed.includes(k))||![1,2].includes(p.schemaVersion))throw problem(400,'invalid_ingest_packet');
 const out={...p};for(const k of ['sensorId','streamId','eventId']){if(typeof p[k]!=='string'||!uuid.test(p[k]))throw problem(400,'invalid_ingest_identity');out[k]=p[k].toLowerCase();}
 if(!Number.isInteger(p.bindingEpoch)||p.bindingEpoch<1||p.bindingEpoch>999999999||!Number.isSafeInteger(p.sequence)||p.sequence<1)throw problem(400,'invalid_ingest_sequence');
 if(!['sample','heartbeat'].includes(p.eventType)||!['synchronized','unsynchronized'].includes(p.clockQuality)||(p.eventType==='sample'?!['on','off'].includes(p.powerState):p.powerState!==null))throw problem(400,'invalid_ingest_sample');
 if(p.clockQuality==='synchronized'){
  if(typeof p.observedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(p.observedAt)||!Number.isFinite(Date.parse(p.observedAt))||new Date(p.observedAt).toISOString()!==p.observedAt)throw problem(400,'invalid_ingest_time');
 }else if(p.observedAt!==null)throw problem(400,'invalid_ingest_time');
 if(p.schemaVersion===2&&p.coverage!==null){const c=p.coverage;if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).length!==2||!Object.hasOwn(c,'startAt')||!Object.hasOwn(c,'endAt')||p.eventType!=='sample'||p.clockQuality!=='synchronized'||!canonicalTime(c.startAt)||!canonicalTime(c.endAt)||c.endAt!==p.observedAt||Date.parse(c.startAt)>=Date.parse(c.endAt)||Date.parse(c.endAt)-Date.parse(c.startAt)>180000)throw problem(400,'invalid_sensor_coverage');out.coverage={startAt:c.startAt,endAt:c.endAt};}
 return out;
}
// Bounded admission per API process; durable device quota remains authoritative across slots.
export class IngestAdmission {
 constructor({now=()=>Date.now()}={}){this.now=now;this.at=now();this.tokens=32;this.active=0;}
 acquire(){const t=this.now();this.tokens=Math.min(32,this.tokens+Math.max(0,t-this.at)*16/1000);this.at=t;if(this.active>=2||this.tokens<1)throw Object.assign(problem(429,'sensor_ingest_busy','rate'),{retryAfter:1});this.active++;this.tokens--;return()=>{this.active--;};}
}
export class SensorIngest {
 constructor(bridge,admission=new IngestAdmission()){this.bridge=bridge;this.admission=admission;}
 async handle(header,input){const proof=ingestProof(header),packet=validateIngest(input),release=this.admission.acquire();
  try{const r=(await this.bridge.query('select svitlo_sensors.ingest_with_history($1::jsonb,$2) result',[JSON.stringify(packet),proof])).rows[0].result;
   if(!r||!Number.isInteger(r.http))throw problem(503,'sensor_ingest_unavailable');
   if(r.http>=400)throw Object.assign(problem(r.http,r.code,r.http===401?'owner':r.http===429?'rate':'schema'),r.http===429?{retryAfter:60}:{});
   const {http,...value}=r;return value;
  }finally{release();}
 }
}
