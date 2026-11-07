import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {MeiliClient,publicDocument} from './meili.js';import {AddressSearch} from './service.js';
test('search client uses a fixed private origin, exact house filter and omits all private source properties',async()=>{
 const calls=[],id=randomUUID(),client=new MeiliClient({url:'http://127.0.0.1:7700',key:'x'.repeat(32),fetcher:async(url,options)=>{calls.push({url,...options});return new Response(JSON.stringify({hits:[{id,fingerprint:'a'.repeat(64)}]}));}});
 await client.search('svitlo_catalog_g_test0000',{kind:'address',parentId:randomUUID(),q:'10/1',limit:50});const sent=JSON.parse(calls[0].body);assert.equal(sent.q,'');assert.ok(sent.filter.includes('houseKey = "10/1"'));
 const document=publicDocument({id,kind:'address',parentId:randomUUID(),label:'10/1',owner:'private',source_ref:{account:'never-index'},allowed:true});assert.ok(!JSON.stringify(document).includes('private'));assert.ok(!JSON.stringify(document).includes('never-index'));
 for(const url of ['http://attacker.invalid','https://user:secret@example.com','file:///private','http://127.0.0.1:7700/other'])assert.throws(()=>new MeiliClient({url,key:'x'.repeat(32)}));
});
test('source-bound signed cursors reject tampering and another parent; legacy keyset cursors retain their path',()=>{
 const port=new AddressSearch({bridge:{},client:null,secret:'server'}),query={kind:'street',parentId:randomUUID(),q:'Шевченка'};
 const cursor=port.cursor({engine:'meili',...query,generation:'svitlo_catalog_g_test0000',offset:50});assert.equal(port.parse(cursor,query).offset,50);
 assert.throws(()=>port.parse(cursor,{...query,parentId:randomUUID()}),e=>e.code==='invalid_cursor');
 const bad=JSON.parse(Buffer.from(cursor,'base64url'));bad.offset=100000;assert.throws(()=>port.parse(Buffer.from(JSON.stringify(bad)).toString('base64url'),query));
 assert.equal(port.parse(Buffer.from(JSON.stringify({kind:'streets',id:randomUUID(),label:'old'})).toString('base64url'),query),null);
 assert.equal(port.parse(Buffer.from('null').toString('base64url'),query),null);
});
test('missing optional search engine preserves the bounded catalogue path',async()=>{
 const port=new AddressSearch({bridge:{query:()=>assert.fail('No index SQL needed without credentials')},client:null,secret:'server'});
 assert.equal(await port.search({kind:'street',parentId:randomUUID(),q:'name',limit:50}),null);
});
