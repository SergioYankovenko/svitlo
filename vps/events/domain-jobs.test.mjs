import test from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';import {readFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';
import {DomainJobs} from './domain-jobs.js';
async function fixture(){const c=new PGlite();await c.exec("create role svitlo_stage_api;create role svitlo_stage_worker;create role svitlo_stage_session;create schema svitlo_vps;create table svitlo_vps.catalog(id uuid primary key,kind text,parent_id uuid,label text,operator_id text,redirect_to uuid,metadata jsonb,source_ref jsonb)");
 for(const f of ['modular-outbox.sql','domain-jobs.sql'])await c.exec(await readFile(new URL('../sql/'+f,import.meta.url),'utf8'));
 return c;
}
const publish=async(c,key='account-a',revision=1,payload={accountId:randomUUID(),entitlementRevision:1})=>(await c.query("select svitlo_events.publish('entitlement.changed.v1',$1,$2,$3::jsonb) id",[key,revision,JSON.stringify(payload)])).rows[0].id;
test('module change and events roll back together, revisions are immutable, namespace grants stay closed',async()=>{
 const c=await fixture();try{
  await c.exec('begin');await publish(c);await c.exec('rollback');assert.equal((await c.query('select count(*)::int n from svitlo_events.domain_events')).rows[0].n,0);
  const data={accountId:randomUUID(),entitlementRevision:1},id=await publish(c,'a',1,data);assert.equal(await publish(c,'a',1,data),id);
  await assert.rejects(()=>publish(c,'a',1,{...data,entitlementRevision:2}),/conflict/);
  await assert.rejects(()=>publish(c,'secret',1,{purchaseToken:'private'}),/invalid domain event/);
  await c.exec('set role svitlo_stage_worker');
  await assert.rejects(()=>publish(c),e=>e.code==='42501');await assert.rejects(()=>c.query('select * from svitlo_events.domain_events'),e=>e.code==='42501');
  const jobs=(await c.query("select svitlo_events.claim_delivery('entitlement-project-v1',10,1) value")).rows[0].value;assert.equal(jobs.length,1);
  assert.equal((await c.query('select svitlo_events.finish_delivery($1,$2) value',[jobs[0].deliveryId,randomUUID()])).rows[0].value,false);
 }finally{await c.close();}
});
test('DB effect and ACK share a transaction; crash/retry and an expired lease cannot double-apply',async()=>{
 const c=await fixture();try{
  await c.exec('create table effects(id text primary key,revision bigint)');await publish(c);
  const pool={query:(...a)=>c.query(...a),connect:async()=>({query:(...a)=>c.query(...a),release(){}})},jobs=new DomainJobs(pool),job=(await jobs.claim('entitlement-project-v1'))[0];
  await assert.rejects(()=>jobs.database(job,async({tx})=>{await tx.query("insert into effects values('one',1)");throw Error('crash before ACK');}));
  assert.equal((await c.query('select count(*)::int n from effects')).rows[0].n,0);
  await jobs.database(job,async({tx})=>tx.query("insert into effects values('one',1)"));
  await assert.rejects(()=>jobs.database(job,async()=>assert.fail('duplicate effect')),e=>e.code==='lease_lost');
  assert.equal((await c.query('select count(*)::int n from effects')).rows[0].n,1);
 }finally{await c.close();}
});
test('unsupported versions wait, retries have bounded jitter, expired work is quarantined and replay is audited/idempotent',async()=>{
 const c=await fixture();try{
  await publish(c);const jobs=new DomainJobs({query:(...a)=>c.query(...a)});let job=(await jobs.claim('entitlement-project-v1'))[0];
  await jobs.fail(job,'private vendor token');let row=(await c.query('select * from svitlo_events.deliveries')).rows[0];
  assert.equal(row.error_code,'handler_error');const delay=new Date(row.next_at)-Date.now();assert.ok(delay>2000&&delay<6500);
  await c.query("update svitlo_events.deliveries set state='dead',finished_at=clock_timestamp() where id=$1",[job.deliveryId]);
  const actor=randomUUID(),request=randomUUID(),reason='Verified dependency recovery';
  assert.equal((await c.query('select svitlo_events.replay_delivery($1,$2,$3,$4) value',[job.deliveryId,actor,request,reason])).rows[0].value,true);
  assert.equal((await c.query('select svitlo_events.replay_delivery($1,$2,$3,$4) value',[job.deliveryId,actor,request,reason])).rows[0].value,true);
  assert.equal((await c.query('select count(*)::int n from svitlo_events.replay_audit')).rows[0].n,1);
  await c.query('update svitlo_events.domain_events set schema_version=2');assert.equal((await jobs.claim('entitlement-project-v1')).length,0);
  await c.query("update svitlo_events.domain_events set deadline=clock_timestamp()-interval '1 second'");
  assert.equal((await jobs.claim('entitlement-project-v1')).length,0);row=(await c.query('select * from svitlo_events.deliveries')).rows[0];assert.equal(row.state,'dead');assert.equal(row.error_code,'deadline_expired');
  assert.equal((await c.query('select svitlo_events.replay_delivery($1,$2,$3,$4) value',[job.deliveryId,actor,randomUUID(),reason])).rows[0].value,false);
 }finally{await c.close();}
});
test('external effect before a lost ACK reuses the same provider idempotency key after lease recovery',async()=>{
 const c=await fixture();try{
  await publish(c);const pool={query:(...a)=>c.query(...a),connect:async()=>({query:(...a)=>c.query(...a),release(){}})},jobs=new DomainJobs(pool);
  let job=(await jobs.claim('entitlement-project-v1'))[0],calls=0;const effects=new Set();
  const send=async({idempotencyKey})=>{calls++;effects.add(idempotencyKey);return {accepted:true};};
  await assert.rejects(()=>jobs.external(job,async context=>{const r=await send(context);await c.query("update svitlo_events.deliveries set lease_until=clock_timestamp()-interval '1 second' where id=$1",[job.deliveryId]);return r;}),e=>e.code==='lease_lost');
  job=(await jobs.claim('entitlement-project-v1'))[0];await jobs.external(job,send);
  assert.equal(calls,2);assert.equal(effects.size,1);assert.equal((await c.query('select state from svitlo_events.deliveries')).rows[0].state,'done');
 }finally{await c.close();}
});
