import test,{after} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {PGlite} from '@electric-sql/pglite';
import {loadBundle} from '../geography/bundle.mjs';import {importGeography} from '../geography/import.mjs';import {seedDiscovery} from './seed.mjs';import {DiscoveryCollector,queueOutcome,transportOutcome} from './collector.mjs';
import {compileTerritories,loadTerritorySnapshot,importTerritories} from './territory.mjs';
const db=new PGlite();await db.exec('create role anon;create role authenticated;create role svitlo_stage_api;create role svitlo_stage_worker;create schema svitlo_vps;grant usage on schema svitlo_vps to svitlo_stage_api,svitlo_stage_worker;');
const old=await readFile(new URL('../sql/universal.sql',import.meta.url),'utf8');await db.exec(old.slice(0,old.indexOf('create function public.svitlo_profile_create_universal')));
const {data}=await loadBundle();await db.exec("insert into svitlo_vps.operators(id,adapter_key,label,state) values('ua-cherkasy','cherkasy-v1','Черкасиобленерго','available'),('ua-kyiv-dtek','dtek-public-v1','Київ','available'),('ua-kyiv-region-dtek','dtek-public-v1','Область','available')");
const linked=[...new Map(data.routes.filter(r=>r.legacyCatalogCityId).map(r=>[r.legacyCatalogCityId,r])).values()];
for(const r of linked)await db.query("insert into svitlo_vps.catalog(id,kind,label) values($1,'city',$2)",[r.legacyCatalogCityId,r.providerCityName]);
for(const r of data.routes.filter(r=>r.operatorId==='ua-cherkasy'&&r.legacyCatalogCityId))await db.query("insert into svitlo_vps.catalog_aliases values('ua-cherkasy','city',$1::jsonb::text,$2) on conflict do nothing",[JSON.stringify([r.branchId,r.providerCityId]),r.legacyCatalogCityId]);
await db.exec(await readFile(new URL('../sql/catalog-quality.sql',import.meta.url),'utf8'));
await db.exec(await readFile(new URL('../sql/settlement-directory.sql',import.meta.url),'utf8'));await importGeography(db);
await db.exec(await readFile(new URL('../sql/geography-discovery.sql',import.meta.url),'utf8'));await seedDiscovery(db);


await db.exec("create schema svitlo_regions;create table svitlo_regions.provider_state(operator text primary key,next_at bigint not null default 0,lease_until bigint not null default 0,cooldown_until bigint not null default 0);alter table svitlo_regions.provider_state enable row level security;create table public.svitlo_provider_hosts(host text primary key,next_start bigint not null default 0,cooldown_until bigint not null default 0);alter table public.svitlo_provider_hosts enable row level security;");
await db.exec(await readFile(new URL('../sql/discovery-throughput.sql',import.meta.url),'utf8'));
await db.exec(await readFile(new URL('../sql/discovery-territory.sql',import.meta.url),'utf8'));
after(()=>db.close());
const snapshot=await loadTerritorySnapshot(),byCode=new Map(snapshot.places.map(p=>[p.code,p]));
test('official snapshot joins every current code and separates liberated cities from occupation',()=>{
 assert.equal(snapshot.places.length,data.nodes.length);assert.equal(byCode.size,data.nodes.length);assert.equal(snapshot.diagnostics.unmatchedCodes,0);
 for(const code of ['UA01000000000013043','UA85000000000065278','UA14140050010029262'])assert.equal(byCode.get(code).status,'occupied');
 assert.equal(byCode.get('UA32080070010087821').status,'liberated');assert.equal(byCode.get('UA65100150010064384').status,'active_combat');
});
const flags={statusWarfare:false,statusWarfareWithResources:false,statusFinishedWarfare:false,statusPossibleWarfare:false,statusFinishedPossibleWarfare:false,statusTemporaryOccupation:false,statusLiberated:false};
const nodes=[{code:'UA01000000000013043',level:1},{code:'UA01010000000000001',parentCode:'UA01000000000013043',level:2},{code:'UA01010000000000002',parentCode:'UA01010000000000001',level:3}];
const row=(id,code,extra={})=>({id,katottgCode:code,katottgLevel:1,dateOfChange:'2022-01-01',endOrderDate:null,updatedAt:'2026-11-05T09:00:00Z',...flags,...extra});
const compile=r=>compileTerritories(r,nodes,{checkedAt:'2026-11-05T15:00:00Z',minRows:1});
test('hierarchy inherits occupation but more specific liberation overrides it despite source level mismatch',()=>{
 const s=compile([row(1,nodes[0].code,{statusTemporaryOccupation:true}),row(2,nodes[2].code,{statusLiberated:true})]);
 assert.deepEqual(s.places.map(p=>p.status),['occupied','occupied','liberated']);assert.deepEqual(s.places.map(p=>p.code),nodes.map(n=>n.code));assert.equal(s.places[1].sourceCode,nodes[0].code);
});
test('ended and future occupation intervals cannot suppress current collection',()=>{
 const s=compile([row(1,nodes[0].code,{statusTemporaryOccupation:true,endOrderDate:'2026-11-05'}),row(2,nodes[1].code,{statusTemporaryOccupation:true,dateOfChange:'2026-11-06'})]);assert.ok(s.places.every(p=>p.status==='unlisted'));
 const invalid=compile([row(1,nodes[0].code,{endOrderDate:'2021-01-01'})]);assert.equal(invalid.diagnostics.historicalInvalidIntervals,1);
});
test('overlaps and conflicting current flags become ambiguous, never occupied',()=>{
 assert.ok(compile([row(1,nodes[0].code,{statusTemporaryOccupation:true,statusLiberated:true})]).places.every(p=>p.status==='ambiguous'));
 assert.ok(compile([row(1,nodes[0].code,{statusTemporaryOccupation:true}),row(2,nodes[0].code,{statusTemporaryOccupation:true})]).places.every(p=>p.status==='ambiguous'));
 assert.throws(()=>compileTerritories([],nodes));assert.throws(()=>compile([row(1,nodes[0].code,{dateOfChange:'2026-02-30'})]));assert.throws(()=>compile([row(1,nodes[0].code,{statusTemporaryOccupation:'true'})]));
});
test('import is additive, retains all task checkpoints, and older snapshots cannot roll back a newer edition',async()=>{
 const before=(await db.query('select * from svitlo_discovery.jobs order by id')).rows;
 assert.equal((await importTerritories(db,snapshot)).status,'imported');assert.deepEqual((await db.query('select * from svitlo_discovery.jobs order by id')).rows,before);
 assert.equal((await db.query('select count(*)::int n from svitlo_discovery.territory_places')).rows[0].n,data.nodes.length);
 assert.equal((await importTerritories(db,snapshot)).status,'newer_snapshot_retained');
});
const claim=async()=>(await db.query('select svitlo_discovery.claim() result')).rows[0].result;
const ready=async()=>{
 await db.exec("update svitlo_discovery.jobs set token=null,lease_until='-infinity',next_at=now()+interval '10 years';update svitlo_discovery.operator_turn set last_claimed_at='-infinity',cooldown_until='-infinity';update svitlo_discovery.state set daily_claims=0,day_key=(now() at time zone 'Europe/Kyiv')::date,last_claim_at='-infinity';update svitlo_discovery.territory_routes set held=true;update svitlo_discovery.territory_current set expires_at=now()+interval '1 day'");
 const j=(await db.query("select id,route_id from svitlo_discovery.jobs where kind='city' order by id limit 1")).rows[0];await db.query('update svitlo_discovery.jobs set next_at=now() where id=$1',[j.id]);return j;
};
test('occupied routes are held before claim without consuming budget, attempts or checkpoints',async()=>{
 await ready();const before=(await db.query('select id,attempts,checkpoint from svitlo_discovery.jobs order by id')).rows;
 assert.notEqual((await claim()).state,'claimed');assert.equal((await db.query('select daily_claims from svitlo_discovery.state')).rows[0].daily_claims,0);assert.deepEqual((await db.query('select id,attempts,checkpoint from svitlo_discovery.jobs order by id')).rows,before);
});
test('released or expired territory hold makes the original queued job eligible again',async()=>{
 const j=await ready();await db.query('update svitlo_discovery.territory_routes set held=false where route_id=$1',[j.route_id]);assert.equal((await claim()).id,j.id);
 await ready();await db.exec("update svitlo_discovery.territory_current set checked_at=now()-interval '8 days',expires_at=now()-interval '1 second'");assert.equal((await claim()).id,j.id);
});
test('runtime API and worker cannot tamper with administrative mask or its expiry',async()=>{
 for(const role of ['svitlo_stage_worker','svitlo_stage_api']){await db.exec('set role '+role);for(const q of ['select * from svitlo_discovery.territory_places','delete from svitlo_discovery.territory_routes',"update svitlo_discovery.territory_current set expires_at=now()+interval '1 year'"])await assert.rejects(()=>db.query(q),e=>e.code==='42501');await db.exec('reset role');}
});
