import {PhoneSensors} from '../vps/sensors/phone.js';
import {SensorAccess} from '../vps/sensors/service.js';
import {sensorSignalView} from '../app/lib/map-sensor.js';
import {verifyLineSql} from '../vps/universal/line-assertions.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {addressGroupCount,confirmedLines,lineGuideKey} from '../app/lib/address-groups.js';

test('line views count homes and only a complete same-address resolution expands',()=>{
 const a={canonicalAddressId:'home',operatorId:'op'};
 assert.equal(addressGroupCount([{address:{...a,lineId:'one'}},{address:{...a,lineId:'two'}},{address:{canonicalAddressId:'other'}}]),2);
 const r={resolution:{state:'ambiguous',complete:true,lines:[{id:'a',groupCode:'1.1'},{id:'b',groupCode:'2.1'},{id:'duplicate',groupCode:'1.1'}]}};
 assert.deepEqual(confirmedLines(r).map(l=>l.id),['a','b']);r.resolution.complete=false;assert.deepEqual(confirmedLines(r),[]);
 const views=[{id:'p1',addressGroupId:'home',lineId:'l1',lineNumber:1},{id:'p2',addressGroupId:'home',lineId:'l2',lineNumber:2}];
 assert.equal(lineGuideKey(views,'p1'),lineGuideKey(views.toReversed(),'p2'));
 assert.equal(lineGuideKey(views.slice(0,1),'p1'),null);
});

async function lineDatabase(){
 const db=new PGlite();
 await db.exec('create role svitlo_stage_api;create role svitlo_stage_worker;create role svitlo_stage_session;create schema svitlo_vps;create table svitlo_vps.migrations(name text primary key,sha256 text);');
 await db.exec(await readFile(new URL('../vps/sql/platform.sql',import.meta.url),'utf8'));
 for(const file of (await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort()){
  let sql=await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8');
  if(file==='20261027203648_conditional_jobs_maintenance.sql')sql=sql.slice(0,sql.search(/create (?:or replace )?function svitlo_internal\.dispatch\(\)/i));
  try{await db.exec(sql);}catch(e){throw Error(file+': '+e.message);}
 }
 for(const file of ['runtime','session-retention','universal','universal-profile-adoption','catalog-quality','telemetry','sensor-access','sensor-ingest','sensor-history','map-addresses','phone-sensor','main-app-subscription','address-lines','phone-qr-rotation','expired-phone-qr']){
  try{await db.exec(await readFile(new URL('../vps/sql/'+file+'.sql',import.meta.url),'utf8'));}catch(e){throw Error(file+': '+e.message);}
 }
 return db;
}
test('SQL quotas, atomic groups and sensor links use homes and exact lines',async()=>{
 const db=await lineDatabase();try{await verifyLineSql(db);}finally{await db.close();}
});

// A real phone DTO must reach the real PWA mapper, rather than a hand-written fixture.
test('phone clock DTO projects trusted on/off and keeps unknown states after SQL migration',async()=>{
 const db=await lineDatabase();
 try{
  const actor=randomUUID(),pid=randomUUID();
  await db.exec("insert into svitlo_vps.operators(id,adapter_key,label,state,is_test) values('qa-clock','qa','Clock QA','available',true)");
  const city=(await db.query("insert into svitlo_vps.catalog(kind,label) values('city','Clock QA') returning id")).rows[0].id;
  const street=(await db.query("insert into svitlo_vps.catalog(kind,parent_id,label) values('street',$1,'Clock Street') returning id",[city])).rows[0].id;
  const address=(await db.query("insert into svitlo_vps.catalog(kind,parent_id,label,operator_id) values('address',$1,'1','qa-clock') returning id",[street])).rows[0].id;
  await db.query('insert into auth.users(id) values($1)',[actor]);
  await db.query("insert into svitlo_sensors.main_app_subscriptions values($1,'private_test',now()-interval '1 minute',now()+interval '1 hour',null)",[actor]);
  await db.query("insert into public.svitlo_profiles(id,owner,address) values($1,$2,$3)",[pid,actor,JSON.stringify({canonicalAddressId:address,operatorId:'qa-clock',department:'universal:qa-clock',house:'1'})]);
  await db.query("select set_config('svitlo.owner_id',$1,false)",[actor]);
  const bridge={query:(sql,args)=>db.query(sql,args)},phone=new PhoneSensors({bridge,secret:'a'.repeat(64)}),access=new SensorAccess({bridge,phone,secret:'b'.repeat(64)});
  const as=async fn=>{await db.exec('set role svitlo_stage_api');try{return await fn();}finally{await db.exec('reset role');}};
  const d=await as(()=>phone.register({schemaVersion:1,registrationToken:'sr_'+'r'.repeat(43)})),control=action=>as(()=>phone.control('Bearer '+d.controlToken,{schemaVersion:1,action,sensorId:d.sensorId}));
  const qr=(await control('owner_qr')).qr;
  const bound=await as(()=>phone.reader(actor,{schemaVersion:1,action:'connect_qr',requestId:randomUUID(),qr,profileId:pid}));
  const key=await control('ingest_credentials'),bootId=randomUUID(),monitorId=randomUUID();let sequence=0;
  const send=async(powerState,clockQuality='synchronized',eventType='sample')=>as(()=>phone.batch('Bearer '+key.ingestToken,{schemaVersion:3,sensorId:d.sensorId,bindingEpoch:bound.sensor.bindingEpoch,streamId:key.streamId,events:[{eventId:randomUUID(),sequence:++sequence,eventType,powerState,observedAt:clockQuality==='synchronized'?new Date().toISOString():null,clockQuality,bootId,monitorId,elapsedRealtimeMs:sequence*100,coverage:null}]}));
  const signal=async()=>(await as(()=>access.handle(actor,{schemaVersion:1,action:'signal',sensorId:d.sensorId,bindingEpoch:bound.sensor.bindingEpoch}))).signal;
  await send('on');const old=await signal();assert.equal(old.powerState,'on');assert.equal(old.clockQuality,undefined);assert.equal(sensorSignalView(old).state,'unknown');
  const metadata=async()=>(await db.query("select proowner,prosecdef,proacl::text from pg_proc where oid='svitlo_sensors.phone_signal(uuid,integer)'::regprocedure")).rows[0];const before=await metadata();
  await db.exec(await readFile(new URL('../vps/sql/phone-signal-clock.sql',import.meta.url),'utf8'));assert.deepEqual(await metadata(),before);
  let current=await signal();assert.equal(current.clockQuality,'synchronized');assert.equal(sensorSignalView(current).state,'on');
  assert.equal(sensorSignalView(current,900001).state,'unknown');
  await send('off');current=await signal();assert.equal(sensorSignalView(current).state,'off');
  await send('off','unsynchronized');current=await signal();assert.equal(current.clockQuality,'unsynchronized');assert.equal(sensorSignalView(current).state,'unknown');
  await send(null,'synchronized','heartbeat');assert.equal(sensorSignalView(await signal()).state,'unknown');
  await send('off');assert.equal(sensorSignalView(await signal()).state,'off');
  await db.query("update svitlo_sensors.ingest_latest set last_received_at=now()-interval '16 minutes',last_confirmed_at=now()-interval '16 minutes' where binding_id=(select binding_id from svitlo_sensors.bindings where sensor_id=$1 and ended_at is null)",[d.sensorId]);assert.equal(sensorSignalView(await signal()).state,'unknown');
 }finally{await db.close();}
});
