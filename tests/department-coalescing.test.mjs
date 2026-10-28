import test from 'node:test';
import assert from 'node:assert/strict';
import {Source} from '../server/source.js';
import {InflightDepartmentRequests} from '../server/inflight-department.js';
import {SharedCategories} from '../server/shared-categories.js';
import {sourceTime} from '../app/lib/time.js';

const now=Date.parse('2026-10-27T08:00:00Z');
const address=house=>({department:'18',cityId:'801',streetId:'100',city:'м. Тест',street:'вул. Тестова',house:String(house)});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const turn=()=>new Promise(r=>setImmediate(r));
const fixture=()=>({DATETIME:'09:50 27.10.2026',DISCONNECTIONS:[1,2,3,4].map(house=>({
 ADDRESS:`<strong>м. Тест</strong><br>вул. Тестова ${house}<br>`,
 DATE_START:`${String(house+10).padStart(2,'0')}:00 27.10.2026`,DATE_STOP:`${String(house+11).padStart(2,'0')}:00 27.10.2026`,
})),DISCONN_QUEUQ:[{QUEUE_INFO:'Графік погодинних відключень: 3 черга 2 підчерга'}]});

test('four concurrent exact department addresses share three HTTP requests without shared-response mutation or extra cache TTL',async()=>{
 const gate=deferred(),calls=[];
 const source=new Source(async url=>{calls.push(new URL(url));await gate.promise;return Response.json(fixture());});
 // Freezing the parsed shared root proves address filtering does not mutate it.
 const request=source.request.bind(source);
 source.request=async(...args)=>{const raw=await request(...args);Object.freeze(raw.DISCONNECTIONS);return Object.freeze(raw);};
 const pending=[1,2,3,4].map(h=>source.address(address(h),now));
 await turn();assert.equal(calls.length,3);assert.equal(source.departmentRequests.entries.size,3);
 gate.resolve();const values=await Promise.all(pending);
 for(let i=0;i<values.length;i++){
  const value=values[i];assert.deepEqual(value.failures,[]);assert.equal(value.queue,null);
  for(const category of ['planned','emergency','hourly']){
   assert.equal(value.categories[category].events.length,1);
   assert.equal(value.categories[category].events[0].start,sourceTime(`${i+11}:00 27.10.2026`));
   assert.equal(value.categories[category].sourceAt,sourceTime('09:50 27.10.2026'));
   assert.equal(value.categories[category].checkedAt,now);
  }
 }
 assert.equal(source.departmentRequests.entries.size,0);
 await source.address(address(1),now+60000);assert.equal(calls.length,6,'completed raw responses are not cached');
});

test('department coalescing does not combine or replace personal account requests',async()=>{
 const gate=deferred(),calls=[];
 const source=new Source(async url=>{const u=new URL(url);calls.push(u);await gate.promise;return Response.json(fixture());});
 const pending=Promise.all([
  source.address(address(1),now),source.address(address(2),now),
  source.address({...address(1),account:'11111111111'},now),source.address({...address(2),account:'22222222222'},now),
 ]);
 await turn();assert.equal(calls.length,9);
 assert.equal(calls.filter(u=>u.searchParams.get('op')==='disconn_by_dept').length,3);
 assert.equal(calls.filter(u=>u.searchParams.get('op')==='disconn_by_ls').length,6);
 assert.deepEqual([...new Set(calls.filter(u=>u.searchParams.get('op')==='disconn_by_ls').map(u=>u.searchParams.get('abon_ls')))].sort(),['11111111111','22222222222']);
 gate.resolve();const values=await pending;
 assert.equal(values[0].queue,null);assert.equal(values[1].queue,null);assert.equal(values[2].queue,'3.2');assert.equal(values[3].queue,'3.2');
});

test('one aborted consumer keeps other exact addresses and their shared transport alive',async()=>{
 const gate=deferred(),signals=[],a=new AbortController(),b=new AbortController();
 const source=new Source(async(url,{signal})=>{signals.push(signal);await gate.promise;signal.throwIfAborted();return Response.json(fixture());});
 const oldAt=now-3600000,previous={categories:{hourly:{checkedAt:oldAt,events:[]}}};
 const first=source.address(address(1),now,previous,{signal:a.signal});
 const second=source.address(address(2),now,{}, {signal:b.signal});
 await turn();assert.equal(signals.length,3);a.abort();
 const cancelled=await first;assert.equal(cancelled.failures.length,3);assert.equal(cancelled.categories.hourly.checkedAt,oldAt);
 assert.ok(signals.every(s=>!s.aborted));gate.resolve();
 const result=await second;assert.deepEqual(result.failures,[]);assert.equal(result.categories.hourly.events[0].start,sourceTime('12:00 27.10.2026'));
 assert.equal(source.departmentRequests.entries.size,0);
});

test('all consumers abort upstream work and a subsequent attempt gets a new operation',async()=>{
 const a=new AbortController(),b=new AbortController(),signals=[];let calls=0,recover=false;
 const source=new Source(async(url,{signal})=>{
  calls++;signals.push(signal);if(recover)return Response.json(fixture());
  return new Promise((resolve,reject)=>{
   if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  });
 });
 const first=source.address(address(1),now,{}, {signal:a.signal}),second=source.address(address(2),now,{}, {signal:b.signal});
 await turn();assert.equal(calls,3);a.abort();b.abort();
 const results=await Promise.all([first,second]);assert.ok(results.every(v=>v.failures.length===3));assert.ok(signals.every(s=>s.aborted));
 assert.equal(source.departmentRequests.entries.size,0);recover=true;
 assert.deepEqual((await source.address(address(1),now)).failures,[]);assert.equal(calls,6);
});

test('shared department errors stay failures for every address and are evicted without an automatic retry',async()=>{
 for(const [kind,code] of [[403,'forbidden'],[429,'rate_limited'],['invalid-json','invalid_response'],['invalid-root','invalid_response']]){
  let calls=0;
  const source=new Source(async()=>{
   calls++;
   if(typeof kind==='number')return new Response('',{status:kind});
   return kind==='invalid-json'?new Response('{broken'):Response.json({DISCONNECTIONS:'not-rows'});
  });
  const results=await Promise.all([1,2,3,4].map(h=>source.address(address(h),now)));
  assert.equal(calls,3);assert.equal(source.departmentRequests.entries.size,0);
  for(const value of results){assert.equal(value.failures.length,3);assert.ok(Object.values(value.errors).every(c=>c===code));}
 }
});

test('department keys retain category, department and date boundaries and never share across Source instances',async()=>{
 const gate=deferred();let calls=0;
 const fetcher=async()=>{calls++;await gate.promise;return Response.json(fixture());};
 const first=new Source(fetcher),second=new Source(fetcher);
 const pending=Promise.all([
  first.address(address(1),now),first.address({...address(2),department:'19'},now),
  first.address(address(3),now+86400000),second.address(address(4),now),
 ]);
 await turn();assert.equal(calls,12);assert.equal(first.departmentRequests.entries.size,3);
 gate.resolve();await pending;assert.equal(first.departmentRequests.entries.size,0);assert.equal(second.departmentRequests.entries.size,0);
});

test('the in-flight map is bounded and already aborted callers do not start HTTP work',async()=>{
 const shared=new InflightDepartmentRequests({maxEntries:1}),gate=deferred();let calls=0;
 const load=async()=>{calls++;await gate.promise;return {safe:true};};
 const first=shared.load('one',load),joined=shared.load('one',load),other=shared.load('two',load);
 await turn();assert.equal(shared.entries.size,1);assert.equal(calls,2);
 const abort=new AbortController();abort.abort();await assert.rejects(()=>shared.load('three',load,abort.signal),e=>e.name==='AbortError');assert.equal(calls,2);
 gate.resolve();await Promise.all([first,joined,other]);assert.equal(shared.entries.size,0);
});

test('the existing response-size ceiling applies to a coalesced request for every consumer',async()=>{
 let calls=0;
 const source=new Source(async()=>{calls++;return new Response('x'.repeat(8_000_001));});
 const values=await Promise.all([source.address(address(1),now),source.address(address(2),now)]);
 assert.equal(calls,3);assert.ok(values.every(v=>v.failures.length===3));assert.equal(source.departmentRequests.entries.size,0);
});

test('cancelling the last caller before the shared loader starts avoids abandoned HTTP work',async()=>{
 const shared=new InflightDepartmentRequests(),controller=new AbortController();let calls=0;
 const pending=shared.load('department',async()=>{calls++;return {};},controller.signal);
 controller.abort();await assert.rejects(()=>pending,e=>e.name==='AbortError');await turn();
 assert.equal(calls,0);assert.equal(shared.entries.size,0);
});

test('exact-address category caches keep separate sanitized results while department HTTP stays shared',async()=>{
 const gate=deferred(),claimed=deferred(),cached=[];let calls=0,claims=0;
 const db={sourceClaim:async key=>{if(++claims===12)claimed.resolve();return {state:'owner',token:key};},
  sourceFinish:async(key,token,value)=>{cached.push({key,value});return true;}};
 const source=new Source(async()=>{calls++;await gate.promise;return Response.json({...fixture(),NAME:'private-fixture-name',LS:'12345678901'});},
  {categories:new SharedCategories(db,'fixture-secret')});
 const pending=[1,2,3,4].map(h=>source.address(address(h),now));
 await claimed.promise;await turn();assert.equal(calls,3);gate.resolve();
 const results=await Promise.all(pending);assert.ok(results.every(v=>!v.failures.length));
 assert.equal(cached.length,12);assert.equal(new Set(cached.map(x=>x.key)).size,12);
 assert.ok(cached.every(x=>x.value.events.length===1));
 const raw=JSON.stringify(cached);assert.ok(!raw.includes('private-fixture-name')&&!raw.includes('12345678901'));
 assert.equal(source.departmentRequests.entries.size,0);
});
