import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {universalEnvelope} from '../app/lib/universal-contract.js';
import {civil,addDays} from '../app/lib/time.js';
const source=(await readFile(new URL('../pwa/live-model.js',import.meta.url),'utf8')).replaceAll("'./core/",`'${new URL('../app/',import.meta.url).href}`);
const {scheduleFor,publishedReference,plannedCountdown,refreshDeadline,profileView,planView,canSharePlan,planClock}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const raw=JSON.parse(await readFile(new URL('fixtures/kyiv-publication/deg25-applies-control.json',import.meta.url),'utf8'));
const now=raw.checkedAt,date='2026-11-04',p=s=>({snapshot:universalEnvelope(s,s.lines[0].id)});
test('published plan totals agree with painted half-hours while actual certainty remains unknown',()=>{
 const profile=p(raw),d=scheduleFor(profile,date,now);
 let off=0;for(let minute=15;minute<d.total;minute+=30)if(d.at(minute,true))off+=30;
 assert.deepEqual(d.planSummary,{on:d.total-off,off});assert.ok(off>0&&off<d.total);
 assert.equal(d.raw.known,false);assert.ok(d.unknown>0);assert.ok(plannedCountdown(profile,date,now));
});
test('saved published plan remains readable with plan totals but expired evidence never starts a timer',()=>{
 const s=structuredClone(raw);s.freshUntil=now-1;s.fault={code:'forbidden'};s.refreshAfter=now+300000;
 const profile=p(s),d=scheduleFor(profile,date,now);
 assert.equal(d.referenceStale,true);assert.ok(d.planSummary.off>0);assert.equal(d.publication,'published');
 assert.equal(d.raw.known,false);assert.equal(plannedCountdown(profile,date,now),null);assert.notEqual(publishedReference(profile,date,now)?.available,true);
 assert.equal(refreshDeadline(profile,now),now+300000,'a cooldown beats expired freshness');
 const expired=scheduleFor(profile,date,now+8*86400000);assert.equal(expired.referenceAvailable,false);
});
test('an existing power line does not publish empty past or future days',()=>{
 for(const date of ['2026-11-03','2026-11-05']){
  const s=structuredClone(raw);s.coverage.fromDate='2026-11-03';s.coverage.toDate='2026-11-05';
  for(const c of Object.values(s.lines[0].categories))c.days=[{date,state:'unknown',intervals:[]}];
  const d=scheduleFor(p(s),date,now);assert.equal(d.publication,'unknown');assert.equal(d.planSummary,null);
 }
 const s=structuredClone(raw);const day=s.lines[0].categories.hourly.days.find(x=>x.date==='2026-11-05');
 assert.equal(day.publication.state,'not_published');assert.equal(scheduleFor(p(s),'2026-11-05',now).publication,'unpublished');
});
test('sharing uses the published plan shown by cards, not unknown effective coverage',()=>{
 const d=scheduleFor(p(raw),date,now),before=JSON.stringify(d),view=planView(d);
 assert.ok(d.unknown>0);assert.ok(canSharePlan(d));assert.equal(view.unknown,0);
 assert.equal(view.out,d.planSummary.off);assert.equal(view.clear,d.planSummary.on);
 const intervals=raw.lines[0].categories.hourly.days.find(x=>x.date===date).publication.intervals;
 assert.deepEqual(view.events.map(e=>[e.start,e.end]),intervals.map(e=>[(e.start-d.from)/60000,(e.end-d.from)/60000]));
 assert.equal(JSON.stringify(d),before);assert.equal(d.raw.known,false);
});
test('saved displayed plan can be shared without making its timer fresh',()=>{
 const s=structuredClone(raw);s.freshUntil=now-1;
 const d=scheduleFor(p(s),date,now);
 assert.equal(d.referenceStale,true);assert.ok(canSharePlan(d));assert.ok(planView(d).events.length);
 assert.equal(plannedCountdown(p(s),date,now),null);
});
test('empty, zero-outage, expired and unavailable plans offer no share button',()=>{
 const zero=structuredClone(raw);zero.lines[0].categories.hourly.days.find(x=>x.date===date).publication.intervals=[];
 assert.equal(canSharePlan(scheduleFor(p(zero),date,now)),false);
 assert.equal(canSharePlan(scheduleFor(p(raw),'2026-11-05',now)),false);
 assert.equal(canSharePlan(scheduleFor(p(raw),date,now+8*86400000)),false);
 assert.equal(canSharePlan({publication:'unknown',unknown:1440,out:0}),false);
});
test('share clocks use Kyiv wall time on 23/25-hour days and finish at 24:00',()=>{
 for(const date of ['2026-03-29','2026-10-25']){
  const from=civil(date),until=civil(addDays(date,1)),d={from,total:(until-from)/60000};
  assert.equal(planClock(d,(civil(date,12*60)-from)/60000),'12:00');
  assert.equal(planClock(d,d.total),'24:00');
 }
});
test('legacy text and canonical record cities render identically for weather binding',()=>{
 assert.equal(profileView({address:{city:'м. Київ',street:'вул. Мрії',house:'15Б'}}).city,'м. Київ');
 assert.equal(profileView({address:{city:{label:'м. Київ'}}}).city,'м. Київ');
});
for(const [date,total] of [['2026-03-29',1380],['2026-10-25',1500]])test(`plan totals use the real ${total/60}-hour Kyiv day without changing exact source times`,()=>{
 const s=structuredClone(raw),from=civil(date),now=from+60000;
 s.coverage={fromDate:date,toDate:date};s.checkedAt=now;s.sourceUpdatedAt=now;s.freshUntil=now+3600000;
 for(const c of Object.values(s.lines[0].categories)){c.checkedAt=now;c.sourceUpdatedAt=now;c.freshUntil=now+3600000;c.days=[{date,state:'unknown',intervals:[]}];}
 s.lines[0].categories.hourly.days=[{date,state:'published',intervals:[{start:from+3600000,end:from+5400000}],publication:{state:'published',checkedAt:now,sourceUpdatedAt:now,freshUntil:now+3600000,intervals:[{start:from+3600000,end:from+5400000}]},applicability:{state:'reported'}}];
 const before=JSON.stringify(s),d=scheduleFor(p(s),date,now);
 assert.equal(d.total,total);assert.deepEqual(d.planSummary,{on:total-30,off:30});assert.equal(JSON.stringify(s),before);
 assert.equal(d.until,civil(addDays(date,1)));
});
