import pg from 'pg';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {verifyLineSql} from './line-assertions.mjs';
import {runtime} from '../runtime.js';
import {ownerContext} from '../db.js';
const database=process.env.PGDATABASE;
if(!/^svitlo_lines_qa_\d+$/.test(database||''))throw Error('Disposable restored line QA database required');
const admin=new pg.Client({host:'postgres',user:'svitlo_owner',database,password:(await readFile('/run/secrets/owner_password','utf8')).trim()});
await admin.connect();let rt;
try{
 const proof=await verifyLineSql({exec:sql=>admin.query(sql),query:(sql,args=[])=>admin.query(sql,args.map(v=>v&&typeof v==='object'?JSON.stringify(v):v))});
 rt=await runtime();const owner=randomUUID();await admin.query('insert into auth.users(id) values($1)',[owner]);
 const houses=(await admin.query("select id,source_ref->>'scenario' scenario from svitlo_vps.catalog where kind='address' and operator_id='qa-grid' order by label")).rows;
 const save=id=>ownerContext.run(owner,()=>rt.service.handle(owner,{action:'save',confirmed:true,address:{canonicalAddressId:id},name:'Мій дім'}));
 const group=await save(houses.find(h=>h.scenario==='1').id);assert.equal(group.profiles.length,2);assert.equal(group.profile.address.lineNumber,1);
 assert.equal(new Set(group.profiles.map(p=>p.snapshot.selectedLineId)).size,2);
 assert.notDeepEqual(group.profiles[0].snapshot.categories.hourly.events,group.profiles[1].snapshot.categories.hourly.events);
 const repeated=await save(group.addressGroupId);assert.deepEqual(repeated.profiles.map(p=>p.id),group.profiles.map(p=>p.id));
 await save(houses.find(h=>h.scenario==='2').id);
 await assert.rejects(()=>save(houses.find(h=>h.scenario==='4').id),e=>e.status===409);
 const racer=randomUUID(),pid=randomUUID(),hash='a'.repeat(64),home=houses.find(h=>h.scenario==='1').id;
 await admin.query('insert into auth.users(id) values($1)',[racer]);
 await admin.query("insert into svitlo_sensors.main_app_subscriptions values($1,'private_test',now()-interval '1 minute',now()+interval '1 hour',null)",[racer]);
 await admin.query("insert into public.svitlo_profiles(id,owner,address) values($1,$2,$3)",[pid,racer,JSON.stringify({canonicalAddressId:home,operatorId:'qa-grid',department:'universal:qa-grid',cityId:'qa',streetId:'qa',house:'1'})]);
 await admin.query('select svitlo_sensors.admin_provision($1)',[hash]);
 const blocker=new pg.Client({host:'postgres',user:'svitlo_owner',database,password:(await readFile('/run/secrets/owner_password','utf8')).trim()});await blocker.connect();
 try{
  await blocker.query('begin');await blocker.query("select set_config('svitlo.owner_id',$1,true)",[racer]);await blocker.query('set local role svitlo_stage_api');
  const claimed=(await blocker.query("select svitlo_sensors.command('claim',$1) r",[JSON.stringify({requestId:randomUUID(),profileId:pid,claimHash:hash})])).rows[0].r;assert.equal(claimed.http,200);
  let completed=false;const blocked=ownerContext.run(racer,()=>rt.service.handle(racer,{action:'save',confirmed:true,address:{canonicalAddressId:home}})).then(r=>{completed=true;return {ok:true,r};},e=>{completed=true;return {ok:false,e};});
  await new Promise(r=>setTimeout(r,150));assert.equal(completed,false,'adoption must wait for the concurrent sensor claim');
  await blocker.query('commit');const outcome=await blocked;assert.equal(outcome.ok,false);assert.equal(outcome.e.status,409);
  assert.equal((await admin.query('select address->>\'lineId\' line from public.svitlo_profiles where id=$1',[pid])).rows[0].line,null);
  assert.equal((await admin.query('select line_id from svitlo_sensors.bindings where sensor_id=$1 and ended_at is null',[claimed.sensor.sensorId])).rows[0].line_id,null);
 }finally{await blocker.query('rollback');await blocker.end();}
 console.log(JSON.stringify({scope:'multiline-home-quota-and-sensors',passed:13,proof,checks:['SQL two-line and three-line canonical grouping','free two homes with multiple lines','premium ten homes and twenty line profiles','idempotent reversed line order','atomic identity rejection','cross-owner denial','twenty independent sensor memberships','one sensor per exact line','disconnect preserves other memberships','server expands confirmed same-address lines','independent per-line snapshots','API free quota enforcement','concurrent sensor claim blocks and fences unresolved-line adoption']}));
}finally{await rt?.p.end();await admin.end();}
