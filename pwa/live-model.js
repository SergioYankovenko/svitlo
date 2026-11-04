import {dayState,countdown} from './core/lib/schedule.js';
import {civil,addDays,dayKey,parts} from './core/lib/time.js';
import {eventKind} from './core/lib/outage-types.js';
export const labels={hourly:'Погодинне відключення',planned:'Планові роботи',unplanned:'Позапланове відключення',emergency:'Аварійне відключення'};
export function scheduleFor(profile,date,now=Date.now()) {
  const from=civil(date),until=civil(addDays(date,1)),total=(until-from)/60000;
  const d=dayState(profile?.snapshot||{},date,now);
  const exact=d.hours.flatMap(h=>h.segments), displayed=d.displayHours.flatMap(h=>h.segments);
  const sum=kind=>exact.filter(s=>s.kind===kind).reduce((n,s)=>n+(s.end-s.start)/60000,0);
  const out=exact.filter(s=>Object.hasOwn(labels,s.kind)).reduce((n,s)=>n+(s.end-s.start)/60000,0);
  const at=(minute,rounded=false)=>{
    const t=from+minute*60000,segment=(rounded?displayed:exact).find(s=>s.start<=t&&t<s.end);
    return !segment||segment.kind==='unknown'?'unknown':segment.kind==='clear'?null:segment.kind;
  };
  return {publication:d.available||d.events.length?'published':'unpublished',total,
    events:d.events.map(e=>({start:Math.max(0,(e.start-from)/60000),end:Math.min(total,((e.end??now)-from)/60000),kind:eventKind(e)})),
    out,unknown:sum('unknown'),clear:sum('clear'),at,from,until,raw:d};
}
export function contextFor(profile,date,now=Date.now()) {
  const d=scheduleFor(profile,date,now),current=date===dayKey(now),c=current?countdown(profile?.snapshot||{},now):{};
  const relevant=d.raw.events.filter(e=>e.end===null||e.end>now).sort((a,b)=>a.start-b.start);
  const active=relevant.filter(e=>e.start<=now).sort((a,b)=>({emergency:3,planned:2,hourly:1}[b.category]||0)-({emergency:3,planned:2,hourly:1}[a.category]||0))[0];
  const category=current?(active||relevant[0]):d.raw.events.slice().sort((a,b)=>({emergency:3,planned:2,hourly:1}[b.category]||0)-({emergency:3,planned:2,hourly:1}[a.category]||0))[0];
  return {kind:category?eventKind(category):null,label:c.label||'',valueMinutes:c.minutes??null,warning:false};
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
