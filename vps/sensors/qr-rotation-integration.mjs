// Disposable restored database only; values of secrets are never assertion arguments or output.
import pg from 'pg';import {readFile} from 'node:fs/promises';import {randomUUID,randomBytes} from 'node:crypto';import assert from 'node:assert/strict';
import {runtime} from '../runtime.js';import {ownerContext,pool} from '../db.js';import {PhoneSensors} from './phone.js';import {SensorAccess,tokenHash} from './service.js';import {enableQaSubscriptions} from './qa-entitlements.mjs';
const database=process.env.PGDATABASE;if(!/^svitlo_phone_qa_\d+$/.test(database||''))throw Error('Disposable phone QA database required');
const admin=new pg.Client({host:'postgres',user:'svitlo_owner',database,password:(await readFile('/run/secrets/owner_password','utf8')).trim()});await admin.connect();
const rt=await runtime(),worker=pool('worker',2),phone=new PhoneSensors({bridge:rt.bridge,secret:(await readFile('/run/secrets/phone_secret','utf8')).trim()}),access=new SensorAccess({bridge:rt.bridge,phone,secret:(await readFile('/run/secrets/sensor_access_secret','utf8')).trim()});
const actors=[randomUUID(),randomUUID(),randomUUID()],[a,b,c]=actors,checks=[];
const token=p=>p+'_'+randomBytes(32).toString('base64url');
const check=async(name,fn)=>{await fn();checks.push(name);console.log(JSON.stringify({check:name,status:'pass'}));};
const deny=(fn,status)=>assert.rejects(fn,e=>e.status===status);
const control=(d,action,requestId)=>phone.control('Bearer '+d.controlToken,{schemaVersion:1,action,sensorId:d.sensorId,...(requestId?{requestId}:{})});
const reg=()=>phone.register({schemaVersion:1,registrationToken:token('sr')});
const rotate=(d,requestId=randomUUID())=>control(d,'rotate_owner_qr',requestId);
const command=(actor,action,data={})=>ownerContext.run(actor,()=>access.handle(actor,{schemaVersion:1,action,...data}));
const actorProfiles=new Map();
const connect=(actor,qr,profileId=actorProfiles.get(actor))=>command(actor,'connect_qr',{requestId:randomUUID(),qr,...(profileId?{profileId}:{})});
let d,first,current,point,profiles=[];
try{
 for(const actor of actors)await admin.query('insert into auth.users(id) values($1)',[actor]);await enableQaSubscriptions(admin,actors);
 const address=(await admin.query("select id from svitlo_vps.catalog where kind='address' and operator_id='qa-grid' order by label limit 1")).rows[0].id;
 for(const actor of actors){const id=randomUUID();profiles.push(id);await admin.query("insert into public.svitlo_profiles(id,owner,address,name) values($1,$2,$3,'QR rotation QA')",[id,actor,JSON.stringify({canonicalAddressId:address,operatorId:'qa-grid',department:'universal:qa-grid',house:'1'})]);}
 await check('rotation requires control credentials and strict request identity',async()=>{
  d=await reg();first=await control(d,'owner_qr');
  await deny(()=>phone.control('Bearer '+token('st'),{schemaVersion:1,action:'rotate_owner_qr',sensorId:d.sensorId,requestId:randomUUID()}),401);
  await deny(()=>phone.control('Bearer '+token('sd'),{schemaVersion:1,action:'rotate_owner_qr',sensorId:d.sensorId,requestId:randomUUID()}),401);
  await deny(()=>phone.control('Bearer '+d.controlToken,{schemaVersion:1,action:'rotate_owner_qr',sensorId:d.sensorId}),400);
  await assert.rejects(()=>rt.p.query('select * from svitlo_sensors.phone_qr_rotations'),e=>e.code==='42501');
  await assert.rejects(()=>worker.query('select svitlo_sensors.phone_qr_rotate($1)',[JSON.stringify({})]),e=>e.code==='42501');
 });
 await check('explicit rotation changes proof and invalidates previous QR before expiry',async()=>{
  current=await rotate(d);assert.ok(current.qr.proof!==first.qr.proof,'new proof differs');
  assert.ok(Date.parse(current.expiresAt)>Date.now()+890000&&Date.parse(current.expiresAt)<=Date.now()+901000,'15 minute server expiry');
  await deny(()=>connect(a,first.qr,profiles[0]),404);
  assert.ok((await control(d,'owner_qr')).qr.proof===current.qr.proof,'ordinary get keeps current proof');
 });
 await check('same request returns same active QR and deadline across concurrent retries',async()=>{
  const requestId=randomUUID(),rs=await Promise.all([rotate(d,requestId),rotate(d,requestId)]);
  assert.ok(rs[0].qr.proof===rs[1].qr.proof&&rs[0].expiresAt===rs[1].expiresAt,'one atomic issuance');
  assert.equal(rs.filter(x=>x.duplicate===true).length,1);current=rs[0];
 });
 await check('superseded requests cannot revive an old proof',async()=>{
  const oldId=randomUUID(),old=await rotate(d,oldId);current=await rotate(d);
  await deny(()=>rotate(d,oldId),409);await deny(()=>connect(a,old.qr,profiles[0]),404);
  assert.ok((await control(d,'owner_qr')).qr.proof===current.qr.proof,'latest remains active');
 });
 await check('rotated QR connects exactly once for a new owner and consumed retry cannot issue again',async()=>{
  const requestId=randomUUID();current=await rotate(d,requestId);point=(await connect(a,current.qr,profiles[0])).sensor;
  await deny(()=>connect(b,current.qr,profiles[1]),409);await deny(()=>rotate(d,requestId),409);
  assert.equal((await connect(a,current.qr)).outcome,'already_owner');
 });
 await check('rotation preserves binding owner viewers invitations profiles ingest and history',async()=>{
  const ref={sensorId:point.sensorId,bindingEpoch:point.bindingEpoch};
  const invitation=(await command(a,'invite_create',{...ref,requestId:randomUUID()})).invitation;
  await command(b,'invite_accept',{requestId:randomUUID(),inviteToken:invitation.inviteToken,profileId:profiles[1]});
  await command(a,'invite_create',{...ref,requestId:randomUUID()});const credential=await control(d,'ingest_credentials');
  const before=JSON.stringify((await admin.query("select b.*, (select jsonb_agg(to_jsonb(m) order by member_id) from svitlo_sensors.memberships m where m.binding_id=b.binding_id) members,(select jsonb_agg(to_jsonb(i) order by invite_id) from svitlo_sensors.invitations i where i.binding_id=b.binding_id) invitations,(select jsonb_agg(to_jsonb(r) order by range_id) from svitlo_sensors.phone_ranges r where r.binding_id=b.binding_id) history from svitlo_sensors.bindings b where sensor_id=$1",[d.sensorId])).rows);
  current=await rotate(d);const after=JSON.stringify((await admin.query("select b.*, (select jsonb_agg(to_jsonb(m) order by member_id) from svitlo_sensors.memberships m where m.binding_id=b.binding_id) members,(select jsonb_agg(to_jsonb(i) order by invite_id) from svitlo_sensors.invitations i where i.binding_id=b.binding_id) invitations,(select jsonb_agg(to_jsonb(r) order by range_id) from svitlo_sensors.phone_ranges r where r.binding_id=b.binding_id) history from svitlo_sensors.bindings b where sensor_id=$1",[d.sensorId])).rows);
  assert.ok(before===after,'no membership/history mutation');assert.ok((await control(d,'ingest_credentials')).ingestToken===credential.ingestToken,'ingest unchanged');
  assert.equal((await command(b,'get',ref)).sensor.role,'viewer');
 });
 await check('two different concurrent rotations leave exactly one active proof',async()=>{
  const race=await reg(),ids=[randomUUID(),randomUUID()],rs=await Promise.all(ids.map(id=>rotate(race,id)));
  assert.ok(rs[0].qr.proof!==rs[1].qr.proof,'two explicit operations');const active=await control(race,'owner_qr');
  const winner=rs.findIndex(x=>x.qr.proof===active.qr.proof);assert.ok(winner>=0);
  assert.ok((await rotate(race,ids[winner])).qr.proof===active.qr.proof);await deny(()=>rotate(race,ids[1-winner]),409);
 });
 await check('concurrent consume and rotate serialize without resurrecting old QR',async()=>{
  const race=await reg(),old=await control(race,'owner_qr');
  const [r]=await Promise.all([rotate(race),connect(a,old.qr,profiles[0]).catch(e=>({status:e.status}))]);
  await deny(()=>connect(c,old.qr,profiles[2]),404);assert.ok((await control(race,'owner_qr')).qr.proof===r.qr.proof);
 });
 await check('expired retry fails closed and a new explicit request can issue a code',async()=>{
  const exp=await reg(),id=randomUUID();await rotate(exp,id);
  await admin.query("update svitlo_sensors.phone_devices set qr_expires_at=now()-interval '1 second' where sensor_id=$1",[exp.sensorId]);
  await deny(()=>rotate(exp,id),409);const fresh=await rotate(exp);assert.ok(Date.parse(fresh.expiresAt)>Date.now());
 });
 await check('permanent factory sticker cannot be rotated by control API',async()=>{
  const sensorId=randomUUID(),proof=token('so'),controlToken=token('sd');
  await admin.query('select svitlo_sensors.admin_factory_phone($1,$2,$3,$4)',[sensorId,tokenHash(controlToken),tokenHash(proof),phone.seal(proof,'owner-qr:'+sensorId)]);
  await deny(()=>rotate({sensorId,controlToken}),403);
  assert.ok((await admin.query('select qr_hash from svitlo_sensors.phone_devices where sensor_id=$1',[sensorId])).rows[0].qr_hash===tokenHash(proof));
 });
 await check('rate limit bounds new issuance but duplicate retries still succeed',async()=>{
  const limited=await reg(),ids=[];for(let n=0;n<12;n++){const id=randomUUID();ids.push(id);await rotate(limited,id);}
  await deny(()=>rotate(limited),429);assert.equal((await rotate(limited,ids.at(-1))).duplicate,true);
 });
 await check('bounded worker cleanup removes old receipts and preserves current issuance',async()=>{
  const clean=await reg();await rotate(clean);const old=randomUUID();
  await admin.query("insert into svitlo_sensors.phone_qr_rotations values($1,$2,repeat('a',64),now()-interval '25 hours',now()-interval '24 hours')",[clean.sensorId,old]);
  await worker.query('select svitlo_sensors.phone_cleanup()');
  assert.equal((await admin.query('select count(*)::int n from svitlo_sensors.phone_qr_rotations where sensor_id=$1',[clean.sensorId])).rows[0].n,1);
 });
 const actor=async()=>{const id=randomUUID(),profile=randomUUID();await admin.query('insert into auth.users(id) values($1)',[id]);await enableQaSubscriptions(admin,[id]);await admin.query("insert into public.svitlo_profiles(id,owner,address,name) values($1,$2,$3,'Manual QA')",[profile,id,JSON.stringify({canonicalAddressId:address,operatorId:'qa-grid',department:'universal:qa-grid',house:'1'})]);actorProfiles.set(id,profile);return id;};
 const codeQr=r=>({version:1,kind:'phone_code',code:r.manualCode});
 await check('six-digit code is encrypted keyed-hashed stable on get and replaced on rotate',async()=>{
  const device=await reg(),one=await control(device,'owner_qr'),same=await control(device,'owner_qr');
  assert.ok(/^[0-9]{6}$/.test(one.manualCode)&&same.manualCode===one.manualCode&&same.expiresAt===one.expiresAt);
  const row=(await admin.query('select manual_code_hash,manual_code_cipher from svitlo_sensors.phone_devices where sensor_id=$1',[device.sensorId])).rows[0];
  assert.ok(row.manual_code_hash===phone.manualHash(one.manualCode)&&row.manual_code_cipher!==one.manualCode&&phone.open(row.manual_code_cipher,'manual-code:'+device.sensorId)===one.manualCode);
  const next=await rotate(device),reader=await actor();assert.ok(next.manualCode!==one.manualCode);
  await deny(()=>connect(reader,codeQr(one)),404);assert.ok((await connect(reader,codeQr(next))).sensor.sensorId===device.sensorId);
 });
 await check('manual consume idempotency survives later rotation and mismatched replay is denied',async()=>{
  const device=await reg(),r=await control(device,'owner_qr'),reader=await actor(),requestId=randomUUID();
  const packet={requestId,qr:codeQr(r),profileId:actorProfiles.get(reader)},first=await command(reader,'connect_qr',packet);await rotate(device);
  const replay=await command(reader,'connect_qr',packet);assert.ok(first.sensor.sensorId===replay.sensor.sensorId);
  await deny(async()=>command(reader,'connect_qr',{requestId,qr:codeQr(await control(device,'owner_qr'))}),409);
 });
 await check('collision rollback keeps previous QR and code usable without partial issuance',async()=>{
  const device=await reg(),one=await control(device,'owner_qr'),collision=await control(await reg(),'owner_qr'),requestId=randomUUID(),proof=phone.token('sp');
  const payload={sensorId:device.sensorId,controlHash:tokenHash(device.controlToken),requestId,qrHash:tokenHash(proof),qrCipher:phone.seal(proof,'owner-qr:'+device.sensorId),manualHash:phone.manualHash(collision.manualCode),manualCipher:phone.seal(collision.manualCode,'manual-code:'+device.sensorId)};
  const result=(await rt.bridge.query('select svitlo_sensors.phone_qr_rotate($1::jsonb) result',[JSON.stringify(payload)])).rows[0].result;
  assert.equal(result.code,'phone_manual_code_collision');const unchanged=await control(device,'owner_qr');assert.ok(unchanged.qr.proof===one.qr.proof&&unchanged.manualCode===one.manualCode);
  assert.equal((await admin.query('select count(*)::int n from svitlo_sensors.phone_qr_rotations where sensor_id=$1 and request_id=$2',[device.sensorId,requestId])).rows[0].n,0);
 });
 await check('five incorrect guesses lock manual lookup for fifteen minutes including correct code',async()=>{
  const reader=await actor(),valid=await control(await reg(),'owner_qr');
  // Synthetic unavailable hash cannot accidentally hit another live six-digit code.
  const packet=()=>JSON.stringify({requestId:randomUUID(),codeHash:'f'.repeat(64)});
  for(let n=0;n<5;n++){const r=await ownerContext.run(reader,async()=> (await rt.bridge.query('select svitlo_sensors.phone_code_connect($1::jsonb) result',[packet()])).rows[0].result);assert.equal(r.http,404);}
  await deny(()=>connect(reader,codeQr(valid)),429);
  await admin.query("update svitlo_sensors.phone_manual_attempts set window_start=now()-interval '16 minutes' where subject=$1",[reader]);
  assert.ok((await connect(reader,codeQr(valid))).sensor.sensorId===valid.qr.sensorId);
 });
 await check('manual expiry and cleanup never extend or reuse an active reservation',async()=>{
  const device=await reg(),r=await control(device,'owner_qr'),reader=await actor();
  await admin.query("update svitlo_sensors.phone_devices set qr_expires_at=now()-interval '1 second' where sensor_id=$1",[device.sensorId]);await deny(()=>connect(reader,codeQr(r)),404);
  await admin.query("insert into svitlo_sensors.phone_manual_codes values(repeat('e',64),$1,now()-interval '25 hours')",[device.sensorId]);
  await admin.query("update svitlo_sensors.phone_manual_attempts set window_start=now()-interval '25 hours' where subject=$1",[reader]);
  await worker.query('select svitlo_sensors.phone_cleanup()');
  assert.equal((await admin.query("select count(*)::int n from svitlo_sensors.phone_manual_codes where code_hash=repeat('e',64)")).rows[0].n,0);
  assert.equal((await admin.query('select count(*)::int n from svitlo_sensors.phone_manual_codes where code_hash=$1',[phone.manualHash(r.manualCode)])).rows[0].n,1);
  await assert.rejects(()=>rt.p.query('select * from svitlo_sensors.phone_manual_codes'),e=>e.code==='42501');
 });
 console.log(JSON.stringify({scope:'isolated-phone-qr-rotation-postgres',passed:checks.length,checks,secretsLogged:false}));
}finally{await Promise.all([rt.p.end(),worker.end(),admin.end()]);}
