import {civil,dayKey,addDays} from '../../app/lib/time.js';
import {CATEGORIES} from '../../app/lib/universal-contract.js';
import {seal,dates} from '../universal/normalize.js';
import {REGIONS,regionError} from './dtek.js';
import {reconcileDay,RECONCILIATION_VERSION} from './reconcile.js';
import {GROUP_PLAN_MAX_AGE} from './group-plans.js';
export const DTEK_SNAPSHOT_VERSION='dtek-publication-v1';
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
const group=x=>typeof x==='string'&&/^GPV[1-9]\d{0,2}\.[1-9]\d?$/.test(x);
const text=x=>typeof x==='string'?x.slice(0,600).replace(/[\x00-\x1f]/g,' ').trim():'';
export function localStamp(value,format='dayFirst'){
 const match=text(value).match(format==='timeFirst'?/^(\d\d):(\d\d) (\d\d)\.(\d\d)\.(\d{4})$/:/^(\d\d)\.(\d\d)\.(\d{4}) (\d\d):(\d\d)$/);if(!match)return null;
 const [d,m,y,h,n]=format==='timeFirst'?[match[3],match[4],match[5],match[1],match[2]]:match.slice(1);
 const date=`${y}-${m}-${d}`;if(+h>23||+n>59||!Number.isFinite(Date.parse(date+'T00:00:00Z'))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)return null;try{return civil(date,+h*60+ +n);}catch{return null;}
}
export function outageKind(reason){return /стабіліз/iu.test(reason)?'hourly':/аварій|екстрен/iu.test(reason)?'emergency':/план/iu.test(reason)?'planned':'unplanned';}
export function projectStreet(raw,checkedAt=Date.now()){
 if(!object(raw?.data)||Object.keys(raw.data).length>10000||!Object.keys(raw.data).length)throw regionError('invalid_house_list');
 const houses={};for(const [number,value] of Object.entries(raw.data)){
  if(!number||number.length>120||/[\x00-\x1f]/.test(number))throw regionError('invalid_house_number');
  const records=(Array.isArray(value)?value:[value]).filter(object);if(!records.length||records.length>32)throw regionError('invalid_house_record');
  const groups=new Set(),outages=[];let invalid=false,external=false;
  for(const record of records){const reason=text(record.sub_type),kind=outageKind(reason),rawGroups=record.sub_type_reason;
   if(!Array.isArray(rawGroups)||rawGroups.length===0||rawGroups.length>32||rawGroups.some(x=>!group(x)))invalid=true;
   const valid=(Array.isArray(rawGroups)?rawGroups:[]).filter(group);for(const id of valid)groups.add(id);
   if(reason)outages.push({reason,kind,start:localStamp(record.start_date,'timeFirst'),end:localStamp(record.end_date,'timeFirst'),groups:valid});
   external=external||!!record.cek;
  }
  if(groups.size>32)throw regionError('invalid_house_groups');
  houses[number]={groups:[...groups].sort(),partial:invalid,external,outages};
 }
 const fact=object(raw.fact)?{data:raw.fact.data,update:text(raw.fact.update),today:raw.fact.today}:null;
 if(fact&&JSON.stringify(fact).length>500000)throw regionError('invalid_schedule_size');
 return {checkedAt,houses,fact,flags:Object.fromEntries(['showTableSchedule','showTableFact','showTablePlan','showCurOutageParam'].map(k=>[k,typeof raw[k]==='boolean'?raw[k]:null]))};
}
export function resolveHouse(data,number){
 // A selected canonical house uses its exact source key; no first/nearest-house inference.
 const house=data.houses[number];if(!house)throw regionError('address_requires_reselection',409);
 const complete=house.groups.length>0&&!house.partial&&!house.external;
 return {state:house.groups.length>1?'ambiguous':complete?'resolved':'unknown',complete,checkedAt:data.checkedAt,
  lines:house.external?[]:house.groups.map(key=>({key,label:'Група '+key.slice(3),groupCode:key.slice(3),provenance:{source:'dtek-address',partial:house.partial}})),
  provenance:{source:'dtek-address',partial:house.partial,externalOperator:house.external,groupsConfirmed:house.groups.length>0}};
}
export function parseHours(hours,date){
 const from=civil(date),until=civil(addDays(date,1));if(until-from!==86400000)return {state:'unknown',intervals:[],reason:'ambiguous_dst_hour_labels'};
 if(!object(hours)||Object.keys(hours).length!==24)return {state:'unknown',intervals:[],reason:'incomplete_hours'};
 const intervals=[];let certain=true;
 for(let hour=1;hour<=24;hour++){const value=hours[String(hour)],start=from+(hour-1)*3600000;
  if(!['yes','no','first','second','maybe','mfirst','msecond'].includes(value))return {state:'unknown',intervals:[],reason:'invalid_hour'};
  if(['maybe','mfirst','msecond'].includes(value))certain=false;
  if(value==='no')intervals.push({start,end:start+3600000});if(value==='first')intervals.push({start,end:start+1800000});if(value==='second')intervals.push({start:start+1800000,end:start+3600000});
 }
 const merged=[];for(const value of intervals){const last=merged.at(-1);if(last?.end===value.start)last.end=value.end;else merged.push({...value});}
 return {state:certain?'published':'unknown',intervals:merged,...(!certain?{reason:'possible_outages_not_confirmed'}:{})};
}
export function dtekSnapshot(entity,resolution,range,data,cityStatus=null,now=Date.now(),groupPlan=null){
 const config=REGIONS[entity.operator_id],house=data.houses[entity.source_ref.house];if(!config||!house)throw regionError('address_requires_reselection',409);
 const schedule=groupPlan||data,maxAgeMs=groupPlan?GROUP_PLAN_MAX_AGE:120000;
 const sourceUpdatedAt=localStamp(schedule.fact?.update),freshUntil=data.checkedAt+120000,all=dates(range.fromDate,range.toDate),factDays=new Map();
 const planUntil=groupPlan&&!groupPlan.fresh?Math.min(schedule.checkedAt,now):schedule.checkedAt+maxAgeMs;
 if(object(schedule.fact?.data))for(const [stamp,groups] of Object.entries(schedule.fact.data)){if(!/^\d{9,11}$/.test(stamp)||!object(groups))continue;const at=Number(stamp)*1000;if(!Number.isFinite(at))continue;factDays.set(dayKey(at),groups);}
 const statusFresh=!!cityStatus&&cityStatus.checkedAt+maxAgeMs>now&&cityStatus.checkedAt<=now+300000;
 const noticeDates=new Map(),decisions={},sourceUnavailable=sourceUpdatedAt===null||sourceUpdatedAt>now+300000||schedule.checkedAt>now+300000;
 const lines=resolution.lines.map(line=>{
  const categories={};for(const kind of CATEGORIES)categories[kind]={checkedAt:kind==='hourly'?schedule.checkedAt:data.checkedAt,sourceUpdatedAt,freshUntil:kind==='hourly'?planUntil:freshUntil,evidenceMode:kind==='hourly'?'daily_schedule':'positive_only',days:all.map(date=>{
   if(kind==='hourly'){
    const hours=factDays.get(date)?.[line.key],parsed=hours?parseHours(hours,date):{state:'not_published',intervals:[]};
    const publication={state:sourceUnavailable?'unknown':parsed.state,intervals:parsed.intervals,checkedAt:schedule.checkedAt,sourceUpdatedAt,freshUntil:planUntil};
    const pack=(state,intervals,applicability,reason)=>({date,state,intervals,publication,applicability:{state:applicability,reason}});
    const hidden=[data.flags,schedule.flags].some(f=>f.showTableSchedule===false||f.showTableFact===false);
    const from=civil(date),until=civil(addDays(date,1)),addressEmergency=data.flags.showCurOutageParam!==false&&house.outages.some(o=>o.kind==='emergency'&&o.groups.includes(line.key)&&o.start!==null&&(o.end===null||o.end>o.start)&&o.start<until&&(o.end===null||o.end>from));
    if(groupPlan&&planUntil<=now){
     if(addressEmergency)return pack('suspended',[],'suspended','address_emergency');
     return pack(schedule.checkedAt?'stale':'unknown',parsed.intervals,'unconfirmed','group_plan_unavailable');
    }
    if(config.city){const status=cityStatus?.groups?.[line.key]?.[date],publishedAt=cityStatus?.groupUpdatedAt&&Object.hasOwn(cityStatus.groupUpdatedAt,line.key)?cityStatus.groupUpdatedAt[line.key]:cityStatus?.updatedAt??null;
     const detail=cityStatus?.daySchedules?.[line.key]?.[date];
     const result=reconcileDay({date,primary:{...parsed,publishedAt:sourceUpdatedAt,checkedAt:schedule.checkedAt},secondary:cityStatus?{...detail,date:status===undefined?null:date,status,checkedAt:cityStatus.checkedAt,publishedAt}:null,addressEmergency,hidden,now,maxAgeMs});
     decisions[line.key+':'+date]={state:result.state,...result.evidence};if(result.state==='suspended'&&result.evidence.scope==='reported_group_day'){if(!noticeDates.has(date))noticeDates.set(date,{lineIds:[],publishedAt});const notice=noticeDates.get(date);notice.lineIds.push(line.id);notice.publishedAt=Math.max(notice.publishedAt,publishedAt);}
     return pack(result.state,result.intervals,result.evidence.applicability||(result.state==='published'?'reported':result.state==='suspended'?'suspended':'unconfirmed'),result.reason);
    }
    if(freshUntil<=now)return pack('stale',parsed.intervals,'unconfirmed','primary_fetch_expired');
    if(hidden||addressEmergency)return pack('suspended',[],'suspended',addressEmergency?'address_emergency':'primary_hides_daily_schedule');
    if(sourceUnavailable)return pack('unknown',[],'unconfirmed','invalid_primary_clock');
    return pack(parsed.state,parsed.intervals,parsed.state==='published'?'reported':'unconfirmed',parsed.state==='published'?'primary_daily_schedule':parsed.reason||'no_primary_schedule_for_date');
   }
   const from=civil(date),to=civil(addDays(date,1)),events=(data.flags.showCurOutageParam===false?[]:house.outages).filter(o=>o.kind===kind&&o.groups.includes(line.key)&&o.start!==null&&(o.end===null||o.end>o.start)&&o.start<to&&(o.end===null||o.end>from)).map(o=>({start:o.start,end:o.end}));
   // Current-address events are positive evidence only; an empty current reply is not a full-day zero.
   return {date,state:events.length?'published':'unknown',intervals:events};
  })};
  return {id:line.id,label:line.label,groupCode:line.groupCode,supportedCategories:CATEGORIES,categories};
 });
 const conflictToday=Object.entries(decisions).some(([key,d])=>key.endsWith(':'+dayKey(now))&&['unknown','stale'].includes(d.state));
 const supportState=Math.min(freshUntil,planUntil)<=now||sourceUnavailable||house.external||!resolution.complete||config.city&&(!statusFresh||conflictToday)?'degraded':'available';
 return seal({schemaVersion:1,addressId:entity.id,operatorId:entity.operator_id,timeZone:'Europe/Kyiv',coverage:range,resolution:{state:resolution.state,complete:resolution.complete},lines,
  notices:[...noticeDates].map(([date,notice])=>({kind:'regional_emergency',scope:'reported_group_day',lineIds:notice.lineIds,active:date===dayKey(now),start:civil(date),end:civil(addDays(date,1)),sourceUpdatedAt:notice.publishedAt,checkedAt:cityStatus.checkedAt,url:'https://static.yasno.ua/kyiv/outages/',reason:'official_sources_emergency_override'})),
  checkedAt:data.checkedAt,sourceUpdatedAt,freshUntil:Math.min(freshUntil,planUntil,cityStatus?cityStatus.checkedAt+maxAgeMs:planUntil),refreshAfter:now+60000,supportState,
  provenance:[{operatorId:entity.operator_id,adapter:'dtek-public-v1',url:`https://${config.host}/ua/shutdowns`,allocation:resolution.provenance,categoryCoverage:'daily_hourly_and_positive_current_address_events',cityEmergencyStatus:cityStatus?'yasno-official':null,...(config.city?{reconciliation:{version:RECONCILIATION_VERSION,days:decisions}}:{})}],synthetic:false});
}
