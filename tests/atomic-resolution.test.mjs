import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {addressResolution} from '../server/address-registry.js';
import {addressResolutionData} from '../server/address-resolution-db.js';

const batch='11111111-1111-4111-8111-111111111111',at=Date.parse('2026-10-27T12:00:00Z');
const address={department:'18',cityId:'801',streetId:'11807',house:'1'};
const url=(id,q)=>`https://www.cherkasyoblenergo.com/${id}/${q}.pdf`;
const version=(id,from='2026-10-01',until='2027-04-01')=>({id,validFrom:from,validUntil:until,checkedAt:at,
 documents:Array.from({length:12},(_,i)=>{const queue=`${Math.floor(i/2)+1}.${i%2+1}`;return {queue,url:url(id,queue),extractedText:'private extracted PDF '.repeat(5000)};}),
 rules:[{scope:'street_all',city:'м. Христинівка',street:'вул. Тестова',queue:'3.2',url:url(id,'3.2'),page:1}],mentions:['not needed by lookup']});
const projection=v=>({id:v.id,validFrom:v.validFrom,validUntil:v.validUntil,documents:v.documents.map(({queue,url})=>({queue,url}))});
async function database({applyNew=true}={}){
 const sql=new PGlite(),dir=new URL('../supabase/migrations/',import.meta.url);
 await sql.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);');
 for(const name of ['20261023225141_svitlo_pwa.sql','20261024144933_queue_registry.sql','20261026145440_address_queue_catalog.sql','20261026153606_queue_registry_metadata.sql','20261026162948_reconcile_address_registry.sql'])
  await sql.exec(await readFile(new URL(name,dir),'utf8'));
 const v=version('v1');
 await sql.query('insert into public.svitlo_queue_versions(id,valid_from,valid_until,checked_at,payload,active) values($1,$2,$3,$4,$5,true)',[v.id,v.validFrom,v.validUntil,at,v]);
 await sql.query("insert into public.svitlo_address_queue_batches(id,import_key,department,status,expected_total,expected_numeric,expected_exclusions,expected_service,checksum_md5,reviewed_at) values($1,'test-batch','18','active',6,4,1,1,repeat('a',32),'2026-10-27T10:00:00Z')",[batch]);
 const rows=[['801','1','numeric','3.2',false,null],['801','2','numeric','3.2',true,'low'],['801','3','not_in_queue',null,false,null],['801','4','service',null,false,null],['801','9 г','numeric','1.1',false,null],['802','1','numeric','6.2',false,null]];
 for(const [city,house,status,queue,estimate,confidence]of rows)await sql.query("insert into public.svitlo_address_queues(batch_id,department,city_id,street_id,house,city,street,status,queue,is_estimate,confidence,evidence) values($1,'18',$2,'11807',$3,'м. Христинівка','вул. Тестова',$4,$5,$6,$7,$8)",[batch,city,house,status,queue,estimate,confidence,{origin:estimate?'curated_estimate':'address_api',...(estimate?{needsReview:false}:{}),...(house==='1'?{pdf_mapping:{scope:'house',page:7}}:{})}]);
 const migration=(await readdir(dir)).find(name=>name.endsWith('_atomic_address_resolution.sql'));
 const apply=()=>readFile(new URL(migration,dir),'utf8').then(q=>sql.exec(q));
 if(applyNew)await apply();
 const resolve=(a=address)=>sql.query('select public.svitlo_address_resolution_data($1,$2,$3,$4) as data',[a.department,a.cityId,a.streetId,a.house]).then(r=>r.rows[0].data);
 return{sql,resolve,apply,version:v};
}

test('prepared metadata backfills current versions and preserves exact legacy address-resolution output',async()=>{
 const s=await database({applyNew:false});try{
  const original=(await s.sql.query('select public.svitlo_queue_metadata() as value')).rows[0].value;
  const archived=version('archived');await s.sql.query('insert into public.svitlo_queue_versions values($1,$2,$3,$4,false,$5)',[archived.id,archived.validFrom,archived.validUntil,at,archived]);
  await s.apply();assert.deepEqual((await s.sql.query('select public.svitlo_queue_metadata() as value')).rows[0].value,original);
  assert.deepEqual((await s.sql.query("select metadata from public.svitlo_queue_metadata_versions where version_id='archived'")).rows[0].metadata,projection(archived));
  for(const house of ['1','2','3','4','9 г']){
   const a={...address,house},next=await s.resolve(a);
   const old=(await s.sql.query("select department,city_id,street_id,house,city,street,status,queue,is_estimate,confidence,evidence,batch from public.svitlo_effective_address_queues where department=$1 and city_id=$2 and street_id=$3 and house=$4",[a.department,a.cityId,a.streetId,a.house])).rows[0];
   assert.deepEqual(next.record,old);assert.deepEqual(next.registry,old.status==='numeric'?original:null);
   assert.deepEqual(addressResolution(next.record,next.registry,at),addressResolution(old,original,at));
  }
  assert.equal((await s.resolve({...address,house:'2'})).record.is_estimate,true);
  const excluded=await s.resolve({...address,house:'3'});assert.equal(addressResolution(excluded.record,excluded.registry,at).inclusion,'not_in_queue');
  assert.deepEqual(await s.resolve({...address,house:'9  г'}),{record:null,registry:null});
  assert.equal((await s.resolve({...address,cityId:'802'})).record.queue,'6.2');
  assert.deepEqual(await s.resolve({...address,department:'19'}),{record:null,registry:null});
  assert.ok(JSON.stringify((await s.sql.query("select metadata from public.svitlo_queue_metadata_versions where version_id='v1'")).rows).length<2500);
  assert.ok(!JSON.stringify(await s.resolve()).includes('extractedText'));
 }finally{await s.sql.close();}
});

test('active-version switches, same-version payload updates and rollback keep overrides and prepared definitions aligned',async()=>{
 const s=await database();try{
  const next=version('v2');await s.sql.query('insert into public.svitlo_queue_versions values($1,$2,$3,$4,false,$5)',[next.id,next.validFrom,next.validUntil,at,next]);
  await s.sql.query("insert into public.svitlo_address_queue_overrides(version_id,batch_id,department,city_id,street_id,house,status,queue,is_estimate,confidence,evidence) values('v2',$1,'18','801','11807','1','numeric','4.2',false,null,'{\"origin\":\"pdf_update\"}')",[batch]);
  assert.equal((await s.resolve()).registry.id,'v1');assert.equal((await s.resolve()).record.queue,'3.2');
  await s.sql.exec("begin;update public.svitlo_queue_versions set active=false where active;update public.svitlo_queue_versions set active=true where id='v2';");
  const uncommitted=await s.resolve();assert.equal(uncommitted.record.queue,'4.2');assert.equal(uncommitted.registry.id,'v2');
  assert.equal(addressResolution(uncommitted.record,uncommitted.registry,at).url,url('v2','4.2'));
  await s.sql.exec('rollback');assert.equal((await s.resolve()).registry.id,'v1');assert.equal((await s.resolve()).record.queue,'3.2');
  await s.sql.exec("begin;update public.svitlo_queue_versions set active=false where active;update public.svitlo_queue_versions set active=true where id='v2';commit;");
  const changed={...next,documents:next.documents.map(d=>({...d,url:d.url+'?revision=2'}))};
  await s.sql.query("update public.svitlo_queue_versions set payload=$1 where id='v2'",[changed]);
  const data=await s.resolve();assert.equal(data.registry.id,'v2');assert.equal(data.record.queue,'4.2');assert.equal(addressResolution(data.record,data.registry,at).url,url('v2','4.2')+'?revision=2');
  await assert.rejects(()=>s.sql.query("update public.svitlo_queue_versions set payload=$1 where id='v2'",[{...next,documents:{invalid:true}}]));
  assert.equal((await s.resolve()).registry.documents[0].url,changed.documents[0].url);
  await s.sql.exec('update public.svitlo_queue_versions set active=false where active');
  assert.equal((await s.resolve()).registry,null);assert.equal(addressResolution((await s.resolve()).record,null,at).status,'unavailable');
  assert.equal((await s.resolve({...address,house:'3'})).record.status,'not_in_queue');
 }finally{await s.sql.close();}
});

test('expiry is evaluated from current metadata at read time, and lookup needs no SELECT privilege on payload',async()=>{
 const s=await database();try{
  const data=await s.resolve();assert.equal(addressResolution(data.record,data.registry,Date.parse('2027-03-31T21:30:00Z')).status,'matched');
  assert.equal(addressResolution(data.record,data.registry,Date.parse('2027-04-01T21:30:00Z')).status,'unavailable');
  await s.sql.exec('revoke select on public.svitlo_queue_versions from service_role;grant select(id,active) on public.svitlo_queue_versions to service_role;set role service_role');
  await assert.rejects(()=>s.sql.query('select payload from public.svitlo_queue_versions'),/permission denied/);
  const result=await s.resolve();assert.equal(result.record.queue,'3.2');assert.deepEqual(result.registry,projection(s.version));
  assert.equal((await s.sql.query('select public.svitlo_queue_metadata() as value')).rows[0].value.id,'v1');
  await s.sql.exec('reset role');
 }finally{await s.sql.close();}
});

test('prepared metadata, projection helpers and atomic resolution stay inaccessible to client roles',async()=>{
 const s=await database();try{
  for(const role of ['anon','authenticated']){
   await s.sql.exec('set role '+role);
   for(const query of ['select * from public.svitlo_queue_metadata_versions','select public.svitlo_queue_metadata()',"select public.svitlo_project_queue_metadata('{}')","select public.svitlo_address_resolution_data('18','801','11807','1')"])
    await assert.rejects(()=>s.sql.query(query),/permission denied/);
   await s.sql.exec('reset role');
  }
  await s.sql.exec('set role service_role');assert.equal((await s.resolve()).record.queue,'3.2');await s.sql.exec('reset role');
  await s.sql.exec('delete from public.svitlo_queue_metadata_versions');
  const missing=await s.resolve();assert.equal(missing.record.queue,'3.2');assert.equal(missing.registry,null);
  assert.equal(addressResolution(missing.record,missing.registry,at).status,'unavailable');
 }finally{await s.sql.close();}
});

test('server adapter makes one private RPC and preserves literal key fields and catalog-miss semantics',async()=>{
 const calls=[],result={record:{status:'numeric',queue:'3.2'},registry:projection(version('v1'))};
 const db={c:{rpc:(name,args)=>{calls.push({name,args});return Promise.resolve({data:result,error:null});}},result:async q=>{const{data,error}=await q;if(error)throw error;return data;}};
 assert.deepEqual(await addressResolutionData(db,{...address,house:'9  г'}),result);
 assert.deepEqual(calls,[{name:'svitlo_address_resolution_data',args:{department_id:'18',city_id:'801',street_id:'11807',house_number:'9  г'}}]);
 for(const invalid of [null,{...address,house:''},{...address,cityId:801},{...address,streetId:'x'.repeat(121)}])assert.deepEqual(await addressResolutionData(db,invalid),{record:null,registry:null});
 assert.equal(calls.length,1);
 db.c.rpc=async()=>({data:{record:null,registry:null},error:null});assert.deepEqual(await addressResolutionData(db,address),{record:null,registry:null});
 db.c.rpc=async()=>({data:null,error:Error('storage')});await assert.rejects(()=>addressResolutionData(db,address),/storage/);
});
