import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {normalizeLegacy} from '../vps/universal/normalize.js';
import {universalEnvelope} from '../app/lib/universal-contract.js';
import {civil,addDays} from '../app/lib/time.js';
import {Service} from '../server/service.js';
import {MemoryDatabase} from '../server/memory.js';
import {validateRequest} from '../vps/telemetry/validation.js';
// The browser source uses the same reviewed core modules copied by the build.
const text=(await readFile(new URL('../pwa/live-model.js',import.meta.url),'utf8')).replaceAll("'./core/",`'${new URL('../app/',import.meta.url).href}`);
const {scheduleFor,contextFor,utcIntervals}=await import('data:text/javascript;base64,'+Buffer.from(text).toString('base64'));
function fixture(date='2026-11-04',events=[]){const now=civil(date,720),legacy={queue:'3.2',categories:Object.fromEntries(['hourly','planned','emergency'].map(k=>[k,{events:events.filter(e=>e.category===k),checkedAt:now,sourceAt:now}])),checkedAt:now,feedCheckedAt:now,failures:[],feedFailed:false,plans:[{date,queue:'3.2',events:events.filter(e=>e.category==='hourly'),publishedAt:now-1000}],emergencies:[]};
 const value=normalizeLegacy({id:'address-a',operator_id:'ua-cherkasy'},legacy,{state:'resolved',complete:true,lines:[{id:'line-a',label:'Основна',groupCode:'3.2'}],provenance:{source:'controlled-test'}},{fromDate:date,toDate:date},now);
 return {now,profile:{id:'profile-a',snapshot:universalEnvelope(value,'line-a')}};
}
test('live adapter separates exact totals/countdown from display-only half hours',()=>{const date='2026-11-04',start=civil(date,721),end=civil(date,842),{profile,now}=fixture(date,[{category:'hourly',start,end}]),d=scheduleFor(profile,date,now);
 assert.equal(d.out,121);assert.equal(d.clear,1319);assert.equal(d.at(720,true),'hourly');assert.equal(d.at(720,false),null);assert.equal(contextFor(profile,date,now).valueMinutes,1);assert.equal(profile.snapshot.categories.hourly.events[0].start,start);
});
test('unplanned, planned and emergency precedence survive real adapter',()=>{const date='2026-11-04',{profile,now}=fixture(date,[{category:'hourly',start:civil(date,600),end:civil(date,900)},{category:'planned',unplanned:true,start:civil(date,720),end:civil(date,840)},{category:'emergency',start:civil(date,780),end:civil(date,810)}]);const d=scheduleFor(profile,date,now);
 assert.equal(d.at(750,true),'unplanned');assert.equal(d.at(795,true),'emergency');assert.equal(d.at(855,true),'hourly');assert.equal(d.out,300);
});
test('unknown, stale and unselected multiple-line snapshots never imply a clear day',()=>{const date='2026-11-04',{profile,now}=fixture(date);
 for(const mutate of [s=>s.freshUntil=0,s=>s.resolution.complete=false,s=>s.lines[0].categories.hourly.days[0].state='not_published']){const p=structuredClone(profile);mutate(p.snapshot.universal);assert.equal(scheduleFor(p,date,now).at(600),'unknown');}
 assert.equal(scheduleFor(null,date,now).at(600),'unknown');
});
test('real Kyiv DST days retain all half-hour epochs without changing source times',()=>{for(const [date,total] of [['2026-10-25',1500],['2026-03-29',1380],['2026-11-04',1440]]){const {profile,now}=fixture(date,[{category:'hourly',start:civil(date,720),end:civil(date,780)}]),d=scheduleFor(profile,date,now);assert.equal(d.total,total);assert.equal(d.out,60);assert.equal(d.from+d.total*60000,civil(addDays(date,1)));}});
test('history accepts declared ISO coverage only; a point or future range is not an interval',()=>{const from=Date.parse('2026-11-03T22:00Z'),end=from+86400000,asOf=from+3600000;
 const overview={overviewVersion:1,dayStartUtc:new Date(from).toISOString(),dayEndUtc:new Date(end).toISOString(),asOf:new Date(asOf).toISOString(),observation:{semantics:'explicit_coverage_only',points:[{at:new Date(from).toISOString(),powerState:'on'}],intervals:[]}};
 assert.deepEqual(utcIntervals(overview),[]);overview.observation.intervals=[{start:new Date(from).toISOString(),end:new Date(asOf).toISOString(),powerState:'off'},{start:new Date(asOf).toISOString(),end:new Date(end).toISOString(),powerState:'on'}];assert.deepEqual(utcIntervals(overview),[{start:from,end:asOf,state:'off'}]);
});
test('QR parser accepts only bounded structured real proofs and rejects demo, URLs and extras',async()=>{const window={};vm.runInNewContext(await readFile(new URL('../pwa/sensor-scanner.js',import.meta.url),'utf8'),{window});const parse=window.SvitloSensorScanner.parse;
 for(const [kind,prefix] of [['phone_owner','sp_'],['factory_owner','so_'],['viewer_invite','si_']]){const q={version:1,kind,sensorId:'11111111-1111-4111-8111-111111111111',proof:prefix+'a'.repeat(43)};assert.deepEqual(JSON.parse(parse(JSON.stringify(q))),q);assert.equal(parse(JSON.stringify({...q,endpoint:'https://evil.invalid'})),null);}
 for(const q of ['DEMO-OK','https://example.invalid',JSON.stringify({version:2}), 'x'.repeat(513)])assert.equal(parse(q),null);
});
test('server rename is owner scoped and preserves concurrent schedule and preferences',async()=>{const db=new MemoryDatabase(),service=new Service({db,source:{}}),id='11111111-1111-4111-8111-111111111111';db.p.set(id,{id,owner:'alice',address:{label:'Controlled fixture'},name:'Old',snapshot:{revision:'keep'},preferences:{lead:15}});
 await assert.rejects(()=>service.handle('bob',{action:'rename',id,name:'Other'}),e=>e.status===404);
 const r=await service.handle('alice',{action:'rename',id,name:' Нове ім’я '});assert.equal(r.profile.name,'Нове ім’я');assert.equal(r.profile.snapshot.revision,'keep');assert.equal(r.profile.preferences.lead,15);
});
test('VPS boundary allows split notification flags but rejects untrusted fields and oversized names',()=>{const id='11111111-1111-4111-8111-111111111111';validateRequest('/api',{action:'preferences',id,preferences:{publication:true,change:false}});validateRequest('/api',{action:'rename',id,name:"Дім О'Браєна"});assert.throws(()=>validateRequest('/api',{action:'rename',id,name:'a'.repeat(61)}));assert.throws(()=>validateRequest('/api',{action:'rename',id,name:'a',owner:'other'}));});
