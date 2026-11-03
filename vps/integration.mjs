import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pool,PgBridge,ownerContext} from './db.js';
import {Database} from '../server/database.js';
import {Service} from '../server/service.js';
const p=pool(),sessions=pool('session',1),bridge=await new PgBridge(p).init(),db=new Database(bridge);
const a=randomUUID(),b=randomUUID(),id=randomUUID(),checks=[];
const run=(owner,work)=>ownerContext.run(owner,work);
async function check(name,fn){await fn();checks.push(name);}
try{
 await sessions.query('insert into auth.users(id) values($1),($2)',[a,b]);
 await check('nonadmin API has no RLS bypass or role membership',async()=>{const r=(await p.query("select rolsuper,rolbypassrls,pg_has_role(current_user,'service_role','MEMBER') as member from pg_roles where rolname=current_user")).rows[0];assert.deepEqual(r,{rolsuper:false,rolbypassrls:false,member:false});});
 const profile={id,owner:a,address:{department:'18',cityId:'801',streetId:'11683',house:'10',city:'Synthetic QA',street:'Synthetic QA',label:'Synthetic QA'},name:"QA ' ; drop table public.svitlo_profiles; --",preferences:{schedule:true}};
 await check('parameterized JSON and profile RPC persist',async()=>{const r=await run(a,()=>db.createProfile(profile));assert.equal(r.created,true);assert.equal((await run(a,()=>db.profile(a,id))).name,profile.name);});
 await check('RLS blocks query without an owner predicate',async()=>{assert.equal((await run(b,()=>db.result(bridge.from('svitlo_profiles').select('*').eq('id',id)))).length,0);assert.equal((await bridge.query('select id from public.svitlo_profiles where id=$1',[id])).rows.length,0);});
 await check('RLS rejects forged owner on insert',async()=>{const r=await run(b,()=>bridge.from('svitlo_profiles').insert({...profile,id:randomUUID()}));assert.ok(r.error);});
 await check('cross-owner service reads/writes/deletes fail',async()=>{const svc=new Service({db,source:{}});assert.deepEqual((await run(b,()=>svc.handle(b,{action:'bootstrap'}))).profiles,[]);
  for(const action of ['refresh','preferences','delete','weather'])await assert.rejects(()=>run(b,()=>svc.handle(b,{action,id})),e=>e.status===404);
  assert.ok(await run(a,()=>db.profile(a,id)));
 });
 await check('duplicate address returns existing profile atomically',async()=>{const r=await run(a,()=>db.createProfile({...profile,id:randomUUID()}));assert.equal(r.created,false);assert.equal(r.profile.id,id);});
 await check('revision guarded profile commit and preference patch',async()=>{const before=await run(a,()=>db.profile(a,id));const candidate={...before,snapshot:{synthetic:true},messages:[],last_checked:Date.now(),next_check:Date.now()+3600000};
  const ok=await run(a,()=>db.commitProfile(candidate,before.snapshot_revision));assert.equal(ok.status,'updated');
  const stale=await run(a,()=>db.commitProfile(candidate,before.snapshot_revision));assert.equal(stale.status,'conflict');
  const changed=await run(a,()=>db.setPreferences(a,id,{emergency:false}));assert.equal(changed.preferences.emergency,false);
 });
 await check('owner context cannot leak through pool reuse',async()=>{const rows=await Promise.all(Array.from({length:24},(_,i)=>run(i%2?a:b,()=>db.profile(i%2?a:b,id))));rows.forEach((r,i)=>assert.equal(!!r,!!(i%2)));});
 await check('no operator accounts in persisted test profile',async()=>assert.equal((await run(a,()=>db.profile(a,id))).address.account,undefined));
 await check('public catalog checksum and all 17940 unique keys available',async()=>{const r=(await p.query('select count(*)::int as n,count(distinct (department,city_id,street_id,house))::int as keys from public.svitlo_effective_address_queues')).rows[0];assert.deepEqual(r,{n:17940,keys:17940});});
 console.log(JSON.stringify({scope:'real-postgresql-integration',passed:checks.length,checks}));
}finally{await sessions.query('delete from auth.users where id=any($1::uuid[])',[[a,b]]);await Promise.all([p.end(),sessions.end()]);}
