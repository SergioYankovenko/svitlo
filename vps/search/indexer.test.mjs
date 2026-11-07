import test from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';import {randomUUID} from 'node:crypto';
import {prepareSearchFixture,poolFor} from './fixture.mjs';import {SearchIndexer} from './indexer.js';import {anchorId} from './meili.js';
class MemorySink {
 constructor(){this.indices=new Map();this.interrupt=null;}
 async ensure(name){if(this.indices.has(name))return false;this.indices.set(name,new Map());return true;}
 async drain(){}
 async upsert(name,rows){if(this.interrupt){const fn=this.interrupt;this.interrupt=null;await fn();}for(const row of rows)this.indices.get(name).set(row.id,structuredClone(row));}
}
async function seed(c){const city=randomUUID(),street=randomUUID(),home=randomUUID();await c.query("insert into svitlo_vps.catalog(id,kind,label,parent_id,operator_id) values($1,'city','Київ',null,null),($2,'street','Перевірена вулиця',$1,null),($3,'address','10/1',$2,'fixture-op')",[city,street,home]);return {city,street,home};}
async function settle(indexer,max=40){for(let n=0;n<max;n++){const result=await indexer.tick();if(result.state==='idle')return;}throw Error('Indexer did not settle');}
test('generation activation catches writes during backfill, drains work and preserves private role boundaries',async()=>{
 const c=new PGlite();try{await prepareSearchFixture(c);const ids=await seed(c),sink=new MemorySink(),indexer=new SearchIndexer({pool:poolFor(c),client:sink});
  const queued=(await c.query('select count(*)::int n from svitlo_search.work')).rows[0].n;assert.equal(queued,3);
  sink.interrupt=async()=>c.query("update svitlo_vps.catalog set label='10 корпус 2' where id=$1",[ids.home]);
  await settle(indexer);const generation=(await c.query('select active_generation from svitlo_search.control')).rows[0].active_generation;
  assert.equal(sink.indices.get(generation).get(ids.home).label,'10 корпус 2');
  assert.equal((await c.query('select count(*)::int n from svitlo_search.work')).rows[0].n,0);
  const state=(await c.query("select svitlo_search.scope_state('address',$1) value",[ids.street])).rows[0].value;
  assert.ok(state.ready);assert.equal(sink.indices.get(generation).get(anchorId('address:'+ids.street)).scopeToken,state.scopeToken);
  await c.exec('set role svitlo_stage_api');await assert.rejects(()=>c.query('select * from svitlo_search.work'),e=>e.code==='42501');await assert.rejects(()=>c.query("select svitlo_search.activate('svitlo_catalog_g_unsafe000')"),e=>e.code==='42501');
 }finally{await c.close();}
});
test('changed parent/reviewed alias reprojects descendants; source check timestamps do not enqueue; deleted houses become hidden tombstones',async()=>{
 const c=new PGlite();try{await prepareSearchFixture(c);const ids=await seed(c),sink=new MemorySink(),indexer=new SearchIndexer({pool:poolFor(c),client:sink});await settle(indexer);
  await c.query("update svitlo_vps.catalog set metadata='{\"sourceCheckedAt\":123}' where id=$1",[ids.street]);assert.equal((await c.query('select count(*)::int n from svitlo_search.work')).rows[0].n,0);
  await c.query("insert into svitlo_catalog.name_aliases(entity_id,label,source_reference,valid_from,reviewed) values($1,'Історична назва','Synthetic reviewed manifest',now(),true)",[ids.street]);await settle(indexer);
  const generation=(await c.query('select active_generation from svitlo_search.control')).rows[0].active_generation;
  assert.deepEqual(sink.indices.get(generation).get(ids.street).aliases,['Історична назва']);
  await c.query("update svitlo_vps.catalog set metadata=metadata||'{\"catalogStatus\":\"service\"}'::jsonb where id=$1",[ids.street]);await settle(indexer);assert.equal(sink.indices.get(generation).get(ids.home).allowed,false);
  await c.query('delete from svitlo_vps.catalog where id=$1',[ids.home]);await settle(indexer);assert.equal(sink.indices.get(generation).get(ids.home).allowed,false);
 }finally{await c.close();}
});
test('rebuild mirrors concurrent changes to old/new generations and activation refuses an incomplete target',async()=>{
 const c=new PGlite();try{await prepareSearchFixture(c);const ids=await seed(c),sink=new MemorySink(),indexer=new SearchIndexer({pool:poolFor(c),client:sink});await settle(indexer);
  const old=(await c.query('select active_generation from svitlo_search.control')).rows[0].active_generation,name='svitlo_catalog_g_rebuild0001';
  await c.query('select svitlo_search.create_generation($1)',[name]);assert.equal((await c.query('select svitlo_search.activate($1) value',[name])).rows[0].value,false);
  sink.interrupt=async()=>c.query("update svitlo_vps.catalog set label='12-А' where id=$1",[ids.home]);await settle(indexer);
  assert.equal((await c.query('select active_generation from svitlo_search.control')).rows[0].active_generation,name);
  assert.equal(sink.indices.get(name).get(ids.home).label,'12-А');assert.equal(sink.indices.get(old).get(ids.home).label,'12-А');
 }finally{await c.close();}
});
