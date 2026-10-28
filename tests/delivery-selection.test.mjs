import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {scalingDatabase} from './helpers/scaling-db.mjs';
const migration='20261027203329_delivery_selection.sql';
const now=Date.now();
async function database(){const s=await scalingDatabase();await s.sql.exec(await readFile(new URL('../supabase/migrations/'+migration,import.meta.url),'utf8'));return s;}
async function profile(s,house='1',owner=randomUUID()){
 await s.sql.query('insert into auth.users values($1) on conflict do nothing',[owner]);
 const p=(await s.db.createProfile({id:randomUUID(),owner,address:{department:'18',cityId:'801',streetId:'100',house},name:'',preferences:{}})).profile;
 const sub='subscription-'+p.id;
 await s.sql.query('insert into public.svitlo_subscriptions(id,owner,profile_id,subscription) values($1,$2,$3,$4)',[sub,owner,p.id,{endpoint:'fixture-'+p.id}]);
 return {...p,sub};
}
const generation=async(s,p)=>(await s.sql.query('select generation from public.svitlo_reminder_tasks where profile_id=$1',[p.id])).rows[0].generation;
async function seed(s,p,n,{generation:gen=null,expires=now+3600000,channel='schedule',prefix='e'}={}){
 await s.sql.query(`insert into public.svitlo_deliveries(subscription_id,profile_id,event_key,title,body,date,expires_at,channel,generation)
  select $1,$2,$3||i::text,'title','body','2026-10-27',$4,$5,$6::uuid from generate_series(1,$7) i`,[p.sub,p.id,prefix,expires,channel,gen,n]);
}
const count=async(s,where='true')=>(await s.sql.query('select count(*)::int as n from public.svitlo_deliveries where '+where)).rows[0].n;

test('delivery selection validates only selected candidates instead of the full pending queue',async()=>{
 const s=await database();try{
  const p=await profile(s);await seed(s,p,1000);
  await s.sql.exec(`create table public.test_validation_calls(n integer);insert into public.test_validation_calls values(0);
  create or replace function public.svitlo_delivery_valid(d public.svitlo_deliveries,now_ms bigint) returns boolean
  language plpgsql volatile set search_path='' as $$ begin update public.test_validation_calls set n=n+1;
   return not d.cancelled and not d.sent and d.expires_at>now_ms and exists(select 1 from public.svitlo_profiles p
   join public.svitlo_subscriptions sub on sub.id=d.subscription_id and sub.owner=p.owner and (sub.profile_id=p.id or sub.profile_id is null)
   left join public.svitlo_reminder_tasks t on t.profile_id=p.id where p.id=d.profile_id and p.push_enabled
   and (d.channel is null or p.preferences->d.channel is distinct from 'false'::jsonb)
   and (d.generation is null or d.generation=t.generation));end $$;`);
  const first=await s.db.deliveryBatch(now,16);assert.equal(first.length,16);
  assert.equal((await s.sql.query('select n from public.test_validation_calls')).rows[0].n,16);
  const second=await s.db.deliveryBatch(now,16);assert.equal(second.length,16);
  assert.equal((await s.sql.query('select n from public.test_validation_calls')).rows[0].n,32);
  assert.equal(new Set([...first,...second].map(x=>x.id)).size,32);
 }finally{await s.sql.close();}
});

test('profile, generation and subscription changes cancel only affected queued deliveries before send',async()=>{
 const s=await database();try{
  const a=await profile(s,'1'),b=await profile(s,'2',a.owner);
  await seed(s,a,2,{generation:await generation(s,a),channel:'reminder'});
  await seed(s,b,2,{generation:await generation(s,b),channel:'reminder'});
  const claimed=await s.db.deliveryBatch(now,16);assert.equal(claimed.length,4);
  await s.sql.query('update public.svitlo_reminder_tasks set generation=gen_random_uuid() where profile_id=$1',[a.id]);
  assert.equal(await count(s,'cancelled'),2);
  assert.equal((await s.db.deliveryActive(claimed,now)).length,2);
  await s.sql.query('update public.svitlo_profiles set preferences=\'{"reminder":false}\' where id=$1',[b.id]);
  assert.equal(await count(s,'cancelled'),4);assert.equal((await s.db.deliveryActive(claimed,now)).length,0);
  await seed(s,a,1,{prefix:'generic-'});
  const pending=await s.db.deliveryBatch(now,16);assert.equal(pending.length,1);
  await s.sql.query('update public.svitlo_subscriptions set profile_id=$1 where id=$2',[b.id,a.sub]);
  assert.equal((await s.db.deliveryActive(pending,now)).length,0);assert.equal(await count(s,'cancelled'),5);
 }finally{await s.sql.close();}
});

test('large unexpected invalid prefixes are repaired without hiding later valid work or changing attempt counts',async()=>{
 for(const n of [3000,5000]){
  const s=await database();try{
   const p=await profile(s);await seed(s,p,n,{generation:randomUUID(),channel:'reminder',prefix:'invalid-'});
   await seed(s,p,1,{prefix:'valid-'});
   let batch=await s.db.deliveryBatch(now,16);
   if(n>4096){assert.equal(batch.length,0);assert.equal(await count(s,'cancelled'),4096);batch=await s.db.deliveryBatch(now,16);}
   assert.equal(batch.length,1);assert.equal(batch[0].event_key,'valid-1');assert.equal(batch[0].attempts,1);
   assert.equal(await count(s,'cancelled'),n);assert.equal(await count(s,'cancelled and attempts<>0'),0);
  }finally{await s.sql.close();}
 }
});

test('expiry is enforced at claim and bounded maintenance prunes expired entries without marking them sent',async()=>{
 const s=await database();try{
  const p=await profile(s);await seed(s,p,1000,{expires:now-1,prefix:'expired-'});await seed(s,p,20,{prefix:'valid-'});
  const batch=await s.db.deliveryBatch(now,16);assert.equal(batch.length,16);assert.ok(batch.every(x=>x.expires_at>now));
  assert.equal(await s.rpc('svitlo_delivery_prune',{now_ms:now,batch_size:100}),100);
  assert.equal(await count(s,'cancelled'),100);assert.equal(await count(s,'sent'),0);
  assert.equal(await s.rpc('svitlo_delivery_prune',{now_ms:now,batch_size:5000}),900);
  assert.equal(await count(s,'cancelled'),1000);
 }finally{await s.sql.close();}
});

test('delivery leases still recover after crashes and stale acknowledgements cannot finish reclaimed work',async()=>{
 const s=await database();try{
  const p=await profile(s);await seed(s,p,1);
  const first=(await s.db.deliveryBatch(now,16))[0];assert.equal((await s.db.deliveryBatch(now+1,16)).length,0);
  const again=(await s.db.deliveryBatch(now+56000,16))[0];assert.notEqual(again.lease_token,first.lease_token);assert.equal(again.attempts,2);
  assert.equal(await s.db.deliveryFinishBatch([{id:first.id,token:first.lease_token,delivered:true,retry_at:0}]),0);
  assert.equal(await s.db.deliveryFinishBatch([{id:again.id,token:again.lease_token,delivered:null,retry_at:now+56001}]),1);
  const retry=(await s.db.deliveryBatch(now+56002,16))[0];assert.equal(retry.attempts,2);
  await s.sql.query('delete from public.svitlo_subscriptions where id=$1',[p.sub]);
  assert.equal((await s.db.deliveryActive([retry],now+56002)).length,0);assert.equal(await count(s),0);
 }finally{await s.sql.close();}
});

test('cancelled reminder targets can be renewed, and sent targets stay deduplicated',async()=>{
 const s=await database();try{
  const p=await profile(s);const event={owner:p.owner,profile_id:p.id,event_key:'reminder:false:target',title:'t',body:'b',date:'2026-10-27',expires_at:now+3600000,channel:'reminder',generation:await generation(s,p)};
  await s.db.enqueue(event);const old=(await s.db.deliveryBatch(now,16))[0];
  await s.sql.query('update public.svitlo_reminder_tasks set generation=gen_random_uuid() where profile_id=$1',[p.id]);
  assert.equal(await count(s,'cancelled'),1);
  event.generation=await generation(s,p);await s.db.enqueue(event);const fresh=(await s.db.deliveryBatch(now,16))[0];
  assert.equal(fresh.id,old.id);assert.notEqual(fresh.lease_token,old.lease_token);
  await s.db.deliveryFinishBatch([{id:fresh.id,token:fresh.lease_token,delivered:true,retry_at:0}]);
  await s.sql.query('update public.svitlo_reminder_tasks set generation=gen_random_uuid() where profile_id=$1',[p.id]);
  event.generation=await generation(s,p);await s.db.enqueue(event);assert.equal((await s.db.deliveryBatch(now,16)).length,0);
 }finally{await s.sql.close();}
});

test('delivery optimization RPCs and trigger functions remain inaccessible to client roles',async()=>{
 const s=await database();try{
  for(const role of ['anon','authenticated']){
   await s.sql.exec('set role '+role);
   for(const q of ['select public.svitlo_delivery_batch(1,16)','select public.svitlo_delivery_prune(1,100)',
    'select public.svitlo_delivery_generation_changed()','select public.svitlo_delivery_profile_changed()','select public.svitlo_delivery_subscription_changed()'])await assert.rejects(()=>s.sql.query(q),/permission denied/);
   await s.sql.exec('reset role');
  }
 }finally{await s.sql.close();}
});
