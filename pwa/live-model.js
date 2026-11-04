import {dayState,countdown,displayHours} from './core/lib/schedule.js';
import {civil,addDays,dayKey,parts} from './core/lib/time.js';
import {eventKind,categoryPriority} from './core/lib/outage-types.js';
import {selectedLine} from './core/lib/universal-contract.js';
export const labels={hourly:'Погодинне відключення',planned:'Планові роботи',unplanned:'Позапланове відключення',emergency:'Аварійне відключення'};
export function refreshDeadline(profile,lastSync){
  const s=profile?.snapshot?.universal;
  const source=[s?.refreshAfter,s?.freshUntil].filter(t=>Number.isFinite(t)&&t>0);
  return Math.max(lastSync+30000,Math.min(lastSync+3600000,...source));
}
// A published table is a display source, never a replacement for effective events,
// current-power certainty, countdowns, sensor observations or delivery policy.
export function publishedReference(profile,date,now=Date.now()){
  const s=profile?.snapshot?.universal,line=selectedLine(s,profile?.snapshot?.selectedLineId);
  if(!line||!s.resolution.complete||!['available','degraded'].includes(s.supportState))return null;
  const category=line.categories.hourly,day=category?.days.find(d=>d.date===date),publication=day?.publication;
  if(category?.evidenceMode!=='daily_schedule'||!publication)return null;
  const from=civil(date),until=civil(addDays(date,1)),stamp=t=>Number.isFinite(t)&&t>=0;
  const fresh=[s,category,publication].every(x=>stamp(x.checkedAt)&&x.checkedAt<=now+300000&&stamp(x.freshUntil)&&x.freshUntil>now&&
    (x.sourceUpdatedAt===null||stamp(x.sourceUpdatedAt)&&x.sourceUpdatedAt<=now+300000));
  if(publication.state==='not_published')return {available:false,notPublished:fresh};
  if(publication.state!=='published'||!fresh||!Array.isArray(publication.intervals)||publication.intervals.length>2000||
    publication.intervals.some(e=>!e||!stamp(e.start)||!stamp(e.end)||e.start<from||e.end>until||e.end<=e.start))return {available:false};
  const positive=line.supportedCategories.filter(k=>k!=='hourly').flatMap(k=>{
    const c=line.categories[k];
    if(c.evidenceMode!=='positive_only'||c.freshUntil<=now||c.checkedAt>now+300000||c.sourceUpdatedAt>now+300000)return [];
    return (c.days.find(d=>d.date===date)?.intervals||[]).filter(e=>e.start<until&&(e.end===null||e.end>from)).map(e=>({...e,category:k==='unplanned'?'planned':k,...(k==='unplanned'?{unplanned:true}:{})}));
  });
  return {available:true,applicability:day.applicability?.state||'unconfirmed',events:publication.intervals.map(e=>({...e,category:'hourly'})),positive};
}
export function plannedCountdown(profile,date,now=Date.now()){
  const ref=publishedReference(profile,date,now);
  if(!ref?.available||ref.applicability!=='reported')return null;
  const tomorrow=publishedReference(profile,addDays(date,1),now);
  const events=[...ref.events,...ref.positive,...(tomorrow?.available&&tomorrow.applicability==='reported'?[...tomorrow.events,...tomorrow.positive]:[])];
  if(events.some(e=>e.start<=now&&e.end===null))return null;
  const merged=[];
  for(const e of events.filter(e=>e.end===null||e.end>now).sort((a,b)=>a.start-b.start)){
    const end=e.end??Infinity,last=merged.at(-1);
    if(last&&e.start<=last.end)last.end=Math.max(last.end,end);else merged.push({start:e.start,end});
  }
  const current=merged.find(e=>e.start<=now&&e.end>now),next=merged.find(e=>e.start>now);
  const target=current?.end??next?.start;
  if(!Number.isFinite(target))return null;
  return {label:current?'До відновлення':'До відключення',minutes:Math.ceil((target-now)/60000),target,source:'applicable_official_plan'};
}
export function officialSource(profile,preferred){
  const sources=profile?.snapshot?.universal?.provenance||[];
  const fallback={'ua-cherkasy':'https://www.cherkasyoblenergo.com/off','ua-kyiv-dtek':'https://www.dtek-kem.com.ua/ua/shutdowns','ua-kyiv-region-dtek':'https://www.dtek-krem.com.ua/ua/shutdowns'};
  for(const value of [preferred,...sources.map(p=>p.url),fallback[profile?.address?.operatorId]]){
    try{const url=new URL(value);if(url.protocol==='https:'&&!url.username&&!url.password)return url.href;}catch{}
  }
  return null;
}
export function scheduleFor(profile,date,now=Date.now()) {
  const from=civil(date),until=civil(addDays(date,1)),total=(until-from)/60000;
  const d=dayState(profile?.snapshot||{},date,now);
  const exact=d.hours.flatMap(h=>h.segments), displayed=d.displayHours.flatMap(h=>h.segments);
  const reference=publishedReference(profile,date,now);
  const referenceEvents=reference?.available?[...reference.events,...reference.positive]:null;
  const referenceDisplay=referenceEvents?displayHours(referenceEvents,from,until,false,now).flatMap(h=>h.segments):null;
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
  const notPublished=reference?!!reference.notPublished:!d.stale&&d.line?.categories.hourly?.days.find(x=>x.date===date)?.state==='not_published';
  const coverage=profile?.snapshot?.universal?.coverage,outside=coverage&&(date<coverage.fromDate||date>coverage.toDate);
  return {publication:outside?'unknown':reference?.available?'published':notPublished&&!d.events.length?'unpublished':d.available||d.known||d.events.length?'published':'unknown',total,
    events:d.events.map(e=>({start:Math.max(0,(e.start-from)/60000),end:Math.min(total,((e.end??now)-from)/60000),kind:eventKind(e)})),
    out,unknown:sum('unknown'),clear:sum('clear'),at,from,until,raw:d,
    referenceAvailable:!!reference?.available,referenceOnly:!!reference?.available&&(!d.known||reference.applicability!=='reported')};
}
export function contextFor(profile,date,now=Date.now()) {
  const d=scheduleFor(profile,date,now),current=date===dayKey(now),c=current?countdown(profile?.snapshot||{},now):{};
  const planned=current&&c.minutes==null?plannedCountdown(profile,date,now):null;
  const relevant=d.raw.events.filter(e=>e.end===null||e.end>now).sort((a,b)=>a.start-b.start);
  const active=relevant.filter(e=>e.start<=now).sort((a,b)=>({emergency:3,planned:2,hourly:1}[b.category]||0)-({emergency:3,planned:2,hourly:1}[a.category]||0))[0];
  const category=current?(active||relevant[0]):d.raw.events.slice().sort((a,b)=>({emergency:3,planned:2,hourly:1}[b.category]||0)-({emergency:3,planned:2,hourly:1}[a.category]||0))[0];
  return {kind:category?eventKind(category):null,label:planned?.label||c.label||'',valueMinutes:planned?.minutes??c.minutes??null,warning:false,plannedCountdown:!!planned};
}
export function profileView(p) {
  const a=p.address||{},city=a.city?.label||a.city?.name||a.cityName||'', street=a.street?.label||a.street?.name||'',house=a.house?.label||a.house?.name||'';
  const label=a.label||[city,street,house].filter(Boolean).join(', ');
  const first=label.indexOf(',');
  return {id:p.id,name:typeof p.name==='string'?p.name:'',city:city||label.slice(0,first<0?undefined:first),street:[street,house].filter(Boolean).join(', ')|| (first<0?'':label.slice(first+1).trim()),queue:p.snapshot?.queue||'',catalogKey:p.id};
}
export function utcIntervals(overview) {
  if(!overview||overview.overviewVersion!==1||overview.observation?.semantics!=='explicit_coverage_only') return [];
  const start=Date.parse(overview.dayStartUtc),until=Math.min(Date.parse(overview.dayEndUtc),Date.parse(overview.asOf));
  return (overview.observation.intervals||[]).map(e=>({start:Date.parse(e.start),end:Date.parse(e.end),state:e.powerState})).filter(e=>['on','off'].includes(e.state)&&Number.isFinite(e.start)&&Number.isFinite(e.end)&&e.start<e.end&&e.start>=start&&e.end<=until);
}
export {parts};
