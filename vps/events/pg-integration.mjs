// Only a disposable database. No operator traffic, push or application runtime.
import pg from 'pg';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {verifyOutbox} from './assertions.mjs';
const database=process.env.PGDATABASE;
if(!/^svitlo_modular_qa_\d+$/.test(database||''))throw Error('Disposable modular QA database required');
const config={host:process.env.PGHOST||'postgres',user:'svitlo_owner',database,
 password:process.env.CI==='true'?'isolated-history-ci':(await readFile('/run/secrets/owner_password','utf8')).trim()};
const c=new pg.Client(config);await c.connect();
try{
 await c.query(`create schema svitlo_vps;create table svitlo_vps.catalog(id uuid primary key,kind text default 'address',parent_id uuid,label text,operator_id text,redirect_to uuid,metadata jsonb default '{}',source_ref jsonb default '{}')`);
 await c.query('begin');await c.query(await readFile(new URL('../sql/modular-outbox.sql',import.meta.url),'utf8'));await c.query('commit');
 const checks=await verifyOutbox(c);
 await c.query('truncate svitlo_events.jobs,svitlo_events.catalog_dirty');
 await c.query("insert into svitlo_vps.catalog(id,label) select gen_random_uuid(),'Synthetic '||g from generate_series(1,4) g");
 const a=new pg.Client(config),b=new pg.Client(config);await a.connect();await b.connect();
 try{
  await a.query('begin');await a.query('set local role svitlo_stage_worker');
  const first=(await a.query('select * from svitlo_events.claim(2)')).rows;
  await b.query('begin');await b.query("set local statement_timeout='2s'");await b.query('set local role svitlo_stage_worker');
  const second=(await b.query('select * from svitlo_events.claim(2)')).rows;
  assert.equal(first.length,2);assert.equal(second.length,2);
  assert.equal(new Set([...first,...second].map(j=>j.id)).size,4,'simultaneous workers claim disjoint jobs without waiting');
  await b.query('commit');
  await a.end(); // A crashed before claim commit: its two jobs remain available.
  const recovered=(await b.query('select * from svitlo_events.claim(2)')).rows;
  assert.deepEqual(new Set(recovered.map(j=>j.id)),new Set(first.map(j=>j.id)));
  console.log(JSON.stringify({scope:'modular-outbox-postgresql',server:(await c.query('show server_version')).rows[0].server_version,checks:checks+4,concurrentWorkers:2,syntheticOnly:true}));
 }finally{await a.end().catch(()=>{});await b.end();}
}finally{await c.end();}
