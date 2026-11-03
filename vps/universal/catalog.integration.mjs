import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {runtime} from '../runtime.js';
import {ownerContext} from '../db.js';
import {universalDay} from '../../app/lib/universal-contract.js';
import {dayKey} from '../../app/lib/time.js';
const admin=new pg.Client({host:'postgres',database:'svitlo_staging',user:'svitlo_owner',password:(await readFile('/run/secrets/owner_password','utf8')).trim()});
await admin.connect();const rt=await runtime(),op='qa-catalog-policy',ids=new Set(),owner=randomUUID(),checks=[];
const check=async(name,fn)=>{await fn();checks.push(name);};
const up=async(kind,key,label,parent=null,ref={})=>{const id=(await admin.query('select svitlo_vps.catalog_upsert($1,$2,$3::jsonb::text,$4,$5,$6,$7) id',[op,kind,JSON.stringify(key),label,parent,JSON.stringify(ref),'{"synthetic":true}'])).rows[0].id;ids.add(id);return id;};
const route=(key,city,state,complete=false,time=new Date())=>admin.query('select svitlo_vps.catalog_route_state($1,$2::jsonb::text,$3,$4,$5,$6,$7)',[op,JSON.stringify(key),city,state,complete,time,'{"reference":"controlled synthetic catalog test"}']);
const search=async(kind,parentId,q='',limit=50)=>rt.reader.catalog.search({kind,parentId,q,limit});
try{
 await admin.query("insert into svitlo_vps.operators values($1,'qa-grid-v1','QA catalog policy','available',true,'{}',1)",[op]);
 const city=await up('city',['city'],'QA Policy city'),street=await up('street',['street'],'вул. Невідомого Солдата',city),house=await up('address',['house'],'1',street,{scenario:'2'});
 await check('exact placeholder normalization rejects only service labels',async()=>{
  for(const label of ['*** Не визначена','вул. *** Не визначена','*невизначена',' ВУЛ.  Не   визначена ','вулиця Не визначена'])assert.equal((await admin.query("select svitlo_vps.catalog_service_label('street',$1) b",[label])).rows[0].b,true,label);
  for(const label of ['вул. Невідомого Солдата','пров. Визначений','вул. Невизначена Площа'])assert.equal((await admin.query("select svitlo_vps.catalog_service_label('street',$1) b",[label])).rows[0].b,false,label);
 });
 const bad=await up('street',['bad'],'*** Не визначена',city),badHouse=await up('address',['bad-house'],'7',bad,{scenario:'2'});
 await check('excluded parent blocks UUID, child, legacy and cached snapshot path',async()=>{
  for(const id of [bad,badHouse])await assert.rejects(()=>rt.reader.catalog.entity(id),e=>e.code==='address_requires_reselection');
  await admin.query("insert into svitlo_vps.catalog_aliases values('ua-cherkasy','address',$1::jsonb::text,$2)",[JSON.stringify([op,'city','bad','7']),badHouse]);
  const legacy=await rt.reader.catalog.legacy({department:op,cityId:'city',streetId:'bad',house:'7'});assert.equal(legacy.state,'needs_confirmation');assert.equal(legacy.reason,'address_requires_reselection');
  await assert.rejects(()=>rt.reader.snapshot(badHouse,rt.reader.range({})),e=>e.code==='address_requires_reselection');
 });
 await check('filtering precedes all cursor pages',async()=>{
  for(let i=0;i<8;i++)await up('street',['page',String(i)],'QA page '+i,city);
  let cursor=null,found=[];do{const r=await rt.reader.catalog.search({kind:'streets',parentId:city,limit:2,cursor});found.push(...r.items);cursor=r.nextCursor;}while(cursor);
  assert.equal(found.length,9);assert.ok(found.every(x=>x.id!==bad));
 });
 await check('repeat import cannot restore service path; verified rename repairs same UUID',async()=>{
  assert.equal(await up('street',['bad'],'вул. *** Не визначена',city),bad);await assert.rejects(()=>rt.reader.catalog.entity(badHouse));
  await up('street',['bad'],'вул. Відновлена',city);assert.equal((await rt.reader.catalog.entity(badHouse)).id,badHouse);
  await up('street',['bad'],'*** Не визначена',city);
 });
 await check('unknown coverage is visible and empty requires complete evidence',async()=>{
  assert.ok((await search('cities',null,'QA Policy')).items.some(x=>x.id===city));
  await assert.rejects(()=>route(['city'],city,'empty',false));
  await route(['city'],city,'unknown');assert.equal((await search('streets',city)).emptyConfirmed,false);
  await route(['city'],city,'available',false,new Date(Date.now()-86400000));assert.equal((await search('streets',city)).coverage,'available');
 });
 await check('verified empty hides before pagination; errors and old imports cannot erase it',async()=>{
  const now=new Date();await route(['city'],city,'empty',true,now);
  assert.equal((await search('cities',null,'QA Policy')).items.length,0);const rows=await search('streets',city);assert.equal(rows.items.length,0);assert.equal(rows.emptyConfirmed,true);
  await route(['city'],city,'unknown',false,new Date(now.getTime()+1000));await route(['city'],city,'available',false,new Date(now.getTime()-1000));
  assert.equal((await search('cities',null,'QA Policy')).items.length,0);
  await route(['city'],city,'available',false,new Date(now.getTime()+2000));assert.equal((await search('cities',null,'QA Policy')).items.length,1);
 });
 const duplicate=await up('city',['duplicate'],'QA Policy city'),distinct=await up('city',['distinct'],'QA Policy city'),otherStreet=await up('street',['other-street'],'вул. Невідомого Солдата',duplicate),otherHouse=await up('address',['other-house'],'1',otherStreet,{scenario:'2'});
 await check('reviewed city merge preserves UUID aliases and distinct same-name streets/places',async()=>{
  await assert.rejects(()=>admin.query('select svitlo_vps.catalog_link_city($1,$2::jsonb::text,$3,$4)',[op,JSON.stringify(['duplicate']),city,'{}']));
  await admin.query('select svitlo_vps.catalog_link_city($1,$2::jsonb::text,$3,$4)',[op,JSON.stringify(['duplicate']),city,'{"reference":"explicit controlled identity mapping"}']);
  assert.equal((await rt.reader.catalog.entity(duplicate)).id,city);assert.equal((await rt.reader.catalog.entity(otherHouse)).id,otherHouse);
  const streets=await search('streets',city);assert.ok(streets.items.some(x=>x.id===street));assert.ok(streets.items.some(x=>x.id===otherStreet));
  assert.ok((await search('cities',null,'QA Policy')).items.some(x=>x.id===distinct));
 });
 await check('one empty route cannot hide a city with another available route',async()=>{
  const future=new Date(Date.now()+5000);await route(['city'],city,'empty',true,future);await route(['duplicate'],city,'available',false,future);
  assert.ok((await search('cities',null,'QA Policy')).items.some(x=>x.id===city));
 });
 await check('API cannot change exclusions, route verification or canonical mapping',async()=>{
  for(const sql of ["delete from svitlo_vps.catalog_exclusions","update svitlo_vps.city_routes set state='available'","select svitlo_vps.catalog_link_city('qa-catalog-policy','[]',$1,'{\"reference\":\"forged client claim\"}')"])
   await assert.rejects(()=>rt.p.query(sql,sql.includes('$1')?[city]:[]),e=>e.code==='42501');
 });
 await admin.query('insert into auth.users(id) values($1)',[owner]);const profileId=randomUUID();
 await admin.query("insert into public.svitlo_profiles(id,owner,address,name,preferences) values($1,$2,$3,'Keep my name','{\"lead\":15,\"emergency\":false}')",[profileId,owner,JSON.stringify({department:'universal:'+op,cityId:'qa',streetId:'qa',house:'1',city:'QA',canonicalAddressId:house,operatorId:op})]);
 await check('saved excluded profile survives with stale history and explicit repair, without false clear',async()=>{
  const run=fn=>ownerContext.run(owner,fn);let p=await run(()=>rt.db.profile(owner,profileId));p=await run(()=>rt.service.refresh(p));const checked=p.snapshot.universal.checkedAt,intervals=JSON.stringify(p.snapshot.universal.lines);
  await up('street',['street'],'*** Не визначена',city);p=await run(()=>rt.service.refresh(p));
  assert.equal(p.id,profileId);assert.equal(p.name,'Keep my name');assert.equal(p.preferences.lead,15);assert.equal(p.preferences.emergency,false);
  assert.equal(p.snapshot.addressRepair.required,true);assert.equal(p.snapshot.universal.checkedAt,checked);assert.equal(JSON.stringify(p.snapshot.universal.lines),intervals);assert.equal(universalDay(p.snapshot.universal,dayKey(),p.snapshot.selectedLineId).known,false);
  await assert.rejects(()=>run(()=>rt.service.handle(owner,{action:'save',confirmed:true,address:{canonicalAddressId:house}})),e=>e.code==='address_requires_reselection');
 });
 console.log(JSON.stringify({scope:'catalog-quality-real-postgres',passed:checks.length,checks}));
}finally{
 await admin.query('delete from auth.users where id=$1',[owner]);
 await admin.query('delete from public.svitlo_source_cache where value->>\'operatorId\'=$1',[op]);
 const all=[...ids];await admin.query('delete from svitlo_vps.address_resolutions where address_id=any($1::uuid[])',[all]);await admin.query('delete from svitlo_vps.address_lines where address_id=any($1::uuid[])',[all]);
 await admin.query('delete from svitlo_vps.catalog_aliases where operator_id=$1 or entity_id=any($2::uuid[])',[op,all]);
 await admin.query('delete from svitlo_vps.catalog where id=any($1::uuid[])',[all]);await admin.query('delete from svitlo_vps.operators where id=$1',[op]);
 await Promise.all([rt.p.end(),admin.end()]);
}
