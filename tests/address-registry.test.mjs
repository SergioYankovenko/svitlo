import { refreshSeeded } from "./helpers/seed-profile.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { addressResolution } from "../server/address-registry.js";
import { Service } from "../server/service.js";
import { MemoryDatabase } from "../server/memory.js";
const now=Date.parse("2026-10-26T15:00:00Z"),address={department:"18",cityId:"801",streetId:"12131",house:"1/а"};
const pdf={id:"pdf",validFrom:"2026-10-01",validUntil:"2027-04-01",documents:[{queue:"3.2",url:"https://www.cherkasyoblenergo.com/cherkasyoblenergo/uploads/pages/files/70d213bb-6275-41e9-bf50-d5262a6624eb.pdf"}],rules:[]};
const record={department:"18",city_id:"801",street_id:"12131",house:"1/а",city:"м. Христинівка",street:"вул. Першотравнева",status:"numeric",queue:"3.2",is_estimate:true,confidence:"low",evidence:{origin:"local_estimate"},batch:{import_key:"test",reviewed_at:"2026-10-26T12:00:00Z"}};
test("curated addresses resolve during operator downtime with numeric legacy wire format and honest decision metadata",async()=>{
 const db=new MemoryDatabase();db.addressQueue=async a=>a.house===address.house?record:null;db.registry=async()=>pdf;
 const service=new Service({db,source:{resolve(){throw Error("operator down");}},now:()=>now});
 const r=(await service.handle("owner",{action:"resolve_queue",address})).resolution;
 assert.equal(r.queue,"3.2");assert.equal(r.estimated,true);assert.equal(r.decisionSource,"local_estimate");assert.equal(r.referenceRole,"queue_definition_only");assert.equal(r.page,1);assert.equal(r.checkedAt,now);assert.ok(r.version.includes("addresses:test"));
 const resolved=await service.resolveAddress(address);assert.equal(resolved.label,"м. Христинівка, вул. Першотравнева, 1/а");
});
test("explicit exclusions and service entries suppress positive PDF fallbacks; expired queue documents are unavailable",()=>{
 assert.equal(addressResolution({...record,status:"not_in_queue",queue:null},pdf,now).queue,null);
 assert.equal(addressResolution({...record,status:"service",queue:null},pdf,now).status,"not_found");
 assert.equal(addressResolution(record,{...pdf,validUntil:"2026-10-25"},now).status,"unavailable");
});
test("primary operator queue still wins over curated estimate during profile refresh",async()=>{
 const db=new MemoryDatabase();db.addressQueue=async()=>record;db.registry=async()=>pdf;
 const source={address:async()=>({queue:"4.2",categories:{hourly:{events:[],queue:"4.2",checkedAt:now}},failures:[]}),feed:async()=>({plans:[],emergencies:[],messages:[],checkedAt:now})};
 const service=new Service({db,source,now:()=>now});
 const result=await refreshSeeded(service,{id:"p",owner:"u",address,snapshot:{},preferences:{}});
 assert.equal(result.snapshot.queue,"4.2");assert.equal(result.snapshot.queueResolution.source,"address_api");
});
test("database catalog preserves literal house spaces, prevents incomplete activation duplicates and denies client writes",async()=>{
 const db=new PGlite();try{
  await db.exec("create role anon;create role authenticated;create role service_role bypassrls;");
  await db.exec(await readFile(new URL("../../work/prod-address-rollout-20261026/schema.sql",import.meta.url),"utf8"));
  const batch=(await db.query("insert into public.svitlo_address_queue_batches(import_key,department,expected_total,expected_numeric,expected_exclusions,expected_service,checksum_md5,reviewed_at) values ('test','18',2,2,0,0,repeat('0',32),now()) returning id")).rows[0].id;
  await db.query("insert into public.svitlo_address_queues(batch_id,department,city_id,street_id,house,city,street,status,queue) values ($1,'18','801','12073','9  г','місто','вулиця','numeric','4.2'),($1,'18','801','12073','9 г','місто','вулиця','numeric','3.2')",[batch]);
  assert.equal((await db.query("select public.svitlo_address_dictionary('house','12073') as items")).rows[0].items.length,0);
  await db.query("update public.svitlo_address_queue_batches set status='active' where id=$1",[batch]);
  assert.equal((await db.query("select public.svitlo_address_dictionary('house','12073') as items")).rows[0].items.length,2);
  await assert.rejects(()=>db.query("insert into public.svitlo_address_queues(batch_id,department,city_id,street_id,house,city,street,status,queue) values ($1,'18','801','12073','invalid','city','street','numeric',null)",[batch]));
  await db.exec("set role authenticated");await assert.rejects(()=>db.query("select * from public.svitlo_address_queues"));await assert.rejects(()=>db.query("select public.svitlo_address_dictionary('house','12073')"));await db.exec("reset role");
 }finally{await db.close();}
});
