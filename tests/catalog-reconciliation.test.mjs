import { refreshSeeded } from "./helpers/seed-profile.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { reconcileCatalog, catalogReconciliation } from "../server/catalog-reconciliation.js";
import { addressResolution } from "../server/address-registry.js";
import { REGISTRY_INTERVAL, registryPeriod, syncRegistry, rulesFromPages } from "../server/queue-registry.js";
import { Service } from "../server/service.js";
import { MemoryDatabase } from "../server/memory.js";
import { providerQueue } from "../server/provider-queue.js";
import { Source } from "../server/source.js";
const now=Date.parse("2026-10-26T16:00:00Z");
const url=q=>`https://www.cherkasyoblenergo.com/cherkasyoblenergo/uploads/pages/files/${q.replace('.','')}.pdf`;
const version=(id,queue="3.2")=>({id,validFrom:"2026-10-01",validUntil:"2027-04-01",checkedAt:now,documents:Array.from({length:12},(_,i)=>({queue:`${Math.floor(i/2)+1}.${i%2+1}`,url:url(`${Math.floor(i/2)+1}.${i%2+1}`)})),rules:[{city:"м. Христинівка",street:"вул. Тестова",scope:"street_all",queue,url:url(queue),page:4}],mentions:[]});
const row=(house,options={})=>({department:"18",city_id:"801",street_id:"100",house,city:"м. Христинівка",street:"вул. Тестова",status:"numeric",queue:"3.2",is_estimate:false,confidence:null,evidence:{origin:"exact_address_api"},batch:{import_key:"curated",reviewed_at:"2026-10-26T12:00:00Z"},...options});
function upstreamFixture() {
 const links=Array.from({length:12},(_,i)=>`https://www.cherkasyoblenergo.com/cherkasyoblenergo/uploads/pages/files/${(i+1).toString(16)}.pdf`);
 let shifted=false, calls=0;
 return {
  shift(){shifted=true;},get calls(){return calls;},
  fetcher:async(url)=>{calls++;const i=links.indexOf(url);return i<0?new Response(links.map(x=>`<a href="${x}">PDF</a>`).join("")):new Response(`${i}:${shifted&&[5,7].includes(i)?1:0}`);},
  pdfPages:async(bytes)=>{const [i,shift]=new TextDecoder().decode(bytes).split(":").map(Number);const street=i===5?(shift?"Початкова":"Тестова"):i===7?(shift?"Тестова":"Інша"):"Гілка "+String.fromCharCode(65+i);return [`${Math.floor(i/2)+1} черга ${i%2?"ІІ":"І"} підчерга\nз 1 жовтня 2026 р. по 1 квітня 2027\nм.Христинівка\nвул: ${street}`];},
 };
}

test("provider interval remains fourteen days; unchanged PDF content does not read the address census",async()=>{
 assert.equal(REGISTRY_INTERVAL,14*86400000);
 assert.equal(await catalogReconciliation({addressCatalogBatches(){throw Error("must not scan");}},version("v1"),version("v1"),now),null);
});
test("period parsing supports the next season and rejects impossible or reversed dates",()=>{
 assert.deepEqual(registryPeriod("з 1 жовтня 2026 р. по 1 квітня 2027"),{from:"2026-10-01",until:"2027-04-01"});
 assert.deepEqual(registryPeriod("з 01 квітня 2027 р. по 01 жовтня 2027"),{from:"2027-04-01",until:"2027-10-01"});
 assert.throws(()=>registryPeriod("з 31 лютого 2027 р. по 1 жовтня 2027"));
 assert.throws(()=>registryPeriod("з 1 жовтня 2027 р. по 1 квітня 2027"));
});
test("business markers do not accidentally discard street names containing the letters тов",()=>{
 const rules=rulesFromPages(["м.Христинівка\nвул: Поштова, Тестова, ТОВ Завод"],"3.2",url("3.2"));
 assert.deepEqual(rules.map(x=>x.street),["вул.Поштова","вул.Тестова"]);
});
test("importer reconciles a PDF change using the same thirteen upstream requests and respects the interval",async()=>{
 const db=new MemoryDatabase(),u=upstreamFixture();
 const run=(at)=>syncRegistry({db,fetcher:u.fetcher,pdfPages:u.pdfPages,now:at});
 assert.equal((await run(now)).status,"updated");assert.equal(u.calls,13);
 let reconciliation;
 const activate=db.activateRegistry.bind(db);
 db.activateRegistry=async(v,r)=>{reconciliation=r;await activate(v);};
 db.addressCatalogBatches=async()=>[{id:"b",expected_total:1}];
 db.addressCatalogPage=async()=>[row("1")];
 assert.equal((await run(now+1000)).status,"not_due");assert.equal(u.calls,13);
 u.shift();assert.equal((await run(now+REGISTRY_INTERVAL)).status,"updated");
 assert.equal(u.calls,26);assert.equal(reconciliation.batches[0].overrides[0].queue,"4.2");
 assert.equal((await db.registryState()).addressReconciliation.batches[0].changed,1);
});
test("a state-save failure after atomic activation is not falsely reported as retaining the old version",async()=>{
 const db=new MemoryDatabase(),u=upstreamFixture();const save=db.saveRegistryState.bind(db);let writes=0;
 db.saveRegistryState=async(v)=>{if(writes++===0)throw Error("state storage failure");await save(v);};
 const result=await syncRegistry({db,fetcher:u.fetcher,pdfPages:u.pdfPages,now});
 assert.equal(result.status,"activated_state_retry");assert.equal(result.version,(await db.registry()).id);
});
test("changed PDF moves consistent numeric addresses and keeps API exceptions, exclusions and service rows",()=>{
 const rows=[row("1"),row("2",{queue:"1.2"}),row("3",{status:"not_in_queue",queue:null}),row("4",{status:"service",queue:null}),row("5",{street:"вул. Інша"})];
 const r=reconcileCatalog(rows,version("v1"),version("v2","4.2"),now);
 assert.deepEqual(r.counts,{changed:1,carried:0,needsReview:2,unchanged:1,service:1});
 assert.equal(r.overrides.find(x=>x.house==="1").queue,"4.2");
 assert.equal(r.overrides.find(x=>x.house==="2").queue,"1.2");
 assert.equal(r.overrides.find(x=>x.house==="2").is_estimate,true);
 assert.equal(r.overrides.find(x=>x.house==="3").status,"not_in_queue");
 assert.equal(rows[0].queue,"3.2");
});
test("cosmetic revisions preserve curated numbers and carry previous version overrides without reverting them",()=>{
 const plain=reconcileCatalog([row("1",{queue:"1.2"})],version("v1"),version("v2"),now);
 assert.equal(plain.overrides.length,0);
 const carried=reconcileCatalog([row("1",{queue:"4.2",override_registry_id:"v2",evidence:{origin:"provider_pdf_change",pdf_mapping:{scope:"street_all",page:4,url:url("4.2")},address_reviewed_at:"2026-10-25T12:00:00Z"}})],version("v2","4.2"),version("v3","4.2"),now);
 assert.equal(carried.counts.carried,1);assert.equal(carried.overrides[0].queue,"4.2");
 assert.equal(carried.overrides[0].evidence.address_reviewed_at,"2026-10-25T12:00:00Z");
});
test("documented renamed houses follow their canonical address and aliases do not cross census batches",()=>{
 const old=row("1",{street_id:"101",street:"вул. Стара"}),canonical=row("1");
 const aliases={batchImportKey:"curated",aliases:[{source:{department:"18",cityId:"801",streetId:"101",house:"1"},target:{department:"18",cityId:"801",streetId:"100",house:"1"},document:"council-rename"}]};
 const r=reconcileCatalog([old,canonical],version("v1"),version("v2","4.2"),now,aliases);
 assert.equal(r.counts.changed,2);assert.ok(r.overrides.every(x=>x.queue==="4.2"));
 assert.equal(r.overrides.find(x=>x.street_id==="101").evidence.alias_document,"council-rename");
 const otherBatch=reconcileCatalog([old,canonical],version("v1"),version("v2","4.2"),now,{...aliases,batchImportKey:"unrelated"});
 assert.equal(otherBatch.counts.changed,1);
 const conflict=reconcileCatalog([{...old,queue:"1.2"},canonical],version("v1"),version("v2","4.2"),now,aliases);
 assert.equal(conflict.overrides.find(x=>x.street_id==="101").queue,"1.2");
 assert.equal(conflict.overrides.find(x=>x.street_id==="101").evidence.review_reason,"confirmed_alias_queue_disagreement");
});
test("removed or ambiguous rules retain a marked estimate instead of inventing a new queue or address citation",()=>{
 const next={...version("v2"),rules:[]};
 const r=reconcileCatalog([row("1")],version("v1"),next,now).overrides[0];
 assert.equal(r.queue,"3.2");assert.equal(r.confidence,"low");assert.equal(r.evidence.needsReview,true);assert.equal(r.evidence.pdf_mapping,null);
 const response=addressResolution({...row("1"),...r},next,now);
 assert.equal(response.queue,"3.2");assert.equal(response.needsReview,true);assert.equal(response.referenceRole,"queue_definition_only");
});
test("known account exclusions and street-versus-lane identity are preserved",()=>{
 const r=reconcileCatalog([row("1",{is_estimate:true,confidence:"medium",evidence:{knownAccountExclusionsPreserved:true}}),row("2",{street:"пров. Тестова"})],version("v1"),version("v2","4.2"),now);
 assert.equal(r.overrides[0].queue,"3.2");assert.equal(r.counts.needsReview,1);assert.equal(r.counts.unchanged,1);
});
test("season boundary uses the previous mapping as comparison evidence without serving its expired PDF",()=>{
 const old={...version("old"),validUntil:"2026-10-25"};
 assert.equal(reconcileCatalog([row("1")],old,version("next","4.2"),now).overrides[0].queue,"4.2");
});
test("incomplete paginated census aborts preparation before activation",async()=>{
 await assert.rejects(()=>catalogReconciliation({addressCatalogBatches:async()=>[{id:"b",expected_total:2}],addressCatalogPage:async()=>[row("1")]},version("v1"),version("v2","4.2"),now),/incomplete_address_catalog/);
});
test("a failed hourly refresh cannot make a cached API queue override the newly reconciled queue",async()=>{
 const db=new MemoryDatabase();
 db.addressQueue=async()=>row("1",{queue:"4.2",evidence:{origin:"provider_pdf_change"}});
 db.registryMetadata=async()=>version("v2","4.2");
 const source={address:async()=>({queue:"3.2",categories:{hourly:{queue:"3.2",checkedAt:now-3600000}},failures:["hourly"]}),feed:async()=>({plans:[],emergencies:[],messages:[],checkedAt:now})};
 const service=new Service({db,source,now:()=>now});
 const result=await refreshSeeded(service,{id:"p",owner:"u",address:{department:"18",cityId:"801",streetId:"100",house:"1"},snapshot:{},preferences:{}});
 assert.equal(result.snapshot.queue,"4.2");assert.equal(result.snapshot.queueResolution.decisionSource,"provider_pdf_change");assert.deepEqual(result.snapshot.failures,["hourly"]);
});
test("cached API evidence is labeled as cached when both the current API and the registry are unavailable",async()=>{
 const db=new MemoryDatabase();db.addressQueue=async()=>null;db.registry=async()=>null;
 const source={address:async()=>({queue:"3.2",categories:{hourly:{checkedAt:now-3600000}},failures:["hourly"]}),feed:async()=>({plans:[],emergencies:[],messages:[],checkedAt:now})};
 const service=new Service({db,source,now:()=>now});
 const result=await refreshSeeded(service,{id:"p",owner:"u",address:{},snapshot:{},preferences:{}});
 assert.equal(result.snapshot.queue,"3.2");assert.equal(result.snapshot.queueResolution.source,"cached_address_api");assert.equal(result.snapshot.queueResolution.checkedAt,now-3600000);
});
test("fresh explicit API exclusion supersedes a numeric catalog queue; mixed or incomplete queue evidence is not authoritative",async()=>{
 const excluded="Графік погодинних відключень: в чергу не включено";
 const numeric="Графік погодинних відключень: 3 черга 2 підчерга";
 const envelope=(infos)=>({DATETIME:"18:00 26.10.2026",DISCONNECTIONS:[],DISCONN_QUEUQ:infos.map(QUEUE_INFO=>({QUEUE_INFO}))});
 assert.equal(providerQueue(envelope([numeric,excluded])).queueStatus,"ambiguous");
 assert.equal(providerQueue(envelope([numeric,"Графік погодинних відключень: уточнюється"])).queueStatus,"partial_queue");
 const db=new MemoryDatabase();db.addressQueue=async()=>row("1");db.registryMetadata=async()=>version("v1");
 const source=new Source();source.request=async()=>envelope([excluded]);source.feed=async()=>({plans:[],emergencies:[],messages:[],checkedAt:now});
 const service=new Service({db,source,now:()=>now});
 const result=await refreshSeeded(service,{id:"p",owner:"u",address:{department:"18",cityId:"801",streetId:"100",house:"1",account:"12345678901"},snapshot:{},preferences:{}});
 assert.equal(result.snapshot.queue,null);assert.equal(result.snapshot.queueResolution.inclusion,"not_in_queue");assert.equal(result.snapshot.queueResolution.source,"address_api");
});

test("SQL activation switches PDF and overlays atomically, retains the immutable census and denies public access",async()=>{
 const db=new PGlite();
 try{
  await db.exec("create role anon;create role authenticated;create role service_role bypassrls;");
  const base=await readFile(new URL("../supabase/migrations/20261024144933_queue_registry.sql",import.meta.url),"utf8");
  await db.exec(base.split("alter table public.svitlo_profiles")[0]);
  await db.exec(await readFile(new URL("../supabase/migrations/20261026145440_address_queue_catalog.sql",import.meta.url),"utf8"));
  await db.exec(await readFile(new URL("../supabase/migrations/20261026162948_reconcile_address_registry.sql",import.meta.url),"utf8"));
  await db.query("select public.svitlo_activate_registry($1)",[version("v1")]);
  const batch=(await db.query("insert into public.svitlo_address_queue_batches(import_key,department,expected_total,expected_numeric,expected_exclusions,expected_service,checksum_md5,reviewed_at) values ('curated','18',3,2,1,0,repeat('0',32),now()) returning id")).rows[0].id;
  await db.query("insert into public.svitlo_address_queues(batch_id,department,city_id,street_id,house,city,street,status,queue) values ($1,'18','801','100','1','м. Христинівка','вул. Тестова','numeric','3.2'),($1,'18','801','100','2','м. Христинівка','вул. Тестова','numeric','1.2'),($1,'18','801','100','3','м. Христинівка','вул. Тестова','not_in_queue',null)",[batch]);
  await db.query("update public.svitlo_address_queue_batches set status='active' where id=$1",[batch]);
  const effective=async()=> (await db.query("select * from public.svitlo_effective_address_queues order by house")).rows;
  const activate=async(previous,next)=>{
   const rows=await effective();const result=reconcileCatalog(rows,previous,next,now);
   await db.query("select public.svitlo_activate_registry($1)",[{...next,addressReconciliation:{previous_registry_id:previous.id,batches:[{batch_id:batch,total:rows.length,...result}]}}]);
  };
  await activate(version("v1"),version("v2","4.2"));
  assert.equal((await effective())[0].queue,"4.2");
  assert.equal((await db.query("select queue from public.svitlo_address_queues where house='1'")).rows[0].queue,"3.2");
  const wire=addressResolution((await effective())[0],version("v2","4.2"),now);
  assert.equal(wire.page,4);assert.equal(wire.referenceRole,"address_mapping");assert.equal(wire.scope,"street_all");
  await activate(version("v2","4.2"),version("v3","4.2"));
  assert.equal((await effective())[0].queue,"4.2");
  await db.query("select public.svitlo_activate_registry($1)",[version("v3","4.2")]);
  assert.equal((await effective())[0].queue,"4.2");
  await assert.rejects(()=>db.query("select public.svitlo_activate_registry($1)",[version("v4","5.2")]),/Address reconciliation required/);
  const bad={...version("v4","5.2"),addressReconciliation:{previous_registry_id:"v3",batches:[{batch_id:batch,total:3,overrides:[{...row("1"),queue:"7.9"}]}]}};
  await assert.rejects(()=>db.query("select public.svitlo_activate_registry($1)",[bad]));
  assert.equal((await db.query("select id from public.svitlo_queue_versions where active")).rows[0].id,"v3");
  assert.equal((await effective())[0].queue,"4.2");
  await assert.rejects(()=>db.query("select public.svitlo_activate_registry($1)",[{...bad,addressReconciliation:{...bad.addressReconciliation,previous_registry_id:"v1"}}]),/Address reconciliation required/);
  await db.exec("set role service_role");assert.equal((await effective())[0].queue,"4.2");
  await db.exec("reset role;set role authenticated");
  await assert.rejects(()=>db.query("select * from public.svitlo_effective_address_queues"));
  await assert.rejects(()=>db.query("select * from public.svitlo_address_queue_overrides"));
  await assert.rejects(()=>db.query("select public.svitlo_activate_registry($1)",[version("v3","4.2")]));
 }finally{await db.close();}
});

