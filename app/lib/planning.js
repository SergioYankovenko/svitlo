import {civil,addDays,dayKey} from './time.js';import {validUniversal,selectedLine} from './universal-contract.js';
export const PLANNING_VERSION=1;
export function unionIntervals(values,{from=-Infinity,to=Infinity}={}){
 if(!Array.isArray(values)||values.length>10000)throw Error('invalid_planning_intervals');const sorted=[];
 for(const e of values){if(!Number.isFinite(e?.start)||!Number.isFinite(e?.end)||e.end<=e.start)throw Error('open_or_invalid_planning_interval');const start=Math.max(from,e.start),end=Math.min(to,e.end);if(end>start)sorted.push({start,end});}
 sorted.sort((a,b)=>a.start-b.start||a.end-b.end);const merged=[];for(const e of sorted){const last=merged.at(-1);if(last&&last.end>=e.start)last.end=Math.max(last.end,e.end);else merged.push({...e});}return merged;
}
const unknown=reason=>({version:PLANNING_VERSION,state:'unknown',reason,confidence:'unknown',guaranteed:false,windows:[],outages:{confirmed:[],possible:[],applied:[]}});
export function planWindows(snapshot,lineId,date,{now=Date.now(),policy,minimumMinutes=0}={}){
 if(!['confirmed','conservative'].includes(policy))throw Error('explicit_planning_policy_required');
 if(!Number.isFinite(now)||!Number.isInteger(minimumMinutes)||minimumMinutes<0||minimumMinutes>1440)throw Error('invalid_planning_options');
 if(!validUniversal(snapshot))return unknown('invalid_snapshot');const line=selectedLine(snapshot,lineId);if(!line||!snapshot.resolution.complete)return unknown('incomplete_resolution');
 if(snapshot.supportState!=='available'||snapshot.freshUntil<=now||snapshot.checkedAt>now+300000)return unknown('stale_or_degraded');
 if(date<snapshot.coverage.fromDate||date>snapshot.coverage.toDate)return unknown('outside_coverage');let from,to;try{from=civil(date);to=civil(addDays(date,1));}catch{return unknown('invalid_civil_day');}
 const relevant=(snapshot.notices||[]).some(n=>n.active===true&&(!n.lineIds?.length||n.lineIds.includes(line.id))&&(n.start??0)<to&&(n.end===null||n.end===undefined||n.end>from));if(relevant)return unknown('emergency_or_unreliable');
 const hourly=line.categories.hourly,day=hourly?.days?.find(d=>d.date===date);
 if(!hourly||!day||!['published','excluded'].includes(day.state)||hourly.freshUntil<=now||hourly.checkedAt>now+300000||hourly.sourceUpdatedAt===null||hourly.sourceUpdatedAt>now+300000)return unknown('incomplete_hourly_plan');
 const mandatory=[...day.intervals],possible=[...(day.possibleIntervals||[])];
 for(const kind of ['planned','unplanned','emergency']){
  if(!line.supportedCategories.includes(kind))continue;const c=line.categories[kind],d=c?.days?.find(d=>d.date===date),events=(d?.intervals||[]).filter(e=>e.start<to&&(e.end===null||e.end>from));
  if(kind==='emergency'&&events.length)return unknown('emergency_or_unreliable');
  if(c?.evidenceMode!=='positive_only'&&(!d||!['published','excluded'].includes(d.state)||c.freshUntil<=now))return unknown('incomplete_outage_category');
  if(events.length&&(c.freshUntil<=now||events.some(e=>e.end===null)))return unknown('open_or_stale_outage');mandatory.push(...events);
 }
 let confirmed,possibleOnly,applied;try{confirmed=unionIntervals(mandatory,{from,to});possibleOnly=unionIntervals(possible,{from,to});applied=policy==='conservative'?unionIntervals([...confirmed,...possibleOnly],{from,to}):confirmed;}catch{return unknown('open_or_invalid_interval');}
 const windows=[];let cursor=Math.max(from,now);for(const e of applied){if(e.end<=cursor)continue;if(e.start>cursor)windows.push({start:cursor,end:e.start});cursor=Math.max(cursor,e.end);}if(cursor<to)windows.push({start:cursor,end:to});
 return {version:PLANNING_VERSION,state:to<=now?'past':'ready',reason:'published_plan',confidence:policy==='confirmed'&&possibleOnly.length?'possible_outages_excluded':'plan_only',guaranteed:false,policy,from,to,sourceRevision:snapshot.revision,validUntil:Math.min(snapshot.freshUntil,hourly.freshUntil),windows:windows.filter(w=>w.end-w.start>=minimumMinutes*60000),outages:{confirmed,possible:possibleOnly,applied}};
}
export function nextPlanEvent(snapshot,lineId,{now=Date.now(),policy}={}){
 if(!['confirmed','conservative'].includes(policy))throw Error('explicit_planning_policy_required');let horizon=0;const outages=[];let stopReason='following_plan_unknown';
 for(let date=dayKey(now),n=0;n<14;n++,date=addDays(date,1)){
  const day=planWindows(snapshot,lineId,date,{now,policy});if(day.state!=='ready'){stopReason=day.reason;break;}horizon=day.to;outages.push(...day.outages.applied);
 }
 if(!horizon)return {version:PLANNING_VERSION,event:null,reason:stopReason};
 const merged=unionIntervals(outages),current=merged.find(e=>e.start<=now&&e.end>now),future=merged.find(e=>e.start>now);
 if(current){if(current.end>=horizon)return {version:PLANNING_VERSION,event:null,reason:'following_plan_unknown',horizon};return {version:PLANNING_VERSION,event:{kind:'restoration',at:current.end},horizon,guaranteed:false};}
 return {version:PLANNING_VERSION,event:future&&future.start<horizon?{kind:'outage',at:future.start}:null,reason:future?'published_plan':'not_scheduled_in_known_horizon',horizon,guaranteed:false};
}
export function isQuiet(now,{startMinute,endMinute}={}){
 if(startMinute===null||startMinute===undefined||endMinute===null||endMinute===undefined||startMinute===endMinute)return false;
 if(!Number.isInteger(startMinute)||!Number.isInteger(endMinute)||startMinute<0||startMinute>1439||endMinute<0||endMinute>1439)throw Error('invalid_quiet_hours');
 const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Kyiv',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now),minute=Number(parts.find(p=>p.type==='hour').value)*60+Number(parts.find(p=>p.type==='minute').value);
 return startMinute<endMinute?minute>=startMinute&&minute<endMinute:minute>=startMinute||minute<endMinute;
}
// Stable domain content, excluding fetch clocks, cache TTL, source prose and
// historical display layers. Server hashing uses this same pure projection.
export function semanticPlan(snapshot,lineId){
 const line=snapshot?.lines?.find(l=>l.id===lineId),clean=values=>[...new Map((values||[]).map(e=>[JSON.stringify([e.start,e.end]),{start:e.start,end:e.end}])).values()].sort((a,b)=>a.start-b.start||(a.end??Infinity)-(b.end??Infinity));
 return {version:PLANNING_VERSION,addressId:snapshot?.addressId||null,lineId:line?.id||null,resolution:snapshot?.resolution||null,supportState:snapshot?.supportState||'unknown',coverage:snapshot?.coverage||null,categories:line?Object.fromEntries(Object.keys(line.categories).sort().map(kind=>[kind,line.categories[kind].days.map(d=>({date:d.date,state:d.state,applicability:d.applicability?.state||null,intervals:clean(d.intervals),possible:clean(d.possibleIntervals)})).sort((a,b)=>a.date.localeCompare(b.date))])):{},notices:(snapshot?.notices||[]).filter(n=>n.active).map(n=>({kind:n.kind,active:n.active,start:n.start,end:n.end,lineIds:n.lineIds||[]}))};
}
