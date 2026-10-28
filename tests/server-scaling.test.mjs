import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {scalingDatabase} from './helpers/scaling-db.mjs';
import {reminderWork} from '../server/scaled-jobs.js';
import {SharedCategories} from '../server/shared-categories.js';
import {Source} from '../server/source.js';
import {countdown} from '../app/lib/schedule.js';
import {runScaledJobs} from '../server/scaled-jobs.js';
import {civil,dayKey} from '../app/lib/time.js';
const owner=randomUUID(),now=Date.parse('2026-10-26T19:00:00Z');
const create=async(s,house='1',subject=owner)=>{await s.sql.query('insert into auth.users values($1) on conflict do nothing',[subject]);return (await s.db.createProfile({owner:subject,id:randomUUID(),address:{department:'18',cityId:'801',streetId:'100',house},name:'',preferences:{}})).profile;};
const subscribe=(s,p,id='s')=>s.sql.query('insert into public.svitlo_subscriptions(id,owner,profile_id,subscription) values($1,$2,$3,\'{}\')',[id,p.owner,p.id]);
const snap=(t=now)=>({queue:'3.2',plans:['1.1','3.2'].flatMap(queue=>[-1,0,1].map(d=>({queue,date:dayKey(t+d*86400000),publishedAt:t-1000,checkedAt:t,events:[{category:'hourly',start:t+20*60000,end:t+80*60000}]}))),
 feedCheckedAt:t,feedFailed:false,failures:[],emergencies:[],categories:Object.fromEntries(['planned','emergency','hourly'].map(k=>[k,{events:[],sourceAt:t,checkedAt:t}]))});
const commit=async(s,p,snapshot=snap())=>s.db.commitProfile({...p,snapshot,messages:[],last_checked:now,next_check:now+3600000},p.snapshot_revision||0);

test('scaling SQL selects only subscribed eligible profiles; global/specific scope and last unsubscribe work',async()=>{
 const s=await scalingDatabase();try{
  const a=await create(s),b=await create(s,'2');await s.sql.query('update public.svitlo_profiles set lease_until=0,last_checked=$1,next_check=0',[Date.now()]);
  assert.equal((await s.db.due(Date.now(),4)).length,0);
  await subscribe(s,a);assert.deepEqual((await s.db.due(Date.now(),4)).map(x=>x.id),[a.id]);
  await s.sql.query('update public.svitlo_subscriptions set profile_id=null where id=\'s\'');await s.sql.exec('update public.svitlo_profiles set lease_until=0');
  assert.equal((await s.db.due(Date.now(),4)).length,2);
  await s.sql.query('update public.svitlo_profiles set preferences=$1 where id=$2',[{schedule:false,emergency:false,reminder:false,restoration:false},a.id]);
  assert.equal((await s.db.profile(owner,a.id)).push_enabled,false);
  await s.sql.exec('delete from public.svitlo_subscriptions');assert.equal((await s.db.reminderClaim(Date.now(),300)).length,0);
  assert.equal((await s.db.profiles(owner)).length,2);assert.equal(await s.db.profile(randomUUID(),b.id),null);
 }finally{await s.sql.close();}
});

test('normalized storage shares own-queue plans and hydrates the legacy contract including history and timestamps',async()=>{
 const s=await scalingDatabase();try{
  const a=await create(s),b=await create(s,'2'),snapshot=snap();
  const one=await commit(s,a,snapshot),two=await commit(s,b,snapshot);
  assert.equal(one.status,'updated');assert.equal(two.profile.snapshot.plans.length,3);
  assert.ok(one.profile.snapshot.plans.every(x=>x.queue==='3.2'));
  assert.equal((await s.sql.query('select count(*)::int as n from public.svitlo_shared_plans')).rows[0].n,1);
  const stored=(await s.sql.query('select snapshot from public.svitlo_profiles where id=$1',[a.id])).rows[0].snapshot;
  assert.deepEqual(stored.plans,[]);assert.ok(stored._plansRef);assert.equal(one.profile.snapshot._plansRef,undefined);
  assert.deepEqual((await s.db.profile(owner,a.id)).snapshot,one.profile.snapshot);
  const failed={...snapshot,queue:null,feedFailed:true,feedCheckedAt:now-7200000};
  const p=await s.db.profile(owner,a.id);const result=await commit(s,p,failed);
  assert.deepEqual(result.profile.snapshot.plans,[]);assert.equal(result.profile.snapshot.feedCheckedAt,failed.feedCheckedAt);
  assert.equal((await s.db.commitProfile({...p,snapshot,messages:[],last_checked:now,next_check:now},0)).status,'conflict');
  await s.sql.query('delete from public.svitlo_profiles where id=$1',[a.id]);assert.equal((await commit(s,p)).status,'missing');
 }finally{await s.sql.close();}
});

test('indexed reminders expire at the event and revisions/preferences/feed changes invalidate old workers and queued pushes',async()=>{
 const s=await scalingDatabase();try{
  let p=await create(s);await subscribe(s,p);p=(await commit(s,p)).profile;
  const claimed=(await s.db.reminderClaim(Date.now(),300))[0];assert.ok(claimed);
  const item=reminderWork(claimed,now);assert.ok(item.event);assert.equal(item.event.expires_at,now+20*60000);
  assert.equal(await s.db.reminderFinish([item]),1);
  const deliveries=await s.db.deliveryBatch(now,16);assert.equal(deliveries.length,1);
  assert.equal((await s.db.deliveryActive(deliveries,now)).length,1);
  await s.sql.query('update public.svitlo_profiles set preferences=\'{"reminder":false}\' where id=$1',[p.id]);
  assert.equal((await s.db.deliveryActive(deliveries,now)).length,0);
  assert.equal(await s.db.reminderFinish([item]),0);
  const next=(await s.db.reminderClaim(Date.now(),300))[0];assert.ok(next);
  await s.sql.query('insert into public.svitlo_cache values(\'feed\',$1)',[{plans:snap().plans,emergencies:[]}]);
  assert.equal(await s.db.reminderFinish([reminderWork(next,now)]),0);
  assert.equal((await s.db.reminderClaim(Date.now(),300)).length,0);
  p=await s.db.profile(owner,p.id);await commit(s,p);
  assert.equal((await s.db.reminderClaim(Date.now(),300)).length,1);
  await s.sql.exec('delete from public.svitlo_subscriptions');assert.equal((await s.db.deliveryBatch(now,16)).length,0);
 }finally{await s.sql.close();}
});

test('batch delivery leases recover without accepting stale acknowledgements and private RPCs deny client roles',async()=>{
 const s=await scalingDatabase();try{
  const p=await create(s);await subscribe(s,p);
  for(let i=0;i<20;i++)await s.db.enqueue({owner,profile_id:p.id,event_key:'e'+i,title:'t',body:'b',date:'2026-10-26',expires_at:now+3600000,channel:'schedule'});
  const batch=await s.db.deliveryBatch(now,500);assert.equal(batch.length,16);assert.equal((await s.db.deliveryBatch(now,16)).length,4);
  const again=await s.db.deliveryBatch(now+56000,16);assert.equal(again.length,16);
  assert.equal(await s.db.deliveryFinishBatch(batch.map(x=>({id:x.id,token:x.lease_token,delivered:true,retry_at:0}))),0);
  assert.equal(await s.db.deliveryFinishBatch(again.map(x=>({id:x.id,token:x.lease_token,delivered:null,retry_at:now+56001}))),16);
  assert.equal((await s.sql.query('select attempts from public.svitlo_deliveries where id=$1',[again[0].id])).rows[0].attempts,1);
  for(const role of ['anon','authenticated']){
   await s.sql.exec('set role '+role);
   for(const q of ['select public.svitlo_profiles_read(null)','select public.svitlo_reminder_claim(1,300)','select public.svitlo_delivery_batch(1,16)',"select public.svitlo_source_claim('k',1)",'select * from public.svitlo_shared_plans','select * from public.svitlo_source_cache'])await assert.rejects(()=>s.sql.query(q),/permission denied/);
   await s.sql.exec('reset role');
  }
 }finally{await s.sql.close();}
});

test('category cache coalesces cross-worker requests, keeps timestamps, separates accounts and never stores provider identities',async()=>{
 const s=await scalingDatabase();try{
  let loads=0;const a=new SharedCategories(s.db,'test-secret'),b=new SharedCategories(s.db,'test-secret');
  const fixture={DISCONNECTIONS:[],DISCONN_QUEUQ:[],DATETIME:'21:00 26.10.2026',NAME:'private-name',LS:'12345678901'};
  const fetcher=async()=>{loads++;await new Promise(r=>setTimeout(r,5));return Response.json(fixture);};
  const first=new Source(fetcher,{categories:a}),second=new Source(fetcher,{categories:b});
  const results=await Promise.all([first.address({account:'12345678901'},now),second.address({account:'12345678901'},now)]);
  assert.equal(loads,3);assert.equal(results[0].failures.length,0);
  const reused=await second.address({account:'12345678901'},now+60000);assert.equal(loads,3);assert.equal(reused.categories.hourly.checkedAt,now);
  await second.address({account:'99999999999'},now);assert.equal(loads,6);
  const raw=JSON.stringify((await s.sql.query('select * from public.svitlo_source_cache')).rows);
  assert.ok(!raw.includes('private-name')&&!raw.includes('12345678901')&&!raw.includes('99999999999'));
  await s.sql.exec('update public.svitlo_source_cache set expires_at=0');
  const failed=new Source(async()=>new Response('',{status:503}),{categories:a});
  const result=await failed.address({account:'12345678901'},now+60000,reused);assert.equal(result.failures.length,3);
  assert.equal(result.categories.hourly.checkedAt,now);
 }finally{await s.sql.close();}
});

test('reminder scheduling agrees with the unchanged client on DST, uncertainty and restoration preferences',()=>{
 for(const date of ['2026-10-25','2026-10-26','2027-03-28']){
  const t=civil(date)+2*3600000;
  for(const change of [{},{feedFailed:true},{queue:null},{failures:['hourly']},{feedCheckedAt:t-10800000}]){
   const snapshot={...snap(t),...change},timer=countdown(snapshot,t);
   const work=reminderWork({id:'p',snapshot,preferences:{}},t);
   assert.equal(!!work.event,timer.minutes!==undefined&&timer.minutes>0&&timer.minutes<=30);
   if(work.event)assert.equal(work.event.expires_at,timer.target);
  }
 }
});

test('scaled jobs batch retries honor 429/5xx, remove 404/410, and release unstarted work after budget exhaustion',async()=>{
 let t=now,claimed=false,finished=[],removed=[],calls=0,jobReleased=false;
 const items=[429,503,404,410,200].map((status,i)=>({id:i,lease_token:'t'+i,subscription_id:'s'+i,subscription:{status},expires_at:now+3600000,attempts:1}));
 const db={jobsClaim:async()=>({granted:true,token:'j'}),jobsFinish:async()=>{jobReleased=true;},due:async()=>[],
  reminderClaim:async()=>[],reminderFinish:async()=>0,deliveryBatch:async()=>claimed?[]:(claimed=true,items),
  deliveryActive:async wave=>wave.map(x=>x.id),deliveryFinishBatch:async x=>finished.push(...x),removeSubscription:async id=>removed.push(id),cleanup:async()=>{}};
 const result=await runScaledJobs({db,now:()=>t,jobBudgetMs:45000,push:async s=>{
  calls++;if(calls===4)t+=40000;
  if(s.status!==200)throw {statusCode:s.status,headers:{'retry-after':'120'}};
 }});
 assert.equal(result.failedDeliveries,2);assert.equal(result.expiredSubscriptions,2);assert.equal(calls,4);
 assert.deepEqual(removed.sort(),['s2','s3']);assert.ok(jobReleased);assert.equal(result.budgetExhausted,true);
 assert.equal(finished.find(x=>x.id===0).retry_at>=now+120000,true);
 assert.equal(finished.find(x=>x.id===4).delivered,null);
});

test('same reminder target can be renewed after cancellation but already sent events remain deduplicated',async()=>{
 const s=await scalingDatabase();try{
  let p=await create(s);await subscribe(s,p);p=(await commit(s,p)).profile;
  let claim=(await s.db.reminderClaim(Date.now(),300))[0];await s.db.reminderFinish([reminderWork(claim,now)]);
  const old=(await s.db.deliveryBatch(now,16))[0];
  p=(await commit(s,p)).profile;assert.equal((await s.db.deliveryActive([old],now)).length,0);
  claim=(await s.db.reminderClaim(Date.now(),300))[0];await s.db.reminderFinish([reminderWork(claim,now)]);
  const fresh=(await s.db.deliveryBatch(now,16))[0];assert.equal(fresh.id,old.id);assert.notEqual(fresh.lease_token,old.lease_token);
  await s.db.deliveryFinishBatch([{id:fresh.id,token:fresh.lease_token,delivered:true,retry_at:0}]);
  await commit(s,p);claim=(await s.db.reminderClaim(Date.now(),300))[0];await s.db.reminderFinish([reminderWork(claim,now)]);
  assert.equal((await s.db.deliveryBatch(now,16)).length,0);
 }finally{await s.sql.close();}
});

test('crash after sending and before acknowledgement retries the same stable browser notification tag',async()=>{
 let failed=false,acknowledged=false,leased=false;const tags=[];
 const db={jobsClaim:async()=>({granted:true,token:'j'}),jobsFinish:async()=>{},due:async()=>[],reminderClaim:async()=>[],cleanup:async()=>{},
 deliveryBatch:async()=>acknowledged||leased?[]:(leased=true,[{id:1,lease_token:'lease',subscription:{},expires_at:now+3600000,event_key:'stable-tag'}]),
 deliveryActive:async()=>[1],deliveryFinishBatch:async()=>{if(!failed){failed=true;throw Error('crash after send');}acknowledged=true;}};
 const svc={db,now:()=>now,jobBudgetMs:45000,push:async(s,p)=>tags.push(p.tag)};
 await assert.rejects(()=>runScaledJobs(svc),/crash after send/);
 leased=false;await runScaledJobs(svc);assert.deepEqual(tags,['stable-tag','stable-tag']);
 assert.ok(acknowledged); // Web Push is at-least-once; the existing client uses tag to replace a duplicate.
});
