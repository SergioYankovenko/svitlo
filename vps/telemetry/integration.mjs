// Destructive/fault-injection fixtures MUST run only in a disposable restored database.
import pg from 'pg';import {readFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';import {spawn} from 'node:child_process';import assert from 'node:assert/strict';
import {runtime} from '../runtime.js';import {pool,ownerContext} from '../db.js';import {Telemetry} from './service.js';
const database=process.env.PGDATABASE;if(!/^svitlo_telemetry_qa_\d+$/.test(database||''))throw Error('Refusing telemetry fixtures outside disposable QA database');
const admin=new pg.Client({host:'postgres',user:'svitlo_owner',database,password:(await readFile('/run/secrets/owner_password','utf8')).trim()});await admin.connect();
const rt=await runtime(),worker=pool('worker',2),owners=Array.from({length:4},()=>randomUUID()),checks=[];let child,logs='';
const sample=(reportId=randomUUID())=>({schemaVersion:1,reportId,client:{target:'pwa',version:'qa-231'},occurredAt:new Date().toISOString(),stage:'street',code:'temporary',events:[{name:'lookup_failed',code:'temporary'}]});
const check=async(name,fn)=>{await fn();checks.push(name);console.log(JSON.stringify({check:name,status:'pass'}));};
const call=(owner,p)=>ownerContext.run(owner,async()=>(await rt.bridge.query('select svitlo_telemetry.submit_report($1::jsonb) result',[JSON.stringify(p)])).rows[0].result);
const sec=p=>rt.p.query('select svitlo_telemetry.record_security($1::jsonb) result',[JSON.stringify(p)]).then(r=>r.rows[0].result);
const event=(reason='schema',field='request',operation='catalog_lookup')=>({operation,field,reason,confidence:'schema_violation',source:'api'});
async function resetSecurity(){await admin.query('delete from svitlo_telemetry.security_events');await admin.query('update svitlo_telemetry.policy set security_enabled=true,security_per_minute=30,security_capacity=2000 where id');}
try{
 await admin.query('delete from svitlo_telemetry.receipts;delete from svitlo_telemetry.admin_audit');await resetSecurity();
 for(const owner of owners)await admin.query('insert into auth.users(id) values($1)',[owner]);
 await check('private RLS tables/admin functions inaccessible; function owner cannot log in or bypass RLS',async()=>{
  const r=(await admin.query("select rolcanlogin,rolsuper,rolbypassrls from pg_roles where rolname='svitlo_telemetry_owner'")).rows[0];assert.deepEqual(r,{rolcanlogin:false,rolsuper:false,rolbypassrls:false});
  assert.equal((await admin.query("select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='svitlo_telemetry' and c.relkind='r' and c.relrowsecurity")).rows[0].n,5);
  for(const q of ['select * from svitlo_telemetry.reports','insert into svitlo_telemetry.security_events(operation) values(null)',"select svitlo_telemetry.admin_read('diagnostics',1)","set role svitlo_telemetry_owner"])
   await assert.rejects(()=>rt.p.query(q),e=>e.code==='42501');
  await assert.rejects(()=>worker.query('select * from svitlo_telemetry.receipts'),e=>e.code==='42501');
 });
 await check('direct SQL bypass rejects extra/null/invalid fields without storing payload',async()=>{
  for(const p of [null,[],{...sample(),address:'QA_SECRET_CANARY'}, {...sample(),stage:null},{...sample(),client:{target:null,version:'qa'}},{...sample(),events:[{name:null,code:'temporary'}]},{...sample(),occurredAt:'2026-02-30T12:00:00Z'}])assert.equal((await call(owners[0],p)).status,'invalid');
  assert.equal(await sec({...event(),raw:'QA_SECRET_CANARY'}),'invalid');assert.equal(await sec({...event(),reason:null}),'invalid');
  await assert.rejects(()=>call(null,sample()),e=>e.code==='42501');assert.equal((await admin.query('select count(*)::int n from svitlo_telemetry.reports')).rows[0].n,0);
 });
 const p=sample();let first;
 await check('durable receipt/idempotency/hash conflict and owner-scoped collisions',async()=>{
  first=await call(owners[0],p);assert.equal(first.status,'created');const again=await call(owners[0],Object.fromEntries(Object.entries(p).reverse()));assert.equal(again.status,'duplicate');assert.equal(again.receiptId,first.receiptId);assert.equal(again.acceptedAt,first.acceptedAt);
  assert.equal((await call(owners[0],{...p,code:'timeout'})).status,'conflict');const other=await call(owners[1],p);assert.equal(other.status,'created');assert.notEqual(other.receiptId,first.receiptId);
  await ownerContext.run(owners[1],()=>rt.bridge.query('select svitlo_telemetry.forget_reports()'));assert.equal((await admin.query('select count(*)::int n from svitlo_telemetry.receipts where owner=$1',[owners[0]])).rows[0].n,1);
 });
 const racePacket=sample();
 await check('concurrent duplicate requests commit exactly one receipt',async()=>{
  const replies=await Promise.all(Array.from({length:10},()=>call(owners[2],racePacket)));assert.equal(replies.filter(x=>x.status==='created').length,1);assert.equal(new Set(replies.map(x=>x.receiptId)).size,1);
 });
 await check('durable daily quota is atomic, duplicates bypass quota, UTC next-day reset',async()=>{
  const replies=await Promise.all(Array.from({length:10},()=>call(owners[2],sample())));assert.equal(replies.filter(x=>x.status==='created').length,4);assert.equal(replies.filter(x=>x.status==='quota').length,6);assert.ok(replies.filter(x=>x.status==='quota').every(x=>x.retryAfter>=1&&x.retryAfter<=86400));
  assert.equal((await call(owners[2],racePacket)).status,'duplicate');await admin.query("update svitlo_telemetry.receipts set accepted_at=now()-interval '1 day' where owner=$1",[owners[2]]);assert.equal((await call(owners[2],sample())).status,'created');
 });
 await check('global report capacity returns retryable refusal without successful receipt',async()=>{
  await admin.query('update svitlo_telemetry.policy set report_capacity=1 where id');const r=await call(owners[3],sample());assert.equal(r.status,'capacity');assert.equal(r.retryAfter,60);await admin.query('update svitlo_telemetry.policy set report_capacity=10000 where id');
 });
 await check('payload TTL keeps minimal dedupe receipt, later receipt TTL and erasure purge safely',async()=>{
  await admin.query("update svitlo_telemetry.reports set expires_at=now()-interval '1 second' where receipt_id=$1",[first.receiptId]);const purged=(await worker.query('select svitlo_telemetry.cleanup() result')).rows[0].result;assert.equal(purged.payloads,1);assert.equal((await call(owners[0],p)).receiptId,first.receiptId);
  assert.equal((await admin.query('select count(*)::int n from svitlo_telemetry.reports where receipt_id=$1',[first.receiptId])).rows[0].n,0);
  await admin.query("update svitlo_telemetry.receipts set expires_at=now()-interval '1 second' where receipt_id=$1",[first.receiptId]);await worker.query('select svitlo_telemetry.cleanup()');const next=await call(owners[0],p);assert.equal(next.status,'created');assert.notEqual(next.receiptId,first.receiptId);
  await ownerContext.run(owners[0],()=>rt.bridge.query('select svitlo_telemetry.forget_reports()'));assert.equal((await admin.query('select count(*)::int n from svitlo_telemetry.receipts where owner=$1',[owners[0]])).rows[0].n,0);
 });
 await check('security dedupe remains atomic across concurrent writers',async()=>{
  const replies=await Promise.all(Array.from({length:20},()=>sec(event())));assert.equal(replies.filter(x=>x==='stored').length,1);assert.equal((await admin.query('select count(*)::int n from svitlo_telemetry.security_events')).rows[0].n,1);
 });
 await check('security rate/capacity/flag are enforced in DB and TTL is bounded',async()=>{
  await resetSecurity();await admin.query('update svitlo_telemetry.policy set security_per_minute=1 where id');assert.equal(await sec(event()),'stored');assert.equal(await sec(event('control')),'rate');
  await admin.query('update svitlo_telemetry.policy set security_per_minute=30,security_capacity=1 where id');assert.equal(await sec(event('control')),'capacity');
  await admin.query('select svitlo_telemetry.admin_collection(false)');assert.equal(await sec(event('size')),'disabled');
  await admin.query("update svitlo_telemetry.security_events set occurred_at=now()-interval '15 days'");await worker.query('select svitlo_telemetry.cleanup()');assert.equal((await admin.query('select count(*)::int n from svitlo_telemetry.security_events')).rows[0].n,0);await resetSecurity();
 });
 await check('admin reads are bounded and audited, runtime cannot administer collection',async()=>{
  const r=(await admin.query("select svitlo_telemetry.admin_read('diagnostics',2) result")).rows[0].result;assert.ok(r.auditId);assert.ok(r.items.length<=2);assert.equal((await admin.query('select operation from svitlo_telemetry.admin_audit where audit_id=$1',[r.auditId])).rows[0].operation,'read_diagnostics');
  await assert.rejects(()=>rt.p.query('select svitlo_telemetry.admin_collection(false)'),e=>e.code==='42501');
 });
 // Private, disposable HTTP child. No published port; actual production API credentials/mounts remain unchanged.
 child=spawn(process.execPath,['vps/http.mjs'],{env:{...process.env,STAGE_ORIGIN:'http://127.0.0.1:8080'},stdio:['ignore','pipe','pipe']});
 for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{logs=(logs+chunk.toString()).slice(-65536);});
 const origin='http://127.0.0.1:8080',url=origin;
 for(let n=0;n<100;n++){if(logs.includes('"event":"listening"'))break;if(child.exitCode!==null)throw Error('Private HTTP QA child exited');await new Promise(r=>setTimeout(r,100));}
 assert.ok(logs.includes('"event":"listening"'));
 const created=await fetch(url+'/api/session',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'});assert.equal(created.status,200);const session=(await created.json()).session,cookie=created.headers.get('set-cookie').split(';')[0];
 const http=async(path,body,extra={})=>{const r=await fetch(url+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie,'X-Svitlo-CSRF':session.csrf_token,...extra},body:JSON.stringify(body)});return {status:r.status,body:await r.json(),headers:r.headers};};
 await check('normal bootstrap/search do not create diagnostic reports without explicit submission',async()=>{
  const before=(await admin.query('select count(*)::int n from svitlo_telemetry.reports')).rows[0].n;assert.equal((await http('/api',{action:'bootstrap'})).status,200);assert.equal((await http('/api/v1/search',{kind:'cities',q:'хри'})).status,200);assert.equal((await admin.query('select count(*)::int n from svitlo_telemetry.reports')).rows[0].n,before);
 });
 await check('actual HTTP storage failure returns 503, retry accepts once, duplicate returns 200',async()=>{
  const p=sample();await admin.query('revoke execute on function svitlo_telemetry.submit_report(jsonb) from svitlo_stage_api');const failure=await http('/diagnostic-reports',p,{'X-Svitlo-Diagnostic-Consent':p.reportId});assert.equal(failure.status,503);assert.equal(failure.body.receiptId,undefined);
  await admin.query('grant execute on function svitlo_telemetry.submit_report(jsonb) to svitlo_stage_api');const retry=await http('/diagnostic-reports',p,{'X-Svitlo-Diagnostic-Consent':p.reportId});assert.equal(retry.status,201);assert.equal((await http('/diagnostic-reports',p,{'X-Svitlo-Diagnostic-Consent':p.reportId})).status,200);
 });
 await check('actual HTTP security sink outage never admits invalid requests or blocks valid reads',async()=>{
  await admin.query('revoke execute on function svitlo_telemetry.record_security(jsonb) from svitlo_stage_api');assert.equal((await http('/api/v1/search',{kind:'cities',raw:'QA_SECRET_CANARY'})).status,400);assert.equal((await http('/api/v1/search',{kind:'cities',q:'хри'})).status,200);await admin.query('grant execute on function svitlo_telemetry.record_security(jsonb) to svitlo_stage_api');
 });
 await check('actual HTTP logs and private metadata never retain canary input or unknown URL',async()=>{
  await http('/api/QA_SECRET_CANARY',{action:'QA_SECRET_CANARY'});await http('/api/v1/search',{kind:'cities',q:'QA_SECRET_CANARY\r\nTOKEN'});await new Promise(r=>setTimeout(r,150));assert.equal(logs.includes('QA_SECRET_CANARY'),false);
  const data=(await admin.query("select (select coalesce(string_agg(packet::text,''),'') from svitlo_telemetry.reports)||(select coalesce(string_agg(to_jsonb(e)::text,''),'') from svitlo_telemetry.security_events e) data")).rows[0].data;assert.equal(data.includes('QA_SECRET_CANARY'),false);
 });
 console.log(JSON.stringify({scope:'isolated-restored-postgres-and-private-http',passed:checks.length,checks}));
}finally{
 if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,5000))]);if(child.exitCode===null)child.kill('SIGKILL');}
 await Promise.all([rt.p.end(),worker.end(),admin.end()]);
}
