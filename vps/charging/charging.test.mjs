import test from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';import {readFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';
import {normalizeOcm} from './catalog.js';import {viewport,chargingForecast} from './service.js';import {civil,dayKey} from '../../app/lib/time.js';
const provider={id:1,reviewed:true,licenseText:'Licensed under CC BY 4.0',name:'Open Charge Map',url:'https://openchargemap.org/',license:'CC BY 4.0',licenseUrl:'https://creativecommons.org/licenses/by/4.0/'};
const row=()=>({ID:100,DataProviderID:1,DataProvider:{IsOpenDataLicensed:true,License:provider.licenseText},AddressInfo:{Country:{ISOCode:'UA'},Title:'QA station',Town:'Київ',AddressLine1:'Публічна адреса',Latitude:50.45,Longitude:30.52},Connections:[{ID:1,PowerKW:50,ConnectionTypeID:33,Quantity:2},{ID:2,PowerKW:22,ConnectionTypeID:25}],StatusType:{IsOperational:true},DateLastVerified:'2026-11-06T12:00:00Z'});
test('license mismatch quarantines catalog, public fields only, multiple connectors never become live observations',()=>{const s=normalizeOcm({...row(),ContactEmail:'not-exported',UserComments:[{private:'discard'}]},{provider});assert.equal(s.connectors.length,2);assert.equal(s.reportedOperational,true);assert.equal(s.liveState,undefined);assert.equal(s.ContactEmail,undefined);assert.throws(()=>normalizeOcm(row(),{provider:{...provider,reviewed:false}}),/license/);const changed=row();changed.DataProvider.License='Other terms';assert.throws(()=>normalizeOcm(changed,{provider}),/license/);});
test('bounded viewport does not accept GPS or entire-country scans',()=>{assert.equal(viewport({bounds:{west:30,south:50,east:31,north:51}}).west,30);for(const b of [{west:22,south:44,east:41,north:53},{west:NaN,south:50,east:31,north:51},{west:30,south:50,east:31,north:51,latitude:50}])assert.throws(()=>viewport({bounds:b}),/карту/);});
test('electrical binding must be exact, current and reviewed; backup power and source plan remain conditional',()=>{
 const date='2026-11-07',now=civil(date,540),binding={reviewed:true,addressId:'home',lineId:'line',proof:'operator review 1',validFrom:now-1,validUntil:now+3600000,backupPower:'yes'},snapshot={schemaVersion:1,revision:'r1',addressId:'home',operatorId:'op',timeZone:'Europe/Kyiv',coverage:{fromDate:date,toDate:date},resolution:{state:'resolved',complete:true},lines:[{id:'line',label:'L',groupCode:null,supportedCategories:['hourly'],categories:{hourly:{checkedAt:now,sourceUpdatedAt:now,freshUntil:now+3600000,days:[{date,state:'published',intervals:[]}]}}}],notices:[],provenance:[],checkedAt:now,sourceUpdatedAt:now,freshUntil:now+3600000,refreshAfter:now+60000,supportState:'available'};
 for(const b of [null,{...binding,reviewed:false},{...binding,validUntil:now-1},{...binding,addressId:'nearest-home'}])assert.equal(chargingForecast({binding:b,snapshot,date,now}).state,'unknown');const result=chargingForecast({binding,snapshot,date,now});assert.equal(result.state,'conditional');assert.equal(result.guaranteed,false);assert.equal(result.stationAvailability,'unknown');assert.equal(result.reason,'backup_power_reported');snapshot.notices=[{kind:'regional_emergency',active:true,start:0,end:null}];assert.equal(chargingForecast({binding,snapshot,date,now}).state,'unknown');
});
test('SQL defaults off without PostGIS; changed pin invalidates electrical review and import deduplicates provider IDs',async()=>{
 const c=new PGlite();try{await c.exec('create role svitlo_stage_api;create role svitlo_stage_worker;create schema svitlo_vps;create table svitlo_vps.catalog(id uuid primary key);create table svitlo_vps.address_lines(id uuid primary key,address_id uuid,active boolean);');await c.exec(await readFile(new URL('../sql/charging.sql',import.meta.url),'utf8'));
 const cap=(await c.query('select svitlo_charging.capabilities() value')).rows[0].value;assert.equal(cap.enabled,false);assert.equal(cap.postgis,false);assert.equal(cap.locationRequired,false);await c.exec('update svitlo_charging.providers set reviewed=true');const s=normalizeOcm(row(),{provider});await c.query('select svitlo_charging.import_catalog($1)',[JSON.stringify([s])]);await c.query('select svitlo_charging.import_catalog($1)',[JSON.stringify([s])]);assert.equal((await c.query('select count(*)::int n from svitlo_charging.stations')).rows[0].n,1);
 const home=randomUUID(),line=randomUUID();await c.query('insert into svitlo_vps.catalog values($1)',[home]);await c.query('insert into svitlo_vps.address_lines values($1,$2,true)',[line,home]);await c.query("insert into svitlo_charging.bindings values($1,$2,$3,true,'operator exact proof',$4,now(),now()+interval '1 day','unknown')",[s.id,home,line,randomUUID()]);await c.query('select svitlo_charging.import_catalog($1)',[JSON.stringify([{...s,latitude:s.latitude+.01}])]);assert.equal((await c.query('select reviewed from svitlo_charging.bindings')).rows[0].reviewed,false);assert.equal((await c.query("select has_table_privilege('svitlo_stage_api','svitlo_charging.bindings','INSERT') value")).rows[0].value,false);
 }finally{await c.close();}
});

test('charging worker stays off until reviewed and applies a refreshed station once via a durable delivery',async()=>{
 const {OpenChargeMap}=await import('./catalog.js'),{ChargingCollector}=await import('./collector.js'),{DomainJobs}=await import('../events/domain-jobs.js');
 const c=new PGlite();let calls=0;
 const pool={query:(...args)=>c.query(...args),connect:async()=>({query:(...args)=>c.query(...args),release(){}})};
 try{
  await c.exec('create role svitlo_stage_api;create role svitlo_stage_worker;create role svitlo_stage_session;create role svitlo_events_owner;create schema svitlo_events authorization svitlo_events_owner;grant usage on schema svitlo_events to svitlo_stage_worker;create schema svitlo_vps;create table svitlo_vps.catalog(id uuid primary key);create table svitlo_vps.address_lines(id uuid primary key,address_id uuid,active boolean);');
  for(const file of ['domain-jobs.sql','charging.sql','charging-collector.sql'])await c.exec(await readFile(new URL('../sql/'+file,import.meta.url),'utf8'));
  const policy={...provider,name:'Open Charge Map Contributors',license:'CC BY-SA 4.0',licenseUrl:'https://creativecommons.org/licenses/by-sa/4.0/'};
  const source=new OpenChargeMap({key:'fixture-key-not-secret',provider:policy,fetcher:async(url,opts)=>{
   calls++;assert.equal(url.origin,'https://api.openchargemap.io');assert.equal(url.searchParams.get('chargepointid'),'100');
   assert.equal(url.searchParams.get('includecomments'),'false');assert.equal(url.searchParams.get('verbose'),'true');
   assert.equal(opts.redirect,'error');const updated=row();updated.AddressInfo.Title='Updated charging station';return Response.json([updated]);
  }});
  const collector=new ChargingCollector({pool,source,jobs:new DomainJobs(pool)});
  await c.exec("update svitlo_charging.providers set reviewed=true");
  await c.query('select svitlo_charging.import_catalog($1)',[JSON.stringify([normalizeOcm(row(),{provider:policy,now:Date.now()-7*3600000})])]);
  await c.exec('set role svitlo_stage_worker');
  assert.deepEqual(await collector.tick(),{state:'disabled'});assert.equal(calls,0);
  await c.exec('reset role;update svitlo_charging.control set collector_enabled=true;set role svitlo_stage_worker');
  assert.deepEqual(await collector.tick(),{state:'progress'});assert.equal(calls,1);
  assert.deepEqual(await collector.tick(),{state:'idle'});assert.equal(calls,1);
  await c.exec('reset role');
  const got=(await c.query('select label from svitlo_charging.stations')).rows[0];
  assert.equal(got.label,'Updated charging station');
  assert.equal((await c.query("select count(*)::int n from svitlo_events.deliveries where consumer='charging-refresh-v1' and state='done'")).rows[0].n,1);
  assert.equal((await c.query("select has_function_privilege('svitlo_stage_worker','svitlo_charging.import_catalog(jsonb)','EXECUTE') ok")).rows[0].ok,false);
  assert.equal((await c.query('select svitlo_charging.capabilities() value')).rows[0].value.enabled,false);
 }finally{await c.close();}
});
