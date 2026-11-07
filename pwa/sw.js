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
  // Fetch caching stores the exact shell only. Modern installation proofs live
  // in a separate owner-bound store, never in the public shell cache.
  const path='./'+url.pathname.slice(scope.pathname.length);
  // HTML and assets belong to one verified release. A new worker replaces the whole shell.
  if(request.mode==='navigate'){event.respondWith((async()=>{const cached=await (await caches.open(VERSION)).match(new URL('./',scope).href);return cached||fetch(request);})());return;}
  if(!Object.hasOwn(HASHES,path))return;
  event.respondWith((async()=>{const cache=await caches.open(VERSION);return await cache.match(new URL(path,scope).href)||verified(new URL(path,scope).href);})());
});
const validModernId=s=>/^[a-f0-9-]{36}$/i.test(s||'');
async function modernNotification(packet){
  if(packet.schemaVersion!==1||!validModernId(packet.intentId)||Date.parse(packet.expiresAt)<=Date.now())return;
  const stateCache=await caches.open('svitlo-installations-v1'),saved=await stateCache.match(new URL('push-installation.json',scope).href);if(!saved)return;const i=await saved.json();if(!i.ready||!i.credential)return;
  const sessionResponse=await fetch(new URL('/api/session',scope),{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(5000)});if(!sessionResponse.ok)return;const {session}=await sessionResponse.json();if(session?.user?.id!==i.owner)return;
  async function receipt(state){const response=await fetch(new URL('/api/v1/notifications',scope),{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','X-Svitlo-CSRF':session.csrf_token},body:JSON.stringify({schemaVersion:1,action:'receipt',installationId:i.installationId,credential:i.credential,intentId:packet.intentId,state}),signal:AbortSignal.timeout(8000)});if(!response.ok)throw Error('notification_validation_failed');return response.json();}
  const verified=await receipt('received');if(!verified.displayAllowed)return;const p=verified.payload;if(Date.parse(p.expiresAt)<=Date.now()||!validModernId(p.profileId))return;
  const seen=new URL('seen/'+p.intentId+'.json',scope).href;if(await stateCache.match(seen))return;
  await self.registration.showNotification(p.title,{body:p.body,tag:'plan:'+p.intentId,renotify:false,icon:new URL('assets/prototype-icon-192.png',scope).href,data:{profile:p.profileId}});
  await stateCache.put(seen,Response.json({expiresAt:p.expiresAt}));const keys=await stateCache.keys();for(const key of keys){if(!key.url.includes('/seen/'))continue;const value=await (await stateCache.match(key)).json();if(Date.parse(value.expiresAt)<Date.now()-86400000)await stateCache.delete(key);}
  await receipt('displayed');
}
self.addEventListener('push',event=>event.waitUntil((async()=>{
  let data;try{data=event.data?.json();}catch{return;}
  if(data?.intentId){try{await modernNotification(data);}catch{}return;}
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
