import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto,createHash} from 'node:crypto';
const original=await readFile(new URL('../pwa/sw.js',import.meta.url),'utf8');
function fixture(tamper=false){
 const body='complete shell',digest=createHash('sha256').update(body).digest('hex'),handlers={},stores=new Map([['svitlo-stage-v2-old',new Map([['https://qa.test/app/',new Response('old shell')]])]]);let skip=0,claim=0;
 const caches={open:async key=>{if(!stores.has(key))stores.set(key,new Map());const c=stores.get(key);return {put:async(k,v)=>c.set(k,v),match:async k=>c.get(k)};},delete:async key=>stores.delete(key),keys:async()=>[...stores.keys()]};
 const self={location:{href:'https://qa.test/app/sw.js'},addEventListener:(name,fn)=>handlers[name]=fn,skipWaiting:async()=>skip++,clients:{claim:async()=>claim++}};
 const source=original.replace('const SHELL = [];','const SHELL = ["./"];').replace('const HASHES = {};',`const HASHES = {"./index.html":"${digest}"};`);
 vm.runInNewContext(source,{self,caches,fetch:async()=>new Response(tamper?'interrupted transfer':body),Request,URL,crypto:webcrypto,Uint8Array});
 const run=async name=>{let pending;handlers[name]({waitUntil:p=>pending=p});await pending;};return {stores,handlers,run,counts:()=>({skip,claim})};
}
test('complete replacement shell is verified before worker takeover and previous cache cleanup',async()=>{
 const f=fixture();await f.run('install');assert.equal(f.stores.has('svitlo-stage-v2-old'),true);assert.equal(f.counts().skip,1);
 await f.run('activate');assert.equal(f.stores.has('svitlo-stage-v2-old'),false);assert.equal(f.counts().claim,1);
});
test('interrupted or mixed-version install cannot replace or delete the usable previous shell',async()=>{
 const f=fixture(true);await assert.rejects(()=>f.run('install'),/integrity mismatch/);assert.equal(f.counts().skip,0);assert.equal(f.stores.has('svitlo-stage-v2-old'),true);assert.equal(f.stores.has('svitlo-stage-v2-development'),false);
});
test('private API and mutations stay outside service-worker shell caching',()=>{
 const f=fixture();for(const [url,method] of [['https://qa.test/api','GET'],['https://qa.test/app/private','POST'],['https://qa.test/api/session','GET']]){
  let intercepted=false;f.handlers.fetch({request:new Request(url,{method}),respondWith:()=>intercepted=true});assert.equal(intercepted,false);
 }
});
