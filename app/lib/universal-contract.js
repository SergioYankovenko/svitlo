import {validDate} from './lifecycle.js';
import {civil,addDays,dayKey} from './time.js';
export const CATEGORIES=['hourly','planned','unplanned','emergency'];
export const STATES=['published','not_published','excluded','unknown','stale','suspended','unsupported'];
const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const stamp=x=>Number.isFinite(x)&&x>=0;
export function validUniversal(s){
 if(!object(s)||s.schemaVersion!==1||typeof s.revision!=='string'||!s.revision||typeof s.addressId!=='string'||typeof s.operatorId!=='string'||s.timeZone!=='Europe/Kyiv')return false;
 if(!['available','degraded','disabled','unsupported'].includes(s.supportState)||!validDate(s.coverage?.fromDate)||!validDate(s.coverage?.toDate)||s.coverage.fromDate>s.coverage.toDate)return false;
 if(!['resolved','ambiguous','excluded','unknown'].includes(s.resolution?.state)||typeof s.resolution.complete!=='boolean'||!Array.isArray(s.lines)||s.lines.length>32)return false;
 if(!stamp(s.checkedAt)||!stamp(s.refreshAfter)||!stamp(s.freshUntil)||s.sourceUpdatedAt!==null&&!stamp(s.sourceUpdatedAt)||!Array.isArray(s.notices)||!Array.isArray(s.provenance))return false;
 if(s.notices.some(n=>!object(n)||!['regional_emergency','maintenance'].includes(n.kind)))return false;
 const ids=new Set();
 for(const line of s.lines){
  if(!object(line)||typeof line.id!=='string'||ids.has(line.id)||typeof line.label!=='string'||line.groupCode!==null&&(typeof line.groupCode!=='string'||line.groupCode.length>80)||!Array.isArray(line.supportedCategories)||line.supportedCategories.some(k=>!CATEGORIES.includes(k))||!object(line.categories))return false;
  ids.add(line.id);
  for(const k of line.supportedCategories){const c=line.categories[k];if(!object(c)||!stamp(c.checkedAt)||!stamp(c.freshUntil)||c.sourceUpdatedAt!==null&&!stamp(c.sourceUpdatedAt)||!Array.isArray(c.days)||c.days.length>14)return false;
   const days=new Set();for(const d of c.days){if(!validDate(d.date)||days.has(d.date)||d.date<s.coverage.fromDate||d.date>s.coverage.toDate||!STATES.includes(d.state)||!Array.isArray(d.intervals)||d.intervals.length>2000)return false;days.add(d.date);
    for(const e of d.intervals)if(!stamp(e.start)||e.end!==null&&(!stamp(e.end)||e.end<=e.start))return false;
   }
  }
 }
 return true;
}
export function selectedLine(s,id){if(!validUniversal(s))return null;if(id)return s.lines.find(l=>l.id===id)||null;return s.resolution.complete&&s.lines.length===1?s.lines[0]:null;}
export function universalDay(s,date,id,now=Date.now()){
 const from=civil(date),until=civil(addDays(date,1)),valid=validUniversal(s),line=valid?selectedLine(s,id):null;
 let known=!!line&&s.supportState==='available'&&s.resolution.complete&&(['resolved','excluded'].includes(s.resolution.state)||s.resolution.state==='ambiguous'&&!!id),stale=!valid||s.freshUntil<=now||s.checkedAt>now+300000;
 const events=[];
 if(line)for(const k of line.supportedCategories){const c=line.categories[k],d=c.days.find(x=>x.date===date);
  if(!d||!['published','excluded'].includes(d.state)||c.freshUntil<=now)known=false;
  if(c.freshUntil<=now||c.checkedAt>now+300000||c.sourceUpdatedAt>now+300000)stale=true;
  for(const e of d?.intervals||[])if(e.start<until&&(e.end===null||e.end>from))events.push({...e,category:k==='unplanned'?'planned':k,...(k==='unplanned'?{unplanned:true}:{})});
 }
 if(stale)known=false;
 const excluded=valid&&s.resolution.state==='excluded';
 const reason=!valid?'unsupported':s.supportState==='disabled'?'provider_disabled':s.supportState==='unsupported'?'unsupported':!line?'line_unknown':stale?'stale':!known?'not_published':excluded?'no_queue':'ready';
 return {events,known,stale,excluded,uncertain:!known||events.some(e=>e.end===null),reason,from,until,line};
}
// Compatibility envelope only for the existing PWA renderer/notification policy, never a provider protocol.
export function universalEnvelope(s,lineId){
 const line=selectedLine(s,lineId),categories={};
 for(const key of ['hourly','planned','emergency']){
  const keys=key==='planned'?['planned','unplanned']:[key],values=keys.map(k=>line?.categories[k]).filter(Boolean);
  categories[key]={checkedAt:values.length?Math.min(...values.map(c=>c.checkedAt)):0,sourceAt:values.length?Math.min(...values.map(c=>c.sourceUpdatedAt||0)):0,
   events:keys.flatMap(k=>(line?.categories[k]?.days||[]).flatMap(d=>d.intervals.map(e=>({...e,category:key,...(k==='unplanned'?{unplanned:true}:{})}))))};
 }
 return {universal:s,selectedLineId:lineId||line?.id||null,queue:line?.groupCode||null,categories,plans:[],emergencies:[],checkedAt:s.checkedAt,feedCheckedAt:s.checkedAt,feedFailed:s.supportState!=='available',failures:s.supportState==='available'?[]:['hourly'],
  queueResolution:{status:s.resolution.state==='resolved'?'matched':'not_found',...(s.resolution.state==='excluded'?{inclusion:'not_in_queue'}:{})}};
}
