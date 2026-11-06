import {civil,addDays,dayKey} from './time.js';
const week=7*86400000;
export function failedPlanRead(s){
 return s?.supportState==='degraded'&&(
  ['forbidden','rate_limited','timeout','source_unavailable','synthetic_unavailable'].includes(s.fault?.code)||
  s.provenance?.some(p=>p.allocation?.sourceUnavailable===true));
}
export function usablePublication(p,date,now){
 const from=civil(date),until=civil(addDays(date,1));
 return p?.state==='published'&&Number.isFinite(p.checkedAt)&&p.checkedAt>0&&p.checkedAt<=now+300000&&now-p.checkedAt<=week&&
  Number.isFinite(p.freshUntil)&&p.freshUntil>=p.checkedAt&&
  (p.sourceUpdatedAt===null||Number.isFinite(p.sourceUpdatedAt)&&p.sourceUpdatedAt>=0&&p.sourceUpdatedAt<=now+300000)&&
  Array.isArray(p.intervals)&&p.intervals.length<=2000&&p.intervals.every(e=>Number.isFinite(e.start)&&Number.isFinite(e.end)&&e.start>=from&&e.end<=until&&e.end>e.start);
}
export function retainedPublication(s,line,day,now){
 const p=day?.savedPublication;
 return failedPlanRead(s)&&p?.version===1&&p.basis==='previous_confirmed_plan'&&p.addressId===s.addressId&&p.operatorId===s.operatorId&&
  p.lineId===line.id&&p.groupCode===line.groupCode&&p.date===day.date&&p.applicability==='reported'&&usablePublication(p,day.date,now)?p:null;
}
// Separate display provenance. Effective intervals, resolution, clocks and reminders stay unchanged.
export function retainCurrentPlan(next,prior,now){
 if(!failedPlanRead(next)||next.addressId!==prior?.addressId||next.operatorId!==prior?.operatorId)return next;
 const date=dayKey(now);
 // A source-cache range miss must not erase the last profile snapshot. This is
 // the same degraded-read contract as the reader cache, with freshness expired.
 if(!next.lines.length&&['available','degraded'].includes(prior.supportState)&&prior.resolution.complete&&
    prior.coverage.fromDate<=date&&prior.coverage.toDate>=date&&now-prior.checkedAt<=week&&prior.checkedAt<=now+300000&&
    prior.lines.some(l=>l.categories.hourly?.evidenceMode==='daily_schedule'&&usablePublication(l.categories.hourly.days.find(d=>d.date===date)?.publication,date,now))){
  return {...structuredClone(prior),supportState:'degraded',freshUntil:Math.min(prior.freshUntil,next.freshUntil,now-1),fault:structuredClone(next.fault||{code:'source_unavailable'}),attemptedAt:next.attemptedAt??now,refreshAfter:next.refreshAfter,
   notices:structuredClone(next.notices.length?next.notices:prior.notices)};
 }
 if(next.coverage.fromDate>date||next.coverage.toDate<date)return next;
 const copy=structuredClone(next);let changed=false;
 for(const line of copy.lines){
  const category=line.categories.hourly,old=prior.lines.find(l=>l.id===line.id&&l.groupCode===line.groupCode),before=old?.categories.hourly?.days.find(d=>d.date===date);
  if(!category||!before||old.categories.hourly.evidenceMode!=='daily_schedule')continue;
  let publication;
  if(prior.resolution.complete&&before.applicability?.state==='reported'&&usablePublication(before.publication,date,now))
   publication={...structuredClone(before.publication),version:1,basis:'previous_confirmed_plan',addressId:prior.addressId,operatorId:prior.operatorId,lineId:old.id,groupCode:old.groupCode,date,applicability:'reported'};
  else publication=retainedPublication(prior,old,before,now);
  if(!publication)continue;
  let day=category.days.find(d=>d.date===date);
  if(!day){
   if(category.days.length>=14){const future=category.days.filter(d=>d.date>date).sort((a,b)=>b.date.localeCompare(a.date))[0];if(!future)continue;category.days=category.days.filter(d=>d!==future);}
   day={date,state:'unknown',intervals:[]};category.days.push(day);category.days.sort((a,b)=>a.date.localeCompare(b.date));
  }
  day.savedPublication=structuredClone(publication);changed=true;
 }
 return changed?copy:next;
}
