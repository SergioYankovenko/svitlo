import {appStorage,safeStorage} from './storage.js';
// HttpOnly cookie is the credential. Stored owner/CSRF metadata permits offline cache display only.
export const SESSION_CHECK_KEY='svitlo-session-check-v1';
const valid=(s,now)=>/^[a-f0-9-]{36}$/.test(s?.user?.id)&&/^[a-f0-9]{64}$/.test(s.csrf_token||'')&&s.access_token===s.csrf_token&&Number.isFinite(s.expires_at)&&s.expires_at*1000>now;
export function vpsClient({storage=appStorage,fetcher=fetch,now=()=>Date.now(),locks=globalThis.navigator?.locks}={}){
  storage=safeStorage(storage);
  const listeners=new Set();let current=null,pending=null,generation=0,retryAt=0;
  const read=key=>{try{return JSON.parse(storage.getItem(key));}catch{return null;}};
  const store=(key,value)=>{try{if(value===null)storage.removeItem(key);else storage.setItem(key,JSON.stringify(value));}catch{/* Per-tab state still permits offline display. */}};
  const stored=()=>{const s=read('svitlo-auth');return valid(s,now())?s:null;};
  current=stored();
  const remember=value=>{current=value;store('svitlo-auth',value);};
  // Share a short freshness receipt, never a credential. Every private server call
  // still verifies its HttpOnly cookie, CSRF token and owner through PostgreSQL.
  const ttl=s=>240000+parseInt(s.user.id.replaceAll('-','').slice(0,4),16)%60001;
  const fresh=()=>{
    current=stored();const r=read(SESSION_CHECK_KEY),t=now();
    return !!current&&r?.version===1&&r.owner===current.user.id&&r.csrf===current.csrf_token&&r.expires===current.expires_at&&Number.isFinite(r.at)&&r.at<=t&&t-r.at<ttl(current);
  };
  const invalidate=()=>{generation++;pending=null;retryAt=0;store(SESSION_CHECK_KEY,null);};
  const call=async(method)=>{
    const stamp=generation,before=read('svitlo-auth');
    let r;try{r=await fetcher('/api/session',{method,credentials:'same-origin',cache:'no-store',
      headers:method==='GET'?{}:{'Content-Type':'application/json',...(current?{'X-Svitlo-CSRF':current.csrf_token}:{})},
      ...(method==='POST'?{body:'{}'}:{}),signal:AbortSignal.timeout(12000)});}catch(error){
      if(stamp!==generation)throw Error('Стан підключення змінився. Повторіть спробу.');
      current=stored();
      if(method==='GET'&&valid(current,now())){retryAt=now()+15000;return {data:{session:current},error:null};}throw error;
    }
    if(stamp!==generation)throw Error('Стан підключення змінився. Повторіть спробу.');
    if(method==='GET'&&(r.status===429||r.status>=500)){
      current=stored();const retry=r.headers?.get('Retry-After'),seconds=/^\d+$/.test(retry||'')?Number(retry):15;
      retryAt=now()+Math.max(1000,Math.min(60000,seconds*1000));
      if(valid(current,now()))return {data:{session:current},error:null};
    }
    if(!r.ok)throw Error('Не вдалося перевірити сесію');
    const data=await r.json();
    if(stamp!==generation)throw Error('Стан підключення змінився. Повторіть спробу.');
    if(method==='GET'&&JSON.stringify(before)!==JSON.stringify(read('svitlo-auth')))throw Error('Стан підключення змінився. Повторіть спробу.');
    if(method!=='DELETE'&&data.session!==null&&!valid(data.session,now()))throw Error('Некоректна відповідь перевірки сесії');
    remember(data.session||null);retryAt=0;
    store(SESSION_CHECK_KEY,current?{version:1,owner:current.user.id,csrf:current.csrf_token,expires:current.expires_at,at:now()}:null);
    return {data:{session:current},error:null};
  };
  const getSession=()=>{
    if(fresh()||valid(current,now())&&retryAt>now())return Promise.resolve({data:{session:current},error:null});
    if(pending)return pending;
    const stamp=generation,load=()=>{if(stamp!==generation)throw Error('Стан підключення змінився');if(fresh())return {data:{session:current},error:null};return call('GET');};
    const task=locks?locks.request('svitlo-session-check',{signal:AbortSignal.timeout(12000)},load):Promise.resolve().then(load);
    pending=Promise.resolve(task).finally(()=>{if(pending===job)pending=null;});const job=pending;return job;
  };
  return {auth:{getSession,invalidateSession:invalidate,signInAnonymously:async()=>{invalidate();const r=await call('POST');for(const f of listeners)queueMicrotask(()=>f('SIGNED_IN',current));return r;},
    signOut:async()=>{invalidate();await call('GET');await call('DELETE');for(const f of listeners)queueMicrotask(()=>f('SIGNED_OUT',null));},
    onAuthStateChange:f=>{listeners.add(f);return {data:{subscription:{unsubscribe:()=>listeners.delete(f)}}};}}};
}
