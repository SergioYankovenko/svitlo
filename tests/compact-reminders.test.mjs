import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {countdown} from '../app/lib/schedule.js';
import {dayKey,addDays,civil} from '../app/lib/time.js';
import {Database} from '../server/database.js';
import {MemoryDatabase} from '../server/memory.js';
import {Service} from '../server/service.js';
const owner='11111111-1111-4111-8111-111111111111';
const migration='20261026210001_compact_reminder_profiles.sql';
async function database(){
 const db=new PGlite();
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);');
 for(const name of ['20261023225141_svitlo_pwa.sql',migration])await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 await db.query('insert into auth.users values($1)',[owner]);return db;
}
const insert=(db,snapshot,now,prefs={},id=randomUUID())=>db.query('insert into public.svitlo_profiles(id,owner,address,name,preferences,snapshot,messages,last_checked) values($1,$2,$3,$4,$5,$6,$7,$8)',[id,owner,{account:'not-for-reminders'},'not-for-reminders',prefs,snapshot,[{body:'not-for-reminders'}],now]).then(()=>id);
function snapshot(now){
 const today=dayKey(now);
 const plans=Array.from({length:7},(_,d)=>Array.from({length:12},(_,q)=>({date:addDays(today,d-3),queue:Math.floor(q/2)+1+'.'+(q%2+1),publishedAt:now-1000,checkedAt:now,events:[{category:'hourly',start:civil(addDays(today,d-3))+23*3600000,end:civil(addDays(today,d-2))}]}))).flat();
 return {queue:'3.2',plans,feedCheckedAt:now,feedFailed:false,failures:[],emergencies:[],categories:Object.fromEntries(['hourly','planned','emergency'].map(k=>[k,{sourceAt:now,checkedAt:now,events:[]}]))};
}
test('SQL projection preserves countdown and reminders across dates, failures, emergencies and preference modes',async()=>{
 const db=await database();let comparisons=0;
 try{
  for(const now of [Date.parse('2026-10-26T20:55:00Z'),Date.parse('2026-10-24T21:55:00Z'),Date.parse('2026-10-25T21:55:00Z')]){
   const original=snapshot(now);
   const cases=[original,{...original,feedFailed:true},{...original,failures:['emergency']},{...original,queue:null},
    {...original,feedCheckedAt:now-10800000},{...original,plans:original.plans.map(p=>({...p,uncertain:true}))},
    {...original,categories:{...original.categories,emergency:{sourceAt:now,checkedAt:now,events:[{category:'emergency',start:now-60000,end:null}]}}},
    {...original,emergencies:[{queues:['3.2'],effectiveAt:now-10000,publishedAt:now-10000,validity:'suspended',ended:false}]}];
   for(const full of cases){
    for(const prefs of [{},{reminder:false,restoration:true},{reminder:true,restoration:false},{reminder:false,restoration:false}]){
     await db.exec('delete from public.svitlo_profiles');
     await insert(db,full,now,prefs);
     const {rows}=await db.query('select * from public.svitlo_reminder_profiles($1,100,null)',[now]);
     if(prefs.reminder===false&&prefs.restoration===false){assert.equal(rows.length,0);continue;}
     assert.equal(rows.length,1);const compact=rows[0];
     assert.deepEqual(Object.keys(compact).sort(),['id','owner','preferences','snapshot']);
     assert.deepEqual(countdown(compact.snapshot,now),countdown(structuredClone(full),now));
     assert.ok(compact.snapshot.plans.every(p=>p.queue==='3.2'&&[dayKey(now),addDays(dayKey(now),1)].includes(p.date)));
     const before=[],after=[];
     await new Service({db:{enqueue:async e=>before.push(e)},now:()=>now}).reminders({...compact,snapshot:structuredClone(full)});
     await new Service({db:{enqueue:async e=>after.push(e)},now:()=>now}).reminders(compact);
     assert.deepEqual(after,before);comparisons++;
    }
   }
  }
  assert.equal(comparisons,72);
 }finally{await db.close();}
});
test('SQL cursor, batch cap, freshness boundary and service-only access remain enforced',async()=>{
 const db=await database(),now=Date.parse('2026-10-26T20:55:00Z');
 try{
  for(let i=0;i<105;i++)await insert(db,{},now);
  await insert(db,{},now-7200000);await insert(db,{},now,{reminder:false,restoration:false});
  const a=(await db.query('select * from public.svitlo_reminder_profiles($1,1000,null)',[now])).rows;assert.equal(a.length,100);
  const b=(await db.query('select * from public.svitlo_reminder_profiles($1,100,$2)',[now,a.at(-1).id])).rows;assert.equal(b.length,5);
  assert.equal(new Set([...a,...b].map(p=>p.id)).size,105);
  for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(()=>db.query('select * from public.svitlo_reminder_profiles($1,100,null)',[now]),/permission denied/);await db.exec('reset role');}
  await db.exec('set role service_role');assert.equal((await db.query('select * from public.svitlo_reminder_profiles($1,1,null)',[now])).rows.length,1);
 }finally{await db.close();}
});
test('disabled reminders skip countdown work; defaults and single enabled channels still participate',async()=>{
 const db=new MemoryDatabase(),now=10000000;
 for(const [id,prefs] of [['a',{}],['b',{reminder:false,restoration:false}],['c',{reminder:false}],['d',{restoration:false}]])await db.saveProfile({id,preferences:prefs,last_checked:now});
 assert.deepEqual((await db.reminderProfiles(now,100)).map(p=>p.id),['a','c','d']);
 assert.deepEqual((await db.reminderProfiles(now,100,0,'a')).map(p=>p.id),['c','d']);
 await new Service({db}).reminders({preferences:{reminder:false,restoration:false},get snapshot(){throw Error('unnecessary countdown');}});
});
test('database adapter uses compact RPC and propagates storage failure',async()=>{
 const calls=[],db=new Database({rpc:(name,args)=>{calls.push([name,args]);return Promise.resolve({data:[{id:'x'}],error:null});}});
 assert.deepEqual(await db.reminderProfiles(123,100,0,null),[{id:'x'}]);assert.deepEqual(calls,[['svitlo_reminder_profiles',{now_ms:123,batch_size:100,after_id:null}]]);
 await assert.rejects(()=>new Database({rpc:()=>({data:null,error:{message:'offline'}})}).reminderProfiles(123,100));
});

