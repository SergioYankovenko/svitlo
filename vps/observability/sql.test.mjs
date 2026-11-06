import test from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';import {readFile} from 'node:fs/promises';
test('aggregate diagnostics expose liveness and progress separately without granting API queue access',async()=>{
 const c=new PGlite();try{
  await c.exec("create role svitlo_stage_api;create role svitlo_stage_worker;create role svitlo_stage_session;create schema svitlo_vps;create table svitlo_vps.catalog(id uuid primary key,kind text,parent_id uuid,label text,operator_id text,redirect_to uuid,metadata jsonb,source_ref jsonb)");
  for(const file of ['modular-outbox.sql','operations-metrics.sql'])await c.exec(await readFile(new URL('../sql/'+file,import.meta.url),'utf8'));
  await c.exec("set role svitlo_stage_worker;select svitlo_events.cycle('attempt',0);select svitlo_events.cycle('ok',0);reset role;set role svitlo_stage_api");
  const summary=(await c.query('select svitlo_events.summary() value')).rows[0].value;
  assert.ok(summary.lastCycleSeconds>0);assert.equal(summary.lastProgressSeconds,null);assert.deepEqual(summary.jobs,{});
  await assert.rejects(()=>c.query('select * from svitlo_events.jobs'),e=>e.code==='42501');
  await assert.rejects(()=>c.query("select svitlo_events.cycle('ok',1)"),e=>e.code==='42501');
  await c.exec("reset role;set role svitlo_stage_worker;select svitlo_events.cycle('ok',1);reset role");
  assert.ok((await c.query('select svitlo_events.summary() value')).rows[0].value.lastProgressSeconds>0);
 }finally{await c.close();}
});
