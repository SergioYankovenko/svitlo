import test from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';import {readFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';
test('bounded catalogue page allocation preserves complete house labels and canonical IDs; partial reviews cannot change bindings',async()=>{
 const c=new PGlite();try{
  await c.exec(`create role svitlo_stage_api;create role svitlo_stage_worker;create role svitlo_stage_session;create schema svitlo_vps;create schema svitlo_geo;create schema svitlo_discovery;
   create table svitlo_geo.places(code text primary key);create table svitlo_vps.catalog(id uuid primary key default gen_random_uuid(),kind text,parent_id uuid,label text,operator_id text,metadata jsonb default '{}',source_ref jsonb default '{}',redirect_to uuid);
   create function svitlo_vps.catalog_allowed(uuid) returns boolean language sql as 'select true';
   create function svitlo_discovery.catalog_entry(rid text,settlement text,k text,p uuid,sk text,l text) returns uuid language plpgsql security definer set search_path='' as $$
   declare result uuid;begin select id into result from svitlo_vps.catalog where parent_id=p and source_ref->>'key'=sk;if result is null then insert into svitlo_vps.catalog(kind,parent_id,label,operator_id,source_ref) values(k,p,l,'ua-cherkasy',jsonb_build_object('key',sk)) returning id into result;end if;return result;end $$;
   grant usage on schema svitlo_vps,svitlo_geo,svitlo_discovery to svitlo_stage_api;grant select on svitlo_vps.catalog to svitlo_stage_api`);
  await c.exec(await readFile(new URL('../sql/canonical-catalog.sql',import.meta.url),'utf8'));
  const city=randomUUID(),street=randomUUID();await c.query("insert into svitlo_vps.catalog(id,kind,label,parent_id) values($1,'city','Київ',null),($2,'street','Перевірена вулиця',$1)",[city,street]);
  await c.exec('set role svitlo_stage_api');
  const page=[{id:'10 a',name:'10 а'},{id:'10/1',name:'10/1'},{id:'10k1',name:'10 корпус 1'}];
  const allocate=async rows=>(await c.query("select svitlo_discovery.catalog_entries('reviewed-route','reviewed-settlement','address',$1,$2::jsonb) value",[street,JSON.stringify(rows)])).rows[0].value;
  const first=await allocate(page),second=await allocate(page);assert.deepEqual(first.map(x=>x.id),second.map(x=>x.id));assert.deepEqual(first.map(x=>x.label),page.map(x=>x.name));assert.ok(first.every(x=>x.city==='Київ'&&x.street==='Перевірена вулиця'));
  await assert.rejects(()=>allocate(Array.from({length:51},()=>page[0])),/invalid catalogue page/);await assert.rejects(()=>allocate([{name:'missing key'}]),/invalid catalogue page/);
  await c.query('select svitlo_catalog.record_review($1,$2,$3::jsonb)',[first[0].id,'partial_binding','["GPV1.1"]']);
  await assert.rejects(()=>c.query('select * from svitlo_catalog.binding_reviews'),e=>e.code==='42501');
  await c.exec('reset role');const review=(await c.query('select * from svitlo_catalog.binding_reviews')).rows[0];assert.deepEqual(review.evidence,{lineKeys:['GPV1.1']});assert.equal(review.state,'open');
  assert.equal((await c.query('select count(*)::int n from svitlo_vps.catalog')).rows[0].n,5);
 }finally{await c.close();}
});
