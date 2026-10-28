import config from "./config.js";
import {appStorage} from './lib/storage.js';
import {SessionController,RetryingLoader,bounded} from './lib/session.js';
const loader=new RetryingLoader({load:async (attempt,signal)=>{
  // A new URL is necessary: browsers cache failed module imports by URL.
  const url=new URL('./vendor/supabase.js'+(attempt?'?svitlo-retry='+attempt:''),import.meta.url);
  const {createClient}=await import(url.href);
  if(signal.aborted)throw Error('obsolete import');
  return createClient(config.supabaseUrl,config.publishableKey,{auth:{storageKey:'svitlo-auth',storage:appStorage,persistSession:true,autoRefreshToken:true}});
}});
const sessionController=new SessionController({client:()=>loader.get()});
let ending=Promise.resolve();
export const onIdentityChange=listener=>sessionController.subscribe(listener);
export async function identity() {
  if(config.local)return 'local-preview';
  if(!configured())return null;
  await ending;
  return sessionController.identity();
}
export async function ensureIdentity(){return config.local?'local-preview':(await sessionForRequest()).user.id;}
const sessionForRequest=async()=>{await ending;return sessionController.ensure();};
export const configured = () => !!config.apiUrl;
export async function request(action, data = {}, {signal,owner}={}) {
  if (!configured())
    throw Error("Сервер ще не підключений. Збережені графіки доступні офлайн.");
  const headers = { "Content-Type": "application/json" };
  if (!config.local) {
    await ending;
    const session=owner?await sessionController.read():await sessionForRequest();
    if(owner&&session?.user.id!==owner)throw Object.assign(Error('Операція вже не актуальна'),{stale:true});
    headers.apikey = config.publishableKey;
    headers.Authorization = "Bearer " + session.access_token;
  }
  const controller=new AbortController(),abort=()=>controller.abort();
  const timer=setTimeout(abort,120000);
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  try{return await post(config.apiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ action, ...data }),
    signal: controller.signal,
    cache: "no-store",
  });}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
export async function post(url, options, fetcher = fetch) {
  let r, payload;
  try {
    r = await fetcher(url, options);
    payload = await r.json();
  } catch {
    if(options.signal?.aborted)throw Object.assign(Error('Запит скасовано'),{name:'AbortError'});
    throw Error("Оновлення тимчасово недоступне. Спробуйте пізніше.");
  }
  if (!r.ok) {const error=Error(payload.error || "Перевірка тимчасово недоступна");error.status=r.status;throw error;}
  return payload;
}
export function forgetSession() {
  sessionController.forget();
  ending=ending.catch(()=>{}).then(async()=>{
    if (!config.local && config.supabaseUrl)try{const c=await loader.get();await bounded(c.auth.signOut({scope:'local'}),4000);}catch{/* Local clearing remains immediate. */}
  });return ending;
}
