import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root='https://example.test/svitlo/app/';
async function worker({cached,network,source}={}){
 const handlers={},reads=[],requests=[],self={location:{href:root+'sw.js'},addEventListener:(n,fn)=>handlers[n]=fn,clients:{matchAll:async()=>[],openWindow:async url=>requests.push(url)}};
 const caches={open:async name=>({match:async url=>{reads.push({name,url});return cached?.(url);}})};
 vm.runInNewContext(source||await readFile('app/sw.js','utf8'),{self,caches,URL,Response,Request,AbortController,crypto:globalThis.crypto,Uint8Array,fetch:network||(()=>{throw Error('offline');}),setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,25)),clearTimeout});
 return {reads,requests,handlers,async get(path,mode='navigate'){let pending;handlers.fetch({request:{url:root+path,method:'GET',mode},respondWith:p=>pending=p});return pending;},async click(data){let pending;handlers.notificationclick({notification:{close(){},data},waitUntil:p=>pending=p});await pending;}};
}
test('installed current shell wins without waiting for stalled or HTTP503 network; diagnostics keeps its own page',async()=>{
 for(const network of [()=>new Promise(()=>{}),async()=>new Response('error',{status:503})]){
  const w=await worker({network,cached:async url=>new Response(url.endsWith('push-check.html')?'diagnostics':'shell')});
  assert.equal(await(await w.get('?profile=x')).text(),'shell');assert.equal(await(await w.get('push-check.html')).text(),'diagnostics');
  assert(w.reads.every(r=>r.name.startsWith('svitlo-pwa-')));
 }
});
test('network fallback is bounded and never promotes an HTTP503 or unrelated navigation to shell',async()=>{
 for(const network of [()=>new Promise(()=>{}),async()=>new Response('error',{status:503})]){
  const w=await worker({network});const response=await w.get('');assert.equal(response.status,503);
  assert.equal(await w.get('unknown-page.html'),undefined);
 }
});
test('missing current shell file accepts only the build hash, never a different release; SDK retry URLs map to same asset',async()=>{
 const body='correct release',digest=createHash('sha256').update(body).digest('hex');
 const source=(await readFile('app/sw.js','utf8')).replace(/const HASHES = \{[^;]*\};/,'const HASHES = '+JSON.stringify({'./index.html':digest})+';');
 for(const [text,status] of [[body,200],['newer release',503]]){
  const w=await worker({source,network:async()=>new Response(text)});assert.equal((await w.get('')).status,status);
 }
 const w=await worker({cached:async url=>new Response(url)});
 assert.equal(await(await w.get('vendor/supabase.js?svitlo-retry=1','cors')).text(),root+'vendor/supabase.js');
});
test('click route revalidates impossible calendar dates and malformed profile IDs',async()=>{
 const w=await worker();await w.click({date:'2026-02-30',profile:'-'.repeat(36)});assert.equal(w.requests[0],root);
 await w.click({date:'2028-02-29',profile:'12345678-1234-1234-1234-123456789abc'});assert(new URL(w.requests[1]).searchParams.has('date'));
});
