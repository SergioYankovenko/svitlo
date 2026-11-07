import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const id='12345678-1234-4234-8234-123456789abc',owner='12345678-1234-4234-8234-123456789abd';
async function fixture({sameOwner=true,allowed=true}={}){const handlers={},stores=new Map(),shown=[],receipts=[];
 const caches={open:async name=>{if(!stores.has(name))stores.set(name,new Map());const s=stores.get(name);return {put:async(k,v)=>s.set(typeof k==='string'?k:k.url,v.clone()),match:async k=>s.get(typeof k==='string'?k:k.url)?.clone(),keys:async()=>[...s.keys()].map(url=>({url})),delete:async k=>s.delete(typeof k==='string'?k:k.url)};},keys:async()=>[...stores.keys()]};
 const self={location:{href:'https://qa.test/app/sw.js'},addEventListener:(k,fn)=>handlers[k]=fn,registration:{showNotification:async(t,o)=>shown.push({title:t,...o})}};
 const payload={schemaVersion:1,intentId:id,profileId:id,title:'Світло',body:'Current server text',expiresAt:new Date(Date.now()+60000).toISOString()};
 const fetch=async(url,options)=>{if(String(url).endsWith('/api/session'))return Response.json({session:{user:{id:sameOwner?owner:id},csrf_token:'csrf'}});receipts.push(JSON.parse(options.body).state);return Response.json({displayAllowed:allowed,payload});};
 vm.runInNewContext(await readFile(new URL('../pwa/sw.js',import.meta.url),'utf8'),{self,caches,URL,Response,Request,fetch,AbortSignal,Date});
 await (await caches.open('svitlo-installations-v1')).put('https://qa.test/app/push-installation.json',Response.json({owner,installationId:id,credential:'installation-proof',ready:true}));
 const push=async p=>{let wait;handlers.push({data:{json:()=>p},waitUntil:p=>wait=p});await wait;};return {push,shown,receipts,payload};
}
test('modern push displays only current server-verified body, stable intent deduplicates after retry',async()=>{const f=await fixture();await f.push({...f.payload,body:'obsolete provider text'});await f.push(f.payload);assert.equal(f.shown.length,1);assert.equal(f.shown[0].body,'Current server text');assert.equal(f.shown[0].renotify,false);assert.deepEqual(f.receipts,['received','displayed','received']);});
test('old owner, obsolete plan and expired offline packet never display as current',async()=>{for(const options of [{sameOwner:false},{allowed:false}]){const f=await fixture(options);await f.push(f.payload);assert.equal(f.shown.length,0);}const f=await fixture();await f.push({...f.payload,expiresAt:new Date(Date.now()-1).toISOString()});assert.equal(f.shown.length,0);assert.equal(f.receipts.length,0);});
