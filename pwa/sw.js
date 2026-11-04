"use strict";
const VERSION="svitlo-stage-v2-development";
const SHELL = [];
const HASHES = {};
const scope=new URL('./',self.location.href);
async function verified(url){
  const response=await fetch(new Request(url,{credentials:'same-origin',cache:'reload'}));
  if(!response.ok||response.redirected)throw Error('Incomplete shell');
  const key='./'+new URL(url).pathname.slice(scope.pathname.length),expected=HASHES[key==='./'?'./index.html':key];
  if(expected){const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await response.clone().arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('');if(digest!==expected)throw Error('Shell integrity mismatch');}
  return response;
}
self.addEventListener('install',event=>event.waitUntil((async()=>{
  const cache=await caches.open(VERSION);
  try{for(const path of SHELL){const url=new URL(path,scope).href;await cache.put(url,await verified(url));}}
  catch(error){await caches.delete(VERSION);throw error;}
  await self.skipWaiting();
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const key of await caches.keys())if(key.startsWith('svitlo-stage-v2-')&&key!==VERSION)await caches.delete(key);await self.clients.claim();})()));
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==scope.origin||!url.pathname.startsWith(scope.pathname))return;
  // No private API responses or sensor proofs in CacheStorage. Exact shell only.
  const path='./'+url.pathname.slice(scope.pathname.length);
  // HTML and assets belong to one verified release. A new worker replaces the whole shell.
  if(request.mode==='navigate'){event.respondWith((async()=>{const cached=await (await caches.open(VERSION)).match(new URL('./',scope).href);return cached||fetch(request);})());return;}
  if(!Object.hasOwn(HASHES,path))return;
  event.respondWith((async()=>{const cache=await caches.open(VERSION);return await cache.match(new URL(path,scope).href)||verified(new URL(path,scope).href);})());
});
self.addEventListener('push',event=>event.waitUntil((async()=>{
  let data;try{data=event.data?.json();}catch{return;}
  if(!data||typeof data.title!=='string'||!data.title.trim())return;
  const profile=/^[a-f0-9-]{36}$/i.test(data.profile||'')?data.profile:null;
  const date=/^\d{4}-\d\d-\d\d$/.test(data.date||'')?data.date:null;
  await self.registration.showNotification(data.title.slice(0,160),{
    body:typeof data.body==='string'?data.body.slice(0,500):'',
    tag:typeof data.tag==='string'?data.tag.slice(0,160):'svitlo',
    icon:new URL('assets/prototype-icon-192.png',scope).href,
    data:{profile,date},
  });
})()));
self.addEventListener('notificationclick',event=>{
  event.notification.close();event.waitUntil((async()=>{
    const data=event.notification.data||{},url=new URL('./',scope);
    if(/^[a-f0-9-]{36}$/i.test(data.profile||''))url.searchParams.set('profile',data.profile);
    if(/^\d{4}-\d\d-\d\d$/.test(data.date||''))url.searchParams.set('date',data.date);
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    for(const client of windows){const current=new URL(client.url);if(current.origin===scope.origin&&current.pathname.startsWith(scope.pathname)){await client.navigate(url.href);await client.focus();return;}}
    await self.clients.openWindow(url.href);
  })());
});
