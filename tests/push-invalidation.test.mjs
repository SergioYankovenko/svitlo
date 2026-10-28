import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
test('SW invalidation survives closed windows and shell upgrade; duplicate pushes are bounded and never fetch',async()=>{
  const stores=new Map(),handlers={},messages=[];let shown=0,fetches=0;
  const caches={async open(name){if(!stores.has(name))stores.set(name,new Map());const m=stores.get(name);return {
    match:async key=>m.get(String(key))?.clone(),put:async(key,value)=>m.set(String(key),value.clone()),addAll:async()=>{}};},
    keys:async()=>[...stores.keys()],delete:async k=>stores.delete(k)};
  let windows=[];
  const self={location:{href:'https://example.com/svitlo/app/sw.js'},addEventListener:(k,fn)=>handlers[k]=fn,
    clients:{matchAll:async()=>windows,claim:async()=>{}},registration:{showNotification:async()=>shown++}};
  vm.runInNewContext(await readFile(new URL('../app/sw.js',import.meta.url),'utf8'),{self,caches,URL,Response,Request,fetch:async()=>fetches++});
  const push=async tag=>{let pending;handlers.push({data:{json:()=>({tag,profile:'12345678-1234-1234-1234-123456789abc',date:'2026-10-28'})},waitUntil:p=>pending=p});await pending;};
  await push('first');
  const cache=await caches.open('svitlo-events-v1'),key='https://example.com/svitlo/app/push-invalid/12345678-1234-1234-1234-123456789abc.json';
  assert.equal((await (await cache.match(key)).json()).token,'first');
  windows=[{postMessage:m=>messages.push(m)}];
  await Promise.all([push('second'),push('third'),push('second')]);
  assert.equal(messages.length,2);assert.equal((await(await cache.match(key)).json()).token,'third');
  await caches.open('svitlo-pwa-old');let activation;handlers.activate({waitUntil:p=>activation=p});await activation;
  assert(stores.has('svitlo-events-v1'));assert(!stores.has('svitlo-pwa-old'));
  assert.equal(fetches,0);assert.equal(shown,4,'notification handling remains independent');
});
