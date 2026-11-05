import {createBackgroundAddresses} from './core/lib/background-addresses.js';
import {subscribeWithTimeout} from './live-push.js';
import {rememberReloadView,takeReloadView} from './reload-state.js';
import {identity,ensureIdentity,request,universalRequest,sensorRequest,onIdentityChange} from './core/api.js';
import {scheduleFor,contextFor,profileView,labels,officialSource,refreshDeadline,planView,summaryVisible,canSharePlan,planClock} from './live-model.js';
import {dayKey,clock,stamp} from './core/lib/time.js';
import {sensorSignalView} from './core/lib/map-sensor.js';
import {messageTitle} from './core/lib/notifications.js';
import {visibleMessages} from './live-messages.js';
import {sensorConnectError} from './core/lib/sensor-errors.js';
const KEY='svitlo.pwa.v2.cache',MAX_CACHE=1500000;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeRead=()=>{try {const raw=localStorage.getItem(KEY);if(!raw||raw.length>MAX_CACHE)return null;const v=JSON.parse(raw);return v.version===1&&typeof v.owner==='string'&&Array.isArray(v.profiles)&&v.profiles.length<=10&&v.profiles.every(p=>p&&typeof p.id==='string'&&p.address&&typeof p.address==='object'&&!Array.isArray(p.address)&&p.snapshot&&typeof p.snapshot==='object')&&v.weather&&typeof v.weather==='object'&&!Array.isArray(v.weather)?v:null;}catch{return null;}};
const weatherType=code=>code===0?['☀️','Ясно']:code<3?['🌤️','Мінлива хмарність']:code===3?['☁️','Хмарно']:code<50?['🌫️','Туман']:code<70?['🌧️','Дощ']:code<80?['🌨️','Сніг']:code<95?['🌦️','Злива']:['⛈️','Гроза'];
export async function createLive(){
  let old=safeRead(),owner=old?.owner||null,profiles=old?.profiles||[],weather=old?.weather||{},active=old?.active||null;
  let epoch=0,dataRevision=0,pending=null,pendingProfile=null,syncQueued=false,lastSync=0,ui=null,offline=false,pushSubscribed=false,vapid='',sensors=[],sensorFetched=0,sensorPending=null,pushBinding=null,pushRestore=null,pushRequest=0,pushPending=null,identityConfirmed=false,syncFailures=0,retryAfter=0;
  const PUSH_CHOICE='svitlo.pwa.v2.push-choice';
  const pushChoice=()=>{try{return JSON.parse(localStorage.getItem(PUSH_CHOICE)||'null');}catch{return null;}};
  const savePushChoice=(enabled,subject=owner)=>{try{localStorage.setItem(PUSH_CHOICE,JSON.stringify({owner:subject,enabled}));}catch{}};
  const preferenceJobs=new Map(),preferenceRevisions=new Map();
  let cap=null;const listeners=new Set();
  const emit=()=>listeners.forEach(f=>f());
  function persist(){try{const raw=JSON.stringify({version:1,owner,profiles,weather,active});if(owner&&raw.length<=MAX_CACHE)localStorage.setItem(KEY,raw);else localStorage.removeItem(KEY);}catch{/* Storage never blocks a fetched schedule. */}}
  const current=id=>profiles.find(p=>p.id===(id||active));
  function clear(){identityConfirmed=true;savePushChoice(false,null);epoch++;pushRequest++;pushPending=null;pushSubscribed=false;pushBinding=null;profiles=[];weather={};sensors=[];active=null;owner=null;try{localStorage.removeItem(KEY);}catch{}emit();}
  async function session(explicit=false){
    const who=explicit?await ensureIdentity():await identity();
    identityConfirmed=true;
    if(who!==owner){epoch++;profiles=[];weather={};sensors=[];active=null;owner=who;persist();}
    return who;
  }
  // Read only. A failed session refresh never creates a new anonymous owner.
  try{await session(false);}catch{offline=true;}
  async function sync(reason='visible'){
    if(pending){if(pendingProfile!==active)syncQueued=true;return pending;}
    pendingProfile=active;
    pending=(async()=>{
      const who=await session(false);if(!who){emit();return;}
      const generation=epoch,revision=dataRevision,id=active;
      const result=await request('sync',{...(id?{id}:{}),reason},{owner:who});
      if(generation!==epoch||who!==owner||revision!==dataRevision)return;
      profiles=result.profiles||[];const linked=new URL(location.href).searchParams.get('profile');if(linked&&profiles.some(p=>p.id===linked)){active=linked;if(ui){ui.active=linked;const date=new URL(location.href).searchParams.get('date');if(/^\d{4}-\d\d-\d\d$/.test(date||''))ui.viewDate=date;}const link=new URL(location.href);link.searchParams.delete('profile');link.searchParams.delete('date');history.replaceState(null,'',link);}
      active=profiles.some(p=>p.id===active)?active:result.active||profiles[0]?.id||null;
      vapid=result.vapid||'';
      restorePush().catch(()=>{});
      const weatherId=result.active||id,weatherProfile=current(weatherId);
      if(result.weather&&weatherProfile&&result.weather.city===profileView(weatherProfile).city)weather[weatherId]=result.weather;
      lastSync=Date.now();syncFailures=0;retryAfter=0;offline=false;persist();emit();
    })().catch(error=>{offline=true;retryAfter=Date.now()+Math.min(900000,30000*2**Math.min(syncFailures++,5));if(error.status===401)clear();emit();throw error;}).finally(()=>{pending=null;pendingProfile=null;if(syncQueued){syncQueued=false;queueMicrotask(()=>sync().catch(()=>{}));}});
    return pending;
  }
  const backgroundAddresses=createBackgroundAddresses((path,body,signal)=>universalRequest(path,body,{signal}));
  async function search(kind,flow,q,signal,cursor=null){
    if(!['city','street','house'].includes(kind)||kind==='city'&&q.trim().length<2||kind==='street'&&!flow.city?.id||kind==='house'&&!flow.street?.id)return [];
    if(kind!=='city'&&flow.geography?.routes?.length){const result=await backgroundAddresses.search(kind==='street'?'streets':'houses',flow,q,signal,cursor);return Object.assign(result.items.map(x=>({...x,name:x.label,context:x.districtVerified?x.district:''})),{nextCursor:result.nextCursor||null});}
    const routed=kind!=='city'&&flow.geography?.route&&flow.geography?.settlement;
    const result=await universalRequest(routed?'settlement-search':'search',{kind:{city:'cities',street:'streets',house:'houses'}[kind],q:q.slice(0,120),limit:50,
      ...(routed?{routeId:flow.geography.route.routeId,settlementCode:flow.geography.settlement.code}:{}),
      ...(kind==='street'?{parentId:flow.city.id}:kind==='house'?{parentId:flow.street.id}:{}),...(cursor?{cursor}:{})},{signal});
    // Render a page immediately, then continue on scroll. Never hide a large city's list behind a page budget.
    return Object.assign(result.items.map(x=>({...x,name:x.label,context:[x.region?.label,x.district?.label,x.context].filter(Boolean).join(' · ')})),{nextCursor:result.nextCursor||null});
  }
  async function enroll(flow,signal){
    const choice=flow.geography?.routes?.length?await backgroundAddresses.resolve(flow,signal):{resolved:await universalRequest('resolve',{addressId:flow.house.id,...(flow.lineId?{lineId:flow.lineId}:{})},{signal})};
    if(choice.requiresLine)return choice;const {resolved}=choice;signal?.throwIfAborted();
    if(['disabled','unsupported'].includes(resolved.operator?.supportState))throw Error('Джерело цього регіону недоступне');
    const lines=resolved.resolution?.lines||[],lineId=resolved.selection?.lineId||null;
    if(lines.length>1&&!lineId){if(flow.geography)return {requiresLine:true,lines};throw Error('Потрібен вибір лінії живлення');}
    const who=await session(true),generation=epoch;signal?.throwIfAborted();
    const result=await request('save',{address:{canonicalAddressId:resolved.address.id,lineId},name:flow.name||'',confirmed:true},{owner:who,signal});
    if(generation!==epoch||who!==owner)throw Error('Сеанс змінився. Спробуйте ще раз');
    dataRevision++;profiles=profiles.filter(p=>p.id!==result.profile.id);profiles.push(result.profile);active=result.profile.id;persist();
    emit();sync().catch(()=>{});return result.profile;
  }
  function adopt(state){
    ui=state;
    if(identityConfirmed&&state.liveOwner&&state.liveOwner!==owner){delete state.onboardingDraft;state.onboardingSeen=false;state.sessionReset=true;}
    if(identityConfirmed)state.liveOwner=owner;state.addresses=profiles.map(profileView);if(!profiles.some(p=>p.id===state.active))state.active=active||profiles[0]?.id||null;
    if(state.active!==active){active=state.active;persist();lastSync=0;queueMicrotask(()=>sync().catch(()=>{}));}
    const p=current(),pref=p?.preferences;
    if(pref) {state.switches={before:!!pref.reminder,restore:!!pref.restoration,tomorrow:!!(pref.publication??pref.schedule),changes:!!(pref.change??pref.schedule),emergency:!!pref.emergency,versions:false};state.reminder=pref.lead||30;}
    state.pwaPermission=globalThis.Notification?.permission||'default';state.permission=state.pwaPermission==='granted'&&pushSubscribed;state.pushSubscribed=pushSubscribed;
    state.pushSupport='Notification' in globalThis&&'PushManager' in globalThis&&'serviceWorker' in navigator?'supported':'unsupported';
    state.pwaInstalled=matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
    state.pwaBrowser=/iPad|iPhone|iPod/.test(navigator.userAgent)?'ios':/; wv\)|FBAV|Instagram/.test(navigator.userAgent)?'embedded':'android';
    state.target='pwa';state.scenario='live';state.clockMode='live';
  }
  async function mutate(action,data){const who=await session(false);if(!who)throw Error('Сеанс завершився. Додайте адресу ще раз');const g=epoch;const r=await request(action,data,{owner:who});if(g!==epoch)throw Error('Сеанс змінився');return r;}
  async function remove(id){await mutate('delete',{id});dataRevision++;profiles=profiles.filter(p=>p.id!==id);if(active===id)active=profiles[0]?.id||null;delete weather[id];sensors=[];persist();emit();}
  async function rename(id,name){const r=await mutate('rename',{id,name});dataRevision++;profiles=profiles.map(p=>p.id===id?r.profile:p);persist();emit();}
  async function preferences(state){const id=state.active;if(!id)return;const f=state.switches,patch={publication:f.tomorrow,change:f.changes,schedule:f.tomorrow||f.changes,reminder:f.before,restoration:f.restore,emergency:f.emergency,lead:state.reminder};
    const revision=(preferenceRevisions.get(id)||0)+1;preferenceRevisions.set(id,revision);
    const job=(preferenceJobs.get(id)||Promise.resolve()).catch(()=>{}).then(()=>mutate('preferences',{id,preferences:patch})).then(r=>{dataRevision++;if(preferenceRevisions.get(id)===revision){profiles=profiles.map(p=>p.id===id?r.profile:p);persist();}});
    preferenceJobs.set(id,job);return job;
  }
  function weatherHTML(e){const w=weather[active];if(!w||!Number.isFinite(w.temperature)||w.city!==profileView(current()||{}).city)return '';
    const [glyph,description]=weatherType(w.code),temp=t=>(t>0?'+':'')+Math.round(t)+'°';
    return `<section class="card outlined weather-card"><div class="muted weather-today" style="font-size:calc(12px * var(--scale))">СЬОГОДНІ</div><div class="weather-top"><div class="weather-temp">${temp(w.temperature)}</div><div><div class="weather-city">${e(profileView(current()).city)}</div><div class="weather-condition"><span class="weather-glyph" aria-hidden="true">${glyph}</span> ${description}</div></div></div><div class="weather-strip" aria-label="Погодинний прогноз">${(w.hours||[]).map(h=>`<div class="weather-hour"><span class="weather-clock">${clock(h.time)}</span><span class="weather-symbol weather-glyph" aria-hidden="true">${weatherType(h.code)[0]}</span><strong>${temp(h.temp)}</strong></div>`).join('')}</div><div class="attribution"><a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a> · <a href="https://www.geonames.org/" target="_blank" rel="noopener">GeoNames</a></div></section>`;
  }
  function messagesHTML(e){const p=current(),messages=visibleMessages(p?.messages||[]);return messages.map(m=>`<article class="card outlined notification-card schedule-message"><div class="notification-meta">Оновлено · ${e(m.publishedAt?stamp(m.publishedAt):'')}</div><div class="notification-title">${e(messageTitle(m)||m.title||'')}</div><div class="notification-body">${e(m.scope==='region'?'В області':p.snapshot?.queue?'Черга '+p.snapshot.queue:m.body||'')}</div><div class="actions"><button class="action" data-action="view-schedule">Переглянути графік</button><button class="action" data-action="source" data-source-url="${e(m.url||'')}">Джерело</button></div></article>`).join('');}
  async function refreshSensors(){if(sensorPending)return sensorPending;if(!owner)return[];const who=owner,g=epoch;return sensorPending=sensorRequest('list',{}, {owner:who}).then(r=>{if(g===epoch){sensors=r.sensors||[];sensorFetched=Date.now();emit();}return sensors;}).finally(()=>sensorPending=null);}
  async function restorePush(){
    if(pushRestore)return pushRestore;const choice=pushChoice();if(choice?.owner!==owner||choice?.enabled!==true)return;if(!owner||!vapid||globalThis.Notification?.permission!=='granted'||!navigator.serviceWorker)return;
    pushRestore=(async()=>{const generation=epoch,who=owner,id=active,registration=await navigator.serviceWorker.getRegistration();if(!registration?.active)return;const sub=await registration.pushManager.getSubscription();if(!sub)return;
      const bytes=sub.options?.applicationServerKey,actual=bytes?btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replaceAll('=',''):null;
      if(actual&&actual!==vapid){await sub.unsubscribe();pushSubscribed=false;return;}
      const key=[who,id,sub.endpoint].join('|');if(key!==pushBinding){await mutate('subscribe',{id,subscription:sub.toJSON()});if(generation!==epoch||id!==active)return;pushBinding=key;}
      pushSubscribed=true;emit();
    })().finally(()=>pushRestore=null);return pushRestore;
  }
  function enablePush(){
    if(pushPending)return pushPending;const g=++pushRequest;
    const job=(async()=>{
    if(!vapid)throw Error('Сервер сповіщень ще не підключений');
    if(!('Notification' in globalThis)||!('serviceWorker' in navigator))throw Error('Цей браузер не підтримує push-сповіщення');
    if(await Notification.requestPermission()!=='granted')return;
    const registration=await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('Не вдалося підключити сповіщення')),15000))]);
    let subscription=await registration.pushManager.getSubscription();
    if(subscription&&pushChoice()?.owner!==owner){await subscription.unsubscribe();subscription=null;}
    savePushChoice(true);
    if(!subscription){const raw=atob(vapid.replaceAll('-','+').replaceAll('_','/'));subscription=await subscribeWithTimeout(registration.pushManager,{userVisibleOnly:true,applicationServerKey:Uint8Array.from(raw,c=>c.charCodeAt(0))},{onLate:sub=>g===pushRequest?restorePush():sub.unsubscribe()});}
    if(g!==pushRequest){await subscription.unsubscribe();throw Error('Стан підключення змінився. Повторіть спробу.');}
    await mutate('subscribe',{id:active,subscription:subscription.toJSON()});pushBinding=[owner,active,subscription.endpoint].join('|');pushSubscribed=true;emit();
    })().finally(()=>{if(pushPending===job)pushPending=null;});pushPending=job;return job;
  }
  async function disablePush(){savePushChoice(false);pushRequest++;pushPending=null;const registration=await navigator.serviceWorker?.getRegistration(),subscription=await registration?.pushManager.getSubscription();if(subscription){if(owner)await mutate('unsubscribe',{endpoint:subscription.endpoint});await subscription.unsubscribe();}pushSubscribed=false;pushBinding=null;emit();}
  const api={adopt,enroll,search,geography:(route,data,signal)=>universalRequest(route,data,{signal}),sync,remove,rename,preferences,enablePush,disablePush,weatherHTML,messagesHTML,planView,summaryVisible,canSharePlan,planClock,label:k=>labels[k]||'',schedule:(date,id)=>scheduleFor(current(id),date||dayKey()),context:(date,id)=>contextFor(current(id),date||dayKey()),
    rememberView:view=>rememberReloadView(()=>sessionStorage,owner,view),takeView:()=>takeReloadView(()=>sessionStorage,owner),
    onChange:f=>{listeners.add(f);return()=>listeners.delete(f);},
    profile:current,profiles:()=>profiles,owner:()=>owner,sensors:()=>sensors,sensorFetched:()=>sensorFetched,signalView:sensorSignalView,refreshSensors,
    sensor:async(action,data,options={})=>{const who=await session(true);try{return await sensorRequest(action,data,{owner:who,...options});}catch(error){if(action==='connect_qr')error.message=sensorConnectError(error);throw error;}},
    capabilities:()=>cap,elapsedMinutes:()=>{const d=scheduleFor(current(),dayKey());return (Date.now()-d.from)/60000;},
    openSource(preferred){const url=officialSource(current(),preferred);if(url)window.open(url,'_blank','noopener');},
    async diagnostic(packet,signal){const who=await session(true);const response=await fetch('/api/session',{credentials:'same-origin',cache:'no-store',signal});const body=await response.json();if(body.session?.user?.id!==who)throw Error('Сеанс змінився');const r=await fetch('/api/v1/diagnostic-reports',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Svitlo-CSRF':body.session.csrf_token,'X-Svitlo-Diagnostic-Consent':packet.reportId},body:JSON.stringify(packet),signal});if(!r.ok)throw Error('Не вдалося надіслати звіт');return r.json();},
    start(){sync().catch(()=>{});universalRequest('capabilities').then(v=>cap=v).catch(()=>{});refreshSensors().catch(()=>{});
      const refresh=()=>{if(!document.hidden&&Date.now()>=retryAfter&&(!lastSync||Date.now()>=refreshDeadline(current(),lastSync)))sync().catch(()=>{});if(!document.hidden&&Date.now()-sensorFetched>=60000)refreshSensors().catch(()=>{});};
      setInterval(refresh,60000);document.addEventListener('visibilitychange',refresh);window.addEventListener('online',()=>sync().catch(()=>{}));
      // The notification already contains identity. Reading auth again here would recurse.
      onIdentityChange(({owner:next,changed})=>{if(changed&&next!==owner){clear();owner=next;}});
    },offline:()=>offline};
  return api;
}
