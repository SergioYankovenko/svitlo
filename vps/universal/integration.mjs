import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {runtime} from '../runtime.js';
import {ownerContext} from '../db.js';
import {seedQa} from './seed.js';
const admin=new pg.Client({host:'postgres',database:'svitlo_staging',user:'svitlo_owner',password:(await readFile('/run/secrets/owner_password','utf8')).trim()});
await admin.connect();const rt=await runtime(),checks=[],owners=[randomUUID(),randomUUID()],op='qa-state';
const run=(owner,fn)=>ownerContext.run(owner,fn);
async function check(name,fn){await fn();checks.push(name);}
try{
 await admin.query('begin');await seedQa(admin,op,'qa-grid-v1','Тимчасовий QA стану');await admin.query('commit');
 const entity=(await admin.query("select * from svitlo_vps.catalog where operator_id=$1 and source_ref->>'scenario'='1'",[op])).rows[0];
 await check('API cannot edit catalog metadata',async()=>await assert.rejects(()=>rt.p.query('update svitlo_vps.catalog set label=label where id=$1',[entity.id]),e=>e.code==='42501'));
 let first;
 await check('stable line IDs survive group changes',async()=>{
  first=await rt.reader.catalog.lines(entity.id,{state:'ambiguous',complete:true,checkedAt:1000,lines:[{key:'north',label:'N',groupCode:'A'},{key:'south',label:'S',groupCode:'B'}]});
  const next=await rt.reader.catalog.lines(entity.id,{state:'ambiguous',complete:true,checkedAt:2000,lines:[{key:'north',label:'N',groupCode:'NEW-42'},{key:'south',label:'S',groupCode:'B'}]});
  assert.equal(next.lines.find(l=>l.key==='north').id,first.lines.find(l=>l.key==='north').id);assert.equal(next.lines.find(l=>l.key==='north').groupCode,'NEW-42');
 });
 await check('partial and stale completions cannot erase known lines',async()=>{
  const partial=await rt.reader.catalog.lines(entity.id,{state:'ambiguous',complete:false,checkedAt:3000,lines:[{key:'north',label:'N',groupCode:'NEW-42'}]});assert.equal(partial.lines.length,2);assert.equal(partial.complete,false);
  const stale=await rt.reader.catalog.lines(entity.id,{state:'unknown',complete:true,checkedAt:1500,lines:[]});assert.equal(stale.lines.length,2);assert.equal(stale.complete,false);
 });
 await check('aliases, source renaming and redirects preserve canonical ID',async()=>{
  await admin.query("insert into svitlo_vps.catalog_aliases(operator_id,kind,provider_key,entity_id) values($1,'address',$2::jsonb::text,$3)",[op,JSON.stringify(['renamed-source-id']),entity.id]);
  await admin.query("update svitlo_vps.catalog set label='1-renamed' where id=$1",[entity.id]);assert.equal((await rt.reader.catalog.entity(entity.id)).id,entity.id);
  const ghost=(await admin.query("insert into svitlo_vps.catalog(kind,parent_id,label,operator_id,redirect_to) values('address',$1,'old alias',$2,$3) returning id",[entity.parent_id,op,entity.id])).rows[0];
  assert.equal((await rt.reader.catalog.entity(ghost.id)).id,entity.id);
 });
 let snapshot;
 await check('concurrent shared reads coalesce to one stored revision',async()=>{const values=await Promise.all(Array.from({length:8},()=>rt.reader.snapshot(entity.id,rt.reader.range({}))));assert.equal(new Set(values.map(v=>v.revision)).size,1);snapshot=values[0];assert.equal(snapshot.lines.length,2);});
 await check('disabled/unsupported operator fails closed without renewing source data',async()=>{
  await admin.query("update svitlo_vps.operators set state='disabled' where id=$1",[op]);const disabled=await rt.reader.snapshot(entity.id,rt.reader.range({}));assert.equal(disabled.supportState,'disabled');assert.equal(disabled.sourceUpdatedAt,snapshot.sourceUpdatedAt);
  await admin.query("update svitlo_vps.operators set state='available',adapter_key='unknown-adapter' where id=$1",[op]);assert.equal((await rt.reader.snapshot(entity.id,rt.reader.range({}))).supportState,'unsupported');
  await admin.query("update svitlo_vps.operators set adapter_key='qa-grid-v1' where id=$1",[op]);
 });
 const resolved=await rt.reader.resolve({addressId:entity.id}),line=resolved.resolution.lines.find(l=>l.key==='north');
 await admin.query('insert into auth.users(id) values($1),($2)',owners);
 const profileId=randomUUID();
 await admin.query("insert into public.svitlo_profiles(id,owner,address,name,preferences) values($1,$2,$3,'Original QA name','{\"lead\":15,\"emergency\":false}')",[profileId,owners[0],JSON.stringify({department:'universal:'+op,cityId:'qa',streetId:'qa',house:'1',city:'QA',canonicalAddressId:entity.id,operatorId:op})]);
 await check('canonical adoption preserves local profile ID/name/preferences without duplicates',async()=>{
  const value=await run(owners[0],()=>rt.service.handle(owners[0],{action:'save',confirmed:true,name:'Must not replace',address:{canonicalAddressId:entity.id,lineId:line.id}}));
  assert.equal(value.created,false);assert.equal(value.profile.id,profileId);assert.equal(value.profile.name,'Original QA name');assert.equal(value.profile.preferences.lead,15);assert.equal(value.profile.preferences.emergency,false);assert.ok(value.profile.snapshot.universal);
  const again=await run(owners[0],()=>rt.service.handle(owners[0],{action:'save',confirmed:true,address:{canonicalAddressId:entity.id,lineId:line.id}}));assert.equal(again.profile.id,profileId);
 });
 await check('canonical profile ownership enforced for sync/mutation',async()=>{for(const action of ['refresh','preferences','delete','weather'])await assert.rejects(()=>run(owners[1],()=>rt.service.handle(owners[1],{action,id:profileId})),e=>e.status===404);});
 await check('public resolution never persists apartment/account in profile',async()=>{await rt.reader.resolve({addressId:entity.id,unit:'2'});const p=await run(owners[0],()=>rt.db.profile(owners[0],profileId));assert.equal(p.address.unit,undefined);assert.equal(p.address.account,undefined);});
 console.log(JSON.stringify({scope:'real-universal-postgres',passed:checks.length,checks}));
}finally{
 await admin.query('delete from auth.users where id=any($1::uuid[])',[owners]);
 await admin.query('delete from public.svitlo_source_cache where value->>\'operatorId\'=$1',[op]);
 await admin.query('delete from svitlo_vps.address_resolutions where address_id in(select id from svitlo_vps.catalog where operator_id=$1)',[op]);
 await admin.query('delete from svitlo_vps.address_lines where address_id in(select id from svitlo_vps.catalog where operator_id=$1)',[op]);
 await admin.query('delete from svitlo_vps.catalog_aliases where operator_id=$1',[op]);
 await admin.query('delete from svitlo_vps.catalog where operator_id=$1',[op]);
 await admin.query("delete from svitlo_vps.catalog where kind='street' and parent_id in(select id from svitlo_vps.catalog where label='Тимчасовий QA стану')");
 await admin.query("delete from svitlo_vps.catalog where label='Тимчасовий QA стану' and kind='city'");
 await admin.query('delete from svitlo_vps.operators where id=$1',[op]);
 await Promise.all([rt.p.end(),admin.end()]);
}
