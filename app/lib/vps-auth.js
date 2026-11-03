import {appStorage} from './storage.js';
// HttpOnly cookie is the credential. Stored owner/CSRF metadata permits offline cache display only.
export function vpsClient({storage=appStorage,fetcher=fetch,now=()=>Date.now()}={}){
  const listeners=new Set();let current=null;
  try{const saved=JSON.parse(storage.getItem('svitlo-auth'));if(/^[a-f0-9-]{36}$/.test(saved?.user?.id)&&/^[a-f0-9]{64}$/.test(saved.csrf_token)&&saved.expires_at*1000>now())current=saved;}catch{}
  const remember=value=>{current=value;if(value)storage.setItem('svitlo-auth',JSON.stringify(value));else storage.removeItem('svitlo-auth');};
  const call=async(method)=>{
    let r;try{r=await fetcher('/api/session',{method,credentials:'same-origin',cache:'no-store',
      headers:method==='GET'?{}:{'Content-Type':'application/json',...(current?{'X-Svitlo-CSRF':current.csrf_token}:{})},
      ...(method==='POST'?{body:'{}'}:{}),signal:AbortSignal.timeout(12000)});}catch(error){
      if(method==='GET'&&current?.expires_at*1000>now())return {data:{session:current},error:null};throw error;
    }
    if(!r.ok)throw Error('Не вдалося перевірити сесію');
    const data=await r.json();remember(data.session||null);return {data:{session:current},error:null};
  };
  return {auth:{getSession:()=>call('GET'),signInAnonymously:async()=>{const r=await call('POST');for(const f of listeners)queueMicrotask(()=>f('SIGNED_IN',current));return r;},
    signOut:async()=>{await call('DELETE');for(const f of listeners)queueMicrotask(()=>f('SIGNED_OUT',null));},
    onAuthStateChange:f=>{listeners.add(f);return {data:{subscription:{unsubscribe:()=>listeners.delete(f)}}};}}};
}
