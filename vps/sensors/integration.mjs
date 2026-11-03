import pg from 'pg';import {readFile} from 'node:fs/promises';import {randomUUID,randomBytes} from 'node:crypto';import {spawn} from 'node:child_process';import assert from 'node:assert/strict';
import {runtime} from '../runtime.js';import {pool,ownerContext} from '../db.js';import {SensorAccess,tokenHash} from './service.js';
const database=process.env.PGDATABASE;if(!/^svitlo_sensor_qa_\d+$/.test(database||''))throw Error('Sensor fixtures require disposable restored DB');
const admin=new pg.Client({host:'postgres',user:'svitlo_owner',database,password:(await readFile('/run/secrets/owner_password','utf8')).trim()});await admin.connect();
const rt=await runtime(),worker=pool('worker',2),secret=(await readFile('/run/secrets/sensor_access_secret','utf8')).trim(),api=new SensorAccess({bridge:rt.bridge,db:rt.db,secret}),checks=[];
const actors=Array.from({length:7},()=>randomUUID());let child,logs='';
const req=(action,p={})=>({schemaVersion:1,action,...p});const cmd=(actor,action,p={})=>ownerContext.run(actor,()=>api.handle(actor,req(action,p)));
const write=(actor,action,p={})=>cmd(actor,action,{requestId:randomUUID(),...p});
const check=async(name,fn)=>{await fn();checks.push(name);console.log(JSON.stringify({check:name,status:'pass'}));};
const deny=async(fn,status)=>assert.rejects(fn,e=>e.status===status);
const addresses=(await admin.query("select id from svitlo_vps.catalog where kind='address' and operator_id='qa-grid' order by label limit 3")).rows;
async function profile(actor,which=0){const id=randomUUID();await admin.query("insert into public.svitlo_profiles(id,owner,address,name) values($1,$2,$3,'Sensor QA')",[id,actor,JSON.stringify({canonicalAddressId:addresses[which].id,operatorId:'qa-grid',department:'universal:qa-grid',cityId:'qa',streetId:id,house:'1',city:'Synthetic QA'})]);return id;}
async function provision(sensor=null){const claimToken='sc_'+randomBytes(32).toString('base64url');const value=(await admin.query('select svitlo_sensors.admin_provision($1,$2) result',[tokenHash(claimToken),sensor])).rows[0].result;return {...value,claimToken};}
const ref=s=>({sensorId:s.sensorId,bindingEpoch:s.bindingEpoch});
try{
 for(const actor of actors)await admin.query('insert into auth.users(id) values($1)',[actor]);
 const [a,b,c,d,q,f]=actors,pa=await profile(a),pb=await profile(b),pc=await profile(c),pd=await profile(d),wrong=await profile(b,1);let owner,viewer,invite,accept,claim,device;
 await check('private sensor tables/functions and dedicated role enforce SQL boundaries',async()=>{
  for(const sql of ['select * from svitlo_sensors.devices','select * from svitlo_sensors.invitations',"select svitlo_sensors.admin_provision(repeat('a',64),null)","set role svitlo_sensor_owner"])
   await assert.rejects(()=>rt.p.query(sql),e=>e.code==='42501');
  const role=(await admin.query("select rolcanlogin,rolsuper,rolbypassrls from pg_roles where rolname='svitlo_sensor_owner'")).rows[0];assert.deepEqual(role,{rolcanlogin:false,rolsuper:false,rolbypassrls:false});
  assert.equal((await admin.query("select count(*)::int n from pg_class t join pg_namespace n on n.oid=t.relnamespace where n.nspname='svitlo_sensors' and t.relkind='r' and relrowsecurity")).rows[0].n,20);
  const result=await ownerContext.run(a,()=>rt.bridge.query("select svitlo_sensors.command('claim',$1::jsonb) result",[JSON.stringify({requestId:randomUUID(),claimHash:'a'.repeat(64),profileId:pa,owner:a})]));assert.equal(result.rows[0].result.http,400);
 });
 await check('bootstrap proof expires and cannot be replaced with sensor ID or foreign profile',async()=>{
  const expired=await provision();await admin.query("update svitlo_sensors.devices set claim_expires_at=now()-interval '1 second' where sensor_id=$1",[expired.sensorId]);await deny(()=>write(a,'claim',{profileId:pa,claimToken:expired.claimToken}),404);
  await worker.query('select svitlo_sensors.cleanup()');const state=(await admin.query('select status,claim_hash from svitlo_sensors.devices where sensor_id=$1',[expired.sensorId])).rows[0];assert.equal(state.status,'disabled');assert.equal(state.claim_hash,null);
  const fresh=await provision();await deny(()=>write(b,'claim',{profileId:pa,claimToken:fresh.claimToken}),404);
 });
 await check('same claim race gives one owner, one epoch/point and stable duplicate receipt',async()=>{
  device=await provision();claim={requestId:randomUUID(),profileId:pa,claimToken:device.claimToken};const replies=await Promise.all([cmd(a,'claim',claim),cmd(a,'claim',claim)]);owner=replies[0].sensor;
  assert.equal(owner.role,'owner');assert.equal(owner.bindingEpoch,1);assert.equal(replies[1].sensor.measurementPointId,owner.measurementPointId);assert.equal((await admin.query('select count(*)::int n from svitlo_sensors.bindings where sensor_id=$1',[owner.sensorId])).rows[0].n,1);
  await deny(()=>write(b,'claim',{profileId:pb,claimToken:device.claimToken}),404);const other=await profile(a);await deny(()=>cmd(a,'claim',{...claim,profileId:other}),409);
 });
 await check('nonmembers cannot enumerate/read a known sensor; reader/profile cardinality is server-side',async()=>{
  assert.deepEqual((await cmd(c,'list')).sensors,[]);await deny(()=>cmd(c,'get',ref(owner)),404);const another=await provision();await deny(()=>write(a,'claim',{profileId:pa,claimToken:another.claimToken}),409);
 });
 await check('invitation retry returns same secret across new server nonces, no private fields leak',async()=>{
  const data={...ref(owner),requestId:randomUUID()};const values=await Promise.all([cmd(a,'invite_create',data),cmd(a,'invite_create',data)]);invite=values[0].invitation;assert.equal(invite.inviteToken,values[1].invitation.inviteToken);
  for(const value of values){assert.equal(value.privateHash,undefined);assert.equal(value.privateNonce,undefined);assert.equal(JSON.stringify(value).includes('token_hash'),false);}
  const info=(await cmd(b,'invite_inspect',{inviteToken:invite.inviteToken})).invitation;assert.equal(info.role,'viewer');assert.equal(info.canonicalAddressId,owner.canonicalAddressId);
  await deny(()=>write(b,'invite_accept',{profileId:wrong,inviteToken:invite.inviteToken}),409);
 });
 await check('single-use invite grants viewer only and accepting same request is idempotent',async()=>{
  accept={requestId:randomUUID(),profileId:pb,inviteToken:invite.inviteToken};viewer=(await cmd(b,'invite_accept',accept)).sensor;assert.equal(viewer.role,'viewer');assert.equal(viewer.measurementPointId,owner.measurementPointId);assert.equal((await cmd(b,'invite_accept',accept)).sensor.membershipId,viewer.membershipId);
  await deny(()=>write(c,'invite_accept',{profileId:pc,inviteToken:invite.inviteToken}),409);
 });
 await check('viewer cannot list members, invite, revoke peers or globally disconnect',async()=>{
  for(const [action,p] of [['members',ref(owner)],['invite_create',{...ref(owner),requestId:randomUUID()}],['member_revoke',{...ref(owner),membershipId:owner.membershipId,requestId:randomUUID()}],['disconnect',{...ref(owner),confirmed:true,requestId:randomUUID()}]])await deny(()=>cmd(b,action,p),403);
 });
 await check('two consumers racing for one invitation create exactly one membership',async()=>{
  const token=(await write(a,'invite_create',ref(owner))).invitation.inviteToken;
  const results=await Promise.allSettled([write(c,'invite_accept',{profileId:pc,inviteToken:token}),write(d,'invite_accept',{profileId:pd,inviteToken:token})]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 });
 await check('two different owners racing one bootstrap cannot create two bindings',async()=>{
  const v=await provision(),one=await profile(f),two=await profile(actors[6]);const result=await Promise.allSettled([write(f,'claim',{profileId:one,claimToken:v.claimToken}),write(actors[6],'claim',{profileId:two,claimToken:v.claimToken})]);assert.equal(result.filter(x=>x.status==='fulfilled').length,1);assert.equal((await admin.query('select count(*)::int n from svitlo_sensors.bindings where sensor_id=$1',[v.sensorId])).rows[0].n,1);
 });
 await check('viewer capacity is atomic and cannot be bypassed through another profile',async()=>{
  await admin.query('update svitlo_sensors.policy set max_viewers=2 where id');const p=await profile(q),token=(await write(a,'invite_create',ref(owner))).invitation;
  await assert.rejects(()=>write(q,'invite_accept',{profileId:p,inviteToken:token.inviteToken}),e=>e.code==='sensor_membership_limit');await write(a,'invite_revoke',{...ref(owner),inviteId:token.inviteId});await admin.query('update svitlo_sensors.policy set max_viewers=20 where id');
 });
 await check('pending/expiry/revocation limits and old token non-resurrection after receipt purge',async()=>{
  const pending=[];for(let n=0;n<5;n++){const requestId=randomUUID();pending.push({requestId,...(await cmd(a,'invite_create',{...ref(owner),requestId})).invitation});}await deny(()=>write(a,'invite_create',ref(owner)),429);
  const old=pending[0];await admin.query("update svitlo_sensors.invitations set expires_at=now()-interval '1 second' where invite_id=$1",[old.inviteId]);await deny(()=>cmd(c,'invite_inspect',{inviteToken:old.inviteToken}),404);await deny(()=>cmd(a,'invite_create',{...ref(owner),requestId:old.requestId}),409);
  await write(a,'invite_revoke',{...ref(owner),inviteId:pending[1].inviteId});await deny(()=>cmd(c,'invite_inspect',{inviteToken:pending[1].inviteToken}),404);
  await admin.query('delete from svitlo_sensors.commands where subject=$1 and request_id=$2',[a,old.requestId]);await admin.query('delete from svitlo_sensors.invitations where invite_id=$1',[old.inviteId]);const next=(await cmd(a,'invite_create',{...ref(owner),requestId:old.requestId})).invitation;assert.notEqual(next.inviteToken,old.inviteToken);await deny(()=>cmd(c,'invite_inspect',{inviteToken:old.inviteToken}),404);
  await admin.query('update svitlo_sensors.invitations set revoked_at=now() where consumed_at is null');
 });
 await check('revoke and leave replays cannot regrant access or revoke a later fresh membership',async()=>{
  const revoke={...ref(owner),membershipId:viewer.membershipId,requestId:randomUUID()};await cmd(a,'member_revoke',revoke);await deny(()=>cmd(b,'get',ref(owner)),404);await deny(()=>cmd(b,'invite_accept',accept),404);await deny(()=>write(b,'invite_accept',{profileId:pb,inviteToken:invite.inviteToken}),409);
  const join=async()=>{const token=(await write(a,'invite_create',ref(owner))).invitation.inviteToken;return (await write(b,'invite_accept',{profileId:pb,inviteToken:token})).sensor;};
  const fresh=await join();assert.notEqual(fresh.membershipId,viewer.membershipId);await cmd(a,'member_revoke',revoke);assert.equal((await cmd(b,'get',ref(owner))).sensor.membershipId,fresh.membershipId);
  const leave={...ref(owner),requestId:randomUUID(),membershipId:fresh.membershipId};await cmd(b,'leave',leave);await deny(()=>cmd(b,'get',ref(owner)),404);const again=await join();await cmd(b,'leave',leave);assert.equal((await cmd(b,'get',ref(owner))).sensor.membershipId,again.membershipId);
 });
 await check('profile deletion preserves physical binding/other readers and durable identity retention',async()=>{
  await ownerContext.run(a,()=>rt.service.handle(a,{action:'erase'}));assert.equal((await admin.query('select count(*)::int n from public.svitlo_profiles where owner=$1',[a])).rows[0].n,0);const current=(await cmd(a,'get',ref(owner))).sensor;assert.equal(current.readerProfileId,null);assert.equal(current.measurementPointId,owner.measurementPointId);assert.equal((await cmd(b,'get',ref(owner))).sensor.role,'viewer');
  await admin.query("update auth.users set created_at=now()-interval '40 days' where id=$1",[a]);await worker.query('select svitlo_vps.session_cleanup()');assert.equal((await admin.query('select count(*)::int n from auth.users where id=$1',[a])).rows[0].n,1);
  const replacement=await profile(a),second=await profile(a);assert.equal((await write(a,'link',{...ref(owner),profileId:replacement})).sensor.readerProfileId,replacement);await deny(()=>write(a,'link',{...ref(owner),profileId:second}),409);
 });
 await check('ten membership limit is independent of client list and preserves remaining devices',async()=>{
  for(let n=0;n<11;n++){const p=await profile(q),v=await provision();const task=()=>write(q,'claim',{profileId:p,claimToken:v.claimToken});if(n<10)await task();else await deny(task,409);}assert.equal((await cmd(q,'list')).sensors.length,10);
 });
 await check('disconnect requires explicit owner confirmation; old epoch/codes/invites stay dead after rebind',async()=>{
  const oldPending=(await write(a,'invite_create',ref(owner))).invitation.inviteToken;
  await deny(()=>cmd(a,'disconnect',{...ref(owner),requestId:randomUUID(),confirmed:false}),409);const stop={...ref(owner),requestId:randomUUID(),confirmed:true};await cmd(a,'disconnect',stop);await cmd(a,'disconnect',stop);
  await deny(()=>cmd(b,'get',ref(owner)),404);await deny(()=>cmd(a,'claim',claim),404);await deny(()=>cmd(c,'invite_inspect',{inviteToken:oldPending}),404);
  const fresh=await provision(owner.sensorId),pf=await profile(f);const changed=(await write(f,'claim',{profileId:pf,claimToken:fresh.claimToken})).sensor;assert.equal(changed.bindingEpoch,2);assert.notEqual(changed.measurementPointId,owner.measurementPointId);await deny(()=>cmd(a,'get',ref(changed)),404);await deny(()=>write(c,'invite_accept',{profileId:pc,inviteToken:oldPending}),404);
 });
 // A private HTTP child in the disposable DB. No host port published.
 child=spawn(process.execPath,['vps/http.mjs'],{env:{...process.env,STAGE_ORIGIN:'http://127.0.0.1:8080'},stdio:['ignore','pipe','pipe']});for(const stream of [child.stdout,child.stderr])stream.on('data',x=>logs=(logs+x.toString()).slice(-65536));
 for(let n=0;n<100&&!logs.includes('"event":"listening"');n++){if(child.exitCode!==null)throw Error('QA child exited');await new Promise(r=>setTimeout(r,100));}assert.ok(logs.includes('"event":"listening"'));
 await check('real private HTTP authentication, consentless role forging and secret redaction boundaries',async()=>{
  const origin='http://127.0.0.1:8080',r=await fetch(origin+'/api/session',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'});const session=(await r.json()).session,cookie=r.headers.get('set-cookie').split(';')[0];
  const post=async(data,headers={})=>{const res=await fetch(origin+'/api/v1/sensors',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie,'X-Svitlo-CSRF':session.csrf_token,...headers},body:JSON.stringify(data)});return {status:res.status,value:await res.json()};};
  assert.equal((await post(req('list'),{'X-Svitlo-CSRF':'0'.repeat(64)})).status,403);assert.equal((await post(req('list',{role:'owner',owner:session.user.id}))).status,400);
  const pp=await profile(session.user.id),virtual=await provision(),raw=virtual.claimToken;
  const value=await post(req('claim',{profileId:pp,claimToken:raw,requestId:randomUUID()}));assert.equal(value.status,200);assert.equal(value.value.sensor.role,'owner');assert.equal(JSON.stringify(value.value).includes(raw),false);
  await post(req('claim',{profileId:pp,claimToken:'DEMO-QA_SECRET_CANARY',requestId:randomUUID()}));await new Promise(r=>setTimeout(r,100));assert.equal(logs.includes(raw),false);assert.equal(logs.includes('QA_SECRET_CANARY'),false);
  const stored=(await admin.query("select coalesce(string_agg(to_jsonb(c)::text,''),'') data from svitlo_sensors.commands c")).rows[0].data;assert.equal(stored.includes(raw),false);
 });
 console.log(JSON.stringify({scope:'sensor-access-isolated-postgres-http',passed:checks.length,checks}));
}finally{
 if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,5000))]);if(child.exitCode===null)child.kill('SIGKILL');}
 await Promise.all([rt.p.end(),worker.end(),admin.end()]);
}
