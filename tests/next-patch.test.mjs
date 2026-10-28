import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Service,httpHandler} from '../server/service.js';
import {MemoryDatabase} from '../server/memory.js';
import {SyncClient,SYNC_KEY,cityKey,legacyEnvelope} from '../app/lib/sync-client.js';
import {civil,addDays,dayKey} from '../app/lib/time.js';
import {dayState,countdown} from '../app/lib/schedule.js';
import {preferences,messageTitle,shareText,reminderTitle} from '../app/lib/notifications.js';
import {addressCard,appearance,legend,notificationSettings,outageCategory} from '../app/lib/patch-ui.js';
import {mergePreferences} from '../server/preferences.js';
import {scalingDatabase} from './helpers/scaling-db.mjs';
import {DictionaryCache} from '../app/lib/dictionary-cache.js';
const now=civil('2026-10-28',600);
const categories=t=>Object.fromEntries(['hourly','planned','emergency'].map(k=>[k,{events:[],sourceAt:t,checkedAt:t}]));
function profile(id='one',owner='alice',t=now) {return {id,owner,address:{department:'18',cityId:'city-1',streetId:'s',house:'49',city:'м. Христинівка',street:'вул. О.Береста',label:'м. Христинівка, вул. О.Береста, 49',account:'private'},preferences:{},last_checked:t,next_check:t+3600000,snapshot_revision:0,snapshot:{queue:'3.2',checkedAt:t,feedCheckedAt:t,failures:[],categories:categories(t),plans:[]},messages:[]};}
const storage=()=>{const m=new Map();return {getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)};};
const locks={async request(k,fn){const before=this.pending||Promise.resolve();let release;this.pending=new Promise(r=>release=r);await before;try{return await fn();}finally{release();}}};
test('upgrade preserves only owner-bound legacy profiles/history and weather, without extending source age',()=>{
  const a=profile(),b=profile('other','bob'),w={city:a.address.city,checkedAt:now};
  const value=legacyEnvelope('alice',[a,b],{one:w},now);
  assert.equal(value.profiles.length,1);assert.equal(value.at,0);assert.equal(value.profiles[0].snapshot.checkedAt,now);
  assert.equal(value.weather[cityKey(a.address)],w);assert.equal(legacyEnvelope('charlie',[a,b],{},now),null);
});
function backend(db=new MemoryDatabase(),time=()=>now) {
  let weatherCalls=0,addressCalls=0;
  const source={weather:async city=>{weatherCalls++;return {city,temperature:13,code:3,isDay:true,hours:[],checkedAt:time()};},
    address:async()=>{addressCalls++;return {...profile().snapshot,checkedAt:time(),categories:categories(time()),failures:[]};},
    feed:async()=>({plans:[],messages:[],emergencies:[],checkedAt:time()})};
  const service=new Service({db,source,now:time});return {service,source,counters:()=>({weatherCalls,addressCalls})};
}
test('one HTTP sync returns 0/1/2/3 owned profiles, active snapshot, weather; legacy actions still work',async()=>{
  for(let count=0;count<=3;count++) {
    const db=new MemoryDatabase(),{service,counters}=backend(db);
    for(let n=0;n<count;n++)await db.saveProfile(profile('p'+n));
    await db.saveProfile(profile('foreign','bob'));
    let calls=0;
    const request=async(action,data={})=>{calls++;const r=await httpHandler(new Request('https://test/api',{method:'POST',body:JSON.stringify({action,...data})}),service,async()=>'alice',[]);assert.equal(r.status,200);return r.json();};
    const c=new SyncClient({request,owner:async()=>'alice',storage:storage(),now:()=>now,locks});
    const r=await c.sync();assert.equal(calls,1);assert.equal(r.profiles.length,count);
    assert(r.profiles.every(p=>!p.address.account));assert.equal(counters().addressCalls,0);
    await c.sync();assert.equal(calls,1,'fresh reopen costs zero HTTP');
    const bootstrap=await service.handle('alice',{action:'bootstrap'});assert.equal(bootstrap.profiles.length,count);
    if(count)assert((await service.handle('alice',{action:'weather',id:'p0'})).weather);
    for(const id of ['foreign','deleted'])await assert.rejects(()=>service.handle('alice',{action:'sync',id}),e=>e.status===404);
  }
});
test('startup/visibility/online and multiple tabs coalesce; manual/push/owner/mutation fences are respected',async()=>{
  const db=new MemoryDatabase();await db.saveProfile(profile());const {service}=backend(db);
  const local=storage();let calls=0,t=now,owner='alice',marker=null;
  const request=async(action,data)=>{calls++;await new Promise(r=>setTimeout(r,5));return service.handle(owner,{action,...data});};
  const options={request,owner:async()=>owner,storage:local,now:()=>t,locks,invalidation:async()=>marker};
  const a=new SyncClient(options),b=new SyncClient(options);
  await Promise.all([a.sync({id:'one'}),a.sync({id:'one'}),b.sync({id:'one'})]);assert.equal(calls,1);
  await a.sync({id:'one',reason:'manual'});assert.equal(calls,2);
  marker='revision-1';await Promise.all([a.sync({id:'one',reason:'push'}),b.sync({id:'one',reason:'push'})]);assert.equal(calls,3);
  await a.sync({id:'one',reason:'push'});assert.equal(calls,3,'duplicate push stays acknowledged');
  t+=3600001;await a.sync({id:'one'});assert.equal(calls,4);
  owner='bob';assert.equal(a.read(owner),null);
  const c=new SyncClient({...options,request:async()=>{await new Promise(r=>setTimeout(r,10));return {profiles:[profile()],errors:{}};}});
  const pending=c.sync();c.clear();assert.equal(await pending,null,'clear prevents late data resurrection');
});
test('push arriving during sync remains unacknowledged; partial data retries without freshening source',async()=>{
  let marker='a',t=now,calls=0;const local=storage();
  const c=new SyncClient({storage:local,owner:async()=>'a',now:()=>t,locks,invalidation:async()=>marker,request:async()=>{
    calls++;const p=profile();if(calls>1){p.snapshot.failures=['hourly'];marker='b';}return {profiles:[p],weatherKey:cityKey(p.address),weather:{checkedAt:now},errors:{}};
  }});
  await c.sync({id:'one'});marker='x';await c.sync({id:'one'});assert.equal(c.read('a').invalidations.one,'x');
  assert.equal(c.read('a').profiles[0].snapshot.checkedAt,now);
  await c.sync({id:'one'});assert.equal(calls,3,'new marker survives response');
  await c.sync({id:'one'});assert.equal(calls,3,'partial data has retry backoff');
  t+=300001;await c.sync({id:'one'});assert.equal(calls,4);
});
test('same city shares weather, city and village differ; weather/subscription errors preserve profiles',async()=>{
  const db=new MemoryDatabase(),{service,source,counters}=backend(db);
  for(const id of ['a','b','v']){const p=profile(id);if(id==='v'){p.address.cityId='village';p.address.city='с. Христинівка';}await db.saveProfile(p);}
  await service.handle('alice',{action:'sync',id:'a'});await service.handle('alice',{action:'sync',id:'b'});
  assert.equal(counters().weatherCalls,1);await service.handle('alice',{action:'sync',id:'v'});assert.equal(counters().weatherCalls,2);
  service.sync.weather.clear();source.weather=async()=>{throw Error('offline');};
  const r=await service.handle('alice',{action:'sync',id:'a',subscription:{endpoint:'bad'}});
  assert.equal(r.profiles.length,3);assert(r.errors.weather);assert(r.errors.subscription);
});
test('unchanged subscription costs zero sync, changed binding/keys and daily repair are acknowledged only by server',async()=>{
  let t=now,calls=0,registered=0;const local=storage(),sub={endpoint:'https://fcm.googleapis.com/fcm/send/x',keys:{p256dh:'A'.repeat(87),auth:'A'.repeat(22)}};
  const c=new SyncClient({storage:local,owner:async()=>'alice',locks,now:()=>t,request:async(action,body)=>{
    calls++;if(body.subscription)registered++;
    const p=profile(body.id||'one','alice',t);
    return {profiles:[p,profile('two','alice',t)],active:p.id,vapid:'key',subscription:!!body.subscription,weatherKey:cityKey(p.address),weather:{checkedAt:t},errors:{}};
  }});
  await c.sync({subscription:sub});await c.sync({id:'one',subscription:sub});assert.equal(calls,1);assert.equal(registered,1);
  await c.sync({id:'two',subscription:sub});assert.equal(calls,2);assert.equal(registered,2);
  const rotated={...sub,keys:{...sub.keys,auth:'B'.repeat(22)}};await c.sync({id:'two',subscription:rotated});assert.equal(registered,3);
  t+=86400001;await c.sync({id:'two',subscription:rotated});assert.equal(registered,4);
});
test('offline retains the owned cache; subsequent online refresh recovers without extending old timestamps',async()=>{
  let t=now,offline=false,calls=0;const local=storage();
  const c=new SyncClient({storage:local,owner:async()=>'alice',locks,now:()=>t,request:async()=>{
    calls++;if(offline)throw Error('offline');const p=profile('one','alice',t);return {profiles:[p],weatherKey:cityKey(p.address),weather:{checkedAt:t},errors:{}};
  }});
  await c.sync({id:'one'});t+=3600001;offline=true;
  await assert.rejects(()=>c.sync({id:'one'}),/offline/);assert.equal(c.read('alice').profiles[0].snapshot.checkedAt,now);
  await c.sync({id:'one'});assert.equal(calls,2,'failed request has retry backoff');
  offline=false;t+=300001;await c.sync({id:'one'});assert.equal(c.read('alice').profiles[0].snapshot.checkedAt,t);assert.equal(calls,3);
});
test('dictionary exact branch cache coalesces, expires, force reloads and never caches errors or invalid lists',async()=>{
  let calls=0,t=now,fail=false;
  const cache=new DictionaryCache(async(action,body)=>{calls++;if(fail)throw Error('offline');return {items:[{id:body.parent||'18',name:'вул. Флорештська, 10а/51'}]};},storage(),()=>t);
  const body={kind:'house',parent:'street-1'};
  await Promise.all([cache.load(body),cache.load(body)]);assert.equal(calls,1);
  await cache.load(body);assert.equal(calls,1);
  await cache.load({kind:'house',parent:'street-2'});assert.equal(calls,2);
  await cache.load(body,true);assert.equal(calls,3);
  t+=86400001;fail=true;await assert.rejects(()=>cache.load(body),/offline/);
  fail=false;const r=await cache.load(body);assert.equal(r.items[0].name,'вул. Флорештська, 10а/51');assert.equal(calls,5);
});
test('legacy preferences inherit schedule once and cannot erase new independent settings',()=>{
  for(const schedule of [true,false])assert.equal(preferences({schedule}).publication,schedule);
  assert.equal(mergePreferences({schedule:true},{schedule:false}).publication,false);
  const p=mergePreferences({schedule:false},{publication:true,change:false});
  assert.equal(p.publication,true);assert.equal(p.change,false);
  const oldWrite=mergePreferences(p,{schedule:true,emergency:false});
  assert.equal(oldWrite.publication,true);assert.equal(oldWrite.change,false);assert.equal(oldWrite.emergency,false);
});
test('not_in_queue confirms only checked dates, never unknown/partial/future; preserves exact DST totals',()=>{
  const p=profile(),s=p.snapshot;s.queue=null;s.queueResolution={inclusion:'not_in_queue'};
  assert.equal(countdown(s,now).label,'У вас відключень поки немає');
  assert.equal(dayState(s,dayKey(now),now).totals.on,1440);
  assert.equal(dayState(s,addDays(dayKey(now),1),now).known,false);
  s.queueResolution={status:'not_found'};assert.equal(dayState(s,dayKey(now),now).totals,null);
  s.queueResolution={inclusion:'not_in_queue'};s.failures=['hourly'];assert.equal(dayState(s,dayKey(now),now).totals,null);
  for(const [date,hours] of [['2026-03-29',23],['2026-10-25',25]]) {
    const t=civil(date,600),d=profile('p','a',t).snapshot;d.queue=null;d.queueResolution={inclusion:'not_in_queue'};
    assert.equal(dayState(d,date,t).totals.on,hours*60);
  }
});
test('publication/change classification is structural; region remains in feed but never enqueues',async()=>{
  const db=new MemoryDatabase();let t=now;const {service,source}=backend(db,()=>t);
  const p=profile();p.last_checked=now-60000;await db.saveProfile(p);
  let id='first';source.feed=async()=>({checkedAt:t,plans:[],messages:[{id,kind:'schedule',queue:'3.2',date:dayKey(t),updatedAt:t,title:'Графік '+dayKey(t),url:'https://example.com'}],emergencies:[{id:'region',queues:[],effectiveAt:t,publishedAt:t,until:t+3600000,validity:'active'}]});
  let result=await service.refresh(p);assert.equal(result.messages.find(m=>m.id==='first').revisionType,'publication');
  assert.equal(db.events.length,1);assert.equal(db.events[0].channel,'publication');assert.equal(db.events[0].title,'Графік на 28 жовтня');
  assert(result.messages.some(m=>m.scope==='region'));
  t+=60000;id='revision';result=await service.refresh(result);
  assert.equal(result.messages.find(m=>m.id==='revision').revisionType,'change');assert.equal(db.events[1].channel,'change');
  assert.equal(db.events[1].title,'Графік на 28 жовтня оновлено');
  await service.enqueue(p,'regional:any','Never',dayKey(t));assert.equal(db.events.length,2);
});
test('share and reminder copy preserves exact time, selected date and single install URL',()=>{
  const d=profile().snapshot,date='2026-10-28',s={totals:{on:1200,off:240},events:[{start:civil(date,960),end:civil(date,1080)}]};
  const text=shareText(d,date,s);assert.match(text,/^Графік · 28 Жовтня · Черга 3.2/);assert.match(text,/16:00–18:00\n-----------------\nВстановити собі\nhttps:\/\/sergioyankovenko.github.io\/svitlo\/$/);
  d.queue=null;assert.doesNotMatch(shareText(d,date,s),/Черга/);
  assert.equal(reminderTitle(false,civil(date,961)),'Відключення о 16:01');assert.equal(reminderTitle(true,civil(date,1082)),'Очікуване відновлення о 18:02');
  assert.equal(messageTitle({kind:'schedule',date,title:'Графік скасовано'}),'Графік скасовано');
});
test('UI has static single address, inline multiple, five real switches and persistent appearance defaults',()=>{
  const p=profile();p.name='<script>escape</script>';
  assert.doesNotMatch(addressCard(p,[p],false),/address-trigger|address-chevron|<script>/);
  assert.match(addressCard(p,[p,profile('two')],true),/aria-expanded="true"/);
  assert.equal((notificationSettings(p,'granted',false).match(/data-pref=/g)||[]).length,5);
  assert.match(notificationSettings({...p,preferences:{reminder:false,restoration:false}},'granted',false),/disabled aria-describedby="lead-help"/);
  for(const theme of ['dark','light'])for(const iconStyle of ['bolt','bulb'])for(const rangeTiles of [false,true]) {
    const html=appearance({theme,iconStyle,rangeTiles});
    assert.equal((html.match(/aria-pressed="true"/g)||[]).length,3);
    assert.doesNotMatch(html,/choice-check|✓/);
    assert(legend(iconStyle,'emergency',true).includes('var(--emergency)'));
  }
});
test('header category uses current confirmed address event independently of other failed categories or selected historical day',()=>{
  const s=profile().snapshot;s.queue=null;s.failures=['hourly'];s.categories.emergency.events=[{category:'emergency',start:now-60000,end:now+60000}];
  assert.equal(outageCategory(s,'2026-10-27',now,true),'emergency');
  s.categories.emergency.sourceAt=now-7200001;assert.equal(outageCategory(s,'2026-10-27',now,true),undefined);
});
test('SQL migration atomically merges independent flags, rejects foreign owner and suppresses queued region pushes',async()=>{
  const {sql,db}=await scalingDatabase();
  try {
    await sql.exec(await readFile(new URL('../supabase/migrations/20261028005221_pwa_sync_notification_channels.sql',import.meta.url),'utf8'));
    const owner='00000000-0000-0000-0000-000000000001',id='00000000-0000-0000-0000-000000000002';
    await sql.query('insert into auth.users(id) values($1)',[owner]);
    await sql.query('insert into svitlo_profiles(id,owner,address,preferences) values($1,$2,$3,$4)',[id,owner,{}, {schedule:false}]);
    await db.setPreferences(owner,id,{schedule:true});
    assert.equal((await db.profile(owner,id)).preferences.publication,true,'legacy master remains functional before independent choices');
    await db.setPreferences(owner,id,{publication:true});
    await db.setPreferences(owner,id,{change:false});
    await sql.query('update svitlo_profiles set preferences=$2 where id=$1',[id,{schedule:true,emergency:true}]);
    const prefs=(await sql.query('select preferences from svitlo_profiles where id=$1',[id])).rows[0].preferences;
    assert.equal(prefs.publication,true);assert.equal(prefs.change,false);
    await db.setPreferences(id,id,{publication:false});
    assert.equal((await db.profile(owner,id)).preferences.publication,true);
    assert.equal((await sql.query("select public.svitlo_channel_enabled($1,'change') as v",[prefs])).rows[0].v,false);
    assert.equal((await sql.query("select has_function_privilege('anon','public.svitlo_preferences_patch(uuid,uuid,jsonb)','EXECUTE') as v")).rows[0].v,false);
    await sql.query('insert into svitlo_subscriptions(id,owner,profile_id,subscription) values($1,$2,$3,$4)',['sub',owner,id,{}]);
    const event={owner,profile_id:id,title:'title',body:'body',date:'2026-10-28',expires_at:Date.now()+3600000};
    await db.enqueue({...event,event_key:'regional:blocked',channel:'emergency'});
    assert.equal((await sql.query('select count(*)::int as n from svitlo_deliveries')).rows[0].n,0);
    await db.enqueue({...event,event_key:'first',channel:'publication'});
    await db.enqueue({...event,event_key:'updated',channel:'change'});
    assert.equal((await sql.query('select count(*)::int as n from svitlo_deliveries')).rows[0].n,1);
    await sql.query("update svitlo_profiles set messages=$2 where id=$1",[id,[{id:'regional:old',scope:'region'}]]);
    await sql.query("insert into svitlo_deliveries(subscription_id,profile_id,event_key,title,body,date,expires_at,channel) values('sub',$1,md5('regional:old'),'old','old','2026-10-28',$2,'emergency')",[id,Date.now()+3600000]);
    const rows=await db.deliveryBatch(Date.now(),16);assert.equal(rows.length,1,'queued legacy regional push is suppressed at delivery');
  } finally {await sql.close();}
});
