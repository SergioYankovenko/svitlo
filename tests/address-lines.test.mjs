import {verifyLineSql} from '../vps/universal/line-assertions.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {addressGroupCount,confirmedLines,lineGuideKey} from '../app/lib/address-groups.js';

test('line views count homes and only a complete same-address resolution expands',()=>{
 const a={canonicalAddressId:'home',operatorId:'op'};
 assert.equal(addressGroupCount([{address:{...a,lineId:'one'}},{address:{...a,lineId:'two'}},{address:{canonicalAddressId:'other'}}]),2);
 const r={resolution:{state:'ambiguous',complete:true,lines:[{id:'a',groupCode:'1.1'},{id:'b',groupCode:'2.1'},{id:'duplicate',groupCode:'1.1'}]}};
 assert.deepEqual(confirmedLines(r).map(l=>l.id),['a','b']);r.resolution.complete=false;assert.deepEqual(confirmedLines(r),[]);
 const views=[{id:'p1',addressGroupId:'home',lineId:'l1',lineNumber:1},{id:'p2',addressGroupId:'home',lineId:'l2',lineNumber:2}];
 assert.equal(lineGuideKey(views,'p1'),lineGuideKey(views.toReversed(),'p2'));
 assert.equal(lineGuideKey(views.slice(0,1),'p1'),null);
});

async function lineDatabase(){
 const db=new PGlite();
 await db.exec('create role svitlo_stage_api;create role svitlo_stage_worker;create role svitlo_stage_session;create schema svitlo_vps;create table svitlo_vps.migrations(name text primary key,sha256 text);');
 await db.exec(await readFile(new URL('../vps/sql/platform.sql',import.meta.url),'utf8'));
 for(const file of (await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort()){
  let sql=await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8');
  if(file==='20261027203648_conditional_jobs_maintenance.sql')sql=sql.slice(0,sql.search(/create (?:or replace )?function svitlo_internal\.dispatch\(\)/i));
  try{await db.exec(sql);}catch(e){throw Error(file+': '+e.message);}
 }
 for(const file of ['runtime','session-retention','universal','universal-profile-adoption','catalog-quality','telemetry','sensor-access','sensor-ingest','sensor-history','map-addresses','phone-sensor','main-app-subscription','address-lines']){
  try{await db.exec(await readFile(new URL('../vps/sql/'+file+'.sql',import.meta.url),'utf8'));}catch(e){throw Error(file+': '+e.message);}
 }
 return db;
}
test('SQL quotas, atomic groups and sensor links use homes and exact lines',async()=>{
 const db=await lineDatabase();try{await verifyLineSql(db);}finally{await db.close();}
});
