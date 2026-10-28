import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

// Full production schema; pg_cron, Vault and pg_net are local SQL-only fixtures.
// Nothing in this suite can send HTTP or access production credentials.
async function database(){
 const sql=new PGlite(),dir=new URL('../supabase/migrations/',import.meta.url);
 await sql.exec(`
  create role anon;create role authenticated;create role service_role bypassrls;
  create schema auth;create table auth.users(id uuid primary key);
  create schema cron;
  create table cron.job(jobid bigint primary key,jobname text,schedule text,command text,active boolean);
  create table cron.job_run_details(runid bigint primary key,start_time timestamptz);
  create function cron.alter_job(job_id bigint,command text) returns void language sql as $$
   update cron.job set command=$2 where jobid=$1;
  $$;
  insert into cron.job values(7,'svitlo-minute','* * * * *','select original_worker();',false),
   (8,'unrelated','0 0 * * *','select unrelated_worker();',true);
  create schema vault;
  create table vault.decrypted_secrets(name text primary key,decrypted_secret text);
  insert into vault.decrypted_secrets values('svitlo_cron_secret',repeat('fixture-only-',4));
  create schema net;
  create table net.requests(id bigint generated always as identity primary key,url text,headers jsonb,body jsonb,timeout_milliseconds integer);
  create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint
  language sql as $$
   insert into net.requests(url,headers,body,timeout_milliseconds) values($1,$2,$3,$4) returning id;
  $$;
 `);
 for(const name of (await readdir(dir)).filter(name=>/^\d{14}_.+\.sql$/.test(name)).sort())
  await sql.exec(await readFile(new URL(name,dir),'utf8'));
 const value=async(query,args=[])=>(await sql.query(query,args)).rows[0].value;
 const work=at=>value('select public.svitlo_jobs_work($1) as value',[at]);
 const dispatch=()=>value('select svitlo_internal.dispatch() as value');
 const maintenance=at=>value('select svitlo_internal.maintenance($1) as value',[at]);
 const requests=()=>value('select count(*)::integer as value from net.requests');
 return {sql,value,work,dispatch,maintenance,requests};
}

async function profile(s){
 const owner=randomUUID(),id=randomUUID(),sub='fixture-'+id;
 await s.sql.query('insert into auth.users values($1)',[owner]);
 await s.sql.query(`insert into public.svitlo_profiles(id,owner,address) values($1,$2,$3)`,
  [id,owner,{department:'18',cityId:'801',streetId:'100',house:'1'}]);
 await s.sql.query('insert into public.svitlo_subscriptions(id,owner,profile_id,subscription) values($1,$2,$3,$4)',
  [sub,owner,id,{endpoint:'fixture-only'}]);
 return {owner,id,sub};
}
async function quiet(s,p,at){
 await s.sql.query('update public.svitlo_profiles set next_check=$2,last_checked=$3,lease_until=0 where id=$1',[p.id,at+3600000,at]);
 await s.sql.exec('update public.svitlo_reminder_tasks set due_at=0,lease_until=0');
 await s.sql.query('update public.svitlo_feed_state set next_refresh=$1,lease_until=0',[at+3600000]);
}
async function delivery(s,p,event,expires,generation=null){
 await s.sql.query(`insert into public.svitlo_deliveries(subscription_id,profile_id,event_key,title,body,date,expires_at,channel,generation)
  values($1,$2,$3,'title','body','2026-10-27',$4,'reminder',$5)`,[p.sub,p.id,event,expires,generation]);
}
const none={profiles:false,reminders:false,deliveries:false,feed:false};

test('idle scheduler sends no HTTP; enable and restore preserve cron identity, schedule and active state',async()=>{
 const s=await database();try{
  assert.deepEqual(await s.work(Date.now()),none);
  const before=(await s.sql.query('select * from cron.job order by jobid')).rows;
  assert.equal((await s.value('select svitlo_internal.disable_scheduler() as value')).status,'not_enabled');
  assert.deepEqual(await s.value('select svitlo_internal.enable_scheduler() as value'),{status:'enabled',jobId:7,active:false});
  await s.value('select svitlo_internal.enable_scheduler() as value');
  const enabled=(await s.sql.query('select * from cron.job order by jobid')).rows;
  assert.deepEqual(enabled,[{...before[0],command:'select svitlo_internal.dispatch();'},before[1]]);
  assert.equal((await s.dispatch()).status,'idle');assert.equal(await s.requests(),0);
  assert.equal(await s.value('select skipped::integer as value from svitlo_internal.scheduler'),1);
  assert.equal((await s.value('select svitlo_internal.disable_scheduler() as value')).status,'restored');
  assert.deepEqual((await s.sql.query('select * from cron.job order by jobid')).rows,before);
  assert.equal((await s.dispatch()).status,'disabled');assert.equal(await s.requests(),0);
  await s.sql.exec("update cron.job set command='select external_change();' where jobid=7");
  await assert.rejects(()=>s.value('select svitlo_internal.enable_scheduler() as value'),/cron command changed externally/);
 }finally{await s.sql.close();}
});

test('readiness distinguishes due profiles, reminder and feed leases, and invalid pending delivery wakes repair',async()=>{
 const s=await database();try{
  const p=await profile(s),at=Date.now();await quiet(s,p,at);
  assert.deepEqual(await s.work(at),none);
  await s.sql.query('update public.svitlo_profiles set next_check=$1 where id=$2',[at-1,p.id]);
  assert.deepEqual(await s.work(at),{...none,profiles:true});
  await s.sql.query('update public.svitlo_profiles set lease_until=$1 where id=$2',[at+1000,p.id]);
  assert.deepEqual(await s.work(at),none);
  await quiet(s,p,at);
  await s.sql.query('update public.svitlo_profiles set next_check=0,last_checked=$1 where id=$2',[at-3600001,p.id]);
  assert.equal((await s.work(at)).profiles,true);
  await quiet(s,p,at);
  await s.sql.query('update public.svitlo_reminder_tasks set due_at=$1 where profile_id=$2',[at-1,p.id]);
  assert.deepEqual(await s.work(at),{...none,reminders:true});
  await s.sql.query('update public.svitlo_reminder_tasks set lease_until=$1 where profile_id=$2',[at+1000,p.id]);
  assert.deepEqual(await s.work(at),none);
  await quiet(s,p,at);
  await s.sql.query('update public.svitlo_feed_state set next_refresh=$1',[at-1]);
  assert.deepEqual(await s.work(at),{...none,feed:true});
  await s.sql.query('update public.svitlo_feed_state set lease_until=$1',[at+1000]);
  assert.deepEqual(await s.work(at),none);
  await quiet(s,p,at);
  await delivery(s,p,'invalid-generation',at+3600000,randomUUID());
  assert.equal(await s.value('select public.svitlo_delivery_valid(d,$1) as value from public.svitlo_deliveries d',[at]),false);
  assert.deepEqual(await s.work(at),{...none,deliveries:true});
  await s.value('select svitlo_internal.enable_scheduler() as value');
  const dispatched=await s.dispatch();assert.equal(dispatched.status,'dispatched');assert.equal(dispatched.work.deliveries,true);
  assert.equal(await s.requests(),1);
  assert.ok(!JSON.stringify(dispatched).includes('fixture-only-'));
  assert.ok(!JSON.stringify(dispatched).includes('original_worker'));
  const request=(await s.sql.query('select url,body,timeout_milliseconds from net.requests')).rows[0];
  assert.equal(request.url,'https://ovcmluucwzsuflusebcc.supabase.co/functions/v1/svitlo-jobs');
  assert.deepEqual(request.body,{});assert.equal(request.timeout_milliseconds,60000);
  // The real claim repairs the invalid row; readiness then goes idle.
  assert.deepEqual(await s.value('select public.svitlo_delivery_batch($1,16) as value',[at]),[]);
  assert.equal(await s.value('select cancelled as value from public.svitlo_deliveries'),true);
  assert.deepEqual(await s.work(at),none);
 }finally{await s.sql.close();}
});

test('pending HTTP and the global worker lease suppress duplicate dispatch; successful completion releases pending',async()=>{
 const s=await database();try{
  const p=await profile(s),at=Date.now();await quiet(s,p,at);
  await s.sql.query('update public.svitlo_profiles set next_check=$1 where id=$2',[at-1,p.id]);
  await s.value('select svitlo_internal.enable_scheduler() as value');
  const firstClaim=await s.value('select public.svitlo_jobs_claim() as value');assert.equal(firstClaim.granted,true);
  assert.equal((await s.dispatch()).status,'busy');assert.equal(await s.requests(),0);
  assert.equal(await s.value('select public.svitlo_jobs_finish($1,null) as value',[firstClaim.token]),true);
  assert.equal((await s.dispatch()).status,'dispatched');
  assert.equal((await s.dispatch()).status,'busy');assert.equal(await s.requests(),1);
  const running=await s.value('select public.svitlo_jobs_claim() as value');assert.equal(running.granted,true);
  assert.equal(await s.value('select public.svitlo_jobs_finish($1,null) as value',[randomUUID()]),false);
  assert.ok(await s.value('select pending_until>0 as value from svitlo_internal.scheduler'));
  // service_role cannot access private scheduler state, but its worker finish RPC
  // can invoke the narrowly scoped definer trigger that releases that state.
  await s.sql.exec('set role service_role');
  assert.equal(await s.value('select public.svitlo_jobs_finish($1,null) as value',[running.token]),true);
  await s.sql.exec('reset role');
  assert.equal(await s.value('select pending_until::integer as value from svitlo_internal.scheduler'),0);
  assert.equal((await s.dispatch()).status,'dispatched');assert.equal(await s.requests(),2);
 }finally{await s.sql.close();}
});

test('maintenance deletes bounded stale batches, protects live references and leases, then uses the hourly gate',async()=>{
 const s=await database();try{
  const p=await profile(s),at=Date.now();await quiet(s,p,at);
  await s.sql.query(`insert into public.svitlo_shared_plans(id,plans,created_at) values
   ('referenced','[]',to_timestamp($1::double precision/1000)-interval '8 days'),
   ('orphan','[]',to_timestamp($1::double precision/1000)-interval '8 days'),('fresh','[]',to_timestamp($1::double precision/1000))`,[at]);
  await s.sql.query('update public.svitlo_profiles set snapshot=$1 where id=$2',[{_plansRef:'referenced'},p.id]);
  await s.sql.query("insert into public.svitlo_source_cache(key,touched_at) select 'old-'||i,$1::bigint-172800000 from generate_series(1,1001) i",[at]);
  await s.sql.query("insert into public.svitlo_source_cache(key,touched_at) values('live',$1)",[at]);
  await delivery(s,p,'ancient',at-604800001);await delivery(s,p,'expired',at-1);await delivery(s,p,'live',at+3600000);
  await s.sql.query('insert into public.svitlo_limits values($1,$2,1),($3,$4,1)',[randomUUID(),at-86400001,randomUUID(),at]);
  await s.sql.query(`insert into public.svitlo_previews values($1,'old',repeat('a',64),'{}',$2,$3),($1,'live',repeat('b',64),'{}',$2,$4)`,[p.owner,at,at-1,at+3600000]);
  await s.sql.query(`insert into public.svitlo_dictionary_cache(key,stale_until,lease_until) values
   ('dictionary:old',$1::bigint-1,0),('dictionary:live',$1::bigint+3600000,0),('dictionary:leased',$1::bigint-1,$1::bigint+30000)`,[at]);
  await s.sql.exec("insert into public.svitlo_provider_hosts(host) values('cabinet.cherkasyoblenergo.com')");
  await s.sql.query(`insert into public.svitlo_provider_leases(host,expires_at) values('cabinet.cherkasyoblenergo.com',$1),('cabinet.cherkasyoblenergo.com',$2)`,[at-1,at+3600000]);
  await s.sql.query("insert into public.svitlo_job_runs(job,started_at,status) values('jobs',$1,'succeeded'),('jobs',$2,'succeeded')",[at-1209600001,at]);
  await s.sql.query(`insert into public.svitlo_registry_candidates(id,created_at,last_seen_at,reason,summary,payload)
   values('old',$1,$2,'fixture','{}','{}'),('live',$1,$1,'fixture','{}','{}')`,[at,at-7776000001]);
  await s.sql.query("insert into cron.job_run_details values(1,to_timestamp($1::double precision/1000)-interval '15 days'),(2,to_timestamp($1::double precision/1000))",[at]);
  const first=await s.maintenance(at);assert.equal(first.status,'completed');assert.equal(first.backlog,true);
  assert.deepEqual(first.removed,{plans:1,sources:1000,deliveries:1,expiredDeliveries:1,limits:1,previews:1,dictionaries:1,leases:1,runs:1,candidates:1,cronRuns:1});
  assert.equal(await s.value('select count(*)::integer as value from public.svitlo_source_cache'),2);
  assert.deepEqual((await s.sql.query('select id from public.svitlo_shared_plans order by id')).rows.map(r=>r.id),['fresh','referenced']);
  assert.deepEqual((await s.sql.query('select event_key,cancelled,sent from public.svitlo_deliveries order by event_key')).rows,
   [{event_key:'expired',cancelled:true,sent:false},{event_key:'live',cancelled:false,sent:false}]);
  assert.deepEqual((await s.sql.query('select key from public.svitlo_dictionary_cache order by key')).rows.map(r=>r.key),['dictionary:leased','dictionary:live']);
  for(const table of ['svitlo_limits','svitlo_previews','svitlo_provider_leases','svitlo_job_runs','svitlo_registry_candidates'])
   assert.equal(await s.value('select count(*)::integer as value from public.'+table),1,table);
  assert.deepEqual((await s.sql.query('select runid from cron.job_run_details')).rows,[{runid:2}]);
  assert.deepEqual(await s.maintenance(at+1000),{status:'not_due'});
  const second=await s.maintenance(at+60001);assert.equal(second.status,'completed');assert.equal(second.backlog,false);assert.equal(second.removed.sources,1);
  const next=await s.value('select next_maintenance as value from svitlo_internal.scheduler');assert.equal(next,at+60001+3600000);
  await s.sql.query("insert into public.svitlo_source_cache(key,touched_at) values('deferred-old',$1)",[at-172800000]);
  assert.deepEqual(await s.maintenance(next-1),{status:'not_due'});
  assert.equal(await s.value("select count(*)::integer as value from public.svitlo_source_cache where key='deferred-old'"),1);
  assert.equal((await s.maintenance(next)).removed.sources,1);
 }finally{await s.sql.close();}
});

test('every-minute timeout detection remains active while hourly maintenance is not due',async()=>{
 const s=await database();try{
  const at=Date.now();await s.maintenance(at);
  await s.sql.query("insert into public.svitlo_job_runs(job,started_at,status) values('jobs',$1,'running'),('jobs',$2,'running')",[at-360000,at]);
  assert.equal((await s.dispatch()).status,'disabled');assert.equal(await s.requests(),0);
  const rows=(await s.sql.query('select started_at,status,error_code,finished_at from public.svitlo_job_runs order by started_at')).rows;
  assert.equal(rows[0].status,'failed');assert.equal(rows[0].error_code,'execution_timeout');assert.ok(rows[0].finished_at>=at);
  assert.equal(rows[1].status,'running');assert.equal(rows[1].finished_at,null);
  assert.equal(await s.value('select last_maintenance as value from svitlo_internal.scheduler'),at);
 }finally{await s.sql.close();}
});

test('failed retention rolls back its entire batch, records only SQLSTATE and does not block ready work',async()=>{
 const s=await database();try{
  const p=await profile(s),at=Date.now();await quiet(s,p,at);
  await s.sql.query('update public.svitlo_profiles set next_check=$1 where id=$2',[at-1,p.id]);
  await s.sql.query("insert into public.svitlo_shared_plans values('orphan','[]',to_timestamp($1::double precision/1000)-interval '8 days')",[at]);
  await s.sql.query("insert into public.svitlo_source_cache(key,touched_at) values('old',$1)",[at-172800000]);
  await s.sql.query('insert into public.svitlo_limits values($1,$2,1)',[p.owner,at-172800000]);
  await s.sql.exec(`create function public.fixture_retention_failure() returns trigger language plpgsql as $$
   begin raise exception using errcode='23514',message='fixture-private-source-details';end $$;
   create trigger fixture_retention_failure before delete on public.svitlo_limits
   for each row execute function public.fixture_retention_failure();`);
  await s.value('select svitlo_internal.enable_scheduler() as value');
  const result=await s.dispatch();assert.equal(result.status,'dispatched');assert.equal(await s.requests(),1);
  assert.ok(!JSON.stringify(result).includes('fixture-private-source-details'));
  const failed=(await s.sql.query('select maintenance_error,next_maintenance,last_maintenance from svitlo_internal.scheduler')).rows[0];
  assert.deepEqual(failed,{maintenance_error:'23514',next_maintenance:0,last_maintenance:0});
  // Plans and sources were deleted before the injected failure, then restored
  // by the maintenance subtransaction rather than being left half-pruned.
  for(const table of ['svitlo_shared_plans','svitlo_source_cache','svitlo_limits'])
   assert.equal(await s.value('select count(*)::integer as value from public.'+table),1,table);
  await s.sql.exec('drop trigger fixture_retention_failure on public.svitlo_limits');
  assert.equal((await s.dispatch()).status,'busy');assert.equal(await s.requests(),1);
  const recovered=(await s.sql.query('select maintenance_error,next_maintenance,last_maintenance from svitlo_internal.scheduler')).rows[0];
  assert.equal(recovered.maintenance_error,null);assert.ok(recovered.last_maintenance>=at);
  assert.equal(recovered.next_maintenance,recovered.last_maintenance+3600000);
  for(const table of ['svitlo_shared_plans','svitlo_source_cache','svitlo_limits'])
   assert.equal(await s.value('select count(*)::integer as value from public.'+table),0,table);
 }finally{await s.sql.close();}
});

test('private scheduler data, credentials and management functions are denied to all API roles',async()=>{
 const s=await database();try{
  for(const role of ['anon','authenticated','service_role']){
   await s.sql.exec('set role '+role);
   for(const query of ['select * from svitlo_internal.scheduler','select svitlo_internal.dispatch()',
    'select svitlo_internal.maintenance(1)','select svitlo_internal.enable_scheduler()',
    'select svitlo_internal.disable_scheduler()','select svitlo_internal.jobs_finished()'])
    await assert.rejects(()=>s.sql.query(query),/permission denied/,role+' '+query);
   if(role==='service_role')assert.deepEqual(await s.work(Date.now()),none);
   else await assert.rejects(()=>s.work(Date.now()),/permission denied/);
   await s.sql.exec('reset role');
  }
 }finally{await s.sql.close();}
});
