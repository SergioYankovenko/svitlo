import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
const migration=async name=>readFile(new URL("../supabase/migrations/"+name,import.meta.url),"utf8");
const owner="11111111-1111-4111-8111-111111111111",other="22222222-2222-4222-8222-222222222222";
const url=q=>`https://www.cherkasyoblenergo.com/cherkasyoblenergo/uploads/pages/files/${q.replace('.','')}.pdf`;
const version=(id,queue="3.2")=>({id,validFrom:"2026-10-01",validUntil:"2027-04-01",checkedAt:Date.now(),documents:Array.from({length:12},(_,i)=>({queue:`${Math.floor(i/2)+1}.${i%2+1}`,url:url(`${Math.floor(i/2)+1}.${i%2+1}`)})),rules:[{city:"м. Приклад",street:"вул. Прикладна",scope:"street_all",queue,url:url(queue),page:1}],mentions:[]});
async function database(){
 const db=new PGlite();
 await db.exec("create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create table public.svitlo_profiles(id uuid primary key,owner uuid,last_checked bigint default 0,snapshot jsonb default '{}'::jsonb);create table public.svitlo_cache(key text primary key,value jsonb not null);grant all on public.svitlo_profiles,public.svitlo_cache to service_role;");
 await db.query("insert into auth.users values ($1),($2)",[owner,other]);
 await db.exec((await migration("20261024144933_queue_registry.sql")).split("alter table public.svitlo_profiles")[0]);
 await db.exec(await migration("20261026145440_address_queue_catalog.sql"));
 await db.exec(await migration("20261026162948_reconcile_address_registry.sql"));
 await db.exec(await migration("20261026185200_service_reliability.sql"));
 return db;
}
test("SQL private preview cache is owner-scoped, one-use, expiring and does not store account numbers",async()=>{
 const db=await database();try{
  const now=Date.now(),data={queue:"3.2",categories:{},failures:[],checkedAt:now},proof="a".repeat(64);
  await db.query("select public.svitlo_preview_put($1,'address',$2,$3,$4)",[owner,proof,data,now]);
  assert.equal((await db.query("select public.svitlo_preview_take($1,'address',$2) as v",[other,proof])).rows[0].v,null);
  assert.deepEqual((await db.query("select public.svitlo_preview_take($1,'address',$2) as v",[owner,proof])).rows[0].v,data);
  assert.equal((await db.query("select public.svitlo_preview_take($1,'address',$2) as v",[owner,proof])).rows[0].v,null);
  await db.query("select public.svitlo_preview_put($1,'old',$2,$3,$4)",[owner,proof,data,now-61000]);
  assert.equal((await db.query("select count(*)::int as n from public.svitlo_previews")).rows[0].n,0);
  await assert.rejects(()=>db.query("select public.svitlo_preview_put($1,'bad',$2,$3,$4)",[owner,proof,{...data,account:"12345678901"},now]));
  for(let i=0;i<11;i++)await db.query("select public.svitlo_preview_put($1,$2,$3,$4,$5)",[owner,"key"+i,proof,data,now]);
  assert.equal((await db.query("select count(*)::int as n from public.svitlo_previews")).rows[0].n,10);
  await db.exec("set role authenticated");await assert.rejects(()=>db.query("select * from public.svitlo_previews"));
  await assert.rejects(()=>db.query("select public.svitlo_preview_take($1,'key10',$2)",[owner,proof]));
 }finally{await db.close();}
});
test("SQL dictionary claims deduplicate workers and preserve stale timestamps after a failed refresh",async()=>{
 const db=await database();try{
  const claim=()=>db.query("select public.svitlo_dictionary_claim('dictionary:department:') as v").then(r=>r.rows[0].v);
  const first=await claim();assert.equal(first.state,"owner");assert.equal((await claim()).state,"busy");
  const items=[{id:"18",name:"Філія"}];
  assert.equal((await db.query("select public.svitlo_dictionary_finish('dictionary:department:',$1,$2,null) as v",[first.token,items])).rows[0].v,true);
  const fresh=await claim();assert.equal(fresh.state,"fresh");assert.deepEqual(fresh.items,items);
  await db.exec("update public.svitlo_dictionary_cache set expires_at=0");
  const stale=await claim();assert.equal(stale.state,"owner");assert.equal(stale.checkedAt,fresh.checkedAt);
  await db.query("select public.svitlo_dictionary_finish('dictionary:department:',$1,null,'server_error')",[stale.token]);
  const kept=await claim();assert.deepEqual(kept.items,items);assert.equal(kept.checkedAt,fresh.checkedAt);
  assert.equal((await db.query("select public.svitlo_dictionary_finish('dictionary:department:',$1,'[]',null) as v",[stale.token])).rows[0].v,false);
 }finally{await db.close();}
});
test("SQL provider gate enforces spacing and four leases, and concurrent success cannot clear a 429 cooldown",async()=>{
 const db=await database();try{
  const host="cabinet.cherkasyoblenergo.com";
  const acquire=()=>db.query("select public.svitlo_provider_acquire($1) as v",[host]).then(r=>r.rows[0].v);
  const tokens=[];tokens.push((await acquire()).token);assert.equal((await acquire()).reason,"spacing");
  for(let i=1;i<4;i++){await db.exec("update public.svitlo_provider_hosts set next_start=0");tokens.push((await acquire()).token);}
  await db.exec("update public.svitlo_provider_hosts set next_start=0");assert.equal((await acquire()).reason,"busy");
  await db.query("select public.svitlo_provider_finish($1,429,null,120000)",[tokens[0]]);
  await db.query("select public.svitlo_provider_finish($1,200,null,0)",[tokens[1]]);
  const blocked=await acquire();assert.equal(blocked.reason,"cooldown");assert.equal(blocked.code,"rate_limited");assert.ok(blocked.waitMs>100000);
  for(const token of tokens.slice(2))await db.query("select public.svitlo_provider_finish($1,200,null,0)",[token]);
  assert.equal((await db.query("select count(*)::int as n from public.svitlo_provider_leases")).rows[0].n,0);
  await db.exec("update public.svitlo_provider_hosts set cooldown_until=0,next_start=0,failures=2");
  const token=(await acquire()).token;await db.query("select public.svitlo_provider_finish($1,503,null,0)",[token]);
  assert.equal((await acquire()).reason,"cooldown");
 }finally{await db.close();}
});
test("mass-change guard blocks activation atomically, preserves carried corrections and validates control addresses",async()=>{
 const db=await database();try{
  await db.query("select public.svitlo_activate_registry($1)",[version("v1")]);
  const batch=(await db.query("insert into public.svitlo_address_queue_batches(import_key,department,expected_total,expected_numeric,expected_exclusions,expected_service,checksum_md5,reviewed_at) values('mass-test','18',1000,1000,0,0,repeat('0',32),now()) returning id")).rows[0].id;
  await db.query("insert into public.svitlo_address_queues(batch_id,department,city_id,street_id,house,city,street,status,queue) select $1,'18','801','100',n::text,'м. Приклад','вул. Прикладна','numeric','3.2' from generate_series(1,1000) n",[batch]);
  await db.query("update public.svitlo_address_queue_batches set status='active' where id=$1",[batch]);
  await db.query("insert into public.svitlo_registry_controls values($1,'18','801','100','1','numeric')",[batch]);
  const candidate=(id,n,previous="v1")=>({...version(id,"4.2"),addressReconciliation:{previous_registry_id:previous,batches:[{batch_id:batch,total:1000,overrides:Array.from({length:n},(_,i)=>({department:"18",city_id:"801",street_id:"100",house:String(i+1),status:"numeric",queue:"4.2",is_estimate:false,confidence:null,evidence:{origin:"provider_pdf_change",pdf_mapping:{url:url("4.2"),scope:"house",page:1}}}))}]}});
  const safety=c=>db.query("select public.svitlo_registry_safety($1) as v",[c]).then(r=>r.rows[0].v);
  assert.equal((await safety(candidate("v2",100))).reason,"mass_queue_change");
  await assert.rejects(()=>db.query("select public.svitlo_activate_registry($1)",[candidate("v2",100)]),/safety review required/);
  assert.equal((await db.query("select id from public.svitlo_queue_versions where active")).rows[0].id,"v1");
  assert.equal((await safety(candidate("v2",99))).approved,true);
  await db.query("select public.svitlo_activate_registry($1)",[candidate("v2",99)]);
  const missing=candidate("v3",0,"v2");assert.equal((await safety(missing)).reason,"missing_carried_overrides");
  const held=candidate("reviewed",199,"v2");assert.equal((await safety(held)).reason,"mass_queue_change");
  await db.query("insert into public.svitlo_registry_candidates(id,base_version,created_at,last_seen_at,reason,summary,payload) values ('reviewed','v2',$1,$1,'mass_queue_change','{}',$2)",[Date.now(),held]);
  await db.query("insert into public.svitlo_cache values ('queue-registry-state',$1)",[{error:'registry_needs_review',pendingVersion:'reviewed'}]);
  await db.query("select public.svitlo_review_registry_candidate('reviewed','Reviewed against the official documents')");
  assert.equal((await db.query("select id from public.svitlo_queue_versions where active")).rows[0].id,"reviewed");
  assert.equal((await db.query("select count(*)::int as n from public.svitlo_registry_approvals")).rows[0].n,1);
  assert.equal((await db.query("select value->>'error' as error from public.svitlo_cache where key='queue-registry-state'")).rows[0].error,null);
  const modified=structuredClone(held);modified.addressReconciliation.batches[0].overrides[0].queue='6.2';
  modified.id='tampered';modified.addressReconciliation.previous_registry_id='reviewed';
  assert.equal((await safety(modified)).approved,false);
  const invalid=candidate("v3",199,"reviewed");invalid.addressReconciliation.batches[0].overrides[0].queue="5.2";
  assert.equal((await safety(invalid)).reason,"invalid_change_proof");
  await db.exec("update public.svitlo_registry_controls set expected_status='not_in_queue'");
  assert.equal((await safety(candidate("v3",199,"reviewed"))).reason,"control_address_failed");
 }finally{await db.close();}
});
test("private report exposes aggregate operational state and cleanup flags interrupted jobs",async()=>{
 const db=await database();try{
  await db.query("insert into public.svitlo_job_runs(job,started_at) values('jobs',$1)",[Date.now()-360000]);
  await db.exec("select public.svitlo_ops_cleanup()");
  const report=(await db.query("select public.svitlo_service_report() as v")).rows[0].v;
  assert.equal(report.recentRuns[0].status,"failed");assert.equal(report.recentRuns[0].error_code,"execution_timeout");
  assert.equal(report.jobs[0].failures_24h,1);assert.equal(report.profiles.total,0);
  await db.exec("set role authenticated");await assert.rejects(()=>db.query("select public.svitlo_service_report()"));
 }finally{await db.close();}
});

