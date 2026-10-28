const CACHE = "svitlo-pwa-65cd22472e16",
  ROOT = new URL("./", self.location.href);
// Build writes the complete hashed app-shell list here, including the bundled client library.
const SHELL = ["./","./api.js","./boot-theme.js","./config.js","./icons/apple-touch-icon.png","./icons/icon-192.png","./icons/icon-512.png","./icons/icon.svg","./icons/maskable-512.png","./index.html","./lib/cache-data.js","./lib/day-transition.js","./lib/dictionary-cache.js","./lib/icons.js","./lib/layout.js","./lib/lifecycle.js","./lib/navigation.js","./lib/notifications.js","./lib/parsers.js","./lib/patch-ui.js","./lib/pickers.js","./lib/schedule.js","./lib/session.js","./lib/storage.js","./lib/sync-client.js","./lib/tiles.js","./lib/time.js","./main.js","./manifest.webmanifest","./push-check.html","./push-check.js","./style.css","./vendor/supabase.js"];
const HASHES = {"./api.js":"cc1c3e52bb74805ff969e308c0642a153e2e0218b882bcf31c918f6bbc4df0e4","./boot-theme.js":"c8ebab78216d9f03d9e9e7454316a8eff2b0bc6dd8a56debe7a0d86104d9c52f","./config.js":"941eb1ba7b5c3469165ad0bdc51b2a640d439449b1d50d2e1418d88fdae609d9","./icons/apple-touch-icon.png":"434b4e073c441a3e16cff3220a238d9621461753691426c166cd397038b39c5e","./icons/icon-192.png":"227f11ab001993045fff31d282f2dfe3769da1e409b8c7028e319af830f7064f","./icons/icon-512.png":"db97fde6c9d4ed28c689dc3d21eb0352b5ff253c3ac19a6ac8ef7bf9c580a5e3","./icons/icon.svg":"23f931fdaa37ecc890989c983fd8f3118dd2299a038771845a90a67b16ff9446","./icons/maskable-512.png":"db97fde6c9d4ed28c689dc3d21eb0352b5ff253c3ac19a6ac8ef7bf9c580a5e3","./index.html":"0e185a422fa612a2bb11614c779968e960c2f942274176bfb067cf159fed93ac","./lib/cache-data.js":"0805404e786c3a4ea2c2f7a6148ffe7587ba7a7df6f036522cab1cf04bebb63b","./lib/day-transition.js":"2683afd046d5e9fdad2e857d7bc15a371a4453f82d67c7750fdb2c1d3901ea9a","./lib/dictionary-cache.js":"174017f51f9825d17f55f232d03adc4e911015826eb7702e66b5cf1605c9cf9f","./lib/icons.js":"33b47a5ea74b8f12559253d5d76d81e66453766ced7b86ba8943ba88a65961bf","./lib/layout.js":"2245350046bdc27d26bf96dd078b6b0d1f46d502f6ee325ec4a6ee562075dae1","./lib/lifecycle.js":"0655addd4d32d934ea22d81f9ad0fe850b3b188396f7f7fae5da6b826d8b11fd","./lib/navigation.js":"577d061d154c2259e67e70bc85ecf16ee4a212ace017fe93ddf0e1604a9c34eb","./lib/notifications.js":"350aa91311b2b028e0636e8c28a07be849bff8298a0de60a0261d423714e8493","./lib/parsers.js":"aa0bd89b81c0d159247776efffd0689583298ce586e3cf9ae7d61ebc91b042db","./lib/patch-ui.js":"2dad9b4c9e1bb8824b63138dc45b927c8bd228d9b54dbbefe7f2ffacfb5a94ab","./lib/pickers.js":"0ae5041c86bc9ea2fa40301eb9ece7e78c3515d4226b2d5202b0fffa1aa6c9b5","./lib/schedule.js":"4c923f6434f8ddfe67c441c9a45af9a7d4b20303a0a2f3fa85c3d1c07659298a","./lib/session.js":"1425c15a562966123b11919a0d9e80866d588b3df89eba60f349cd33e78243d2","./lib/storage.js":"e46d44cf90ab3af2d1478b0cc162bfcf66f3b06fea0eeb97bbe6ce7cabd13202","./lib/sync-client.js":"68d65d42672cc2f3813e0bdd82e67cbf4e571106a51e22acf081662ae67d9c65","./lib/tiles.js":"8ddb3a01447732eb0aada57b93cd5b4c49e22d1ec2d5df67636fe348655e9ac9","./lib/time.js":"832e5d6f5e1c32977065e8d83cd5bb2d87c59af1db3d12677429a1ac49a818e1","./main.js":"bca96a164119005e01bdc82e4a6ab01e8e4174fe6453dd68761fb668126bac04","./manifest.webmanifest":"d274f1b1c5debd1dabdf1668b02346d5f24cbe8d47853f6d29ad60031ab3697a","./push-check.html":"b3dbaf592870d406fae90fe51105685b1c50fac93d962f738bd912abbbf08e67","./push-check.js":"e564630e4c5c1e5dcf13718c45c3786bcdac69447b9bd41291e9368319dd3650","./style.css":"9234cd17495b89b9d7a8be4ae0052d2391653c88d466cf33b1462e90bba75f0b","./vendor/supabase.js":"e8e0a9921fa6ea82626f11c92b0d90bde6a3d017d70a1516a8b17b07cd134b39"};
function validDate(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const [y,m,d]=value.split('-').map(Number),date=new Date(0);date.setUTCFullYear(y,m-1,d);
  return y>0&&date.getUTCFullYear()===y&&date.getUTCMonth()===m-1&&date.getUTCDate()===d;
}
const validProfile=id=>typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
async function verifyShell(response,url){
  if(!response?.ok)throw Error('unavailable');
  const path=new URL(url).pathname.slice(ROOT.pathname.length),expected=HASHES['./'+(path||'index.html')];
  if(expected){
    const bytes=await response.clone().arrayBuffer(),digest=await crypto.subtle.digest('SHA-256',bytes);
    if([...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('')!==expected)throw Error('version');
  }
  return response;
}
async function shellResponse(url,request){
  try{
    const cached=await (await caches.open(CACHE)).match(url);
    if(cached?.ok)return cached;
  }catch{/* Storage failure still permits a bounded verified network attempt. */}
  const controller=new AbortController();let timer;
  try{
    const response=await Promise.race([fetch(new Request(request,{signal:controller.signal,cache:'no-store'})),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('timeout'));},5000);})]);
    return await verifyShell(response,url);
  }catch{return new Response('Світло тимчасово недоступне. Перевірте підключення та відкрийте застосунок знову.',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}});}
  finally{clearTimeout(timer);}
}
self.addEventListener("install", (event) =>
  event.waitUntil(
    caches
      .open(CACHE)
      .then(async c=>{
        await c.addAll(SHELL.map(p=>new Request(new URL(p,ROOT),{cache:'reload'})));
        // A partially propagated release must never replace the working shell.
        for(const path of SHELL){const url=new URL(path,ROOT).href;await verifyShell(await c.match(url),url);}
      }),
  ),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("svitlo-pwa-") && k !== CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  ),
);
self.addEventListener("fetch", (event) => {
  const r = event.request,
    u = new URL(r.url);
  if (
    r.method !== "GET" ||
    u.origin !== ROOT.origin ||
    !u.pathname.startsWith(ROOT.pathname)
  )
    return;
  const canonical=new URL(u);canonical.search='';canonical.hash='';
  if(canonical.href===ROOT.href)canonical.pathname+='index.html';
  const known=SHELL.some(p=>new URL(p,ROOT).href===canonical.href);
  if(known)event.respondWith(shellResponse(canonical.href,new Request(canonical.href,r.mode==='navigate'?{}:r)));
});
self.addEventListener('message',event=>{
  if(event.data?.type==='svitlo-shell-version')event.ports?.[0]?.postMessage({cache:CACHE});
});
async function recordPush(stage, error = "") {
  try {
    const cache = await caches.open(CACHE);
    await cache.put(
      new URL("push-receipt.json", ROOT).href,
      Response.json({ at: Date.now(), stage, error }),
    );
  } catch {
    /* Local diagnostics must not prevent notification delivery. */
  }
}
let invalidationQueue=Promise.resolve();
self.addEventListener("push", (event) =>
  event.waitUntil(
    (async () => {
      await recordPush("received");
      let p = {};
      try {
        p = event.data?.json() || {};
      } catch {}
      if(validProfile(p.profile)) {
        try {
          invalidationQueue=invalidationQueue.catch(()=>{}).then(async()=>{
            const c=await caches.open('svitlo-events-v1'),url=new URL(`push-invalid/${p.profile}.json`,ROOT).href;
            const token=String(p.tag||'svitlo').slice(0,160),old=await c.match(url),record=old?await old.json():{};
            if(record.seen?.includes(token))return;
            await c.put(url,Response.json({token,seen:[...(record.seen||[]),token].slice(-64)}));
            const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
            for(const window of windows)window.postMessage({type:'svitlo-invalidated',profile:p.profile});
          });
          await invalidationQueue;
        } catch { /* Notification delivery remains independent of local storage. */ }
      }
      try {
        await self.registration.showNotification(
          String(p.title || "Світло").slice(0, 160),
          {
            body: String(p.body || "З’явилося оновлення графіка.").slice(
              0,
              300,
            ),
            icon: new URL("icons/icon-192.png", ROOT).href,
            badge: new URL("icons/icon-192.png", ROOT).href,
            tag: String(p.tag || "svitlo").slice(0, 160),
            data: {
              date: validDate(p.date) ? p.date : null,
              profile: validProfile(p.profile) ? p.profile : null,
            },
          },
        );
        await recordPush("created");
      } catch (error) {
        await recordPush("failed", String(error.name));
        throw error;
      }
    })(),
  ),
);
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const url = new URL(ROOT),
        d = event.notification.data || {};
      if (validDate(d.date)) url.searchParams.set("date", d.date);
      if (validProfile(d.profile)) url.searchParams.set("profile", d.profile);
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const existing = windows.find(
        (c) =>
          new URL(c.url).origin === ROOT.origin &&
          new URL(c.url).pathname.startsWith(ROOT.pathname),
      );
      if (existing) {
        await existing.navigate(url.href);
        await existing.focus();
      } else await self.clients.openWindow(url.href);
    })(),
  );
});
