import test from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';import {readFile} from 'node:fs/promises';import {seedSourceRegistry} from './evidence.js';
test('source registry seeding is idempotent; transport failure never advances last accepted evidence',async()=>{
 const c=new PGlite();try{
  await c.exec('create role svitlo_stage_api;create role svitlo_stage_worker;create role svitlo_stage_session');await c.exec(await readFile(new URL('../sql/source-evidence.sql',import.meta.url),'utf8'));
  await seedSourceRegistry(c);await seedSourceRegistry(c);assert.equal((await c.query('select count(*)::int n from svitlo_sources.registry')).rows[0].n,28);
  const now=Date.now(),success=now-60000,base={sourceId:'ua-cherkasy',phase:'normalize',outcome:'accepted',contentHash:'a'.repeat(64),status:200,bytes:100,parserVersion:'cherkasy-v1',observedAt:now,checkedAt:success};
  await c.exec('set role svitlo_stage_api');for(const value of [base,{...base,phase:'fetch',outcome:'forbidden',status:403,checkedAt:undefined,contentHash:null,observedAt:now+1000}])await c.query('select svitlo_sources.record($1::jsonb)',[JSON.stringify(value)]);
  await assert.rejects(()=>c.query('select * from svitlo_sources.evidence'),e=>e.code==='42501');await c.exec('reset role');
  const row=(await c.query("select * from svitlo_sources.state where source_id='ua-cherkasy'")).rows[0];assert.equal(new Date(row.last_success_at).getTime(),success);assert.equal(row.last_outcome,'forbidden');
  assert.equal((await c.query('select count(*)::int n from svitlo_sources.evidence')).rows[0].n,2);
 }finally{await c.close();}
});
