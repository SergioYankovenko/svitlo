import test from "node:test";
import assert from "node:assert/strict";
import {readFile,readdir} from "node:fs/promises";
import {PGlite} from "@electric-sql/pglite";
const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const address=house=>({department:'18',cityId:'801',streetId:'100',house});
async function database(){
 const db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);');
 await db.exec(await readFile(new URL('../supabase/migrations/20261023225141_svitlo_pwa.sql',import.meta.url),'utf8'));
 await db.exec('alter table public.svitlo_profiles add column next_check bigint not null default 0;');
 await db.exec(await readFile(new URL('../supabase/migrations/20261026193707_server_concurrency.sql',import.meta.url),'utf8'));
 await db.query('insert into auth.users values($1),($2)',[owner,other]);return db;
}
const create=(db,house,subject=owner)=>db.query('select public.svitlo_profile_create($1,gen_random_uuid(),$2,\'name\',\'{"reminder":true}\') as v',[subject,address(house)]).then(r=>r.rows[0].v);
const commit=(db,p,revision,n=1000)=>db.query('select public.svitlo_profile_commit($1,$2,$3,$4) as v',[p.owner,p.id,revision,{snapshot:{checkedAt:n},messages:[],last_checked:n,next_check:n+3600000}]).then(r=>r.rows[0].v);

test('SQL atomic enrollment deduplicates exact addresses, enforces quota and preserves literal house identities',async()=>{
 const db=await database();try{
  const same=await Promise.all(Array.from({length:5},()=>create(db,'1')));assert.equal(new Set(same.map(x=>x.profile.id)).size,1);
  assert.equal(same.filter(x=>x.created).length,1);
  await create(db,'9 г');await create(db,'9  г');
  const many=await Promise.all(Array.from({length:15},(_,i)=>create(db,String(i+20))));
  assert.equal(many.filter(x=>x.created).length,7);assert.equal(many.filter(x=>x.status==='limit').length,8);
  assert.equal((await create(db,'1')).status,undefined);assert.equal((await create(db,'1',other)).created,true);
  const count=await db.query('select count(*)::int as n from public.svitlo_profiles where owner=$1',[owner]);assert.equal(count.rows[0].n,10);
  await assert.rejects(()=>db.query('insert into public.svitlo_profiles(id,owner,address) values(gen_random_uuid(),$1,$2)',[owner,address('1')]),/duplicate key/);
 }finally{await db.close();}
});

test('SQL snapshot commit updates only server fields, rejects stale revisions and never recreates deleted rows',async()=>{
 const db=await database();try{
  const p=(await create(db,'1')).profile;
  await db.query('update public.svitlo_profiles set preferences=\'{"reminder":false}\',name=\'new name\' where id=$1',[p.id]);
  const won=await commit(db,p,0);assert.equal(won.status,'updated');assert.equal(won.profile.preferences.reminder,false);assert.equal(won.profile.name,'new name');
  assert.equal(won.profile.snapshot_revision,1);assert.equal(won.profile.lease_until,0);
  const stale=await commit(db,p,0,2000);assert.equal(stale.status,'conflict');assert.equal(stale.profile.last_checked,1000);
  assert.equal((await commit(db,p,1,999)).status,'conflict');
  await db.query('delete from public.svitlo_profiles where id=$1',[p.id]);assert.equal((await commit(db,p,1)).status,'missing');
  assert.equal((await db.query('select count(*)::int as n from public.svitlo_profiles')).rows[0].n,0);
 }finally{await db.close();}
});

test('SQL shared feed ownership prevents duplicate refresh and late writers; partial/error results retain evidence',async()=>{
 const db=await database();try{
  const claim=()=>db.query('select public.svitlo_feed_claim() as v').then(r=>r.rows[0].v);
  const finish=(t,v,e=null)=>db.query('select public.svitlo_feed_finish($1,$2,$3) as v',[t,v,e]).then(r=>r.rows[0].v);
  const first=await claim();assert.equal(first.state,'owner');assert.equal((await claim()).state,'busy');
  const good={plans:[],emergencies:[],messages:[],checkedAt:1000};assert.equal(await finish(first.token,good),true);
  assert.equal((await claim()).state,'fresh');assert.equal((await claim()).value.checkedAt,1000);
  await db.exec('update public.svitlo_feed_state set next_refresh=0');const next=await claim();assert.equal(next.state,'owner');
  assert.equal(await finish(first.token,{...good,checkedAt:3000}),false);
  await finish(next.token,{...good,partial:true,failedArticles:1,attemptedAt:2000});
  const partial=await claim();assert.equal(partial.value.checkedAt,1000);assert.equal(partial.value.partial,true);
  await db.exec('update public.svitlo_feed_state set next_refresh=0');const failed=await claim();await finish(failed.token,null,'server_error');
  assert.equal((await claim()).value.checkedAt,1000);assert.equal((await claim()).value.feedError,'server_error');
  await db.exec('update public.svitlo_feed_state set next_refresh=0,lease_until=0');const expired=await claim();
  await db.exec('update public.svitlo_feed_state set lease_until=0');const recovered=await claim();assert.notEqual(recovered.token,expired.token);
  assert.equal(await finish(expired.token,good),false);
 }finally{await db.close();}
});

test('SQL job and delivery leases recover after a crash; stale tokens cannot acknowledge reclaimed work',async()=>{
 const db=await database();try{
  const job=()=>db.query('select public.svitlo_jobs_claim() as v').then(r=>r.rows[0].v);
  const first=await job();assert.equal(first.granted,true);assert.equal((await job()).granted,false);
  await db.exec('update public.svitlo_jobs_state set lease_until=0');const next=await job();
  assert.equal((await db.query('select public.svitlo_jobs_finish($1,$2) as v',[first.token,owner])).rows[0].v,false);
  assert.equal((await db.query('select public.svitlo_jobs_finish($1,$2) as v',[next.token,owner])).rows[0].v,true);
  assert.equal((await job()).cursor,owner);
  const p=(await create(db,'1')).profile;
  await db.query('insert into public.svitlo_subscriptions(id,owner,profile_id,subscription) values(\'subscription\',$1,$2,\'{}\')',[owner,p.id]);
  await db.query('insert into public.svitlo_deliveries(subscription_id,profile_id,event_key,title,body,date,expires_at) values(\'subscription\',$1,\'e\',\'t\',\'b\',\'2026-10-26\',1000000)',[p.id]);
  const delivery=t=>db.query('select public.svitlo_delivery_claim($1) as v',[t]).then(r=>r.rows[0].v);
  const one=(await delivery(1000))[0];assert.equal(one.attempts,1);assert.equal((await delivery(1001)).length,0);
  const two=(await delivery(32000))[0];assert.notEqual(two.lease_token,one.lease_token);assert.equal(two.attempts,2);
  const done=(token)=>db.query('select public.svitlo_delivery_finish($1,$2,true,0) as v',[one.id,token]).then(r=>r.rows[0].v);
  assert.equal(await done(one.lease_token),false);assert.equal(await done(two.lease_token),true);assert.equal((await delivery(64000)).length,0);
 }finally{await db.close();}
});

test('SQL adds both foreign-key indexes and all new RPCs stay inaccessible to client roles',async()=>{
 const db=await database();try{
  for(const name of ['svitlo_subscriptions_profile_id','svitlo_deliveries_profile_id'])assert.equal((await db.query('select count(*)::int as n from pg_indexes where indexname=$1',[name])).rows[0].n,1);
  const p=(await create(db,'1')).profile;
  for(const role of ['anon','authenticated']){
   await db.exec('set role '+role);
   for(const query of ['select public.svitlo_feed_claim()','select public.svitlo_jobs_claim()','select public.svitlo_delivery_claim(1000)','select * from public.svitlo_feed_state','select * from public.svitlo_jobs_state'])await assert.rejects(()=>db.query(query),/permission denied/);
   await assert.rejects(()=>create(db,'2'));await assert.rejects(()=>commit(db,p,0));await db.exec('reset role');
  }
 }finally{await db.close();}
});

test('the complete migration chain installs together and unattempted delivery claims do not consume retries',async()=>{
 const db=new PGlite();try{
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);');
  const dir=new URL('../supabase/migrations/',import.meta.url);
  for(const name of (await readdir(dir)).filter(x=>x.endsWith('.sql')).sort())await db.exec(await readFile(new URL(name,dir),'utf8'));
  await db.query('insert into auth.users values($1)',[owner]);const p=(await create(db,'1')).profile;
  await db.query('insert into public.svitlo_subscriptions(id,owner,profile_id,subscription) values(\'sub\',$1,$2,\'{}\')',[owner,p.id]);
  await db.query('insert into public.svitlo_deliveries(subscription_id,profile_id,event_key,title,body,date,expires_at) values(\'sub\',$1,\'e\',\'t\',\'b\',\'2026-10-26\',1000000)',[p.id]);
  const item=(await db.query('select public.svitlo_delivery_claim(1000) as v')).rows[0].v[0];
  await db.query('select public.svitlo_delivery_finish($1,$2,null,1001)',[item.id,item.lease_token]);
  const state=(await db.query('select attempts,sent,lease_until,lease_token from public.svitlo_deliveries')).rows[0];
  assert.equal(state.attempts,0);assert.equal(state.sent,false);assert.equal(state.lease_token,null);
  assert.equal((await db.query('select public.svitlo_service_report() as v')).rows[0].v.limits.registryIntervalDays,14);
 }finally{await db.close();}
});
