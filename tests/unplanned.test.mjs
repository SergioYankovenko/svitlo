import test from 'node:test';
import assert from 'node:assert/strict';
import {parseOutages} from '../app/lib/parsers.js';
import {Source} from '../server/source.js';
import {SharedCategories} from '../server/shared-categories.js';
import {Service,httpHandler} from '../server/service.js';
import {MemoryDatabase} from '../server/memory.js';
import {preparedSnapshot} from '../server/enrollment-preview.js';
import {SyncClient,SYNC_KEY,cityKey} from '../app/lib/sync-client.js';
import {envelopeData} from '../app/lib/cache-data.js';
import {dayState,countdown} from '../app/lib/schedule.js';
import {civil,dayKey} from '../app/lib/time.js';
import {hourTile,groupRepeatedHours} from '../app/lib/tiles.js';
import {categoryText,outageCategory,legend} from '../app/lib/patch-ui.js';
import {eventKind,needsOutageTypes,OUTAGE_TYPES_VERSION} from '../app/lib/outage-types.js';
import {scalingDatabase} from './helpers/scaling-db.mjs';

const date='2026-10-28',now=civil(date,600),owner='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const address={department:'18',cityId:'801',streetId:'1',house:'1',city:'м. Тест',street:'вул. Тестова',label:'м. Тест, вул. Тестова, 1',account:'12345678901'};
const row=(type='Позапланове відключення')=>({DATE_START:'12:01 28.10.2026',DATE_STOP:'14:02 28.10.2026',DISCONN_TYPE:type,ADDRESS:'<strong>м. Тест</strong><br>вул. Тестова 1<br>'});
const root=events=>({DISCONNECTIONS:events,DATETIME:'10:00 28.10.2026',DISCONN_QUEUQ:[]});
const event=(s,e,category='planned',unplanned=true)=>({start:civil(date,s),end:civil(date,e),category,...(category==='planned'?{unplanned}:{})});
const snapshot=(events=[])=>({queue:'3.2',checkedAt:now,feedCheckedAt:now,plans:[],emergencies:[],failures:[],categories:Object.fromEntries(['hourly','planned','emergency'].map(k=>[k,{checkedAt:now,sourceAt:now,events:events.filter(e=>e.category===k),...(k==='planned'?{outageTypesVersion:1}:{})}]))});
const profile=s=>({id,owner,address:{...address},preferences:{reminder:true,restoration:true,lead:30},messages:[],snapshot:s,last_checked:now-120000,next_check:now+3600000});
const storage=()=>{const m=new Map();return {getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)};};
const weather={city:address.city,temperature:10,code:3,hours:[],checkedAt:now};

test('DISCONN_TYPE is case insensitive, explicit and subordinate to emergency category',()=>{
 for(const [type,expected] of [['Позапланове відключення',true],['ПОЗАПЛАНОВЕ ВІДКЛЮЧЕННЯ',true],['тест позапланові роботи',true],['Планові роботи',false],['Невідомо',false],['',false],[null,false],[undefined,false],[42,false]]) {
  const r=parseOutages(root([{...row(),DISCONN_TYPE:type}]),'planned',now);assert.equal(r.events[0].category,'planned');assert.equal(r.events[0].unplanned,expected);assert.equal(r.outageTypesVersion,1);
 }
 for(const category of ['emergency','hourly']) {
  const e=parseOutages(root([row()]),category,now).events[0];assert.equal(eventKind(e),category);assert.equal(e.unplanned,undefined);
 }
 assert.equal(eventKind({category:'emergency',unplanned:true}),'emergency');
 assert.equal(eventKind({category:'planned',unplanned:'true'}),'planned');
 assert.equal(parseOutages(root([{...row(),STATE_CHAR:'Скасовано'}]),'planned',now).events.length,0);
});

test('provider -> Source -> service JSON API -> local cache -> tiles preserves subtype using three selectors',async()=>{
 for(const account of [true,false]) {
  const db=new MemoryDatabase(),requests=[];
  const source=new Source(async url=>{const u=new URL(url);requests.push(u);return Response.json(root(u.searchParams.get('disconn_selector')==='0'?[row()]:[]));});
  source.feed=async()=>({checkedAt:now,plans:[],messages:[],emergencies:[]});source.weather=async()=>weather;
  const s=profile(snapshot());if(!account)delete s.address.account;await db.saveProfile(s);
  const svc=new Service({db,source,now:()=>now});svc.queueResolution=async()=>({queue:'3.2',status:'matched'});
  const cache=new SyncClient({owner:async()=>owner,now:()=>now,storage:storage(),locks:null,request:async(action,body)=>{
   const response=await httpHandler(new Request('https://local.test/api',{method:'POST',body:JSON.stringify({action,...body})}),svc,async()=>owner,[]);
   assert.equal(response.status,200);return response.json();
  }});
  const value=await cache.sync({id,reason:'manual'}),p=value.profiles[0];
  assert.equal(requests.length,3);assert.deepEqual(requests.map(u=>u.searchParams.get('disconn_selector')).sort(),['0','1','2']);
  assert.deepEqual(Object.keys(p.snapshot.categories).sort(),['emergency','hourly','planned']);
  assert.equal(p.snapshot.categories.planned.events[0].unplanned,true);assert.equal(p.address.account,undefined);
  assert.equal(cache.read(owner).profiles[0].snapshot.categories.planned.events[0].unplanned,true);
  const day=dayState(p.snapshot,date,now);assert.deepEqual(day.totals,{off:121,on:1319});
  assert.match(hourTile(day.displayHours[12],date,now,true),/позапланове відключення/);
  assert.equal(outageCategory(p.snapshot,date,now,true),'unplanned');
 }
});

test('new planned shared-cache namespace bypasses a fresh type-less v1 result',async()=>{
 const db={values:new Map(),async sourceClaim(key){return this.values.has(key)?{state:'fresh',value:structuredClone(this.values.get(key))}:{state:'owner',token:key};},async sourceFinish(key,t,value){this.values.set(key,structuredClone(value));}};
 const shared=new SharedCategories(db,'fixture-secret',{now:()=>now}),base=['account',address.account];
 await shared.load(['address-v1',base,'planned','21.10.2026','29.10.2026'],async()=>({events:[{start:now,end:now+60000,category:'planned'}]}));
 let calls=0;const source=new Source(async()=>{calls++;return Response.json(root([row()]));},{categories:shared});
 const result=await source.address(address,now);assert.equal(calls,3);assert.equal(result.categories.planned.events[0].unplanned,true);
 await source.address(address,now);assert.equal(calls,3,'parsed sanitized result remains shared');
});

test('legacy planned snapshots refresh once, reject old preview, preserve owner/history and respect retry limits',async()=>{
 const legacy=snapshot([event(721,842)]);delete legacy.categories.planned.events[0].unplanned;delete legacy.categories.planned.outageTypesVersion;
 assert.equal(needsOutageTypes(legacy),true);assert.equal(preparedSnapshot({...legacy,checkedAt:now}),null);
 const db=new MemoryDatabase();await db.saveProfile(profile(legacy));let calls=0;
 const source=new Source(async()=>{calls++;return Response.json(root(calls%3===1?[row()]:[]));});
 source.feed=async()=>({checkedAt:now,plans:[],messages:[],emergencies:[]});source.weather=async()=>weather;
 const svc=new Service({db,source,now:()=>now}),local=storage();let syncCalls=0;
 local.setItem(SYNC_KEY,JSON.stringify({version:1,owner,profiles:[profile(legacy)],active:id,at:now,day:date,weather:{[cityKey(address)]:weather}}));
 const client=new SyncClient({owner:async()=>owner,now:()=>now,storage:local,locks:null,request:(action,body)=>{syncCalls++;return svc.handle(owner,{action,...body});}});
 assert.equal(client.read(owner).profiles.length,1);const value=await client.sync({id});
 assert.equal(calls,3);assert.equal(syncCalls,1);assert.equal(value.profiles[0].snapshot.categories.planned.outageTypesVersion,OUTAGE_TYPES_VERSION);
 assert.equal(value.profiles[0].snapshot.categories.planned.events[0].unplanned,true);await client.sync({id});assert.equal(syncCalls,1);
 // A not-yet-deployed server must not cause a request loop.
 let oldCalls=0,t=now;const oldClient=new SyncClient({owner:async()=>owner,now:()=>t,storage:storage(),locks:null,request:async()=>{oldCalls++;return {profiles:[profile(legacy)],active:id,weather,weatherKey:cityKey(address)};}});
 await oldClient.sync({id});await oldClient.sync({id});assert.equal(oldCalls,1);t+=300001;await oldClient.sync({id});assert.equal(oldCalls,2);
});

test('failed migration retains old evidence, never invents a subtype, and observes server backoff',async()=>{
 const legacy=snapshot([event(721,842)]);delete legacy.categories.planned.events[0].unplanned;delete legacy.categories.planned.outageTypesVersion;
 const db=new MemoryDatabase();let t=now,calls=0;await db.saveProfile(profile(legacy));
 const source=new Source(async()=>{calls++;return new Response('',{status:429});});source.feed=async()=>({checkedAt:t,plans:[],messages:[],emergencies:[]});source.weather=async()=>weather;
 const svc=new Service({db,source,now:()=>t});await svc.handle(owner,{action:'sync',id});assert.equal(calls,3);
 const failed=await db.profile?.(owner,id)||db.p.get(id);assert.equal(failed.snapshot.categories.planned.events[0].unplanned,undefined);assert(needsOutageTypes(failed.snapshot));
 t+=120000;await svc.handle(owner,{action:'sync',id});assert.equal(calls,3);
});

test('planned/unplanned priority is unchanged and official hourly plans keep address events',()=>{
 const s=snapshot([event(720,780,'hourly'),event(720,750,'planned',false),event(750,780),event(765,780,'emergency')]);
 s.plans=[{date,queue:'3.2',events:[event(720,780,'hourly')],checkedAt:now,publishedAt:now}];
 const raw=JSON.stringify(s),d=dayState(s,date,now);
 assert(d.events.some(e=>e.unplanned));assert.deepEqual(d.displayHours[12].segments.map(e=>e.kind),['planned','unplanned']);
 assert.equal(d.hours[12].segments.find(e=>e.start===civil(date,765)).kind,'emergency');
 assert.equal(d.hours[12].segments.find(e=>e.start===civil(date,750)).kind,'unplanned');assert.deepEqual(d.totals,{on:1380,off:60});assert.equal(JSON.stringify(s),raw);
 s.categories.emergency.events=[];assert.deepEqual(dayState(s,date,now).displayHours[12].segments.map(e=>e.kind),['planned','unplanned']);
 for(const range of [false,true])for(const style of ['bolt','bulb']) {
  const html=hourTile(dayState(s,date,now).displayHours[12],date,now,range,style);assert.match(html,/--planned/);assert.match(html,/--unplanned/);assert.match(html,/планові роботи/);assert.match(html,/позапланове відключення/);
 }
 s.categories.emergency.events=[event(750,780,'emergency')];assert.deepEqual(dayState(s,date,now).displayHours[12].segments.map(e=>e.kind),['planned','emergency']);
});

test('precise totals/countdown/reminders remain raw when unplanned tiles round to half-hours',async()=>{
 const time=civil(date,841),s=snapshot([event(721,842)]);for(const c of Object.values(s.categories)){c.checkedAt=time;c.sourceAt=time;}s.feedCheckedAt=time;
 assert.equal(dayState(s,date,time).displayHours[14].segments[0].kind,'clear');assert.equal(countdown(s,time).minutes,1);assert.equal(dayState(s,date,time).totals.off,121);
 const db=new MemoryDatabase(),svc=new Service({db,now:()=>civil(date,691)}),p=profile(snapshot([event(721,842)]));
 await svc.reminders(p);assert.equal(db.events.length,1);assert.match(db.events[0].title,/12:01/);
});

test('unknown queue and regional GAV do not manufacture an address emergency or erase unplanned intervals',()=>{
 const s=snapshot([event(720,780)]);s.queue=null;s.emergencies=[{queues:[],effectiveAt:now,publishedAt:now,validity:'unknown'}];
 const d=dayState(s,date,now);assert.equal(d.policy.active,true);assert.equal(d.totals,null);assert.equal(d.displayHours[12].segments[0].kind,'unplanned');assert.equal(d.displayHours[11].segments[0].kind,'unknown');
 assert.equal(outageCategory(s,date,now,true),'unplanned');assert.equal(categoryText('unplanned'),'Позапланове відключення');
 for(const style of ['bolt','bulb'])assert.match(legend(style,'unplanned',true),/Позапланове відключення/);
});

test('subtype survives cache validation and 23/25-hour days without changing calendar bounds',()=>{
 const p=profile(snapshot([event(721,842)])),v={owner,profiles:[p],weather:{},at:now,day:date};
 assert.equal(envelopeData(v,owner,now).profiles[0].snapshot.categories.planned.events[0].unplanned,true);
 p.snapshot.categories.planned.events[0].unplanned='true';assert.equal(envelopeData(v,owner,now),null);
 for(const [date,hours] of [['2026-03-29',23],['2026-10-25',25]]) {
  const from=civil(date),to=from+hours*3600000,t=from+10*3600000,s=snapshot();s.feedCheckedAt=t;
  for(const c of Object.values(s.categories)){c.checkedAt=t;c.sourceAt=t;}
  s.plans=[{date,queue:'3.2',events:[],publishedAt:t,checkedAt:t}];s.categories.planned.events=[{start:from,end:to,category:'planned',unplanned:true}];
  const d=dayState(s,date,t);assert.deepEqual(d.totals,{off:hours*60,on:0});assert.equal(d.displayHours.length,hours);
  assert.equal(groupRepeatedHours(d.displayHours).length,hours===25?24:23);
 }
});

test('existing Postgres JSON snapshot RPCs retain the additive subtype without schema changes',async()=>{
 const {sql,db}=await scalingDatabase();
 try {
  await sql.query('insert into auth.users(id) values($1)',[owner]);
  const p=profile(snapshot([event(721,842)]));
  await sql.query('insert into svitlo_profiles(id,owner,address,preferences) values($1,$2,$3,$4)',[id,owner,address,{}]);
  const saved=await db.commitProfile(p,0);assert.equal(saved.status,'updated');
  const [read]=await db.profiles(owner);assert.equal(read.snapshot.categories.planned.events[0].unplanned,true);assert.equal(read.snapshot.categories.planned.outageTypesVersion,1);
  assert.deepEqual(Object.keys(read.snapshot.categories).sort(),['emergency','hourly','planned']);
 } finally {await sql.close();}
});
