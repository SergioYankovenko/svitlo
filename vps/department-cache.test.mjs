import test from 'node:test';import assert from 'node:assert/strict';
import {DepartmentSchedules} from './department-cache.js';import {Source} from '../server/source.js';
const at=Date.parse('2026-11-04T08:00:00Z'),secret='a'.repeat(64),base={n_date:'28.10.2026',k_date:'05.11.2026'};
const a=(house='1',city='м. Тест',street='вул. Тестова')=>({department:'18',city,street,cityId:'1',streetId:'2',house});
const raw=(address='<strong>м. Тест</strong><br>вул. Тестова 1, 2<br>')=>({DATETIME:'09:50 04.11.2026',DISCONNECTIONS:[{ADDRESS:address,DATE_START:'10:00 04.11.2026',DATE_STOP:'11:00 04.11.2026',DISCONN_TYPE:'Позапланові роботи',LS:'12345678901',NAME:'Must never persist'}],DISCONN_QUEUQ:[{QUEUE_INFO:'Графік погодинних відключень: 3 черга 2 підчерга'}]});
function setup(){let time=at,calls=0,stored;const state=new Map();const shared={load:async(scope,fn)=>{const k=JSON.stringify(scope),old=state.get(k);if(!old||old.checkedAt+300000<=time)state.set(k,await fn());stored=state.get(k);return structuredClone(stored);}};
 const bridge={query:async()=>({rows:[{city:'м. Тест',street:'вул. Тестова'},{city:'с. Тест',street:'вул. Тестова'},{city:'м. Тест',street:'прв. Тестовий'}]})};
 const make=()=>new DepartmentSchedules({secret,bridge,shared,now:()=>time});
 return {make,shared,bridge,time:v=>{time=v;},stored:()=>stored,calls:()=>calls,fetch:async()=>{calls++;return raw();}};
}
test('sequential addresses and separate API/worker instances share parsed schedules; timestamps are not renewed',async()=>{
 const x=setup(),one=x.make(),two=x.make();const first=await one.address(a(),'planned',base,at,x.fetch);x.time(at+1000);
 const second=await one.address(a('2'),'planned',base,at+1000,x.fetch);assert.equal(x.calls(),1);assert.equal(second.checkedAt,at);assert.equal(second.events[0].unplanned,true);first.events.length=0;assert.equal(second.events.length,1);
 const third=await two.address(a('2'),'planned',base,at+1000,x.fetch);assert.equal(third.events.length,1);assert.equal(x.calls(),1);
 const persisted=JSON.stringify(x.stored());for(const text of ['12345678901','Must never persist','<strong>','м. Тест','вул. Тестова'])assert.ok(!persisted.includes(text),text);
 assert.equal(first.queue,null);assert.equal(one.memo.size,1);
});
test('expired data is reloaded; no extending old source or checked timestamps',async()=>{
 const x=setup(),c=x.make();await c.address(a(),'hourly',base,at,x.fetch);x.time(at+300001);const value=await c.address(a(),'hourly',base,at+300001,x.fetch);assert.equal(x.calls(),2);assert.equal(value.checkedAt,at+300001);assert.equal(value.queue,null);assert.equal(value.queueStatus,'queue_missing');
});
test('city/village, street/provulok and house suffixes never collapse; uncovered streets use the old exact path',async()=>{
 const x=setup(),c=x.make();assert.equal((await c.address(a('1'),'planned',base,at,x.fetch)).events.length,1);
 for(const other of [a('1а'),a('1','с. Тест'),a('1','м. Тест','прв. Тестовий')])assert.equal((await c.address(other,'planned',base,at,x.fetch)).events.length,0);
 assert.equal(await c.address(a('1','м. Невідоме'),'planned',base,at,x.fetch),null);
});
test('ambiguous numeric ranges fail for the affected street without turning other streets into a failure',async()=>{
 const x=setup(),c=x.make(),fetcher=async()=>raw('<strong>м. Тест</strong><br>вул. Тестова 1-3<br>');
 await assert.rejects(()=>c.address(a(),'planned',base,at,fetcher),/Неоднозначний/);assert.equal((await c.address(a('1','м. Тест','прв. Тестовий'),'planned',base,at,fetcher)).events.length,0);
});
test('failure is not cached as a successful absence and cancellation does not corrupt a shared refresh',async()=>{
 const x=setup(),c=x.make();let fail=true;const fetcher=async()=>{if(fail)throw Error('upstream unavailable');return raw();};await assert.rejects(()=>c.address(a(),'planned',base,at,fetcher));fail=false;assert.equal((await c.address(a(),'planned',base,at,fetcher)).events.length,1);
 const abort=new AbortController();abort.abort();await assert.rejects(()=>c.address(a(),'planned',base,at,x.fetch,abort.signal));
});
test('personal account requests keep their independent source data and do not enter the branch cache',async()=>{
 const x=setup();let calls=0;const source=new Source(async()=>{calls++;return Response.json(raw());},{departmentSchedules:x.make()});
 const value=await source.address({...a(),account:'11111111111'},at);assert.equal(calls,3);assert.equal(value.queue,'3.2');assert.equal(x.stored(),undefined);
});
test('completed branch graphs serve later exact addresses without more upstream requests',async()=>{
 const x=setup();let calls=0;const source=new Source(async()=>{calls++;return Response.json(raw());},{departmentSchedules:x.make()});
 const first=await source.address(a(),at),second=await source.address(a('2'),at+60000);assert.deepEqual(first.failures,[]);assert.deepEqual(second.failures,[]);assert.equal(calls,3);assert.equal(second.categories.hourly.checkedAt,at);
});
