import test from 'node:test';
import assert from 'node:assert/strict';
import {SafeStorage} from '../app/lib/storage.js';
import {SessionController,RetryingLoader} from '../app/lib/session.js';
import {Lifecycle,readRoute,validDate} from '../app/lib/lifecycle.js';
import {SyncClient,SYNC_KEY,cityKey,legacyEnvelope} from '../app/lib/sync-client.js';
import {dayKey} from '../app/lib/time.js';
import {notificationSettings} from '../app/lib/patch-ui.js';

const now=Date.parse('2026-10-28T10:00:00Z');
const raw=()=>{const m=new Map();return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k)};};
const gate=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const profile=(id='one',owner='alice')=>({id,owner,name:'Дім',address:{department:'18',cityId:'801',city:'м. Христинівка',street:'вул. Тестова',house:'1',label:'м. Христинівка, вул. Тестова, 1'},snapshot:{queue:null,queueResolution:{inclusion:'not_in_queue'},checkedAt:now,feedCheckedAt:now,failures:[],plans:[],categories:Object.fromEntries(['hourly','planned','emergency'].map(k=>[k,{checkedAt:now,sourceAt:now,events:[]}]))},messages:[],preferences:{}});
const weather={checkedAt:now,city:'м. Христинівка',temperature:12,code:3,hours:[]};
const envelope=()=>({owner:'alice',at:now,day:dayKey(now),profiles:[profile()],active:'one',weather:{[cityKey(profile().address)]:weather}});
const response=()=>({profiles:[profile()],active:'one',weather,weatherKey:cityKey(profile().address),errors:{}});
const options=s=>({storage:s,owner:async()=>'alice',now:()=>now,locks:{request:async(_key,fn)=>fn()},request:async()=>response()});

test('storage survives blocked getter, quota and failed removals with a per-tab memory fallback',()=>{
  const blocked=new SafeStorage(()=>{throw new DOMException('blocked','SecurityError');});
  assert.equal(blocked.getItem('x'),null);blocked.setItem('x','value');assert.equal(blocked.getItem('x'),'value');blocked.removeItem('x');assert.equal(blocked.getItem('x'),null);assert.equal(blocked.persistent,false);
  const backing=raw();backing.setItem('x','old');backing.setItem=()=>{throw Error('quota');};backing.removeItem=()=>{throw Error('blocked');};
  const s=new SafeStorage(backing);s.setItem('x','new');assert.equal(s.getItem('x'),'new');s.removeItem('x');assert.equal(s.getItem('x'),null);
});

function auth(getSession) {
  let callback,signups=0;
  const client={auth:{getSession,onAuthStateChange:fn=>{callback=fn;return {data:{subscription:{unsubscribe(){}}}};},signInAnonymously:async()=>{signups++;return {data:{session:{user:{id:'bob'},access_token:'new'}},error:null};},signOut:async()=>({error:null})}};
  return {client,emit:(event,s)=>callback?.(event,s),signups:()=>signups};
}
test('temporary session recovery errors never create another anonymous owner',async()=>{
  const mock=auth(async()=>({data:{session:null},error:{name:'AuthRetryableFetchError',status:503}}));
  const c=new SessionController({client:async()=>mock.client,storage:new SafeStorage(raw())});
  await assert.rejects(()=>c.ensure(),/відновити|підключення/i);assert.equal(mock.signups(),0);
});
test('same-owner token refresh keeps lifecycle version, while sign-out fences delayed recovery',async()=>{
  let delayed=null;const mock=auth(async()=>delayed?delayed.promise:{data:{session:{user:{id:'alice'},access_token:'one'}},error:null});
  const c=new SessionController({client:async()=>mock.client,storage:new SafeStorage(raw())});assert.equal(await c.identity(),'alice');const version=c.version;
  mock.emit('TOKEN_REFRESHED',{user:{id:'alice'},access_token:'two'});await Promise.resolve();assert.equal(c.version,version);
  delayed=gate();const pending=c.identity();await new Promise(r=>setTimeout(r,0));c.forget();delayed.resolve({data:{session:{user:{id:'alice'},access_token:'old'}},error:null});
  assert.equal(await pending,null);assert.equal(c.owner,null);
});
test('definitively lost session returns normal empty identity; fresh sign-in occurs only when requested',async()=>{
  const mock=auth(async()=>({data:{session:null},error:{code:'refresh_token_not_found',status:400}}));
  const c=new SessionController({client:async()=>mock.client,storage:new SafeStorage(raw())});
  assert.equal(await c.identity(),null);assert.equal(mock.signups(),0);assert.equal((await c.ensure()).user.id,'bob');assert.equal(mock.signups(),1);
});
test('failed module loader retries a different attempt but remains bounded',async()=>{
  let time=0;const attempts=[];const loader=new RetryingLoader({now:()=>time,cooldown:10,max:2,load:async n=>{attempts.push(n);if(n===0)throw Error('offline');return 'ready';}});
  await assert.rejects(()=>loader.get());await assert.rejects(()=>loader.get());assert.equal(attempts.length,1);time=11;assert.equal(await loader.get(),'ready');assert.deepEqual(attempts,[0,1]);
});
test('real calendar routes and lifecycle stamps reject impossible dates and obsolete owner/intent',()=>{
  for(const date of ['2026-99-99','2026-02-29','2026-02-30','2026-04-31','0000-01-01'])assert.equal(validDate(date),false,date);
  assert.equal(validDate('2028-02-29'),true);assert.equal(readRoute('?date=2026-99-99').date,null);
  const c=new Lifecycle();c.setOwner('alice');const stamp=c.capture();c.setOwner('bob');assert.equal(c.current(stamp),false);
  const s=c.capture();c.select();assert.equal(c.current(s),true);assert.equal(c.current(s,true),false);
});

for(const failure of [false,true])test(`late ${failure?'failure':'success'} cannot resurrect cache after clear during final owner await`,async()=>{
  const backing=raw(),entered=gate(),release=gate();let owners=0;
  const c=new SyncClient({...options(backing),owner:async()=>{if(++owners===2){entered.resolve();await release.promise;}return 'alice';},request:async()=>{if(failure)throw Error('network');return response();}});
  const pending=c.sync().catch(()=>null);await entered.promise;c.clear();release.resolve();await pending;assert.equal(c.read('alice'),null);
});
test('network success remains usable when cache writes fail, and clear still fences failed persistence',async()=>{
  const backing=raw(),old=backing.setItem;backing.setItem=(k,v)=>{if(k===SYNC_KEY||k==='svitlo-cache-epoch')throw Error('quota');old(k,v);};
  const c=new SyncClient(options(backing));const result=await c.sync();assert.equal(result.profiles[0].id,'one');assert.equal(c.read('alice').profiles.length,1);c.clear();assert.equal(c.read('alice'),null);
});
test('blocked lease storage degrades to a functioning per-tab sync',async()=>{
  const backing=raw();backing.setItem=()=>{throw new DOMException('blocked','SecurityError');};
  const c=new SyncClient({...options(backing),locks:null});assert.equal((await c.sync()).profiles.length,1);
});
test('failed request does not reject a waiting request for another profile',async()=>{
  const entered=gate(),release=gate();let calls=0;
  const c=new SyncClient({...options(raw()),request:async(_a,b)=>{calls++;if(calls===1){entered.resolve();await release.promise;throw Error('first failed');}return {...response(),active:b.id,profiles:[profile(b.id)]};}});
  const first=c.sync({id:'one'}).catch(()=>null);await entered.promise;const second=c.sync({id:'two'});release.resolve();await first;assert.equal((await second).active,'two');assert.equal(calls,2);
});
test('cache rejects null and foreign profiles without excluding valid unknown/not_in_queue data',()=>{
  const backing=raw(),c=new SyncClient(options(backing));
  for(const profiles of [[null],[profile('one','bob')]]){backing.setItem(SYNC_KEY,JSON.stringify({...envelope(),profiles}));assert.equal(c.read('alice'),null);}
  backing.setItem(SYNC_KEY,JSON.stringify(envelope()));assert.equal(c.read('alice').profiles[0].snapshot.queue,null);
  const unknown=envelope();delete unknown.profiles[0].snapshot.queueResolution;backing.setItem(SYNC_KEY,JSON.stringify(unknown));assert(c.read('alice'));
  assert.doesNotThrow(()=>legacyEnvelope('alice',[null,profile()],{},now));
});
test('future cache time cannot postpone an update and mutations retain other data without extending freshness',async()=>{
  const backing=raw(),c=new SyncClient(options(backing)),v=envelope();v.at=now+86400000;v.profiles[0].snapshot.failures=['hourly'];backing.setItem(SYNC_KEY,JSON.stringify(v));assert.equal(await c.needed(c.read('alice'),'one','auto',null),true);
  const cached=envelope();cached.profiles.push(profile('two'));backing.setItem(SYNC_KEY,JSON.stringify(cached));
  c.patch('alice',old=>({...old,profiles:old.profiles.map(p=>p.id==='one'?{...p,preferences:{lead:60}}:p)}));
  const next=c.read('alice');assert.equal(next.at,now);assert.equal(next.profiles.length,2);assert.equal(next.weather[cityKey(profile().address)].checkedAt,now);assert.equal(next.profiles[0].preferences.lead,60);
});
test('bell reflects permission plus active subscription, replaces status row and keeps a descriptive target',()=>{
  const on=notificationSettings(profile(),'granted',true),off=notificationSettings(profile(),'granted',false);
  assert.match(on,/data-notification-status/);assert.match(on,/Сповіщення увімкнено/);assert.match(off,/Сповіщення вимкнено/);
  assert.doesNotMatch(on,/class="permission-status"/);assert.match(on,/notification-bell/);assert.match(off,/bell-off/);
});

test('stalled SDK loading times out and marks its late import obsolete',async()=>{
 let signal;const loader=new RetryingLoader({load:(_attempt,s)=>{signal=s;return new Promise(()=>{});},timeout:5});
 await assert.rejects(()=>loader.get(),/завантажити/);assert.equal(signal.aborted,true);
});
test('initial network failure never creates a confirmed-empty cache',async()=>{
 const c=new SyncClient({...options(raw()),request:async()=>{throw Error('offline');}});
 await assert.rejects(()=>c.sync(),/offline/);assert.equal(c.read('alice'),null);
});

test('future weather is discarded and cannot postpone the next sync',async()=>{
 const s=raw(),c=new SyncClient(options(s)),v=envelope();v.weather[cityKey(profile().address)].checkedAt=now+86400000;
 s.setItem(SYNC_KEY,JSON.stringify(v));assert.equal(await c.needed(c.read('alice'),'one','auto',null),true);
});

test('late erased-owner callback cannot delete or replace a newly accepted session',async()=>{
 const storage=new SafeStorage(raw()),mock=auth(async()=>({data:{session:{user:{id:'alice'},access_token:'old'}}})),c=new SessionController({client:async()=>mock.client,storage});
 await c.identity();c.forget();const newer={user:{id:'bob'},access_token:'new'};c.accept(newer);storage.setItem('svitlo-auth',JSON.stringify(newer));
 mock.emit('TOKEN_REFRESHED',{user:{id:'alice'},access_token:'late'});
 assert.equal(JSON.parse(storage.getItem('svitlo-auth')).user.id,'bob');assert.equal(await c.identity(),'bob');
});
test('notification states distinguish a pending check, unsupported browser and failed disable of an active subscription',()=>{
 assert.match(notificationSettings(null,'unsupported',false),/Push у цьому браузері недоступний/);
 assert.match(notificationSettings(profile(),'granted',false,{checking:true}),/Перевіряємо стан/);
 const failed=notificationSettings(profile(),'granted',true,{error:'Помилка вимкнення'});assert.doesNotMatch(failed,/notification-status bell-off/);assert.match(failed,/Сповіщення увімкнено/);
});
