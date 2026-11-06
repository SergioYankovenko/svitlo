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
 console.log(JSON.stringify({scope:'multiline-home-quota-and-sensors',passed:12,proof,checks:['SQL two-line and three-line canonical grouping','free two homes with multiple lines','premium ten homes and twenty line profiles','idempotent reversed line order','atomic identity rejection','cross-owner denial','twenty independent sensor memberships','one sensor per exact line','disconnect preserves other memberships','server expands confirmed same-address lines','independent per-line snapshots','API free quota enforcement']}));
}finally{await rt?.close();await admin.end();}
