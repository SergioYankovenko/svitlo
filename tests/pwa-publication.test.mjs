import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {universalEnvelope} from '../app/lib/universal-contract.js';
const text=(await readFile(new URL('../pwa/live-model.js',import.meta.url),'utf8')).replaceAll("'./core/",`'${new URL('../app/',import.meta.url).href}`);
const {scheduleFor,contextFor,publishedReference,plannedCountdown,refreshDeadline}=await import('data:text/javascript;base64,'+Buffer.from(text).toString('base64'));
const root=new URL('fixtures/kyiv-publication/',import.meta.url),index=JSON.parse(await readFile(new URL('index.json',root),'utf8'));
const date='2026-11-04',now=index.clockMs;
const profile=s=>({snapshot:universalEnvelope(s,s.lines[0].id)});
for(const entry of index.scenarios)test(`published/reference contract: ${entry.file}`,async()=>{
 const s=JSON.parse(await readFile(new URL(entry.file,root),'utf8')),p=profile(s),before=JSON.stringify(p),d=scheduleFor(p,date,now),c=contextFor(p,date,now);
 if(entry.scenario==='missing-control')assert.equal(d.publication,'unpublished');
 else {
  assert.equal(d.publication,'published');assert.equal(d.referenceAvailable,true);
  const pub=s.lines[0].categories.hourly.days[0].publication;
  assert.deepEqual(publishedReference(p,date,now).events.map(({start,end})=>({start,end})),pub.intervals);
  assert.ok(pub.intervals.length>0);
  for(const e of pub.intervals)assert.equal(d.at((e.start+e.end)/2/60000-d.from/60000),'hourly');
 }
 if(entry.scenario==='emergency'){
  assert.equal(d.referenceOnly,true);assert.equal(d.raw.known,false);assert.equal(c.valueMinutes,null);assert.notEqual(c.kind,'emergency');
  assert.equal(d.events.filter(e=>e.kind==='hourly').length,0);
  assert.ok(d.unknown>0);assert.notEqual(d.clear,d.total);assert.equal(c.warning,false);
 }
 if(entry.scenario==='applies-control'){
  const planned=plannedCountdown(p,date,now);assert.ok(planned&&Number.isFinite(planned.minutes));assert.equal(c.valueMinutes,planned.minutes);assert.equal(c.plannedCountdown,true);
  assert.equal(d.raw.known,false,'a planned timer does not promote full-day certainty');assert.ok(d.unknown>0);
 }
 assert.equal(JSON.stringify(p),before,'display never mutates cached/effective source data');
});
test('stale, invalid, ambiguous and failed publications never become a fresh clear plan',async()=>{
 const s=JSON.parse(await readFile(new URL('deg25-emergency.json',root),'utf8'));
 for(const edit of [s=>s.freshUntil=now,s=>s.lines[0].categories.hourly.days[0].publication.freshUntil=now,s=>s.resolution.complete=false,s=>s.lines[0].categories.hourly.days[0].publication.intervals[0].end=null]){
  const x=structuredClone(s);edit(x);const p=profile(x),d=scheduleFor(p,date,now);assert.equal(publishedReference(p,date,now)?.available===true,false);assert.equal(plannedCountdown(p,date,now),null);assert.ok(d.unknown>0);if(d.referenceAvailable)assert.equal(d.referenceStale,true);
 }
 const missing=scheduleFor({snapshot:{}},date,now);assert.equal(missing.publication,'unknown');assert.equal(missing.at(0),'unknown');
 assert.equal(scheduleFor(profile(s),'2026-11-10',now).publication,'unknown');
 for(const state of ['suspended','conflict','unconfirmed']){const x=structuredClone(s);x.lines[0].categories.hourly.days[0].applicability.state=state;assert.equal(plannedCountdown(profile(x),date,now),null);}
});
test('fresh positive address events overlay reference hours with existing category priority',async()=>{
 const s=JSON.parse(await readFile(new URL('deg25-emergency.json',root),'utf8')),line=s.lines[0];
 const start=Date.parse(date+'T12:01:00+02:00'),end=Date.parse(date+'T13:02:00+02:00');
 for(const k of ['planned','unplanned','emergency'])line.categories[k].days[0].intervals=[{start,end}];
 let p=profile(s),d=scheduleFor(p,date,now),minute=(start-d.from)/60000+1;
 assert.equal(d.at(minute),'emergency');
 line.categories.emergency.days[0].intervals=[];d=scheduleFor(profile(s),date,now);assert.equal(d.at(minute),'planned');
 line.categories.planned.days[0].intervals=[];d=scheduleFor(profile(s),date,now);assert.equal(d.at(minute),'unplanned');
 const exact=d.events.find(e=>e.kind==='unplanned');assert.equal(exact.start*60000+d.from,start);assert.equal(exact.end*60000+d.from,end);
 line.categories.unplanned.freshUntil=now-1;d=scheduleFor(profile(s),date,now);assert.notEqual(d.at(minute),'unplanned');
});

for(const state of ['conflict','unconfirmed'])test(`fresh published reference survives degraded ${state} without confirming effective power`,async()=>{
 const s=JSON.parse(await readFile(new URL('deg25-emergency.json',root),'utf8'));
 s.supportState='degraded';const day=s.lines[0].categories.hourly.days[0];
 day.state='unknown';day.applicability.state=state;
 const p=profile(s),before=JSON.stringify(p),d=scheduleFor(p,date,now),c=contextFor(p,date,now);
 assert.equal(d.publication,'published');assert.equal(d.referenceAvailable,true);assert.equal(d.referenceOnly,true);
 for(const e of day.publication.intervals)assert.equal(d.at(((e.start+e.end)/2-d.from)/60000),'hourly');
 assert.equal(d.raw.known,false);assert.ok(d.unknown>0);assert.equal(c.valueMinutes,null);assert.equal(c.warning,false);
 assert.equal(d.events.filter(e=>e.kind==='hourly').length,0);assert.equal(JSON.stringify(p),before);
 for(const edit of [x=>x.freshUntil=now,x=>x.resolution.complete=false,x=>x.lines[0].categories.hourly.days[0].publication.freshUntil=now]){
  const x=structuredClone(s);edit(x);const p=profile(x),d=scheduleFor(p,date,now);assert.notEqual(publishedReference(p,date,now)?.available,true);assert.equal(plannedCountdown(p,date,now),null);if(d.referenceAvailable)assert.equal(d.referenceStale,true);
 }
});

test('disabled and unsupported providers cannot expose a published reference even with fresh cached publication fields',async()=>{
 const s=JSON.parse(await readFile(new URL('deg25-emergency.json',root),'utf8'));
 for(const state of ['disabled','unsupported']){const x=structuredClone(s);x.supportState=state;assert.equal(scheduleFor(profile(x),date,now).referenceAvailable,false);}
});
test('visible refresh uses the source deadline with a bounded floor and a one-hour legacy default',()=>{
 assert.equal(refreshDeadline(null,now),now+3600000);
 assert.equal(refreshDeadline({snapshot:{universal:{refreshAfter:now+120000,freshUntil:now+180000}}},now),now+120000);
 assert.equal(refreshDeadline({snapshot:{universal:{refreshAfter:now-1}}},now),now+30000);
 assert.equal(refreshDeadline({snapshot:{universal:{refreshAfter:'invalid',freshUntil:now+7200000}}},now),now+3600000);
});
