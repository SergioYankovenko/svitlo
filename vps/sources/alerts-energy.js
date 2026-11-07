import {createHash} from 'node:crypto';import {readFileSync,existsSync} from 'node:fs';import {SharedCategories} from '../../server/shared-categories.js';import {civil,addDays} from '../../app/lib/time.js';import {seal,dates} from '../universal/normalize.js';
const failure=(code,status=503)=>Object.assign(Error('Додаткове джерело тимчасово недоступне'),{code,status});
const lineKey=(initiator,group)=>'alerts:'+createHash('sha256').update(JSON.stringify([initiator,group])).digest('hex').slice(0,48);
const clock=value=>typeof value==='string'&&/(?:Z|[+-]\d\d:\d\d)$/.test(value)&&Number.isFinite(Date.parse(value))?Date.parse(value):null;
export function hourIntervals(date,values){
 if(!Array.isArray(values)||values.length!==24||values.some(x=>![0,1,2,3].includes(x)))throw failure('invalid_alerts_hours');
 const start=civil(date,0),end=civil(addDays(date,1),0);if(end-start!==86400000)throw failure('ambiguous_civil_day');const intervals=[];
 for(const [h,v]of values.entries())if(v){const lo=h*60+(v===3?30:0),hi=h*60+(v===2?30:60),item={start:civil(date,lo),end:civil(date,hi)},last=intervals.at(-1);if(last?.end===item.start)last.end=item.end;else intervals.push(item);}
 return intervals;
}
export function normalizeAlerts(rows,mapping,resolution,entity,range,checkedAt,statuses=[]){
 if(!Array.isArray(rows)||rows.length>10000)throw failure('invalid_alerts_response');const supported=['hourly'];
 const lines=resolution.lines.map(line=>{
  const match=rows.filter(r=>r.initiator===mapping.initiator&&r.queue===line.groupCode);if(match.length>1)throw failure('conflicting_alerts_groups');const row=match[0],updated=clock(row?.updated),until=updated===null?0:Math.max(0,Math.min(checkedAt+600000,updated+3600000));
  const unreliable=statuses.some(s=>s.supplier_slug===mapping.initiator&&s.schedule_unreliable===true&&(clock(s.expires_at)||0)>checkedAt);
  const days=dates(range.fromDate,range.toDate).map(date=>{const side=['today','tomorrow'].find(k=>row?.[k+'_date']===date);if(!side)return {date,state:'not_published',intervals:[]};
   const state=row[side+'_status'];if(state==='EmergencyShutdowns'||unreliable)return {date,state:'suspended',intervals:[]};if(!['ScheduleApplies','NoShutdowns'].includes(state))return {date,state:'not_published',intervals:[]};
   try{const intervals=hourIntervals(date,row[side]),possible=row[side+'_possible'];if(state==='NoShutdowns'&&intervals.length)throw failure('conflicting_alerts_status');return {date,state:until>checkedAt?'published':'stale',intervals,possibleIntervals:possible===undefined?[]:hourIntervals(date,possible)};}catch(e){return {date,state:'unknown',intervals:[],reason:e.code};}
  });
  return {id:line.id,label:line.label,groupCode:line.groupCode,supportedCategories:supported,categories:{hourly:{checkedAt,sourceUpdatedAt:updated,freshUntil:until,days}}};
 });
 const categories=lines.map(l=>l.categories.hourly),valid=categories.filter(c=>c.freshUntil>checkedAt),clocks=categories.map(c=>c.sourceUpdatedAt).filter(x=>x!==null);
 return seal({schemaVersion:1,addressId:entity.id,operatorId:entity.operator_id,timeZone:'Europe/Kyiv',coverage:range,resolution:{state:resolution.state,complete:resolution.complete},lines,notices:[],checkedAt,sourceUpdatedAt:clocks.length?Math.min(...clocks):null,freshUntil:categories.length?Math.min(...categories.map(c=>c.freshUntil)):0,refreshAfter:checkedAt+600000,supportState:resolution.complete&&valid.length===categories.length&&lines.length?'available':'degraded',provenance:[{source:'alerts-energy-documented-api',adapter:'alerts-energy-v1',area:mapping.area_slug,initiator:mapping.initiator,mappingProof:mapping.source_reference,auxiliary:true}],synthetic:false});
}
export class AlertsEnergy {
 constructor({bridge,db,secret,key=null,enabled=false,fetcher=fetch,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){Object.assign(this,{bridge,key,enabled,fetcher,now,sleep});this.cache=new SharedCategories(db,secret,{ttl:600000,now});}
 get configured(){return this.enabled===true&&typeof this.key==='string'&&/^[A-Za-z0-9._-]{16,500}$/.test(this.key);}
 async request(area,kind){
  if(!this.configured)throw failure('alerts_not_configured');if(!/^[a-z0-9-]{1,80}$/.test(area)||!['shutdowns','statuses'].includes(kind))throw failure('invalid_alerts_scope',400);
  const deadline=this.now()+5000;while(true){const q=(await this.bridge.query('select svitlo_sources.external_acquire() value')).rows[0].value;if(q.granted)break;if(q.code!=='busy'||this.now()>=deadline)throw failure(q.code,q.code==='daily_quota_exceeded'||q.code==='rate_limited'?429:503);await this.sleep(Math.min(250,Math.max(1,q.waitMs||200)));}
  let response;try{response=await this.fetcher('https://alerts.energy/api/v1/source-registry/areas/'+area+'/'+kind,{headers:{Authorization:'Bearer '+this.key,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(10000)});}catch{throw failure('alerts_unreachable');}
  if(!response.ok){await response.body?.cancel();const retry=response.headers.get('retry-after');let seconds=/^\d+$/.test(retry||'')?Number(retry):Math.ceil((Date.parse(retry)-this.now())/1000);if(!Number.isFinite(seconds)||seconds<1)seconds=response.status===429?60:response.status===401||response.status===403?1800:30;await this.bridge.query('select svitlo_sources.external_cooldown($1)',[Math.max(1,Math.min(86400,seconds))]);throw failure(response.status===403?'forbidden':response.status===401?'alerts_not_configured':response.status===429?'rate_limited':'alerts_unavailable',response.status===429?429:503);}
  let bytes=0;const chunks=[];for await(const c of response.body){bytes+=c.length;if(bytes>4000000)throw failure('alerts_response_too_large');chunks.push(c);}let value;try{value=JSON.parse(Buffer.concat(chunks));}catch{throw failure('invalid_alerts_response');}if(!Array.isArray(value)||value.length>10000)throw failure('invalid_alerts_response');return value;
 }
 async mapping(entity){if(!this.configured)throw failure('alerts_not_configured');const m=(await this.bridge.query('select svitlo_sources.external_mapping($1) value',[entity.id])).rows[0].value;
  if(!m||m.operator_id!==entity.operator_id||!Array.isArray(m.groups)||m.groups.length>32||m.groups.some(g=>typeof g!=='string'||!g||g.length>80)||new Set(m.groups).size!==m.groups.length)throw failure('alerts_mapping_requires_review');return m;
 }
 async area(slug){return this.cache.load(['alerts-energy-area-v1',slug],async()=>{const rows=await this.request(slug,'shutdowns'),statuses=await this.request(slug,'statuses');return {rows,statuses,checkedAt:this.now()};});}
}
export class AlertsEnergyAdapter {
 constructor(service){this.service=service;}
 async resolve(entity){const m=await this.service.mapping(entity);return {state:m.complete?(m.groups.length>1?'ambiguous':'resolved'):'unknown',complete:m.complete,checkedAt:Date.parse(m.valid_from),lines:m.groups.map(group=>({key:lineKey(m.initiator,group),label:'Лінія '+group,groupCode:group,provenance:{source:'alerts-energy-mapping',reviewed:true}})),provenance:{source:'reviewed_auxiliary_mapping',sourceReference:m.source_reference,auxiliary:true}};}
 async snapshot(entity,resolution,range){const m=await this.service.mapping(entity),data=await this.service.area(m.area_slug);return {value:normalizeAlerts(data.rows,m,resolution,entity,range,data.checkedAt,data.statuses)};}
}
export function configuredAlerts(options){const file='/run/sources/alerts-energy-key';return new AlertsEnergy({...options,enabled:process.env.SVITLO_ALERTS_ENERGY_ENABLED==='true',key:existsSync(file)?readFileSync(file,'utf8').trim():null});}
