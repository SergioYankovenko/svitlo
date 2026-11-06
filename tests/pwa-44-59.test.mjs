import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {universalEnvelope} from '../app/lib/universal-contract.js';
import {retainPublishedDays} from '../app/lib/universal-history.js';
import {countdown} from '../app/lib/schedule.js';
import {civil} from '../app/lib/time.js';
import {UniversalService} from '../vps/universal/service.js';
const text=(await readFile(new URL('../pwa/live-model.js',import.meta.url),'utf8')).replaceAll("'./core/",`'${new URL('../app/',import.meta.url).href}`);
const {scheduleFor,contextFor,plannedCountdown,referenceCountdown,planView,summaryVisible}=await import('data:text/javascript;base64,'+Buffer.from(text).toString('base64'));
const fixture=JSON.parse(await readFile(new URL('fixtures/pwa-44-59/blocked-published-plan.json',import.meta.url),'utf8')),date='2026-11-06',now=fixture.now;
const profile=s=>({snapshot:universalEnvelope(s,'test-line')});
function partial(){const s=structuredClone(fixture.universal);s.resolution={state:'unknown',complete:false};s.checkedAt=now;s.freshUntil=now+120000;for(const c of Object.values(s.lines[0].categories)){c.checkedAt=now;c.freshUntil=now+120000;}const h=s.lines[0].categories.hourly.days[0];h.state='unknown';h.applicability={state:'unconfirmed',reason:'source_unavailable'};h.publication={state:'unknown',intervals:[],checkedAt:now,sourceUpdatedAt:null,freshUntil:now+120000};return s;}
test('observed403: displayed saved plan and header agree, without renewing source or backend reminders',()=>{
 const s=structuredClone(fixture.universal),before=JSON.stringify(s),p=profile(s),d=scheduleFor(p,date,now),c=contextFor(p,date,now),reference=referenceCountdown(p,date,now);
 assert.equal(d.referenceStale,true);assert.equal(d.publication,'published');assert.ok(reference.minutes>0);assert.equal(c.valueMinutes,reference.minutes);assert.equal(c.label,'До відновлення');assert.equal(reference.source,'saved_official_plan');
 assert.equal(reference.target,s.lines[0].categories.hourly.days[0].publication.intervals[0].end);
 assert.equal(plannedCountdown(p,date,now),null);assert.equal(countdown(p.snapshot,now).minutes,undefined);assert.equal(JSON.stringify(s),before);
});
test('partial line recheck retains display provenance of the exact previously confirmed plan',()=>{
 const next=partial(),before=JSON.stringify(next),s=retainPublishedDays(next,fixture.universal,date,now),d=scheduleFor(profile(s),date,now);
 assert.equal(s.resolution.complete,false);assert.equal(d.raw.known,false);assert.equal(d.referenceStale,true);assert.equal(d.at(0),null);assert.equal(d.at(5*60),'hourly');
 assert.equal(s.lines[0].categories.hourly.days[0].publication.state,'unknown');assert.deepEqual(s.lines[0].categories.hourly.days[0].savedPublication.intervals,fixture.universal.lines[0].categories.hourly.days[0].publication.intervals);
 assert.equal(s.lines[0].categories.hourly.days[0].savedPublication.checkedAt,fixture.universal.lines[0].categories.hourly.days[0].publication.checkedAt);
 assert.equal(contextFor(profile(s),date,now).label,'До відновлення');assert.equal(countdown(profile(s).snapshot,now).minutes,undefined);assert.equal(JSON.stringify(next),before);
 const forwarded=retainPublishedDays(partial(),s,date,now);assert.equal(scheduleFor(profile(forwarded),date,now).at(0),null);
});
test('source-cache range miss keeps the same profile plan as expired, including an omitted day',()=>{
 const empty=partial();empty.lines=[];empty.freshUntil=0;const restored=retainPublishedDays(empty,fixture.universal,date,now),d=scheduleFor(profile(restored),date,now);
 assert.equal(d.referenceStale,true);assert.equal(d.at(0),null);assert.equal(restored.checkedAt,fixture.universal.checkedAt);assert.equal(restored.freshUntil,0);assert.equal(countdown(profile(restored).snapshot,now).minutes,undefined);
 const missing=partial();missing.lines[0].categories.hourly.days=missing.lines[0].categories.hourly.days.filter(d=>d.date!==date);
 const result=retainPublishedDays(missing,fixture.universal,date,now);assert.equal(scheduleFor(profile(result),date,now).at(0),null);assert.deepEqual(result.lines[0].categories.hourly.days[0].intervals,[]);
});
test('server profile fallback keeps the explicit prior line and never sends restored-plan notices',async()=>{
 const prior=structuredClone(fixture.universal),second=structuredClone(prior.lines[0]);second.id='another-line';second.groupCode='2.2';prior.lines.push(second);
 const wire=partial();wire.lines=[];wire.freshUntil=0;const sent=[],db={commitProfile:async p=>({status:'updated',profile:p}),enqueue:async e=>sent.push(e)};
 const service=new UniversalService({db,source:{},now:()=>now},{snapshot:async()=>wire,range:()=>({})});
 const p={id:'p',owner:'o',address:{canonicalAddressId:prior.addressId,lineId:null},snapshot:universalEnvelope(prior,'test-line'),preferences:{publication:true,change:true,emergency:true},last_checked:now-1000,messages:[]};
 const result=await service.refresh(p);assert.equal(result.snapshot.selectedLineId,'test-line');assert.equal(result.snapshot.universal.supportState,'degraded');assert.equal(result.snapshot.universal.freshUntil,0);assert.equal(sent.length,0);assert.deepEqual(result.address,p.address);
});
test('no reference from another address, operator, line, group, day, old data or future clock',()=>{
 for(const edit of [s=>s.addressId='other',s=>s.operatorId='other',s=>s.lines[0].id='other',s=>s.lines[0].groupCode='2.2',s=>s.lines[0].categories.hourly.days[0].date='2026-11-05',s=>s.lines[0].categories.hourly.days[0].publication.checkedAt=now-8*86400000,s=>s.lines[0].categories.hourly.days[0].publication.checkedAt=now+600000]){
  const prior=structuredClone(fixture.universal);edit(prior);const s=retainPublishedDays(partial(),prior,date,now);assert.equal(s.lines[0].categories.hourly.days[0].savedPublication,undefined);
 }
 const next=partial();delete next.fault;next.supportState='available';assert.equal(retainPublishedDays(next,fixture.universal,date,now).lines[0].categories.hourly.days[0].savedPublication,undefined);
});
test('a partial daily table without a prior plan does not render a half-unknown grid or question totals',()=>{
 const s=partial(),p=profile(s),d=scheduleFor(p,date,now);assert.equal(d.publication,'unknown');assert.ok(d.events.length>0);assert.equal(d.at(0),'unknown');assert.equal(summaryVisible(d,{on:null,off:null}),false);assert.equal(summaryVisible(d,{on:15,off:30}),true);
});
test('suspension, conflict, open emergency and expired saved plan never get a reference countdown',()=>{
 for(const edit of [s=>{const h=s.lines[0].categories.hourly.days[0];h.state='suspended';h.applicability={state:'suspended',reason:'reported_emergency_without_primary_plan'};},s=>s.lines[0].categories.hourly.days[0].applicability.state='conflict',s=>s.lines[0].categories.emergency.days[0].intervals=[{start:now-60000,end:null}],s=>s.lines[0].categories.hourly.days[0].publication.checkedAt=now-8*86400000]){
  const s=structuredClone(fixture.universal);edit(s);assert.equal(referenceCountdown(profile(s),date,now),null);assert.equal(contextFor(profile(s),date,now).valueMinutes,null);
 }
});
test('successful refresh restores a regular countdown and empty full plan has a clear header',()=>{
 const s=structuredClone(fixture.universal);s.supportState='available';delete s.fault;s.checkedAt=now;s.freshUntil=now+120000;for(const c of Object.values(s.lines[0].categories)){c.checkedAt=now;c.freshUntil=now+120000;}const h=s.lines[0].categories.hourly.days[0];h.publication.checkedAt=now;h.publication.freshUntil=now+120000;
 assert.equal(scheduleFor(profile(s),date,now).referenceStale,false);assert.equal(contextFor(profile(s),date,now).label,'До відновлення');h.intervals=[];h.publication.intervals=[];
 assert.equal(contextFor(profile(s),date,now).label,'Не заплановано');assert.equal(contextFor(profile(s),date,now).valueMinutes,null);assert.equal(planView(scheduleFor(profile(s),date,now)).unknown,0);
 assert.equal(referenceCountdown(profile(s),'2026-11-05',now),null);
});

test('saved plan before an outage uses the approved short header',()=>{const s=structuredClone(fixture.universal),at=s.lines[0].categories.hourly.days[0].publication.intervals[0].start-60000;assert.equal(referenceCountdown(profile(s),date,at).label,'До відключення');assert.equal(referenceCountdown(profile(s),date,at).source,'saved_official_plan');});
