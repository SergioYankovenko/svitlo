import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {universalEnvelope} from '../app/lib/universal-contract.js';
import {civil} from '../app/lib/time.js';
const source=(await readFile(new URL('../pwa/live-model.js',import.meta.url),'utf8')).replaceAll("'./core/",`'${new URL('../app/',import.meta.url).href}`);
const {scheduleFor,contextFor,canSharePlan,plannedCountdown}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const base=JSON.parse(await readFile(new URL('fixtures/kyiv-publication/deg25-emergency.json',import.meta.url),'utf8'));
const date='2026-11-04',now=base.checkedAt;
function setup(){const s=structuredClone(base);return {s,line:s.lines[0],p:{snapshot:universalEnvelope(s,s.lines[0].id)}};}
// universalEnvelope retains a validated copy; construct only after fixture changes.
const profile=s=>({snapshot:universalEnvelope(s,s.lines[0].id)});

test('suspended reference is rounded visually but never changes precise evidence, totals, timer or sharing',()=>{
 const {s,line}=setup(),day=line.categories.hourly.days[0];
 day.publication.intervals=[{start:civil(date,721),end:civil(date,842)}];
 const p=profile(s),before=JSON.stringify(p),d=scheduleFor(p,date,now);
 assert.ok(d.referenceOverlay);assert.equal(d.referenceOverlay.at(735),true);assert.equal(d.referenceOverlay.at(825),true);
 assert.equal(d.referenceOverlay.at(855),false);assert.equal(d.referenceOverlay.at(-1),false);assert.equal(d.referenceOverlay.at(1440),false);
 assert.equal(d.at(735,true),'unknown');assert.equal(d.out,0);assert.equal(d.planSummary,null);assert.equal(d.planEvents,null);
 assert.equal(canSharePlan(d),false);assert.equal(plannedCountdown(p,date,now),null);assert.equal(contextFor(p,date,now).valueMinutes,null);
 assert.equal(JSON.stringify(p),before);
});

test('short approved queue banner never promotes the queue event into address evidence',()=>{
 const {s}=setup(),p=profile(s),c=contextFor(p,date,now);
 assert.equal(c.kind,null);assert.equal(c.notice.title,'Аварійне відключення');assert.equal(c.notice.reference,true);
 assert.equal(c.notice.text,'Спеціалісти працюють над відновленням.');assert.equal(c.notice.stale,false);
});

test('confirmed exact address emergency overrides reference and an unknown end never becomes old plan end',()=>{
 const {s,line}=setup(),start=now-11*60000;
 line.categories.emergency.days[0].intervals=[{start,end:null}];
 const p=profile(s),before=JSON.stringify(p),d=scheduleFor(p,date,now);
 assert.equal(d.at((start-d.from)/60000+1),'emergency');assert.equal(d.at((now-d.from)/60000+15),'unknown');
 assert.equal(d.out,11);assert.equal(contextFor(p,date,now).valueMinutes,null);assert.equal(canSharePlan(d),false);
 assert.equal(contextFor(p,date,now).notice.title,'Аварійне відключення');
 assert.equal(JSON.stringify(p),before);
});

test('active address emergency banner exists independently of queue suspension',()=>{
 const {s,line}=setup(),day=line.categories.hourly.days[0];
 day.state='unknown';day.applicability.state='unconfirmed';day.publication.state='not_published';day.publication.intervals=[];
 line.categories.emergency.days[0].intervals=[{start:now-60000,end:null}];
 const p=profile(s),c=contextFor(p,date,now);
 assert.equal(c.notice.title,'Аварійне відключення');assert.equal(c.notice.text,'Спеціалісти працюють над відновленням.');assert.equal(c.notice.reference,false);
 assert.equal(scheduleFor(p,date,now).referenceOverlay,null);
 line.categories.emergency.days[0].intervals[0].end=now+60000;
 assert.equal(contextFor(profile(s),date,now).notice.text,'Спеціалісти працюють над відновленням.');
});

test('saved suspension remains an explicitly saved reference; bad, unsupported or future-clock sources get no layer',()=>{
 const {s}=setup();s.freshUntil=now-1;
 const p=profile(s),d=scheduleFor(p,date,now),c=contextFor(p,date,now);
 assert.ok(d.referenceOverlay);assert.equal(d.referenceOverlay.stale,true);assert.equal(c.notice.title,'Збережений графік');
 assert.notEqual(c.label,'Аварійний режим у черзі');assert.equal(d.out,0);
 for(const edit of [x=>x.resolution.complete=false,x=>x.supportState='disabled',x=>x.checkedAt=now+3600000,x=>x.lines[0].categories.hourly.days[0].publication.intervals[0].end=null]){
  const x=structuredClone(s);edit(x);assert.equal(scheduleFor(profile(x),date,now).referenceOverlay,null);
 }
});

test('restored official plan removes reference layer and suspension banner',()=>{
 const {s,line}=setup(),day=line.categories.hourly.days[0];day.state='published';day.applicability={state:'reported',reason:'official_plan'};day.intervals=structuredClone(day.publication.intervals);
 const p=profile(s),d=scheduleFor(p,date,now);
 assert.equal(d.referenceOverlay,null);assert.equal(contextFor(p,date,now).notice,null);assert.ok(d.planSummary);
});

test('an empty or absent publication never draws a fictitious reference grid',()=>{
 const {s,line}=setup();line.categories.hourly.days[0].publication.intervals=[];
 assert.equal(scheduleFor(profile(s),date,now).referenceOverlay,null);
 line.categories.hourly.days[0].publication.state='not_published';
 assert.equal(scheduleFor(profile(s),date,now).referenceOverlay,null);assert.equal(contextFor(profile(s),date,now).notice,null);
});


test('emergency without a confirmed countdown describes restoration, not outage start',()=>{
 const {s,line}=setup();
 assert.equal(contextFor(profile(s),date,now).label,'Час відновлення уточнюється');
 line.categories.emergency.days[0].intervals=[{start:now-60000,end:null}];
 const c=contextFor(profile(s),date,now);assert.equal(c.label,'Час відновлення уточнюється');assert.equal(c.valueMinutes,null);
});


test('archived plan is a separate past-only display layer and cannot alter effective facts',()=>{
 const {s,line}=setup(),from=Date.parse(date+'T00:00:00+02:00');
 line.categories.hourly.days[0].historicalPlan={version:1,basis:'archived_official_plan',periods:[{start:from,end:from+3600000,intervals:[{start:from,end:from+1800000}]}]};
 const p=profile(s),before=JSON.stringify(p),d=scheduleFor(p,date,now);
 assert.equal(d.historicalOverlay.at(15),'hourly');assert.equal(d.historicalOverlay.at(45),null);assert.equal(d.historicalOverlay.at(75),undefined);
 assert.equal(d.at(15),'unknown');assert.equal(d.at(45),'unknown');assert.equal(d.out,0);assert.equal(d.clear,0);assert.equal(d.planSummary,null);assert.equal(canSharePlan(d),false);
 assert.equal(JSON.stringify(p),before);assert.equal(d.historicalOverlay.emergency,true);
 line.categories.hourly.days[0].applicability.reason='primary_hides_daily_schedule';assert.equal(scheduleFor(profile(s),date,now).historicalOverlay.emergency,false);
 line.categories.hourly.days[0].historicalPlan.periods[0].end=now+1;assert.equal(scheduleFor(profile(s),date,now).historicalOverlay,null);
});
