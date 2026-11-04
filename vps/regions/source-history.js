import {DtekClient,boundedBody,regionError} from './dtek.js';
import {projectStreet,localStamp,parseHours,DTEK_SNAPSHOT_VERSION} from './policy.js';
import {projectYasno} from './yasno.js';
import {reconcileDay,RECONCILIATION_VERSION} from './reconcile.js';
import {dayKey,addDays} from '../../app/lib/time.js';

export const HISTORY_VERSION='paired-history-v1';
export const YASNO_URL='https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/25/dsos/902/planned-outages';
export const HISTORY_TARGETS=Object.freeze([
 {source:'dtek-kyiv',operator:'ua-kyiv-dtek',city:'м. Київ',street:'вул. Хрещатик',house:'36'},
 {source:'dtek-kyiv-region',operator:'ua-kyiv-region-dtek',city:'м. Бровари',street:'вул. Київська',house:'1'},
 {source:'yasno-kyiv',url:YASNO_URL}
]);
const groupKey=x=>/^GPV[1-9]\d{0,2}\.[1-9]\d?$/.test(x);
const noClock=value=>{const {checkedAt,...data}=value;return data;};
const code=e=>/^[a-zA-Z0-9_]{1,80}$/.test(e.code||'')?e.code:e.name==='TimeoutError'?'timeout':'source_unavailable';

// Fixed public reference requests; never a user's profile, owner, account or cookies.
export function historyPayload(target,raw,checkedAt){
 if(target.source==='yasno-kyiv'){
  const parsed=projectYasno(raw,checkedAt),protocol={};
  for(const [key,value] of Object.entries(raw))if(groupKey('GPV'+key)&&value&&typeof value==='object'){
   protocol[key]={updatedOn:typeof value.updatedOn==='string'?value.updatedOn.slice(0,80):null};
   for(const name of ['today','tomorrow']){const d=value[name];if(d&&typeof d==='object')protocol[key][name]={date:typeof d.date==='string'?d.date.slice(0,80):null,status:typeof d.status==='string'?d.status.slice(0,80):null,
    slots:Array.isArray(d.slots)?d.slots.slice(0,193).map(s=>({start:typeof s?.start==='number'?s.start:null,end:typeof s?.end==='number'?s.end:null,type:typeof s?.type==='string'?s.type.slice(0,80):null})):null};}
  }
  return {version:HISTORY_VERSION,source:target.source,protocol,parsed:noClock(parsed)};
 }
 const parsed=projectStreet(raw,checkedAt),house=parsed.houses[target.house];
 // Retain original dated hour labels for replay, plus the projected public reference
 // house. Unrelated street houses and arbitrary top-level response fields are omitted.
 const fact=parsed.fact;
 return {version:HISTORY_VERSION,source:target.source,projectionVersion:DTEK_SNAPSHOT_VERSION,reference:{city:target.city,street:target.street,house:target.house},
  parsed:{fact,flags:parsed.flags,house:house||null}};
}

export function compareHistory(observations,now=Date.now()){
 const first=observations.find(x=>x.source==='dtek-kyiv'),second=observations.find(x=>x.source==='yasno-kyiv');
 if(first?.state!=='ok'||second?.state!=='ok')return [];
 const primary=first.payload.parsed,secondary=second.payload.parsed,groups=new Set(Object.keys(secondary.groups));
 const byDate=new Map();for(const [stamp,values] of Object.entries(primary.fact?.data||{}))if(/^\d{9,11}$/.test(stamp)&&values&&typeof values==='object'){
  byDate.set(dayKey(Number(stamp)*1000),values);for(const key of Object.keys(values))if(groupKey(key))groups.add(key);
 }
 const today=dayKey(now),dates=[today,addDays(today,1)],pairSkewMs=Math.abs(first.checkedAt-second.checkedAt),result=[];
 for(const group of [...groups].sort())for(const date of dates){
  const hours=byDate.get(date)?.[group],p=hours?parseHours(hours,date):{state:'not_published',intervals:[]};
  const s=secondary.daySchedules[group]?.[date],publishedAt=secondary.groupUpdatedAt[group]??null;
  const decision=reconcileDay({date,primary:{...p,publishedAt:localStamp(primary.fact?.update),checkedAt:first.checkedAt},
   secondary:{...s,date:s?.date??null,status:secondary.groups[group]?.[date],publishedAt,checkedAt:second.checkedAt},
   hidden:primary.flags.showTableFact===false||primary.flags.showTableSchedule===false,now});
  let classification=decision.evidence.intervalComparison==='equal'?'agreement':decision.evidence.applicability==='conflict'?'conflict':decision.state==='suspended'&&decision.evidence.scope==='reported_group_day'?'emergency_override':'unconfirmed';
  if(pairSkewMs>30000)classification='unconfirmed';
  result.push({group,date,classification,pairSkewMs,referenceScope:'fixed_public_request_group_schedule',
   policy:RECONCILIATION_VERSION,...decision,...(pairSkewMs>30000?{state:'unknown',reason:'pair_capture_skew',evidence:{...decision.evidence,reason:'pair_capture_skew',applicability:'unconfirmed'}}:{})});
 }
 return result;
}

export function historyTransitions(rows){
 let previous=null,previousSlot=null,gaps=0;const transitions=[],samplingGaps=[];
 for(const row of rows){const classification=row.comparison?.classification;
  if(previousSlot!==null&&row.slot>previousSlot+300000){const missing=(row.slot-previousSlot)/300000-1;gaps+=missing;samplingGaps.push({afterSlot:previousSlot,beforeSlot:row.slot,missingWindows:missing});}previousSlot=row.slot;
  if(!['agreement','conflict','emergency_override'].includes(classification)){gaps++;continue;}
  if(previous&&previous.classification!==classification)transitions.push({from:previous.classification,to:classification,
   afterObservedAt:previous.checkedAt,beforeObservedAt:row.finishedAt,gapObservations:gaps,exactChangeTime:null});
  previous={classification,checkedAt:row.finishedAt};gaps=0;
 }
 return {transitions,samplingGaps,lastComparable:previous,trailingUnconfirmedObservations:gaps};
}

export class SourceHistory {
 constructor({bridge,regions,enabled=false,now=Date.now,fetcher=fetch,compare=compareHistory}){
  Object.assign(this,{bridge,regions,enabled,now,fetcher,compare});this.clients=new Map();
 }
 async capture(target){
  const startedAt=this.now(),trace=[];let raw,requestCount=0;
  const tracked=async(...args)=>{requestCount++;const response=await this.fetcher(...args);trace.push(response.status);return response;};
  try{
   if(target.operator){
    if(!this.clients.has(target.source))this.clients.set(target.source,new DtekClient(target.operator,{now:this.now,gate:op=>this.regions.gate(op),finish:(...args)=>this.regions.finish(...args),
     fetcher:(...args)=>this.currentFetchers.get(target.source)(...args)}));
    this.currentFetchers??=new Map();this.currentFetchers.set(target.source,tracked);
    raw=await this.clients.get(target.source).houses(target.city,target.street);
   }else{
    const ticket=await this.regions.gate('yasno-kyiv');let status=0,error=null,retry=0;
    try{const r=await tracked(target.url,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(8000),headers:{accept:'application/json','user-agent':'Svitlo-private-staging/1.0'}});status=r.status;
     retry=Math.min(900000,Math.max(0,Number(r.headers.get('retry-after'))*1000||0));if(!r.ok){await r.body?.cancel();throw regionError(status===403?'forbidden':status===429?'rate_limited':'source_http_'+status);}
     raw=JSON.parse(await boundedBody(r,500000));
    }catch(e){error=code(e);throw e;}finally{await this.regions.finish('yasno-kyiv',ticket,{status,error,retry}).catch(()=>{});}
   }
   const checkedAt=this.now(),payload=historyPayload(target,raw,checkedAt);
   if(Buffer.byteLength(JSON.stringify(payload))>650000)throw regionError('history_payload_too_large');
   return {source:target.source,startedAt,checkedAt,state:'ok',httpStatus:trace.at(-1)??null,requestCount,errorCode:null,payload};
  }catch(e){return {source:target.source,startedAt,checkedAt:this.now(),state:'error',httpStatus:trace.at(-1)??null,requestCount,errorCode:e instanceof SyntaxError?'invalid_source_json':code(e)};}
 }
 async runDue(){
  if(!this.enabled)return {state:'disabled'};
  const claim=(await this.bridge.query('select svitlo_source_history.claim() value')).rows[0].value;
  if(!claim.granted)return {state:'not_due'};
  // Every leg persists independently. Upstream quotas/403 cooldowns are shared
  // with the main reader, and one refused source never suppresses the other leg.
  const observations=await Promise.all(HISTORY_TARGETS.map(target=>this.capture(target)));
  let comparisons=[],comparisonError=null;
  try{comparisons=this.compare(observations,this.now());}catch(e){comparisonError='comparison_error';}
  const result=(await this.bridge.query('select svitlo_source_history.finish($1,$2,$3::jsonb,$4::jsonb,$5) value',
   [claim.slot,claim.token,JSON.stringify(observations),JSON.stringify(comparisons),comparisonError])).rows[0].value;
  await this.bridge.query('select svitlo_source_history.cleanup()');
  return {...result,slot:claim.slot,sourceStates:Object.fromEntries(observations.map(x=>[x.source,x.state])),profileWrites:0};
 }
 async report({fromDate,toDate=fromDate,group='23.1',scheduleDate=fromDate}){
  const rows=(await this.bridge.query('select svitlo_source_history.timeline($1::date,$2::date,$3,$4::date) value',[fromDate,toDate,'GPV'+group,scheduleDate])).rows[0].value;
  return {version:HISTORY_VERSION,timeZone:'Europe/Kyiv',fromDate,toDate,group,scheduleDate,pollIntervalMs:300000,retentionDays:90,
   rows,...historyTransitions(rows),latestCycleAgeMs:rows.length?Math.max(0,this.now()-rows.at(-1).slot):null,actualPower:'unknown',limitations:['Fixed public reference requests, not all addresses.','No official YASNO Kyiv-oblast feed in the verified source directory; oblast DTEK is a separate control.','Transitions are bounded by observations, not exact outage onset/restoration.']};
 }
}
