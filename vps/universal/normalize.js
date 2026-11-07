import {createHash} from 'node:crypto';
import {dayState} from '../../app/lib/schedule.js';
import {dayKey,addDays,fresh} from '../../app/lib/time.js';
import {CATEGORIES,validUniversal} from '../../app/lib/universal-contract.js';
import {GROUP_PLAN_MAX_AGE} from '../regions/group-plans.js';
export function dates(from,to){const result=[];for(let d=from;d<=to;d=addDays(d,1)){if(result.length>=14)throw Error('date_range');result.push(d);}return result;}
export function revision(value){const {revision,...body}=value;return createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0,32);}
export function seal(value){const result={...value,revision:revision(value)};if(!validUniversal(result))throw Error('invalid_adapter_snapshot');return result;}
export function normalizeLegacy(entity,legacy,resolution,range,now=Date.now()){
 const line=resolution.lines.find(l=>l.key==='main')||(resolution.lines.length===1?resolution.lines[0]:null),all=dates(range.fromDate,range.toDate),categories={};
 for(const kind of CATEGORIES){
  const raw=legacy.categories?.[kind==='unplanned'?'planned':kind],checkedAt=raw?.checkedAt||0,sourceUpdatedAt=raw?.sourceAt||null;
  const freshUntil=Math.min(checkedAt||0,sourceUpdatedAt||0)+3600000;
  if(kind==='hourly'&&legacy.groupSchedule&&resolution.state!=='excluded'){
   const observedAt=legacy.feedCheckedAt||0,publicationAt=Math.max(0,...legacy.plans.map(p=>p.publishedAt))||null;
   const planUntil=legacy.feedFailed?observedAt:observedAt+GROUP_PLAN_MAX_AGE;
   categories[kind]={checkedAt:observedAt,sourceUpdatedAt:publicationAt,freshUntil:planUntil,evidenceMode:'daily_schedule',days:all.map(date=>{
    const {plan,policy,events}=dayState(legacy,date,now);
    const intervals=(plan?.events||[]).map(({start,end})=>({start,end}));
    const state=!plan?legacy.feedFailed?'unknown':'not_published':plan.uncertain?'unknown':'published';
    const publication={state,intervals,checkedAt:observedAt,sourceUpdatedAt:plan?.publishedAt||null,freshUntil:planUntil};
    if(policy.validity!=='active')return {date,state:'suspended',intervals:events.filter(e=>e.category==='hourly').map(({start,end})=>({start,end})),publication};
    return {date,state:state==='published'&&planUntil<=now?'stale':state,intervals,publication};
   })};
   continue;
  }
  categories[kind]={checkedAt,sourceUpdatedAt,freshUntil,days:all.map(date=>{
   const d=dayState(legacy,date,now),plan=d.plan;
   let state;
   if(kind==='hourly')state=resolution.state==='excluded'?'excluded':plan&&!plan.uncertain&&d.policy.validity==='active'||d.known&&!d.uncertain?'published':d.policy.validity!=='active'?'suspended':legacy.failures?.includes(kind)?'unknown':'not_published';
   else state=fresh(raw?.checkedAt,now)&&fresh(raw?.sourceAt,now)&&!legacy.failures?.includes(kind==='unplanned'?'planned':kind)&&date<=addDays(dayKey(now),1)?'published':'unknown';
   const intervals=d.events.filter(e=>kind==='unplanned'?e.category==='planned'&&e.unplanned:kind==='planned'?e.category==='planned'&&!e.unplanned:e.category===kind).map(e=>({start:e.start,end:e.end}));
   return {date,state,intervals};
  })};
 }
 // Explicit exclusions have no group, but still expose a stable direct service line for other outage types.
 const normalLine=line?{id:line.id,label:line.label,groupCode:legacy.queue||line.groupCode||null,supportedCategories:CATEGORIES,categories}:null;
 const sources=Object.values(categories).map(c=>c.sourceUpdatedAt).filter(Boolean),untils=Object.values(categories).map(c=>c.freshUntil);
 const supportState=legacy.failures?.length||legacy.feedFailed?'degraded':'available';
 return seal({schemaVersion:1,addressId:entity.id,operatorId:entity.operator_id,timeZone:'Europe/Kyiv',coverage:range,resolution:{state:resolution.state,complete:resolution.complete},lines:normalLine?[normalLine]:[],
  notices:[...(legacy.maintenance?[{kind:'maintenance',...legacy.maintenance}]:[]),...(legacy.emergencies||[]).filter(e=>!e.queues?.length||e.queues.includes(legacy.queue)).map(e=>({kind:'regional_emergency',active:!e.ended&&fresh(legacy.feedCheckedAt,now)&&e.effectiveAt<=now&&now<(e.until??Math.max(e.effectiveAt,e.publishedAt)+7200000),start:e.effectiveAt,end:e.until||null,sourceUpdatedAt:e.publishedAt,url:e.url}))],
  checkedAt:legacy.checkedAt||now,sourceUpdatedAt:sources.length?Math.min(...sources):null,freshUntil:Math.min(...untils),
  refreshAfter:legacy.groupSchedule?Math.max(now+60000,(Math.floor((legacy.feedCheckedAt||now)/300000)+1)*300000):now+300000,supportState,
  provenance:[{operatorId:entity.operator_id,adapter:'cherkasy-v1',allocation:resolution.provenance}],synthetic:false});
}
export function degraded(entity,range,previous,code,now=Date.now(),state='degraded'){
 const base=previous||{schemaVersion:1,addressId:entity.id,operatorId:entity.operator_id,timeZone:'Europe/Kyiv',coverage:range,resolution:{state:'unknown',complete:false},lines:[],notices:[],checkedAt:0,sourceUpdatedAt:null,freshUntil:0,provenance:[],synthetic:false};
 return seal({...base,supportState:state,attemptedAt:now,refreshAfter:now+300000,fault:{code}});
}
export function retainPartial(value,previous,failed=[]){
 if(!previous||!failed.length)return value;
 const keep=new Set(failed.flatMap(k=>k==='planned'?['planned','unplanned']:[k]));
 const lines=value.lines.map(line=>{const old=previous.lines.find(x=>x.id===line.id);if(!old)return line;const categories={...line.categories};
  for(const kind of keep)if(old.categories[kind])categories[kind]={...old.categories[kind],days:old.categories[kind].days.map(d=>({...d,state:'stale'}))};
  return {...line,categories};
 });
 const values=lines.flatMap(l=>Object.values(l.categories)),stamps=values.map(c=>c.sourceUpdatedAt).filter(Boolean);
 return seal({...value,lines,supportState:'degraded',sourceUpdatedAt:stamps.length?Math.min(...stamps):null,freshUntil:values.length?Math.min(...values.map(c=>c.freshUntil)):0});
}
