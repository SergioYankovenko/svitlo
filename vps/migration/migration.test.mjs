import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID,generateKeyPairSync} from 'node:crypto';import {readFile} from 'node:fs/promises';
import {billingFixture} from '../billing/fixture.mjs';import {MigrationService} from './service.js';import {SupabaseMigrationSource} from './source.js';
async function fixture(){const f=await billingFixture(),{c}=f;await c.exec(`alter table public.svitlo_profiles add column address jsonb,add column name text,add column preferences jsonb;grant select,insert,update on public.svitlo_profiles to svitlo_stage_api;create policy api_owner on public.svitlo_profiles to svitlo_stage_api using(owner=auth.uid()) with check(owner=auth.uid());create table public.svitlo_shared_plans(id text,plans jsonb);alter table public.svitlo_shared_plans enable row level security;
 create table svitlo_vps.catalog(id uuid);create table svitlo_vps.address_lines(id uuid);
 create function public.svitlo_address_group(jsonb) returns text language sql as $$select $1->>'canonicalAddressId'$$;
 create or replace function svitlo_sensors.address_limit(subject uuid) returns integer language sql as $$select 2$$;
 create function public.svitlo_hydrate(public.svitlo_profiles) returns public.svitlo_profiles language sql as $$select $1$$;
 create function svitlo_sensors.profile_has_sensor(uuid) returns boolean language sql as $$select false$$;
 create function public.svitlo_profile_quota_allows(uuid,jsonb) returns boolean language sql as $$select true$$;
 create function public.svitlo_profile_create_universal(subject uuid,pid uuid,a jsonb,n text,p jsonb) returns jsonb language plpgsql as $$declare result public.svitlo_profiles;begin if n='quota-failure' then raise exception 'quota';end if;insert into public.svitlo_profiles values(pid,subject,a,n,p) returning * into result;return jsonb_build_object('created',true,'profile',to_jsonb(result));end$$;
 create function public.svitlo_profile_group_create(subject uuid,a jsonb,n text,p jsonb) returns jsonb language plpgsql as $$declare x jsonb;result jsonb:='[]';begin for x in select * from jsonb_array_elements(a) loop result:=result||jsonb_build_array(public.svitlo_profile_create_universal(subject,gen_random_uuid(),x,n,p)->'profile');end loop;return jsonb_build_object('created',true,'profiles',result);end$$;`);
 await c.exec(await readFile(new URL('../sql/migration-transfer.sql',import.meta.url),'utf8'));await c.exec(await readFile(new URL('../sql/migration-saga.sql',import.meta.url),'utf8'));await c.exec('update svitlo_migration.control set enabled=true');await c.query('insert into svitlo_migration.cohort values($1,true)',[f.owner]);
 const old=randomUUID(),home=randomUUID(),keys=generateKeyPairSync('ed25519'),exported={revision:'r1',profiles:[{id:'old-1',name:'Мій підпис',address:{house:'12/А'},preferences:{reminder:false}}]},calls=[];let clock=Date.now();
 const source={configured:true,authenticate:async token=>{if(token!=='old-session')throw Error('old_session_invalid');return {subject:old};},export:async()=>structuredClone(exported),freeze:async p=>{calls.push('freeze');return {fenced:true,nonce:p.nonce,revision:p.sourceRevision};},finalize:async()=>calls.push('finalize'),abort:async value=>{calls.push('abort');source.lastAbort=value;}};
 const service=new MigrationService({bridge:f.pool,source,...keys,targetOrigin:'https://qa.test',now:()=>clock,mapper:async()=>({status:'resolved',addresses:[{canonicalAddressId:home,lineId:randomUUID(),operatorId:'op'}]})});
 return {...f,service,source,exported,calls,session:{owner:f.owner},setClock:v=>clock=v};
}
test('dual-proof preview is read-only, retry returns durable same receipt and never imports sensor ownership',async()=>{const f=await fixture();try{const preview=await f.service.handle(f.session,{schemaVersion:1,action:'preview',sourceAccessToken:'old-session'});assert.equal((await f.c.query('select count(*)::int n from public.svitlo_profiles')).rows[0].n,0);const packet={schemaVersion:1,action:'commit',sourceAccessToken:'old-session',backupSaved:true,envelope:preview.envelope};const committed=await f.service.handle(f.session,packet);assert.equal(committed.ok,true);assert.equal(committed.sensorOwnershipImported,false);assert.deepEqual(await f.service.handle(f.session,packet),committed);assert.deepEqual(f.calls,['freeze','finalize','finalize']);assert.equal((await f.c.query('select count(*)::int n from public.svitlo_profiles')).rows[0].n,1);}finally{await f.c.close();}});
test('tampering, missing backup, changed source and absent writer fence reject before target writes',async()=>{const f=await fixture();try{const preview=await f.service.handle(f.session,{schemaVersion:1,action:'preview',sourceAccessToken:'old-session'}),p={schemaVersion:1,action:'commit',sourceAccessToken:'old-session',backupSaved:true,envelope:preview.envelope};await assert.rejects(f.service.handle(f.session,{...p,backupSaved:false}),/backup/);await assert.rejects(f.service.handle(f.session,{...p,envelope:{...p.envelope,payload:p.envelope.payload+'x'}}),/invalid/);f.exported.revision='r2';await assert.rejects(f.service.handle(f.session,p),/source_changed/);f.exported.revision='r1';f.source.freeze=async()=>({fenced:false});await assert.rejects(f.service.handle(f.session,p),/not_fenced/);assert.equal((await f.c.query('select count(*)::int n from public.svitlo_profiles')).rows[0].n,0);f.setClock(Date.now()+901000);await assert.rejects(f.service.handle(f.session,p),/expired/);}finally{await f.c.close();}});
test('old identity is obtained by fresh getUser, caller UUID and editable metadata do not prove identity',async()=>{let seen;const source=new SupabaseMigrationSource({url:'https://project.supabase.co',publishableKey:'public',bridge:{},clientFactory:()=>({auth:{getUser:async token=>{seen=token;return {data:{user:{id:'actual-source-subject',user_metadata:{owner:'forged'}}}};}}})});assert.deepEqual(await source.authenticate('a'.repeat(40)),{subject:'actual-source-subject'});assert.equal(seen,'a'.repeat(40));assert.throws(()=>new SupabaseMigrationSource({url:'https://attacker.test'}),/origin/);});

test('failed target group commits no rows and signs a terminal, retryable cancellation',async()=>{
 const f=await fixture();
 try{
  f.exported.profiles.push({id:'old-2',name:'quota-failure',address:{house:'12/А'},preferences:{}});
  const p=await f.service.handle(f.session,{schemaVersion:1,action:'preview',sourceAccessToken:'old-session'});
  const input={schemaVersion:1,action:'commit',sourceAccessToken:'old-session',backupSaved:true,envelope:p.envelope};
  await assert.rejects(f.service.handle(f.session,input),/migration_target_rejected/);
  assert.equal((await f.c.query('select count(*)::int n from public.svitlo_profiles')).rows[0].n,0);
  assert.deepEqual(f.calls,['freeze','abort']);
  const cancel=f.source.lastAbort.cancellation;
  const {verify}=await import('node:crypto'),{canonicalJson}=await import('../planning/service.js');
  assert(verify(null,Buffer.from(canonicalJson(cancel.statement)),f.service.publicKey,Buffer.from(cancel.signature,'base64url')));
  assert.equal(cancel.statement.targetSubject,f.owner);
  assert.equal(cancel.statement.aborted,true);
  await assert.rejects(f.service.handle(f.session,input),/migration_transfer_aborted/);
  assert.deepEqual(f.calls,['freeze','abort','abort']);
  assert.equal((await f.c.query("select has_function_privilege('svitlo_stage_api','svitlo_migration.commit_before_saga(uuid,text,jsonb)','EXECUTE') allowed")).rows[0].allowed,false);
 }finally{await f.c.close();}
});
