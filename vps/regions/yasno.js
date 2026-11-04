import {civil,addDays} from '../../app/lib/time.js';
import {regionError} from './dtek.js';
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
export function parseYasnoDay(day){
 if(!object(day)||typeof day.date!=='string'||!/^\d{4}-\d\d-\d\dT00:00:00(?:\.0+)?(?:Z|[+-]\d\d:\d\d)$/.test(day.date))return null;
 const date=day.date.slice(0,10);let from,to;try{from=civil(date);to=civil(addDays(date,1));}catch{return null;}
 if(Date.parse(day.date)!==from||typeof day.status!=='string'||day.status.length>80)return null;
 const unknown=reason=>({date,status:day.status,state:'unknown',intervals:[],reason});
 if(to-from!==86400000)return unknown('ambiguous_dst_minute_labels');
 if(!Array.isArray(day.slots)||day.slots.length>192)return unknown('invalid_secondary_slots');
 if(day.status==='NoOutages'&&day.slots.length===0)return {date,status:day.status,state:'published',intervals:[]};
 const slots=[...day.slots];if(slots.some(s=>!object(s)||!Number.isInteger(s.start)||!Number.isInteger(s.end)||s.start<0||s.start>=s.end||s.end>1440||!['Definite','NotPlanned'].includes(s.type)))return unknown('invalid_secondary_slots');
 slots.sort((a,b)=>a.start-b.start||a.end-b.end);let cursor=0;const intervals=[];
 for(const s of slots){if(s.start!==cursor)return unknown('incomplete_or_overlapping_secondary_day');cursor=s.end;if(s.type==='Definite'){const value={start:from+s.start*60000,end:from+s.end*60000},last=intervals.at(-1);if(last?.end===value.start)last.end=value.end;else intervals.push(value);}}
 if(cursor!==1440)return unknown('incomplete_or_overlapping_secondary_day');
 if(day.status==='NoOutages'&&intervals.length)return unknown('secondary_status_conflicts_with_slots');
 return {date,status:day.status,state:'published',intervals};
}
export function projectYasno(raw,checkedAt){
 if(!object(raw)||Object.keys(raw).length>300)throw regionError('invalid_status_schema');
 const groups={},daySchedules={},groupUpdatedAt={};let updatedAt=null;
 for(const [key,value] of Object.entries(raw)){
  if(!/^[1-9]\d{0,2}\.[1-9]\d?$/.test(key)||!object(value))continue;
  const days={},plans={};for(const slot of ['today','tomorrow']){const d=parseYasnoDay(value[slot]);if(!d)continue;
   if(plans[d.date]&&JSON.stringify(plans[d.date])!==JSON.stringify(d)){plans[d.date]={...d,state:'unknown',status:'InvalidSourceDay',intervals:[],reason:'duplicate_secondary_date'};days[d.date]='InvalidSourceDay';}
   else{plans[d.date]=d;days[d.date]=d.status;}
  }
  const group='GPV'+key;groups[group]=days;daySchedules[group]=plans;
  const stamp=Date.parse(value.updatedOn);groupUpdatedAt[group]=Number.isFinite(stamp)?stamp:null;if(Number.isFinite(stamp))updatedAt=updatedAt===null?stamp:Math.min(stamp,updatedAt);
 }
 if(!Object.keys(groups).length)throw regionError('invalid_status_schema');
 return {checkedAt,updatedAt,groupUpdatedAt,groups,daySchedules};
}
