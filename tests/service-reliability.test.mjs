import test from "node:test";
import assert from "node:assert/strict";
import { Service } from "../server/service.js";
import { MemoryDatabase } from "../server/memory.js";
import { SharedDictionaries } from "../server/shared-dictionaries.js";
import { providerTransport, retryDelay } from "../server/provider-transport.js";
import { Source } from "../server/source.js";
import { SourceError } from "../server/source-errors.js";
import { runLoggedJob } from "../server/operations.js";
import { syncRegistry, REGISTRY_INTERVAL } from "../server/queue-registry.js";
const initial=Date.parse("2026-10-26T18:00:00Z");
const address={department:"18",cityId:"801",streetId:"11807",house:"10а/51"};
function enrollmentFixture(){
 const db=new MemoryDatabase(),entries=new Map();let now=initial,account="12345678901",partial=false,calls=0;
 db.rememberPreview=async(owner,key,proof,prepared,checkedAt)=>entries.set(JSON.stringify([owner,key]),{proof,prepared:structuredClone(prepared),checkedAt});
 db.takePreview=async(owner,key,proof)=>{const k=JSON.stringify([owner,key]),item=entries.get(k);entries.delete(k);return item?.proof===proof&&now-item.checkedAt<60000?structuredClone(item.prepared):null;};
 const source={resolve:async input=>({...input,account,city:"м. Христинівка",street:"вул. Флорештська",label:"Тестова адреса"}),
  address:async()=>{calls++;return {queue:"3.2",categories:{hourly:{queue:"3.2",events:[],checkedAt:now}},failures:partial?["planned"]:[],errors:{},checkedAt:now};},
  feed:async()=>({plans:[],emergencies:[],messages:[],checkedAt:now})};
 return {db,entries,source,service:()=>new Service({db,source,now:()=>now}),get calls(){return calls;},advance:ms=>now+=ms,account:v=>account=v,partial:v=>partial=v};
}
test("preview is reused across service instances only for the same owner, exact address and account proof",async()=>{
 const f=enrollmentFixture();await f.service().handle("alice",{action:"preview",address});
 assert.equal(f.calls,1);assert.ok([...f.entries.values()].every(x=>!JSON.stringify(x.prepared).includes("12345678901")));
 f.advance(1000);const saved=await f.service().handle("alice",{action:"save",address,confirmed:true});
 assert.equal(f.calls,1);assert.equal(saved.profile.snapshot.checkedAt,initial);assert.equal(saved.profile.snapshot.lastSuccessAt,initial);
 assert.equal(saved.profile.last_checked,initial+1000);assert.equal(saved.profile.address.account,undefined);
 const other=enrollmentFixture();await other.service().handle("alice",{action:"preview",address});
 await other.service().handle("bob",{action:"save",address,confirmed:true});assert.equal(other.calls,2);
});
test("expired, partial and changed-account previews are fetched again",async()=>{
 for(const scenario of [{after:f=>f.advance(60001)},{after:f=>f.account("12345678902")},{before:f=>f.partial(true)}]){
  const f=enrollmentFixture();scenario.before?.(f);
  await f.service().handle("a",{action:"preview",address});scenario.after?.(f);
  await f.service().handle("a",{action:"save",address,confirmed:true});assert.equal(f.calls,2);
 }
});
test("a preview does not bypass explicit confirmation or change literal house identity",async()=>{
 const f=enrollmentFixture();await f.service().handle("a",{action:"preview",address});
 await assert.rejects(()=>f.service().handle("a",{action:"save",address}));
 await f.service().handle("a",{action:"save",address:{...address,house:"10а /51"},confirmed:true});assert.equal(f.calls,2);
});
test("fresh dictionaries share one load locally and another server instance uses the durable result",async()=>{
 let state={state:"owner",token:"one",items:null,checkedAt:null},loads=0;
 const db={dictionaryClaim:async()=>state,dictionaryFinish:async(k,t,items)=>{state={state:"fresh",items,checkedAt:100};return true;}};
 const loader=async()=>{loads++;await Promise.resolve();return [{id:"18",name:"Філія"}];};
 const cache=new SharedDictionaries(db,{now:()=>100});
 const [one,two]=await Promise.all([cache.load("dictionary:department:",loader),cache.load("dictionary:department:",loader)]);
 assert.deepEqual(one,two);assert.equal(loads,1);
 await new SharedDictionaries(db,{now:()=>100}).load("dictionary:department:",loader);assert.equal(loads,1);
});
test("dictionary failures keep stale labels with their real timestamp and invalid data is not written",async()=>{
 const calls=[];const stale=[{id:"18",name:"Known"}];
 const db={dictionaryClaim:async()=>({state:"owner",token:"t",items:stale,checkedAt:10}),dictionaryFinish:async(...a)=>{calls.push(a);return true;}};
 const cache=new SharedDictionaries(db,{now:()=>100});
 const r=await cache.load("dictionary:department:",async()=>{throw new SourceError("server_error",503);});
 assert.deepEqual(r,{items:stale,checkedAt:10});assert.equal(calls[0][2],null);assert.equal(calls[0][3],"server_error");
});
test("a busy cache waits for the other worker instead of starting another provider request",async()=>{
 let now=0,claims=0,loads=0;
 const db={dictionaryClaim:async()=>++claims===1?{state:"busy",items:null}:{state:"fresh",items:[],checkedAt:1}};
 const cache=new SharedDictionaries(db,{now:()=>now,sleep:async ms=>{now+=ms;}});
 assert.deepEqual((await cache.load("dictionary:city:18",async()=>{loads++;return [];})).items,[]);assert.equal(loads,0);
});
test("source validates dictionary data before caching and ignores meaningless department parent values",async()=>{
 const keys=[];const source=new Source(async()=>new Response('[{"ID":"18","NAME":"Філія"}]'),{dictionaries:{load:async(key,loader)=>{keys.push(key);return {items:await loader(),checkedAt:0};}}});
 await source.dictionary("department",{parent:"one"});await source.dictionary("department",{parent:"two"});
 assert.deepEqual(keys,["dictionary:department:","dictionary:department:"]);
 const invalid=new Source(async()=>new Response('[{"NAME":"missing ID"}]'),{dictionaries:{load:async(k,loader)=>({items:await loader(),checkedAt:0})}});
 await assert.rejects(()=>invalid.dictionary("department"));
});
test("provider lease is held until the response body is consumed and released only once",async()=>{
 let body;const completed=[];
 const db={providerAcquire:async()=>({granted:true,token:"t"}),providerFinish:async(...x)=>completed.push(x)};
 const transport=providerTransport(db,async()=>new Response(new ReadableStream({start(c){body=c;}})));
 const response=await transport("https://www.cherkasyoblenergo.com/test");assert.equal(completed.length,0);
 body.enqueue(new TextEncoder().encode("ok"));body.close();assert.equal(await response.text(),"ok");
 assert.equal(completed.length,1);assert.equal(completed[0][1],200);
});
test("403/429 cooldown prevents another network request and honors bounded Retry-After",async()=>{
 for(const status of [403,429]){
  let blocked=false,fetches=0;const completed=[];
  const db={providerAcquire:async()=>blocked?{granted:false,reason:"cooldown",code:status===403?"forbidden":"rate_limited"}:{granted:true,token:"t"},providerFinish:async(...x)=>{completed.push(x);blocked=true;}};
  const transport=providerTransport(db,async()=>{fetches++;return new Response(null,{status,headers:{"Retry-After":"120"}});});
  assert.equal((await transport("https://cabinet.cherkasyoblenergo.com/test")).status,status);
  await assert.rejects(()=>transport("https://cabinet.cherkasyoblenergo.com/test"),e=>e.code===(status===403?"forbidden":"rate_limited"));
  assert.equal(fetches,1);assert.equal(completed[0][3],120000);
 }
 assert.equal(retryDelay("999999"),900000);assert.equal(retryDelay("bad"),0);
});
test("provider spacing waits without retrying HTTP and unrelated hosts use their original transport",async()=>{
 let now=0,attempts=0,network=0,finishes=0;
 const db={providerAcquire:async()=>++attempts<3?{granted:false,reason:"spacing",waitMs:250}:{granted:true,token:"t"},providerFinish:async()=>finishes++};
 const transport=providerTransport(db,async()=>{network++;return new Response("ok");},{now:()=>now,sleep:async ms=>now+=ms});
 await (await transport("https://www.cherkasyoblenergo.com/test")).text();assert.equal(network,1);assert.equal(now,500);assert.equal(finishes,1);
 await (await transport("https://api.open-meteo.com/test")).text();assert.equal(network,2);assert.equal(attempts,3);
});
test("network and body failures release the lease without recording private URLs",async()=>{
 const completed=[];const db={providerAcquire:async()=>({granted:true,token:"t"}),providerFinish:async(...x)=>completed.push(x)};
 const transport=providerTransport(db,async()=>{throw new TypeError("https://private/12345678901");});
 await assert.rejects(()=>transport("https://cabinet.cherkasyoblenergo.com/test"));
 assert.equal(completed[0][2],"unreachable");assert.ok(!JSON.stringify(completed).includes("12345678901"));
 let body;
 const streamed=providerTransport(db,async()=>new Response(new ReadableStream({start(c){body=c;}})));
 const response=await streamed("https://cabinet.cherkasyoblenergo.com/test");
 body.error(new TypeError("private body failure"));await assert.rejects(()=>response.text());
 assert.equal(completed.length,2);assert.equal(completed[1][2],"unreachable");
});
test("a suspicious registry candidate is held without activation or an immediate extra provider retry",async()=>{
 const db=new MemoryDatabase();db.registryVersion={id:"old",documents:[],rules:[{}],validFrom:"2026-10-01",validUntil:"2027-04-01"};
 let held,fetches=0;
 db.registrySafety=async()=>({approved:false,reason:"mass_queue_change",changed:2000});
 db.holdRegistry=async(v,r,review)=>held={version:v,review};
 db.activateRegistry=async()=>{throw Error("must not activate suspicious mapping");};
 const links=Array.from({length:12},(_,i)=>`https://www.cherkasyoblenergo.com/cherkasyoblenergo/uploads/pages/files/${(i+1).toString(16)}.pdf`);
 const fetcher=async url=>{fetches++;const i=links.indexOf(url);return i<0?new Response(links.map(x=>`<a href="${x}">PDF</a>`).join("")):new Response(String(i));};
 const pdfPages=async bytes=>{const i=+new TextDecoder().decode(bytes);return [`${Math.floor(i/2)+1} черга ${i%2?"ІІ":"І"} підчерга\nз 1 жовтня 2026 р. по 1 квітня 2027\nм.Христинівка\nвул: Гілка ${String.fromCharCode(65+i)}`];};
 const result=await syncRegistry({db,fetcher,pdfPages,now:initial});
 assert.equal(result.status,"held_for_review");assert.equal(db.registryVersion.id,"old");assert.equal(held.review.reason,"mass_queue_change");
 assert.equal((await db.registryState()).nextCheckAt,initial+REGISTRY_INTERVAL);assert.equal(fetches,13);
});
test("job journal distinguishes successful, skipped, held and failed work without logging arbitrary result data",async()=>{
 const finished=[];const db={startJob:async()=>"id",finishJob:async(...x)=>finished.push(x),opsCleanup:async()=>{}};
 for(const [result,status] of [[{sent:2,refreshed:3,private:"omit"},"succeeded"],[{status:"not_due"},"not_due"],[{status:"held_for_review",review:{reason:"mass_queue_change"}},"needs_review"],[{status:"failed_retained"},"failed"],[{refreshed:2,partialRefreshes:1},"partial"]]){
  await runLoggedJob(db,"registry",async()=>result,()=>100);assert.equal(finished.at(-1)[1],status);
 }
 await assert.rejects(()=>runLoggedJob(db,"jobs",async()=>{throw new Error("private account 12345678901");}));
 assert.equal(finished.at(-1)[1],"failed");assert.ok(!JSON.stringify(finished).includes("12345678901"));assert.ok(!JSON.stringify(finished).includes('"private"'));
});
