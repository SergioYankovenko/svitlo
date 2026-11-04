import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../pwa/sw.js',import.meta.url),'utf8');
function worker({fail=false}={}){
 const handlers={},calls=[],entries=new Map(),cache={match:async k=>entries.get(k),put:async(k,v)=>entries.set(k,v)};
 const self={location:{href:'https://pilot.invalid/app/sw.js'},skipWaiting:async()=>calls.push('skip'),addEventListener:(k,f)=>handlers[k]=f,
 registration:{showNotification:async(...v)=>calls.push(v)},clients:{claim:async()=>{},matchAll:async()=>[],openWindow:async url=>calls.push(url)}};
 const code=source.replace('const SHELL = [];',"const SHELL = ['./','./app.js'];");
 vm.runInNewContext(code,{self,URL,Request,Response,crypto:globalThis.crypto,fetch:async()=>{if(fail)throw Error('offline');return new Response('ok');},caches:{open:async()=>cache,keys:async()=>['unrelated-cache','svitlo-stage-v2-old'],delete:async k=>calls.push('delete:'+k)}});
 return {handlers,calls,entries};
}
async function event(handler,data={}){let p;handler({...data,waitUntil:v=>p=v,respondWith:v=>p=v});return p;}
test('new pilot SW installs an atomic isolated shell and removes only its own old versions',async()=>{
 const w=worker();await event(w.handlers.install);assert.equal(w.entries.size,2);assert.ok(w.calls.includes('skip'));await event(w.handlers.activate);
 assert.ok(w.calls.includes('delete:svitlo-stage-v2-old'));assert.ok(!w.calls.includes('delete:unrelated-cache'));
 const failed=worker({fail:true});await assert.rejects(()=>event(failed.handlers.install));assert.ok(!failed.calls.includes('skip'));assert.ok(failed.calls.includes('delete:svitlo-stage-v2-development'));
});
test('new pilot SW excludes all private APIs and keeps offline navigation in the verified shell',async()=>{
 const w=worker();await event(w.handlers.install);
 assert.equal(await event(w.handlers.fetch,{request:{method:'GET',url:'https://pilot.invalid/api/v1/sensors'}}),undefined);
 const r=await event(w.handlers.fetch,{request:{method:'GET',url:'https://pilot.invalid/app/?profile=x',mode:'navigate'}});assert.equal(await r.text(),'ok');
});
test('new pilot push uses bounded plain text and safe owned-app click parameters',async()=>{
 const w=worker(),profile='11111111-1111-4111-8111-111111111111';
 await event(w.handlers.push,{data:{json:()=>({title:'Світло',body:'Тест',profile,date:'2026-11-04',url:'https://evil.invalid'})}});
 assert.equal(w.calls[0][1].data.profile,profile);assert.equal(w.calls[0][1].data.url,undefined);
 await event(w.handlers.notificationclick,{notification:{close(){},data:{profile,date:'2026-11-04',url:'https://evil.invalid'}}});
 const url=new URL(w.calls[1]);assert.equal(url.origin,'https://pilot.invalid');assert.equal(url.pathname,'/app/');assert.equal(url.searchParams.get('profile'),profile);
});
