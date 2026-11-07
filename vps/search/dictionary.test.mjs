import test from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';import {randomUUID} from 'node:crypto';import {readFile} from 'node:fs/promises';
import {prepareSearchFixture,poolFor} from './fixture.mjs';import {DictionarySearch,DictionaryIndexer,dictionaryRows,dictionaryProof} from './dictionary.js';
test('provider projection admits public id/name only and binds signed pagination to source partition',()=>{
 assert.deepEqual(dictionaryRows([{id:'17',name:'Лесі Українки',account:'secret'},{id:'17',name:'duplicate'},{id:'bad',name:'Невідомо'},{id:'18',name:'Шевченка'}]),[{id:'17',name:'Лесі Українки'},{id:'18',name:'Шевченка'}]);
 const p=new DictionarySearch({secret:'server'}),scope=p.scope('route','settlement','street','parent'),value={engine:'dictionary',scope,q:'Шевченка',revision:randomUUID(),offset:50};const cursor=p.cursor(value);
 assert.equal(p.parse(cursor,{scope,q:value.q}).offset,50);assert.throws(()=>p.parse(cursor,{scope:'other',q:value.q}));assert.throws(()=>p.parse(cursor,{scope,q:'different'}));
});
test('a search-engine edit cannot forge a provider key/label; signed document failures request repair and use source fallback',async()=>{
 const scope='a'.repeat(64),revision=randomUUID(),row={id:'source-house-10',name:'10/1'};let repairs=0,forged=false;
 const port=new DictionarySearch({secret:'server',bridge:{query:async(sql)=>{if(sql.includes('dictionary_repair'))repairs++;return {rows:[{value:{ready:true,revision}}]};}},client:{index:()=>'/indexes/svitlo_dictionary_g_public01',request:async()=>({hits:[{providerId:row.id,label:forged?'101':row.name,proof:dictionaryProof('server',scope,revision,row)}]})}});
 assert.equal((await port.search({scope,q:'10/1',kind:'house',limit:50})).page[0].name,'10/1');forged=true;assert.equal(await port.search({scope,q:'10/1',kind:'house',limit:50}),null);assert.equal(repairs,1);
});
test('dictionary task ACK is fenced; lost index repairs and expired scope falls back; API cannot read stored projections',async()=>{
 const c=new PGlite();try{
  await prepareSearchFixture(c);await c.exec('create table svitlo_geo.routes(id text primary key,operator_id text,active boolean);create table svitlo_geo.route_places(route_id text,settlement_code text)');await c.exec(await readFile(new URL('../sql/dictionary-search.sql',import.meta.url),'utf8'));
  await c.exec("insert into svitlo_vps.operators(id,adapter_key,label,state) values('ua-cherkasy','cherkasy-v1','Тест','available')");const parent=randomUUID();await c.query("insert into svitlo_vps.catalog(id,kind,label,operator_id) values($1,'city','Тестове місто','ua-cherkasy')",[parent]);await c.exec("insert into svitlo_geo.routes values('r','ua-cherkasy',true);insert into svitlo_geo.route_places values('r','UA123')");
  const port=new DictionarySearch({bridge:c,client:{},secret:'server'}),scope=port.scope('r','UA123','street',parent),rows=[{id:'s1',name:'Шевченка',account:'private'}];
  await c.exec('set role svitlo_stage_api');await port.stage({route:'r',settlement:'UA123',kind:'street',parent,rows});await assert.rejects(()=>c.query('select rows from svitlo_search.dictionaries'),e=>e.code==='42501');
  await c.exec('set role svitlo_stage_worker');let doc;const client={index:n=>'/indexes/'+n,request:async()=>({taskUid:1}),wait:async()=>{},upsert:async(n,items)=>{doc=items[0];}};
  const indexer=new DictionaryIndexer({pool:poolFor(c),client,secret:'server'});assert.equal((await indexer.tick()).state,'progress');assert.equal(doc.providerId,'s1');assert.ok(!JSON.stringify(doc).includes('private'));
  await c.exec('set role svitlo_stage_api');assert.equal((await c.query('select svitlo_search.dictionary_state($1) value',[scope])).rows[0].value.ready,true);
  port.client={index:client.index,request:async()=>{throw Object.assign(Error(),{httpStatus:404});}};assert.equal(await port.search({scope,q:'Шев',kind:'street',limit:50}),null);assert.equal((await c.query('select svitlo_search.dictionary_state($1) value',[scope])).rows[0].value.ready,false);
  await c.exec('set role svitlo_stage_worker');const job=(await c.query('select svitlo_search.dictionary_claim() value')).rows[0].value;await c.exec('reset role');await c.query("update svitlo_search.dictionaries set token=gen_random_uuid() where scope=$1",[scope]);assert.equal((await c.query('select svitlo_search.dictionary_finish($1,$2,$3) value',[scope,job.token,job.revision])).rows[0].value,false);
 }finally{await c.close();}
});
