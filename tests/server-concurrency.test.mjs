import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Service,DEFAULT_PREFS } from "../server/service.js";
import { MemoryDatabase } from "../server/memory.js";
import { Source } from "../server/source.js";
import { SharedFeed } from "../server/shared-feed.js";
const initial=Date.parse("2026-10-26T19:00:00Z");
const address={department:"18",cityId:"801",streetId:"100",house:"1",city:"м. Тест",street:"вул. Тестова"};
const snapshot=t=>({queue:null,categories:{hourly:{events:[],checkedAt:t}},failures:[],errors:{},checkedAt:t});
const feed=t=>({checkedAt:t,plans:[],emergencies:[],messages:[]});
const profile=(id="p")=>({id,owner:"u",address,preferences:{...DEFAULT_PREFS},snapshot:{},messages:[],last_checked:0});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {resolve,promise};};

test("delayed refresh preserves newly changed preferences and cannot recreate a deleted address",async()=>{
 for(const action of ["preferences","delete"]){
  const db=new MemoryDatabase(),p=profile(),entered=deferred(),release=deferred();await db.saveProfile(p);
  const svc=new Service({db,now:()=>initial,source:{address:async()=>{entered.resolve();await release.promise;return snapshot(initial);},feed:async()=>feed(initial)}});
  const running=svc.refresh(p);await entered.promise;
  await svc.handle("u",{action,id:p.id,preferences:{reminder:false}});release.resolve();
  if(action==="delete") {await assert.rejects(()=>running,e=>e.status===404);assert.equal(db.p.size,0);}
  else {const result=await running;assert.equal(result.preferences.reminder,false);assert.equal(db.p.get(p.id).preferences.reminder,false);}
 }
});

test("a slower snapshot cannot overwrite the winner of a concurrent refresh",async()=>{
 const db=new MemoryDatabase(),p=profile(),entered=deferred(),release=deferred();await db.saveProfile(p);let calls=0;
 const svc=new Service({db,now:()=>initial,source:{address:async()=>{if(++calls===1){entered.resolve();await release.promise;return {...snapshot(initial),queue:"1.1"};}return {...snapshot(initial),queue:"3.2"};},feed:async()=>feed(initial)}});
 const slow=svc.refresh(p);await entered.promise;await svc.refresh(p);release.resolve();
 const result=await slow;assert.equal(result.snapshot.queue,"3.2");assert.equal(db.p.get(p.id).snapshot_revision,1);
});

test("simultaneous identical enrollments create one address; concurrent quota checks admit at most ten",async()=>{
 const db=new MemoryDatabase();const svc=new Service({db,now:()=>initial,source:{resolve:async a=>a,address:async()=>snapshot(initial),feed:async()=>feed(initial)}});
 const save=house=>svc.handle("u",{action:"save",confirmed:true,address:{...address,house}});
 const same=await Promise.all(Array.from({length:6},()=>save("1")));
 assert.equal(new Set(same.map(x=>x.profile.id)).size,1);assert.equal(db.p.size,1);
 const many=await Promise.allSettled(Array.from({length:20},(_,i)=>save(String(i+2))));
 assert.equal(many.filter(x=>x.status==="fulfilled").length,9);assert.equal(db.p.size,10);
 assert.ok(many.filter(x=>x.status==="rejected").every(x=>x.reason.status===400));
 assert.equal((await save("1")).profile.id,same[0].profile.id);
});

test("deleting an address while its initial enrollment is loading does not resurrect it",async()=>{
 const db=new MemoryDatabase(),entered=deferred(),release=deferred();
 const svc=new Service({db,now:()=>initial,source:{resolve:async a=>a,address:async()=>{entered.resolve();await release.promise;return snapshot(initial);},feed:async()=>feed(initial)}});
 const saving=svc.handle("u",{action:"save",confirmed:true,address});await entered.promise;
 await svc.handle("u",{action:"delete",id:[...db.p.keys()][0]});release.resolve();
 await assert.rejects(()=>saving,e=>e.status===404);assert.equal(db.p.size,0);
});

test("job budget leaves unclaimed refresh work due and the next run resumes it",async()=>{
 const db=new MemoryDatabase();let now=initial;for(let i=0;i<3;i++)await db.saveProfile(profile("p"+i));
 const svc=new Service({db,now:()=>now,source:{address:async()=>{now+=24000;return snapshot(now);},feed:async()=>feed(now)}});
 const one=await svc.jobs();assert.equal(one.refreshed,1);assert.equal((await db.due(now,10)).length,2);
 now+=60000;const two=await svc.jobs();assert.equal(two.refreshed,1);assert.equal((await db.due(now,10)).length,1);
 assert.equal(db.jobClaimed,false);
});

test("job lease rejects overlapping runs and is released after failure",async()=>{
 const db=new MemoryDatabase(),entered=deferred(),release=deferred();await db.saveProfile(profile());
 const svc=new Service({db,now:()=>initial,source:{address:async()=>{entered.resolve();await release.promise;return snapshot(initial);},feed:async()=>feed(initial)}});
 const running=svc.jobs();await entered.promise;assert.equal((await svc.jobs()).status,"busy");release.resolve();await running;
 db.reminderProfiles=async()=>{throw Error("storage unavailable");};await assert.rejects(()=>svc.jobs());assert.equal(db.jobClaimed,false);
});

test("reminder cursor continues beyond a bounded page budget and wraps after the last profile",async()=>{
 const db=new MemoryDatabase();for(let i=0;i<605;i++)await db.saveProfile({id:String(i).padStart(4,"0"),last_checked:initial});
 const svc=new Service({db,source:{},now:()=>initial}),seen=[];svc.reminders=async p=>seen.push(p.id);
 await svc.jobs();assert.equal(seen.length,300);await svc.jobs();assert.equal(seen.length,600);await svc.jobs();
 assert.equal(seen.length,605);assert.equal(new Set(seen).size,605);assert.equal(db.reminderCursor,null);
});

test("push claims are just in time, at most two deliveries run together, TTL is bounded by expiry",async()=>{
 const db=new MemoryDatabase();let index=0,active=0,max=0;const completed=[];
 db.deliveries=async()=>index<14?[{id:++index,lease_token:"lease"+index,event_key:"e",expires_at:initial+5000,attempts:1,subscription:{}}]:[];
 db.deliveryDone=async(id,token)=>completed.push([id,token]);
 const svc=new Service({db,source:{},now:()=>initial,push:async(s,p,opts)=>{active++;max=Math.max(max,active);assert.equal(opts.ttl,5);await Promise.resolve();active--;}});
 const result=await svc.jobs();assert.equal(result.sent,10);assert.equal(index,10);assert.equal(completed.length,10);assert.equal(max,2);
});

test("failed push uses its lease token and Retry-After; expired subscriptions are removed",async()=>{
 const db=new MemoryDatabase();let index=0;const retry=[],removed=[];
 db.deliveries=async()=>index<2?[{id:++index,lease_token:"l"+index,subscription_id:"s"+index,subscription:{id:index},attempts:1,expires_at:initial+3600000}]:[];
 db.deliveryRetry=async(...a)=>retry.push(a);db.removeSubscription=async id=>removed.push(id);
 const svc=new Service({db,source:{},now:()=>initial,push:async(s)=>{throw s.id===1?{statusCode:429,headers:{"retry-after":"120"}}:{statusCode:410};}});
 const result=await svc.jobs();assert.equal(result.failedDeliveries,1);assert.equal(result.expiredSubscriptions,1);
 assert.deepEqual(retry,[[1,initial,"l1",120000]]);assert.deepEqual(removed,["s2"]);
});

test("one failed article retains previous evidence and valid articles without inventing a fresh feed timestamp",async()=>{
 const payload=JSON.parse(await readFile(new URL("./fixtures/plan24.json",import.meta.url),"utf8"));
 const now=Date.parse("2026-10-24T12:00:00Z"),oldAt=now-7200000;
 const source=new Source(async url=>{
  const u=new URL(url);
  if(u.pathname.includes('/category/'))return Response.json({success:true,data:{content:u.searchParams.get('page')==='0'?[{title:'ГПВ',slug:'good'},{title:'ГПВ',slug:'broken'}]:[]}});
  return u.pathname.endsWith('/good')?Response.json(payload):new Response('',{status:503});
 });
 const oldPlan={date:"2026-10-25",queue:"1.1",publishedAt:oldAt,revision:"old"};
 const value=await source.feed(now,{checkedAt:oldAt,plans:[oldPlan],emergencies:[]});
 assert.equal(value.partial,true);assert.equal(value.failedArticles,1);assert.equal(value.checkedAt,oldAt);
 assert.ok(value.plans.some(x=>x.date==='2026-10-24'&&x.queue==='3.2'));assert.ok(value.plans.some(x=>x.revision==='old'));
});

test("shared feed coordinates independent workers and keeps timestamps during a concurrent refresh",async()=>{
 let current=feed(initial-7200000),owned=false,finished=false,loads=0;const entered=deferred(),release=deferred();
 const db={feedClaim:async()=>finished?{state:'fresh',value:current}:owned?{state:'busy',value:current}:(owned=true,{state:'owner',token:'one',value:current}),
  feedFinish:async(token,value,error)=>{assert.equal(error,null);current=value;finished=true;return true;}};
 const loader=async()=>{loads++;entered.resolve();await release.promise;return feed(initial);};
 const first=new SharedFeed(db).load(current,loader);await entered.promise;
 const waiting=await new SharedFeed(db).load(current,loader);assert.equal(waiting.partial,true);assert.equal(waiting.checkedAt,initial-7200000);
 release.resolve();await first;const reused=await new SharedFeed(db).load({},loader);assert.equal(reused.checkedAt,initial);assert.equal(loads,1);
});

test("an aborted job signal reaches all category requests and preserves old category timestamps",async()=>{
 const controller=new AbortController(),oldAt=initial-3600000;let requests=0;
 const source=new Source(async(url,{signal})=>{requests++;return new Promise((resolve,reject)=>{
  if(signal.aborted)return reject(signal.reason);signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
 });});
 const running=source.address({account:'12345678901'},initial,{categories:{hourly:{checkedAt:oldAt,events:[]}}},{signal:controller.signal});
 controller.abort();const result=await running;assert.equal(requests,3);assert.equal(result.failures.length,3);assert.equal(result.categories.hourly.checkedAt,oldAt);
});

test("a slow claim that exhausts the job budget is released without attempting a push",async()=>{
 const db=new MemoryDatabase();let now=initial,pushes=0;const released=[];
 db.deliveries=async()=>{now+=40000;return [{id:1,lease_token:'one',expires_at:initial+3600000}];};
 db.deliveryRelease=async(...a)=>released.push(a);
 const svc=new Service({db,source:{},now:()=>now,push:async()=>pushes++});
 const result=await svc.jobs();assert.equal(pushes,0);assert.ok(released.length>=1);assert.equal(result.budgetExhausted,true);
});

test("a valid feed is returned if its optional shared-cache write fails",async()=>{
 const db={feedClaim:async()=>({state:'owner',token:'t'}),feedFinish:async()=>{throw Error('cache unavailable');}};
 const result=await new SharedFeed(db).load({},async()=>feed(initial));assert.equal(result.checkedAt,initial);
});

test("when every article fails the existing feed is not replaced with a successful empty result",async()=>{
 const source=new Source(async url=>new URL(url).pathname.includes('/category/')?
  Response.json({success:true,data:{content:[{title:'ГПВ',slug:'broken'}]}}):new Response('',{status:503}));
 await assert.rejects(()=>source.loadFeed(initial,feed(initial-7200000)),e=>e.code==='server_error');
 assert.equal(source.publicCache,null);
});
