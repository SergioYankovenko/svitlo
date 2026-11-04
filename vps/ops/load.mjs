// ARC-05 isolated data/load drill. Never accepts the live database name.
import pg from 'pg';import {readFile} from 'node:fs/promises';import {spawn} from 'node:child_process';import {randomUUID,randomBytes} from 'node:crypto';import assert from 'node:assert/strict';
import {runtime} from '../runtime.js';import {ownerContext} from '../db.js';import {PhoneSensors} from '../sensors/phone.js';import {SensorAccess,tokenHash} from '../sensors/service.js';
if(!/^svitlo_arc_qa_\d+$/.test(process.env.PGDATABASE||''))throw Error('Disposable ARC QA database required');
const admin=new pg.Client({host:'postgres',user:'svitlo_owner',database:process.env.PGDATABASE,password:(await readFile('/run/secrets/owner_password','utf8')).trim()});await admin.connect();
const rt=await runtime(),phone=new PhoneSensors({bridge:rt.bridge,secret:(await readFile('/run/secrets/phone_secret','utf8')).trim()}),access=new SensorAccess({bridge:rt.bridge,phone,secret:(await readFile('/run/secrets/sensor_access_secret','utf8')).trim()});
const actors=Array.from({length:3000},()=>randomUUID()),devices=[],boot=randomUUID(),monitor=randomUUID();let child;const checks=[];
const q=(sql,p)=>admin.query(sql,p),token=p=>p+'_'+randomBytes(32).toString('base64url');
const check=(name,fn)=>Promise.resolve(fn()).then(()=>{checks.push(name);console.log(JSON.stringify({check:name,status:'pass'}));});
const event=(seq=1)=>({eventId:randomUUID(),sequence:seq,eventType:'sample',powerState:'on',observedAt:new Date().toISOString(),clockQuality:'synchronized',bootId:boot,elapsedRealtimeMs:seq*300000,monitorId:monitor,coverage:null});
const packet=(d,e)=>({schemaVersion:3,sensorId:d.sensorId,bindingEpoch:d.bindingEpoch,streamId:d.streamId,events:[e]});
async function request(path,data,auth){const start=performance.now(),r=await fetch('http://127.0.0.1:8080'+path,{method:'POST',headers:{Host:'localhost:18765','content-type':'application/json',authorization:'Bearer '+auth},body:JSON.stringify(data)});const value=await r.json();return {status:r.status,ms:performance.now()-start,value};}
async function start(){child=spawn(process.execPath,['vps/http.mjs'],{stdio:['ignore','ignore','pipe'],env:{...process.env,STAGE_ORIGIN:'http://127.0.0.1:8080'}});let log='';child.stderr.on('data',d=>{log=(log+d).slice(-1000);});for(let i=0;i<80;i++){try{const r=await fetch('http://127.0.0.1:8080/readyz');if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('QA server not ready '+log.replace(/\b[spdt]_[A-Za-z0-9_-]+/g,'[redacted]'));}
async function stop(){if(!child)return;const c=child;child=null;c.kill('SIGTERM');await new Promise(r=>c.once('exit',r));}
try{
 await q('insert into auth.users(id) select unnest($1::uuid[])',[actors]);
 const address=(await q("select id,operator_id from svitlo_vps.catalog where kind='address' and operator_id='qa-grid' order by label limit 1")).rows[0];assert.ok(address);
 const profiles=actors.map(owner=>({id:randomUUID(),owner,address:{canonicalAddressId:address.id,operatorId:address.operator_id,department:'universal:qa-grid',house:'1'}}));
 await q("insert into public.svitlo_profiles(id,owner,address,name) select (x->>'id')::uuid,(x->>'owner')::uuid,x->'address','ARC disposable' from jsonb_array_elements($1::jsonb) x",[JSON.stringify(profiles)]);
 const seedStart=performance.now();
 for(let i=0;i<actors.length;i++){
  // Registration deliberately retains pilot caps100/hour and1000phone enrollments.
  // Seed a larger, disposable factory fleet with the existing admin provisioning API.
  const d={sensorId:randomUUID(),controlToken:token('sd')},proof=token('so');
  await q('select svitlo_sensors.admin_factory_phone($1,$2,$3,$4)',[d.sensorId,tokenHash(d.controlToken),tokenHash(proof),phone.seal(proof,'owner-qr:'+d.sensorId)]);
  const control=action=>phone.control('Bearer '+d.controlToken,{schemaVersion:1,action,sensorId:d.sensorId});
  const qr={version:1,kind:'factory_owner',sensorId:d.sensorId,proof};
  await ownerContext.run(actors[i],()=>access.handle(actors[i],{schemaVersion:1,action:'connect_qr',requestId:randomUUID(),qr,profileId:profiles[i].id}));
  devices.push({...d,...await control('ingest_credentials')});
 }
 await check('3000 private profiles and factory phone identities seeded via actual admin/access logic; enrollment caps unchanged',()=>assert.equal(devices.length,3000));
 console.log(JSON.stringify({seedSeconds:Math.round((performance.now()-seedStart)/1000)}));
 // Preserve metadata receipts for the complete replay horizon; no raw body is retained.
 const d=devices[0],binding=(await q('select binding_id from svitlo_sensors.bindings where sensor_id=$1',[d.sensorId])).rows[0].binding_id;
 const before=Number((await q("select pg_total_relation_size('svitlo_sensors.phone_receipts') n")).rows[0].n);
 await q("insert into svitlo_sensors.phone_receipts select $1::uuid,$2::uuid,gen_random_uuid(),s+1000,repeat('a',64),now()-(s||' minutes')::interval,'stored' from generate_series(1,25920) s",[binding,d.streamId]);
 const after=Number((await q("select pg_total_relation_size('svitlo_sensors.phone_receipts') n")).rows[0].n),bytesPerRow=(after-before)/25920;
 console.log(JSON.stringify({storageSampleRows:25920,incrementalBytes:after-before,bytesPerReceipt:Math.round(bytesPerRow),estimatedReceiptsFor3000Devices91Days:3000*288*91,estimatedGiBFor3000Devices91Days:Math.round(bytesPerRow*3000*288*91/2**30*10)/10,isProjection:true,includesOtherTablesOrBackups:false}));
 await check('retention keeps boundary receipts and expires only bounded older rows',async()=>{await q("update svitlo_sensors.phone_receipts set received_at=now()-interval '90 days 12 hours' where binding_id=$1 and sequence=1001",[binding]);await q("update svitlo_sensors.phone_receipts set received_at=now()-interval '92 days' where binding_id=$1 and sequence between 1002 and 2105",[binding]);const r=(await q('select svitlo_sensors.phone_cleanup() r')).rows[0].r;assert.equal(r.expiredPhoneReceipts,1000);assert.equal((await q('select count(*)::int n from svitlo_sensors.phone_receipts where binding_id=$1 and sequence=1001',[binding])).rows[0].n,1);});
 await start();const durations=[],statuses={},pending=new Set();let started=performance.now(),completed=0;
 for(let i=0;i<devices.length*2;i++){
  const wait=started+i*50-performance.now();if(wait>0)await new Promise(r=>setTimeout(r,wait));
  if(pending.size>=8)await Promise.race(pending);
  const d=devices[Math.floor(i/2)],ingest=i%2===1,data=ingest?packet(d,event()):{schemaVersion:1,action:'status',sensorId:d.sensorId};
  const task=(async()=>{for(let retry=0;retry<4;retry++){
   const r=await request(ingest?'/api/v1/sensor-events':'/api/v1/sensor-devices/control',data,ingest?d.ingestToken:d.controlToken);
   durations.push(r.ms);statuses[r.status]=(statuses[r.status]||0)+1;
   if(r.status===200){completed++;return;}
   assert.equal(r.status,429);await new Promise(r=>setTimeout(r,1000));
  }throw Error('Bounded retry exhausted');})();pending.add(task);task.then(()=>pending.delete(task));
 }
 await Promise.all(pending);assert.equal(completed,6000);
 const e=event(2),pack=packet(devices[1],e),proof=devices[1].ingestToken;
 assert.equal((await request('/api/v1/sensor-events',pack,proof)).status,200);await stop();await start();
 await check('process restart preserves device credentials and exact duplicate ACK',async()=>{const r=await request('/api/v1/sensor-events',pack,proof);assert.equal(r.status,200);assert.equal(r.value.acknowledged[0].duplicate,true);});
 durations.sort((a,b)=>a-b);console.log(JSON.stringify({scope:'isolated-3000-profiles-3000-sensors',httpRequests:durations.length,statuses,p50ms:Math.round(durations[Math.floor(durations.length*.5)]),p95ms:Math.round(durations[Math.floor(durations.length*.95)]),p99ms:Math.round(durations[Math.floor(durations.length*.99)]),seconds:Math.round((performance.now()-started)/1000),offeredAverageRequestsPerSecond:20,providerRequests:0,doesNotEstablishPwaFleetCapacity:true,checks}));
}finally{await stop();await rt.p.end();await admin.end();}
