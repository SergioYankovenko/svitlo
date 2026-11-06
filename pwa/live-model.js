import {retainedPublication,usablePublication} from './core/lib/retained-plan.js';
import {dayState,countdown,displayHours} from './core/lib/schedule.js';
import {civil,addDays,dayKey,parts} from './core/lib/time.js';
import {eventKind,categoryPriority} from './core/lib/outage-types.js';
import {selectedLine} from './core/lib/universal-contract.js';
export const labels={hourly:'Погодинне відключення',planned:'Планові роботи',unplanned:'Позапланове відключення',emergency:'Аварійне відключення'};
// Presentation only: sharing and summary cards describe the displayed plan,
// without promoting it to effective events or current-power evidence.
export function planView(data){
  return data.planSummary?{...data,out:data.planSummary.off,clear:data.planSummary.on,unknown:0,events:data.planEvents}:data;
}
// A pair of totals is useful only when both durations are known; measured partial coverage stays usable.
export function summaryVisible(data,summary){
  if(!summary)return false;
  return [summary.on,summary.off].every(Number.isFinite);
}
export function canSharePlan(data){
  const plan=planView(data);
  return plan.publication==='published'&&plan.unknown===0&&plan.out>0;
}
export function planClock(data,minute){
  if(minute===data.total)return '24:00';
  const p=parts(data.from+minute*60000);
  return `${p.hour}:${p.minute}`;
}
export function refreshDeadline(profile,lastSync){
  const s=profile?.snapshot?.universal;
  if(Number.isFinite(s?.freshUntil)&&s.freshUntil<=lastSync&&s.refreshAfter>lastSync)return Math.max(lastSync+30000,s.refreshAfter);
  const source=[s?.refreshAfter,s?.freshUntil].filter(t=>Number.isFinite(t)&&t>0);
  return Math.max(lastSync+30000,Math.min(lastSync+3600000,...source));
}
// A table is display provenance, never effective power, sensor or delivery evidence.
// An expired table may drive only the explicitly labelled UI reference countdown.
export function publishedReference(profile,date,now=Date.now(),saved=false){
  const s=profile?.snapshot?.universal,line=selectedLine(s,profile?.snapshot?.selectedLineId);
  if(!line||!['available','degraded'].includes(s.supportState))return null;
  const category=line.categories.hourly,day=category?.days.find(d=>d.date===date),retained=saved&&day?retainedPublication(s,line,day,now):null;
  if(category?.evidenceMode!=='daily_schedule'&&!retained||!s.resolution.complete&&!retained)return null;
  const fromSaved=!!retained&&(!s.resolution.complete||!usablePublication(day?.publication,date,now)),publication=fromSaved?retained:day?.publication;
  if(!publication)return null;
  const from=civil(date),until=civil(addDays(date,1)),stamp=t=>Number.isFinite(t)&&t>=0;
  const fresh=!fromSaved&&s.resolution.complete&&[s,category,publication].every(x=>stamp(x.checkedAt)&&x.checkedAt<=now+300000&&stamp(x.freshUntil)&&x.freshUntil>now&&
    (x.sourceUpdatedAt===null||stamp(x.sourceUpdatedAt)&&x.sourceUpdatedAt<=now+300000));
  const suspension={suspended:day.state==='suspended'||day.applicability?.state==='suspended',suspensionReason:day.applicability?.reason||null};
  if(publication.state==='not_published')return {available:false,notPublished:fresh,stale:!fresh,...suspension};
  const savedPlan=saved&&date<=dayKey(now)&&(fromSaved||[s,category,publication].every(x=>stamp(x.checkedAt)&&x.checkedAt<=now+300000&&now-x.checkedAt<=7*86400000&&(x.sourceUpdatedAt===null||stamp(x.sourceUpdatedAt)&&x.sourceUpdatedAt<=now+300000)));
  if(publication.state!=='published'||!fresh&&!savedPlan||!Array.isArray(publication.intervals)||publication.intervals.length>2000||
    publication.intervals.some(e=>!e||!stamp(e.start)||!stamp(e.end)||e.start<from||e.end>until||e.end<=e.start))return {available:false};
  const positive=line.supportedCategories.filter(k=>k!=='hourly').flatMap(k=>{
    const c=line.categories[k];
    if(c.evidenceMode!=='positive_only'||c.freshUntil<=now||c.checkedAt>now+300000||c.sourceUpdatedAt>now+300000)return [];
    return (c.days.find(d=>d.date===date)?.intervals||[]).filter(e=>e.start<until&&(e.end===null||e.end>from)).map(e=>({...e,category:k==='unplanned'?'planned':k,...(k==='unplanned'?{unplanned:true}:{})}));
  });
  return {available:true,stale:!fresh,...suspension,applicability:['suspended','conflict'].includes(day.applicability?.state)?day.applicability.state:fromSaved?'reported':day.applicability?.state||'unconfirmed',fromSaved,events:publication.intervals.map(e=>({...e,category:'hourly'})),positive};
}
export function plannedCountdown(profile,date,now=Date.now()){return planCountdown(profile,date,now,false);}
export function referenceCountdown(profile,date,now=Date.now()){return planCountdown(profile,date,now,true);}
function planCountdown(profile,date,now,saved){
  if(date!==dayKey(now))return null;
  const ref=publishedReference(profile,date,now,saved);
  if(!ref?.available||ref.suspended||ref.applicability!=='reported')return null;
  const s=profile?.snapshot?.universal,line=selectedLine(s,profile?.snapshot?.selectedLineId);
  if(line?.supportedCategories.some(k=>k!=='hourly'&&(line.categories[k].days.find(d=>d.date===date)?.intervals||[]).some(e=>e.start<=now&&e.end===null)))return null;
  if(saved&&ref.stale&&s.notices.some(n=>n.kind==='regional_emergency'&&n.scope==='reported_group_day'&&n.active&&n.lineIds?.includes(line.id)&&n.start<=now&&(n.end===null||n.end>now)))return null;
  const tomorrow=publishedReference(profile,addDays(date,1),now,saved);
  const events=[...ref.events,...ref.positive,...(tomorrow?.available&&tomorrow.applicability==='reported'?[...tomorrow.events,...tomorrow.positive]:[])];
  if(events.some(e=>e.start<=now&&e.end===null))return null;
  const merged=[];
  for(const e of events.filter(e=>e.end===null||e.end>now).sort((a,b)=>a.start-b.start)){
    const end=e.end??Infinity,last=merged.at(-1);
    if(last&&e.start<=last.end)last.end=Math.max(last.end,end);else merged.push({start:e.start,end});
  }
  const current=merged.find(e=>e.start<=now&&e.end>now),next=merged.find(e=>e.start>now);
  const target=current?.end??next?.start;
  if(!Number.isFinite(target))return saved?{label:ref.stale?'За графіком: не заплановано':'Не заплановано',minutes:null,target:null,source:ref.stale?'saved_official_plan':'applicable_official_plan'}:null;
  const estimate=saved&&ref.stale;
  return {label:estimate?(current?'За графіком: до відновлення':'За графіком: до відключення'):current?'До відновлення':'До відключення',minutes:Math.ceil((target-now)/60000),target,source:estimate?'saved_official_plan':'applicable_official_plan'};
}
export function officialSource(profile,preferred){
  const sources=profile?.snapshot?.universal?.provenance||[];
  const fallback={'ua-cherkasy':'https://www.cherkasyoblenergo.com/off','ua-kyiv-dtek':'https://www.dtek-kem.com.ua/ua/shutdowns','ua-kyiv-region-dtek':'https://www.dtek-krem.com.ua/ua/shutdowns'};
  for(const value of [preferred,...sources.map(p=>p.url),fallback[profile?.address?.operatorId]]){
    try{const url=new URL(value);if(url.protocol==='https:'&&!url.username&&!url.password)return url.href;}catch{}
  }
  return null;
}
// A separate history-of-plan layer; it cannot turn archive samples into power facts.
export function historicalReference(profile,date,now=Date.now()){
 const s=profile?.snapshot?.universal,line=selectedLine(s,profile?.snapshot?.selectedLineId);
 const h=line?.categories.hourly?.days.find(d=>d.date===date)?.historicalPlan,from=civil(date),until=Math.min(civil(addDays(date,1)),now);
 if(h?.version!==1||h.basis!=='archived_official_plan'||!Array.isArray(h.periods)||!h.periods.length||h.periods.length>400)return null;
 if(h.periods.some((p,i)=>!p||!Number.isFinite(p.start)||!Number.isFinite(p.end)||p.start<from||p.end>until||p.end<=p.start||i&&p.start<h.periods[i-1].end||!Array.isArray(p.intervals)||p.intervals.length>96||p.intervals.some(e=>!e||!Number.isFinite(e.start)||!Number.isFinite(e.end)||e.start<from||e.end>civil(addDays(date,1))||e.end<=e.start)))return null;
 const periods=h.periods.map(p=>({...p,display:displayHours(p.intervals.map(e=>({...e,category:'hourly'})),from,civil(addDays(date,1)),false,now).flatMap(x=>x.segments)}));
 return {at(minute){const t=from+minute*60000,p=periods.find(p=>p.start<=t&&t<p.end);if(!p)return undefined;return p.display.some(s=>s.kind==='hourly'&&s.start<=t&&t<s.end)?'hourly':null;}};
}
export function scheduleFor(profile,date,now=Date.now()) {
  const from=civil(date),until=civil(addDays(date,1)),total=(until-from)/60000;
  const reference=publishedReference(profile,date,now,true);
  let snapshot=profile?.snapshot||{};
  if(reference?.suspended){
    const s=snapshot.universal,line=selectedLine(s,snapshot.selectedLineId);
    // A read projection only: retain original publication, timestamps and cached source unchanged.
    // Expired positive-only observations must not acquire fresh certainty from the suspended table.
    const categories=Object.fromEntries(Object.entries(line.categories).map(([kind,c])=>[kind,{...c,days:c.days.map(day=>
      day.date===date&&(kind==='hourly'||c.freshUntil<=now||c.checkedAt>now+300000||c.sourceUpdatedAt>now+300000)
        ? {...day,intervals:[]} : day)}]));
    snapshot={...snapshot,universal:{...s,lines:s.lines.map(l=>l.id===line.id?{...l,categories}:l)}};
  }
  const d=dayState(snapshot,date,now);
  const exact=d.hours.flatMap(h=>h.segments), displayed=d.displayHours.flatMap(h=>h.segments);
  // An explicitly suspended plan stays in provenance, but must not paint effective hours or totals.
  // Positive address intervals still come from dayState, including emergency intervals with no end.
  const referenceEvents=reference?.available&&!reference.suspended?[...reference.events,...reference.positive]:null;
  const referenceDisplay=referenceEvents?displayHours(referenceEvents,from,until,false,now).flatMap(h=>h.segments):null;
  // Separate, decorative reference only. Never enters at(), events, totals or delivery.
  const suspendedDisplay=reference?.available&&reference.suspended&&reference.events.length
    ? displayHours(reference.events,from,until,false,now).flatMap(h=>h.segments):null;
  const referenceOverlay=suspendedDisplay?{
    stale:reference.stale,
    at(minute){
      const t=from+minute*60000;
      return t>=from&&t<until&&suspendedDisplay.some(s=>s.kind==='hourly'&&s.start<=t&&t<s.end);
    }
  }:null;
  const sum=kind=>exact.filter(s=>s.kind===kind).reduce((n,s)=>n+(s.end-s.start)/60000,0);
  const out=exact.filter(s=>Object.hasOwn(labels,s.kind)).reduce((n,s)=>n+(s.end-s.start)/60000,0);
  const at=(minute,rounded=false)=>{
    const t=from+minute*60000,segment=(rounded?displayed:exact).find(s=>s.start<=t&&t<s.end);
    if(referenceEvents){
      if(t<from||t>=until)return 'unknown';
      if(rounded){const match=referenceDisplay.find(s=>s.start<=t&&t<s.end);return match?.kind==='clear'?null:match?.kind||'unknown';}
      return eventKind(referenceEvents.filter(e=>e.start<=t&&(e.end??now)>t).sort((a,b)=>categoryPriority[b.category]-categoryPriority[a.category])[0])||null;
    }
    return !segment||segment.kind==='unknown'?'unknown':segment.kind==='clear'?null:segment.kind;
  };
  const daily=d.line?.categories.hourly;
  const incompleteDaily=daily?.evidenceMode==='daily_schedule'&&!reference?.available&&!d.known&&!d.events.some(e=>e.category!=='hourly');
  const notPublished=reference?!!reference.notPublished:!d.stale&&d.line?.categories.hourly?.days.find(x=>x.date===date)?.state==='not_published';
  const coverage=profile?.snapshot?.universal?.coverage,outside=coverage&&(date<coverage.fromDate||date>coverage.toDate);
  // This is a total of the published plan, never a claim about actual power.
  const planSegments=referenceEvents?displayHours(referenceEvents,from,until,true,now).flatMap(h=>h.segments):null;
  const planOut=planSegments?.filter(s=>Object.hasOwn(labels,s.kind)).reduce((n,s)=>n+(s.end-s.start)/60000,0);
  const planSummary=planSegments&&!referenceEvents.some(e=>e.end===null)?{on:total-planOut,off:planOut}:null;
  const archived=reference?.suspended?historicalReference(profile,date,now):null;
  const historicalOverlay=archived?{...archived,emergency:/^(?:emergency_report_|reported_emergency_|address_emergency)/.test(reference.suspensionReason||'')}:null;
  return {publication:outside?'unknown':reference?.available?'published':notPublished&&!d.events.length?'unpublished':incompleteDaily?'unknown':d.known||d.events.length?'published':'unknown',total,
    events:d.events.map(e=>({start:Math.max(0,(e.start-from)/60000),end:Math.min(total,((e.end??now)-from)/60000),kind:eventKind(e)})),
    out,unknown:sum('unknown'),clear:sum('clear'),planSummary,
    planEvents:referenceEvents?.map(e=>({start:Math.max(0,(e.start-from)/60000),end:e.end===null?null:Math.min(total,(e.end-from)/60000),kind:eventKind(e)}))||null,
    at,from,until,raw:d,referenceOverlay,historicalOverlay,
    emergencySuspended:!!reference?.suspended&&/^(?:emergency_report_|reported_emergency_|address_emergency)/.test(reference.suspensionReason||''),
    suspended:!!reference?.suspended,referenceAvailable:!!reference?.available,referenceStale:!!reference?.stale,referenceOnly:!!referenceEvents&&(reference.stale||!d.known||reference.applicability!=='reported')};
}
export function contextFor(profile,date,now=Date.now()) {
  const d=scheduleFor(profile,date,now),current=date===dayKey(now),c=current?countdown(profile?.snapshot||{},now):{};
  const planned=current&&c.minutes==null?(plannedCountdown(profile,date,now)||referenceCountdown(profile,date,now)):null;
  const relevant=d.raw.events.filter(e=>e.end===null||e.end>now).sort((a,b)=>a.start-b.start);
  const active=relevant.filter(e=>e.start<=now).sort((a,b)=>({emergency:3,planned:2,hourly:1}[b.category]||0)-({emergency:3,planned:2,hourly:1}[a.category]||0))[0];
  const category=current?(active||relevant[0]):d.raw.events.slice().sort((a,b)=>({emergency:3,planned:2,hourly:1}[b.category]||0)-({emergency:3,planned:2,hourly:1}[a.category]||0))[0];
  const ref=current&&!active?publishedReference(profile,date,now):null;
  const suspensionLabel=ref?.suspended&&!ref.stale
    ? /^(?:emergency_report_|reported_emergency_|address_emergency)/.test(ref.suspensionReason||'')?'Аварійний режим у черзі':'Погодинний графік тимчасово не діє'
    : null;
  const emergencySuspension=/^(?:emergency_report_|reported_emergency_|address_emergency)/.test(publishedReference(profile,date,now,true)?.suspensionReason||'');
  const notice=d.suspended&&(d.referenceAvailable||ref?.suspended&&!ref.stale)?{
    title:d.referenceStale?'Збережений графік':emergencySuspension?'Аварійне відключення':'Графік призупинено',
    text:!d.referenceStale&&emergencySuspension?'Спеціалісти працюють над відновленням.':'Час відновлення уточнюється.',
    reference:d.referenceAvailable,stale:d.referenceStale
  }:current&&active?.category==='emergency'?{
    title:'Аварійне відключення',
    text:'Спеціалісти працюють над відновленням.',
    reference:false,stale:false
  }:null;
  const valueMinutes=suspensionLabel?null:planned?.minutes??c.minutes??null;
  const restorationUnknown=current&&valueMinutes===null&&(emergencySuspension||active?.category==='emergency');
  return {kind:category?eventKind(category):null,label:restorationUnknown?'Час відновлення уточнюється':suspensionLabel||planned?.label||c.label||'',valueMinutes,warning:false,notice,plannedCountdown:!!planned};
}
export function profileView(p) {
  const a=p.address||{},city=(typeof a.city==='string'?a.city:a.city?.label||a.city?.name)||a.cityName||'', street=(typeof a.street==='string'?a.street:a.street?.label||a.street?.name)||'',house=(typeof a.house==='string'?a.house:a.house?.label||a.house?.name)||'';
  const label=a.label||[city,street,house].filter(Boolean).join(', ');
  const first=label.indexOf(',');
  return {...(a.lineNumber?{addressGroupId:a.canonicalAddressId,lineNumber:a.lineNumber,lineId:a.lineId}:{}),id:p.id,name:typeof p.name==='string'?p.name:'',city:city||label.slice(0,first<0?undefined:first),street:[street,house].filter(Boolean).join(', ')|| (first<0?'':label.slice(first+1).trim()),queue:p.snapshot?.queue||'',catalogKey:p.id};
}
export function utcIntervals(overview) {
  if(!overview||overview.overviewVersion!==1||overview.observation?.semantics!=='explicit_coverage_only') return [];
  const start=Date.parse(overview.dayStartUtc),until=Math.min(Date.parse(overview.dayEndUtc),Date.parse(overview.asOf));
  return (overview.observation.intervals||[]).map(e=>({start:Date.parse(e.start),end:Date.parse(e.end),state:e.powerState})).filter(e=>['on','off'].includes(e.state)&&Number.isFinite(e.start)&&Number.isFinite(e.end)&&e.start<e.end&&e.start>=start&&e.end<=until);
}
export {parts};
