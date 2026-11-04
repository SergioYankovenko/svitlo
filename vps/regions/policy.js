import {civil,dayKey,addDays} from '../../app/lib/time.js';
import {CATEGORIES} from '../../app/lib/universal-contract.js';
import {seal,dates} from '../universal/normalize.js';
import {REGIONS,regionError} from './dtek.js';
import {reconcileDay,RECONCILIATION_VERSION} from './reconcile.js';
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
  const groups=new Set(),outages=[];let partial=false,invalid=false,external=false;
  for(const record of records){const reason=text(record.sub_type),kind=outageKind(reason),rawGroups=record.sub_type_reason;
   if(!Array.isArray(rawGroups)||rawGroups.length===0||rawGroups.length>32||rawGroups.some(x=>!group(x)))invalid=true;
   const valid=(Array.isArray(rawGroups)?rawGroups:[]).filter(group);for(const id of valid)groups.add(id);
   if(reason){outages.push({reason,kind,start:localStamp(record.start_date,'timeFirst'),end:localStamp(record.end_date,'timeFirst'),groups:valid});if(kind==='hourly')partial=true;}
   external=external||!!record.cek;
  }
  if(groups.size>32)throw regionError('invalid_house_groups');
  houses[number]={groups:[...groups].sort(),partial:partial||invalid,external,outages};
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
export function dtekSnapshot(entity,resolution,range,data,cityStatus=null,now=Date.now()){
 const config=REGIONS[entity.operator_id],house=data.houses[entity.source_ref.house];if(!config||!house)throw regionError('address_requires_reselection',409);
 const sourceUpdatedAt=localStamp(data.fact?.update),freshUntil=data.checkedAt+120000,all=dates(range.fromDate,range.toDate),factDays=new Map();
 if(object(data.fact?.data))for(const [stamp,groups] of Object.entries(data.fact.data)){if(!/^\d{9,11}$/.test(stamp)||!object(groups))continue;const at=Number(stamp)*1000;if(!Number.isFinite(at))continue;factDays.set(dayKey(at),groups);}
 const statusFresh=!!cityStatus&&cityStatus.checkedAt+120000>now&&cityStatus.checkedAt<=now+300000;
 const noticeDates=new Set(),decisions={},sourceUnavailable=sourceUpdatedAt===null||sourceUpdatedAt>now+300000||data.checkedAt>now+300000;
 const lines=resolution.lines.map(line=>{
  const categories={};for(const kind of CATEGORIES)categories[kind]={checkedAt:data.checkedAt,sourceUpdatedAt,freshUntil,days:all.map(date=>{
   if(kind==='hourly'){
    const hours=factDays.get(date)?.[line.key],parsed=hours?parseHours(hours,date):{state:'not_published',intervals:[]};
    const hidden=data.flags.showTableSchedule===false||data.flags.showTableFact===false;
    const from=civil(date),until=civil(addDays(date,1)),addressEmergency=data.flags.showCurOutageParam!==false&&house.outages.some(o=>o.kind==='emergency'&&o.groups.includes(line.key)&&o.start!==null&&o.start<until&&(o.end===null||o.end>from));
    if(config.city){const status=cityStatus?.groups?.[line.key]?.[date],publishedAt=cityStatus?.groupUpdatedAt?.[line.key]??cityStatus?.updatedAt??null;
     const result=reconcileDay({date,primary:{...parsed,publishedAt:sourceUpdatedAt,checkedAt:data.checkedAt},secondary:cityStatus?{date:status===undefined?null:date,status,checkedAt:cityStatus.checkedAt,publishedAt}:null,addressEmergency,hidden,now});
     decisions[line.key+':'+date]={state:result.state,...result.evidence};if(result.state==='suspended'&&result.reason==='emergency_report_newer_than_plan')noticeDates.add(date);
     return {date,state:result.state,intervals:result.intervals};
    }
    if(hidden||addressEmergency)return {date,state:'suspended',intervals:[]};
    if(sourceUnavailable)return {date,state:'unknown',intervals:[]};
    return {date,state:freshUntil<=now?'stale':parsed.state,intervals:parsed.intervals};
   }
   const from=civil(date),to=civil(addDays(date,1)),events=(data.flags.showCurOutageParam===false?[]:house.outages).filter(o=>o.kind===kind&&o.groups.includes(line.key)&&o.start!==null&&(o.end===null||o.end>o.start)&&o.start<to&&(o.end===null||o.end>from)).map(o=>({start:o.start,end:o.end}));
   // Current-address events are positive evidence only; an empty current reply is not a full-day zero.
   return {date,state:events.length?'published':'unknown',intervals:events};
  })};
  return {id:line.id,label:line.label,groupCode:line.groupCode,supportedCategories:CATEGORIES,categories};
 });
 const supportState=freshUntil<=now||sourceUnavailable||house.external||config.city&&!statusFresh?'degraded':'available';
 return seal({schemaVersion:1,addressId:entity.id,operatorId:entity.operator_id,timeZone:'Europe/Kyiv',coverage:range,resolution:{state:resolution.state,complete:resolution.complete},lines,
  notices:[...noticeDates].map(date=>({kind:'regional_emergency',active:date===dayKey(now),start:civil(date),end:civil(addDays(date,1)),sourceUpdatedAt:cityStatus.updatedAt,checkedAt:cityStatus.checkedAt,url:'https://static.yasno.ua/kyiv/outages/',reason:'official_sources_emergency_override'})),
  checkedAt:data.checkedAt,sourceUpdatedAt,freshUntil:Math.min(freshUntil,cityStatus?cityStatus.checkedAt+120000:freshUntil),refreshAfter:now+60000,supportState,
  provenance:[{operatorId:entity.operator_id,adapter:'dtek-public-v1',url:`https://${config.host}/ua/shutdowns`,allocation:resolution.provenance,categoryCoverage:'daily_hourly_and_positive_current_address_events',cityEmergencyStatus:cityStatus?'yasno-official':null,...(config.city?{reconciliation:{version:RECONCILIATION_VERSION,days:decisions}}:{})}],synthetic:false});
}
