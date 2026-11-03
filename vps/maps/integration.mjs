import pg from 'pg';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID,randomBytes} from 'node:crypto';
import {runtime} from '../runtime.js';
import {ownerContext} from '../db.js';
import {SensorAccess,tokenHash} from '../sensors/service.js';
import {SensorIngest} from '../sensors/ingest.js';
import {validProfile} from '../../app/lib/cache-data.js';
import {publicProfile} from '../../server/service.js';
const database=process.env.PGDATABASE;
if(!/^svitlo_map_qa_\d+$/.test(database||''))throw Error('Disposable restored map QA database required');
const admin=new pg.Client({host:'postgres',user:'svitlo_owner',database,password:(await readFile('/run/secrets/owner_password','utf8')).trim()});await admin.connect();
const rt=await runtime(),checks=[];
const actors=Array.from({length:5},()=>randomUUID()),[a,b,c,d,e]=actors;
const command=(owner,fn)=>ownerContext.run(owner,fn);
const check=async(name,fn)=>{await fn();checks.push(name);console.log(JSON.stringify({check:name,status:'pass'}));};
const up=async(kind,key,label,parent=null)=>(await admin.query("select svitlo_vps.catalog_upsert('ua-cherkasy',$1,$2::jsonb::text,$3,$4,'{}','{\"testOnly\":true}') id",[kind,JSON.stringify(key),label,parent])).rows[0].id;
const req=(cityId,street='Флорештська',house='10а/51')=>({schemaVersion:1,cityId,street,house});
let calls=0;
try{
 for(const actor of actors)await admin.query('insert into auth.users(id) values($1)',[actor]);
 const key=['map-qa',randomUUID()],city=await up('city',key,'м. Христинівка');
 await admin.query("select svitlo_vps.catalog_route_state('ua-cherkasy',$1::jsonb::text,$2,'available',true,now(),'{\"reference\":\"isolated MAP-01 fixture\"}')",[JSON.stringify(key),city]);
 const street=await up('street',['map-provider-street'],'Контрольна',city),house=await up('address',['map-provider-house'],'1',street);
 const frozen=JSON.parse(await readFile(new URL('./fixtures/floreshtska-street.json',import.meta.url),'utf8'));
 const location={featureId:frozen.id,streetId:frozen.id,settlementId:'STL1NYKCD',street:'Флорештська',streetType:'вул.',matchedHouse:null,precision:'street',relation:'same',source:'visicom',city:'Христинівка',checkedAt:Date.now(),longitude:frozen.geo_centroid.coordinates[0],latitude:frozen.geo_centroid.coordinates[1],url:`https://maps.visicom.ua/c/29.97122,48.811678,17/f/${frozen.id}?lang=uk`,label:'Христинівка, вул. Флорештська'};
 rt.maps.connector={lookup:async()=>{calls++;return [location];}};
 const search=(owner,p=req(city))=>command(owner,()=>rt.maps.search(owner,p));
 const save=async(owner,p=req(city))=>{const result=await search(owner,p);return command(owner,()=>rt.service.handle(owner,{action:'save',confirmed:true,name:'MAP QA',address:{mapCandidateToken:result.candidates[0].token}}));};
 let pa,pb;
 await check('existing provider house prevents map calls',async()=>{const r=await search(a,req(city,'Контрольна','1'));assert.equal(r.state,'provider_found');assert.equal(r.addressId,house);assert.equal(calls,0);});
 await check('map-only profile preserves full input, null line/queue and approximate precision in PostgreSQL',async()=>{pa=(await save(a)).profile;assert.equal(pa.address.house,'10а/51');assert.equal(pa.address.mapLocation.precision,'street');assert.equal(pa.address.lineId,null);assert.equal(pa.snapshot.queue,null);assert.equal(pa.snapshot.checkedAt,0);assert.equal(pa.snapshot.universal,undefined);assert(validProfile(pa,a));});
 await check('duplicate save keeps profile ID and original full house',async()=>{const duplicate=(await save(a)).profile;assert.equal(duplicate.id,pa.id);assert.equal(duplicate.address.house,'10а/51');});
 await check('map references stay absent from provider search and foreign direct lookups',async()=>{const publicStreets=await rt.reader.catalog.search({kind:'streets',parentId:city});assert(publicStreets.items.every(x=>x.id!==pa.address.streetId));await assert.rejects(()=>rt.reader.catalog.entity(pa.address.canonicalAddressId),x=>x.status===404);await assert.rejects(()=>command(c,()=>rt.reader.catalog.entity(pa.address.canonicalAddressId)),x=>x.status===404);assert.equal((await command(a,()=>rt.reader.catalog.entity(pa.address.canonicalAddressId))).id,pa.address.canonicalAddressId);});
 await check('owner-bound proof prevents cross-owner creation and source metadata is never trusted from client',async()=>{const r=await search(a);await assert.rejects(()=>command(b,()=>rt.service.handle(b,{action:'save',confirmed:true,address:{mapCandidateToken:r.candidates[0].token}})),x=>x.status===409);assert.equal((await admin.query('select count(*)::int n from public.svitlo_profiles where owner=$1',[b])).rows[0].n,0);});
 await check('same map address shares canonical identity without leaking either private profile',async()=>{pb=(await save(b)).profile;assert.equal(pb.address.canonicalAddressId,pa.address.canonicalAddressId);assert.notEqual(pb.id,pa.id);const values=await command(b,()=>rt.db.profiles(b));assert.equal(values.length,1);assert(values.every(p=>p.owner===b));});
 await check('proof-only catalog allocator is no-login and cannot be SET ROLE or read budgets by API',async()=>{await assert.rejects(()=>rt.p.query('set role svitlo_map_owner'),x=>x.code==='42501');await assert.rejects(()=>rt.p.query('select * from svitlo_maps.budgets'),x=>x.code==='42501');const role=(await admin.query("select rolcanlogin,rolbypassrls from pg_roles where rolname='svitlo_map_owner'")).rows[0];assert.deepEqual(role,{rolcanlogin:false,rolbypassrls:false});});
 await check('map profile remains eligible for sensor proof and viewer invitation under existing 1:1 rules',async()=>{
  const sensor=new SensorAccess({bridge:rt.bridge,db:rt.db,secret:(await readFile('/run/secrets/sensor_access_secret','utf8')).trim()});
  const claimToken='sc_'+randomBytes(32).toString('base64url');await admin.query('select svitlo_sensors.admin_provision($1,null)',[tokenHash(claimToken)]);
  const packet={schemaVersion:1,action:'claim',requestId:randomUUID(),claimToken,profileId:pa.id};
  const first=await command(a,()=>sensor.handle(a,packet));assert.equal(first.sensor.canonicalAddressId,pa.address.canonicalAddressId);assert.equal(first.sensor.lineId,null);
  const again=await command(a,()=>sensor.handle(a,packet));assert.equal(again.sensor.measurementPointId,first.sensor.measurementPointId);
  const ref={sensorId:first.sensor.sensorId,bindingEpoch:first.sensor.bindingEpoch};
  const invitation=await command(a,()=>sensor.handle(a,{schemaVersion:1,action:'invite_create',requestId:randomUUID(),...ref}));
  const accepted=await command(b,()=>sensor.handle(b,{schemaVersion:1,action:'invite_accept',requestId:randomUUID(),inviteToken:invitation.invitation.inviteToken,profileId:pb.id}));assert.equal(accepted.sensor.measurementPointId,first.sensor.measurementPointId);
  const list=await command(a,()=>sensor.handle(a,{schemaVersion:1,action:'list'}));assert.equal(list.sensors[0].readerProfileId,pa.id);
  const token='st_'+randomBytes(32).toString('base64url'),key=(await admin.query('select svitlo_sensors.admin_ingest_credential($1,$2,$3) result',[ref.sensorId,ref.bindingEpoch,tokenHash(token)])).rows[0].result;
  await new SensorIngest(rt.bridge).handle('Bearer '+token,{schemaVersion:1,...ref,streamId:key.streamId,eventId:randomUUID(),sequence:1,eventType:'sample',powerState:'off',observedAt:new Date().toISOString(),clockQuality:'synchronized'});
  const fresh=await command(b,()=>sensor.handle(b,{schemaVersion:1,action:'signal',...ref}));assert.equal(fresh.signal.powerState,'off');assert.equal(fresh.signal.isTest,true);
  assert.equal((await command(a,()=>rt.db.profiles(a)))[0].snapshot.queue,null);
 });
 await check('concurrent different houses allocate one new map street without collision',async()=>{
  const local={...location,streetId:'STRQARACE'+randomUUID().replaceAll('-','').toUpperCase()};
  const results=await Promise.all(['901','902'].map(house=>command(e,()=>rt.service.handle(e,{action:'save',confirmed:true,address:{mapCandidateToken:rt.maps.token(e,{cityId:city,street:'Флорештська',house},local)}}))));
  assert.equal(results[0].profile.address.streetId,results[1].profile.address.streetId);assert.notEqual(results[0].profile.address.canonicalAddressId,results[1].profile.address.canonicalAddressId);
 });
 await check('per-owner map budgets enforce six lookups and no source call on seventh',async()=>{for(let i=0;i<6;i++)await search(c);const before=calls;await assert.rejects(()=>search(c),x=>x.status===429);assert.equal(calls,before);});
 await check('profile maximum ten and duplicate handling remain atomic for map-only addresses',async()=>{
  for(let n=0;n<10;n++){const input={cityId:city,street:'Флорештська',house:String(1000+n)};const token=rt.maps.token(d,input,location);await command(d,()=>rt.service.handle(d,{action:'save',confirmed:true,address:{mapCandidateToken:token}}));}
  const token=rt.maps.token(d,{cityId:city,street:'Флорештська',house:'1010'},location);await assert.rejects(()=>command(d,()=>rt.service.handle(d,{action:'save',confirmed:true,address:{mapCandidateToken:token}})),x=>x.status===409);
  assert.equal((await admin.query('select count(*)::int n from public.svitlo_profiles where owner=$1',[d])).rows[0].n,10);
 });
 await check('saved map profile is stable after fresh database read and no provider evidence or candidate proof is stored',async()=>{const stored=(await command(a,()=>rt.db.profiles(a)))[0];assert.equal(stored.address.house,'10а/51');assert(validProfile(publicProfile(stored),a));assert(!JSON.stringify(stored).includes('mapCandidateToken'));assert.equal((await admin.query('select count(*)::int n from svitlo_vps.address_lines where address_id=$1',[stored.address.canonicalAddressId])).rows[0].n,0);});
 console.log(JSON.stringify({scope:'isolated-restored-map-QA',passed:checks.length,failed:0,realPhysicalTelemetry:false}));
}finally{await Promise.all([rt.p.end(),admin.end()]);}
