import pg from 'pg';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {runtime} from '../runtime.js';
import {ownerContext} from '../db.js';
import {validUniversal} from '../../app/lib/universal-contract.js';
import {projectYasno} from './yasno.js';
import {projectStreet} from './policy.js';
import {dtekFixtureAt,yasnoFixtureAt} from './fixtures/calendar.mjs';
import {dayKey,addDays} from '../../app/lib/time.js';
import {finalCandidate,normalHouse} from '../maps/policy.js';
import {SensorAccess,tokenHash} from '../sensors/service.js';
import {SensorIngest} from '../sensors/ingest.js';
const database=process.env.PGDATABASE;
if(!/^svitlo_kyiv_qa_\d+$/.test(database||''))throw Error('Disposable restored Kyiv QA database required');
const admin=new pg.Client({host:'postgres',user:'svitlo_owner',database,password:(await readFile('/run/secrets/owner_password','utf8')).trim()});await admin.connect();
const rt=await runtime(),worker=await runtime('worker'),rt2=await runtime(),checks=[];
const op='ua-kyiv-dtek',province='ua-kyiv-region-dtek',actors=[randomUUID(),randomUUID()];
const originals=(await admin.query('select id from public.svitlo_profiles order by id')).rows.map(r=>r.id);
const digest=async()=>(await admin.query("select md5(string_agg(id::text||owner::text||address::text||name||preferences::text,'|' order by id)) value from public.svitlo_profiles where id=any($1::uuid[])",[originals])).rows[0].value;
const before=await digest(),now=Date.now(),fixtureDate=dayKey(now),decisionKey='GPV23.1:'+fixtureDate,range={fromDate:fixtureDate,toDate:addDays(fixtureDate,1)};
const fixtures=Object.fromEntries(await Promise.all(['kyiv','brovary'].map(async name=>[name,dtekFixtureAt(JSON.parse(await readFile(new URL('./fixtures/'+name+'.json',import.meta.url),'utf8')),now)])));
let calls=0,child=null;
const check=async(name,fn)=>{await fn();checks.push(name);console.log(JSON.stringify({check:name,status:'pass'}));};
const find=async(kind,parentId,q)=>{const result=await rt.reader.catalog.search({kind,parentId,q});assert(result.items.length);return result.items;};
const command=(owner,fn)=>ownerContext.run(owner,fn);
const request=(path,body)=>new Promise((resolve,reject)=>{const r=http.request({host:'127.0.0.1',port:8080,path,method:body?'POST':'GET',headers:{Host:'localhost:18765',...(body?{'content-type':'application/json'}:{})}},res=>{let value='';res.on('data',d=>value+=d);res.on('end',()=>{try{resolve({status:res.statusCode,value:JSON.parse(value)});}catch(e){reject(e);}});});r.on('error',reject);r.setTimeout(5000,()=>r.destroy(Error('HTTP timeout')));r.end(body?JSON.stringify(body):undefined);});
try{
 // Freeze only regional QA clocks at the captured real instant; transport, SQL,
 // sensor and child HTTP clocks keep running. No historical fixtures become live data.
 for(const r of [rt,rt2,worker]){
  r.regions.now=()=>now;
  for(const cache of ['indexCache','streetCache','snapshotCache','statusCache'])r.regions[cache].now=()=>now;
 }
 for(const id of actors)await admin.query('insert into auth.users(id) values($1)',[id]);
 for(const r of [worker,rt])for(const operator of [op,province])r.regions.clients.set(operator,{streets:async()=>{calls++;return operator===op?{'м. Київ':['вул.Хрещатик']}:{'м.Бровари':['вул.Київська'],'м.Ірпінь':['вул.Університетська']};},houses:async()=>{calls++;return fixtures[operator===op?'kyiv':'brovary'];}});
 let cityMode='EmergencyShutdowns',cityMismatch=false,cityIncomplete=false;
 rt.regions.cityStatus=async()=>{const raw=yasnoFixtureAt(JSON.parse(await readFile(new URL('./fixtures/yasno-applies-23.1.json',import.meta.url),'utf8')),now);raw['23.1'].today.status=cityMode;if(cityMismatch){raw['23.1'].today.slots[1].end=809;raw['23.1'].today.slots[2].start=809;}if(cityIncomplete)raw['23.1'].today.slots=[];return projectYasno(raw,now);};
 let city,town,street,address,other,brovary;
 await check('private allocator cannot be assumed or read directly and API cannot seed cities',async()=>{
  await assert.rejects(()=>rt.p.query('set role svitlo_region_owner'),e=>e.code==='42501');
  await assert.rejects(()=>rt.p.query('select * from svitlo_regions.provider_state'),e=>e.code==='42501');
  await assert.rejects(()=>rt.regions.import(op,'city',null,['м. Київ'],now));
  assert.deepEqual((await admin.query("select rolcanlogin,rolbypassrls from pg_roles where rolname='svitlo_region_owner'")).rows[0],{rolcanlogin:false,rolbypassrls:false});
 });
 await check('worker seeds separate city and province routes; suffix does not pollute Kyiv search',async()=>{
  await worker.regions.seed();city=(await find('cities',null,'м. Київ')).find(e=>e.label==='м. Київ').id;
  const cities=await find('cities',null,'Київ');assert(cities.every(e=>!e.label.includes('Бровари')&&!e.label.includes('Ірпінь')));
  town=(await find('cities',null,'Бровари'))[0].id;
 });
 await check('on-demand street and exact full house discovery has stable shared identities',async()=>{
  street=(await find('streets',city,'Хрещатик'))[0].id;const houses=await find('houses',street,'36');address=houses.find(e=>e.label==='36').id;other=houses.find(e=>e.label!=='36');assert(other);
  assert.equal((await rt.reader.catalog.entity(address)).source_ref.house,'36');assert.equal((await rt.reader.catalog.search({kind:'houses',parentId:street,q:'99999'})).items.length,0);
  rt2.regions.clients.set(op,{streets:async()=>{throw Error('shared index missed');},houses:async()=>{throw Error('shared street missed');}});
  assert.deepEqual((await rt2.reader.catalog.search({kind:'houses',parentId:street,q:'36'})).items,houses);
 });
 await check('cross-region parent is rejected before any catalog update',async()=>{
  await assert.rejects(()=>rt.regions.import(province,'street',city,['Injected'],now+1));
  const legacy=(await admin.query("select id from svitlo_vps.catalog where kind='city' and metadata->>'regionOperator' is null limit 1")).rows[0];
  assert(legacy);await assert.rejects(()=>rt.regions.import(op,'street',legacy.id,['Injected'],now+1));
 });
 await check('all three Brovary groups survive resolution and require explicit selection',async()=>{
  const s=(await find('streets',town,'Київська'))[0].id;brovary=(await find('houses',s,'1')).find(e=>e.label==='1').id;
  const result=await rt.reader.resolve({addressId:brovary});assert.equal(result.resolution.lines.length,3);assert.equal(result.resolution.complete,true);assert.equal(result.selection.lineId,null);
  await assert.rejects(()=>command(actors[0],()=>rt.service.handle(actors[0],{action:'save',confirmed:true,address:{canonicalAddressId:brovary}})),e=>e.status===409);
 });
 await check('Kyiv emergency suspends applicability while keeping dated plan in provenance',async()=>{
  const value=await rt.reader.snapshot(address,range);assert(validUniversal(value));assert.equal(value.lines[0].categories.hourly.days[0].state,'suspended');
  const decision=value.provenance[0].reconciliation.days[decisionKey];assert.equal(decision.policy,'kyiv-sources-v3');assert.equal(decision.powerState,'unknown');assert(Array.isArray(decision.publishedIntervals));
 });
 await check('explicit line saves one private profile, duplicate is stable and foreign owner cannot read it',async()=>{
  const result=await rt.reader.resolve({addressId:brovary}),lineId=result.resolution.lines[0].id;
  const save=()=>command(actors[0],()=>rt.service.handle(actors[0],{action:'save',confirmed:true,name:'Kyiv QA',address:{canonicalAddressId:brovary,lineId}}));
  const first=(await save()).profile,second=(await save()).profile;assert.equal(first.id,second.id);assert.equal(first.address.lineId,lineId);
  assert.equal((await command(actors[1],()=>rt.db.profiles(actors[1]))).length,0);
 });
 let mapCalls=0;rt.maps.connector={lookup:async(input,context)=>{mapCalls++;const capital=context.name==='Київ';assert.equal(context.region,capital?'Київ':'Київська область');const geo=JSON.parse(await readFile(new URL('./fixtures/'+(capital?'kyiv':'brovary')+'-visicom-street.json',import.meta.url),'utf8')),p=geo.properties;return [finalCandidate(geo,{featureId:geo.id,streetId:geo.id,settlementId:p.settlement_id,street:p.name,streetType:p.type,matchedHouse:null,precision:'street',relation:'same'},input,context,Date.now())];}};
 await check('regional provider addresses and slash-before-letter aliases avoid map fallback',async()=>{const result=await command(actors[0],()=>rt.maps.search(actors[0],{schemaVersion:1,cityId:city,streetId:street,street:'вул.Хрещатик',house:'36/а'}));assert.equal(result.state,'provider_found');assert.equal((await rt.reader.catalog.entity(result.addressId)).label,'36А');assert.equal(mapCalls,0);});
 for(const [cityId,streetName,house] of [[city,'Хрещатик','10а/51'],[town,'Київська','8/а']])await check('regional map fallback preserves full house and allows independent sensor '+house,async()=>{
  const result=await command(actors[0],()=>rt.maps.search(actors[0],{schemaVersion:1,cityId,street:streetName,house}));assert.equal(result.state,'found');assert.equal(result.candidates[0].precision,'street');
  const saved=(await command(actors[0],()=>rt.service.handle(actors[0],{action:'save',confirmed:true,name:'Region map QA',address:{mapCandidateToken:result.candidates[0].token}}))).profile;assert.equal(saved.address.house,house);assert.equal(saved.address.mapOnly,true);assert.equal(saved.address.lineId,null);assert.equal(saved.snapshot.queue,null);assert.equal(saved.snapshot.checkedAt,0);
  const sensor=new SensorAccess({bridge:rt.bridge,db:rt.db,secret:(await readFile('/run/secrets/sensor_access_secret','utf8')).trim()}),claim='sc_'+randomBytes(32).toString('base64url');await admin.query('select svitlo_sensors.admin_provision($1,null)',[tokenHash(claim)]);
  const attached=await command(actors[0],()=>sensor.handle(actors[0],{schemaVersion:1,action:'claim',requestId:randomUUID(),claimToken:claim,profileId:saved.id}));assert.equal(attached.sensor.canonicalAddressId,saved.address.canonicalAddressId);assert.equal(attached.sensor.lineId,null);
  const ref={sensorId:attached.sensor.sensorId,bindingEpoch:attached.sensor.bindingEpoch},token='st_'+randomBytes(32).toString('base64url'),stream=(await admin.query('select svitlo_sensors.admin_ingest_credential($1,$2,$3) result',[ref.sensorId,ref.bindingEpoch,tokenHash(token)])).rows[0].result;
  await new SensorIngest(rt.bridge).handle('Bearer '+token,{schemaVersion:1,...ref,streamId:stream.streamId,eventId:randomUUID(),sequence:1,eventType:'sample',powerState:'off',observedAt:new Date().toISOString(),clockQuality:'synchronized'});
  assert.equal((await command(actors[0],()=>sensor.handle(actors[0],{schemaVersion:1,action:'signal',...ref}))).signal.powerState,'off');
 });
 await check('import retirement is restricted to this new parent and stale replay cannot restore it',async()=>{
  const e=await rt.reader.catalog.entity(other.id),version=Date.now()+1000;await rt.regions.import(op,'address',street,['36'],version);
  await assert.rejects(()=>rt.reader.catalog.entity(e.id),x=>x.code==='address_requires_reselection');
  await rt.regions.import(op,'address',street,['36',e.label],version-1);await assert.rejects(()=>rt.reader.catalog.entity(e.id),x=>x.code==='address_requires_reselection');
 });
 await check('retired regional street or city cannot keep a direct child address active',async()=>{for(const parent of [street,city]){await admin.query("update svitlo_vps.catalog set metadata=jsonb_set(metadata,'{sourceActive}','false') where id=$1",[parent]);await assert.rejects(()=>rt.reader.catalog.entity(address),e=>e.code==='address_requires_reselection');await admin.query("update svitlo_vps.catalog set metadata=jsonb_set(metadata,'{sourceActive}','true') where id=$1",[parent]);}});
 await check('upstream budget serializes workers and persists forbidden cooldown',async()=>{
  const first=(await rt.bridge.query('select svitlo_regions.acquire($1) result',['yasno-kyiv'])).rows[0].result;assert(first.granted);
  assert.equal((await rt2.bridge.query('select svitlo_regions.acquire($1) result',['yasno-kyiv'])).rows[0].result.granted,false);
  await rt.regions.finish('yasno-kyiv',first.ticket,{status:403,error:'forbidden',retry:0});
  const next=(await rt2.bridge.query('select svitlo_regions.acquire($1) result',['yasno-kyiv'])).rows[0].result;assert.equal(next.reason,'cooldown');assert.equal(next.code,'forbidden');
 });
 await check('public HTTP ready/search/resolve/snapshots preserve the existing schema',async()=>{
  child=spawn(process.execPath,['vps/http.mjs'],{stdio:['ignore','pipe','pipe'],env:{...process.env,RELEASE_ID:'kyiv-isolated-qa'}});let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
  let ready;for(let i=0;i<40;i++){try{ready=await request('/readyz');if(ready.status===200)break;}catch{}await new Promise(r=>setTimeout(r,100));}assert.equal(ready?.status,200,logs);
  const cap=await request('/api/v1/capabilities');assert.equal(cap.status,200);assert(cap.value.operators.some(x=>x.id===op));
  const result=await request('/api/v1/search',{kind:'cities',q:'Київ'});assert.equal(result.status,200);assert(result.value.items.some(x=>x.id===city));
  assert.equal((await request('/api/v1/resolve',{addressId:address})).status,200);
  const snapshots=await request('/api/v1/snapshots',{...range,items:[{addressId:address}]});assert.equal(snapshots.status,200);assert.equal(snapshots.value.results[0].status,'snapshot');
 });
 await check('original profile identities, addresses, names and preferences are unchanged',async()=>{assert.equal(await digest(),before);});
 await check('source interval agreement is checked after explicit ScheduleApplies mode',async()=>{cityMode='ScheduleApplies';const value=await rt.reader.snapshot(address,{fromDate:fixtureDate,toDate:fixtureDate});const day=value.provenance[0].reconciliation.days[decisionKey];assert.equal(day.intervalComparison,'equal');assert.equal(day.state,'published');assert.equal(value.supportState,'available');});
 await check('one-minute official interval disagreement persists as degraded with both versions',async()=>{cityMismatch=true;const value=await rt.reader.snapshot(address,{fromDate:addDays(fixtureDate,-1),toDate:fixtureDate});const day=value.provenance[0].reconciliation.days[decisionKey];assert.equal(day.intervalComparison,'different');assert.equal(day.state,'unknown');assert(day.secondaryIntervals.length);assert.equal(value.supportState,'degraded');assert(value.lines[0].categories.hourly.days.find(d=>d.date===fixtureDate).intervals.length);});
 await check('incomplete secondary day never confirms primary interval applicability',async()=>{cityIncomplete=true;const value=await rt.reader.snapshot(address,{fromDate:addDays(fixtureDate,-2),toDate:fixtureDate});assert.equal(value.provenance[0].reconciliation.days[decisionKey].reason,'secondary_intervals_unavailable');assert.equal(value.supportState,'degraded');});
 await check('fresh reported emergency remains scoped and visible without a primary daily table',async()=>{cityMode='EmergencyShutdowns';const data=projectStreet(fixtures.kyiv,now);data.fact.data={};const original=rt.regions.address.bind(rt.regions);rt.regions.address=async e=>e.id===address?data:original(e);const value=await rt.reader.snapshot(address,{fromDate:addDays(fixtureDate,-3),toDate:fixtureDate});assert.equal(value.provenance[0].reconciliation.days[decisionKey].reason,'reported_emergency_without_primary_plan');const notice=value.notices.find(n=>n.active);assert.deepEqual(notice.lineIds,[value.lines[0].id]);assert.equal(notice.scope,'reported_group_day');rt.regions.address=original;});
 await check('provider failure serves known catalog with old timestamp and never re-confirms an old single line',async()=>{
  rt.regions.streetCache={load:async(_scope,load)=>load()};rt.regions.clients.set(op,{houses:async()=>{throw Object.assign(Error('forbidden'),{code:'forbidden',status:503});}});
  await admin.query("update svitlo_vps.catalog set metadata=jsonb_set(metadata,'{sourceCheckedAt}',to_jsonb($2::bigint)) where id=$1",[address,now-180000]);
  const cached=await rt.reader.catalog.search({kind:'houses',parentId:street,q:'36'});assert.equal(cached.coverage,'cached_subset');assert.equal(cached.sourceFresh,false);assert.equal(cached.sourceState,'forbidden');assert.equal(cached.items[0].id,address);
  const resolved=await rt.reader.resolve({addressId:address});assert.equal(resolved.resolution.state,'unknown');assert.equal(resolved.resolution.complete,false);assert.equal(resolved.selection.lineId,null);assert.equal(resolved.resolution.provenance.sourceCheckedAt,now-180000);
 });
 await check('reported Degtyarivska and Mrii addresses retain published reference plans and valid source group mapping',async()=>{
  const samples=Object.fromEntries(await Promise.all(['kyiv-dehtiarivska-20261104','kyiv-mrii-20261104'].map(async name=>[name,dtekFixtureAt(JSON.parse(await readFile(new URL('./fixtures/'+name+'.json',import.meta.url),'utf8')),now)])));
  await rt.regions.import(op,'street',city,['вул.Хрещатик','вул. Дегтярівська','вул. Мрії'],Date.now()+2000);
  rt.regions.clients.set(op,{houses:async(_city,s)=>{calls++;return samples[s==='вул. Мрії'?'kyiv-mrii-20261104':'kyiv-dehtiarivska-20261104'];}});
  const groups=['GPV22.1','GPV14.1','GPV21.1'];rt.regions.cityStatus=async()=>({checkedAt:now,groupUpdatedAt:Object.fromEntries(groups.map(g=>[g,now-1000])),groups:Object.fromEntries(groups.map(g=>[g,{[fixtureDate]:'EmergencyShutdowns'}]))});
  for(const [streetName,house,group] of [['вул. Дегтярівська','25','22.1'],['вул. Дегтярівська','25А/к.1','14.1'],['вул. Мрії','15Б','21.1']]){
   const parent=(await admin.query("select id from svitlo_vps.catalog where parent_id=$1 and kind='street' and source_ref->>'street'=$2",[city,streetName])).rows[0].id;
   const entity=(await find('houses',parent,house)).find(e=>e.house===house||e.label===house);assert(entity);
   const resolved=await rt.reader.resolve({addressId:entity.id});assert.equal(resolved.resolution.complete,true);assert.equal(resolved.resolution.lines[0].groupCode,group);assert(resolved.selection.lineId);
   const value=await rt.reader.snapshot(entity.id,{fromDate:fixtureDate,toDate:fixtureDate}),day=value.lines[0].categories.hourly.days[0];assert(validUniversal(value));assert.equal(day.publication.state,'published');assert(day.publication.intervals.length);assert.equal(day.state,'suspended');assert.deepEqual(day.intervals,[]);assert.equal(day.applicability.state,'suspended');assert.equal(value.lines[0].categories.planned.evidenceMode,'positive_only');
  }
  assert.equal(await digest(),before);
 });
 console.log(JSON.stringify({suite:'kyiv-regions',checks:checks.length,status:'pass',originalProfiles:originals.length,originalConfigurationDigest:before,mockUpstreamCalls:calls}));
}finally{
 if(child){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}
 await Promise.allSettled([rt.p.end(),rt2.p.end(),worker.p.end()]);await admin.end();
}
