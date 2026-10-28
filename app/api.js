import config from "./config.js";
let clientPromise;
let authPromise;
async function client() {
  if (!clientPromise)
    clientPromise = import("./vendor/supabase.js").then(({ createClient }) =>
      createClient(config.supabaseUrl, config.publishableKey, {
        auth: {
          storageKey: "svitlo-auth",
          persistSession: true,
          autoRefreshToken: true,
        },
      }),
    );
  return clientPromise;
}
export async function identity() {
  if(config.local)return 'local-preview';
  if(!configured())return null;
  const c=await client();return (await c.auth.getSession()).data.session?.user?.id || null;
}
export async function ensureIdentity(){return config.local?'local-preview':(await sessionForRequest()).user.id;}
async function sessionForRequest() {
  if(!authPromise)authPromise=(async()=>{
    const c=await client();let session=(await c.auth.getSession()).data.session;
    if(!session) {const r=await c.auth.signInAnonymously();if(r.error)throw Error('Не вдалося підключитися. Спробуйте пізніше.');session=r.data.session;}
    return session;
  })().finally(()=>authPromise=null);
  return authPromise;
}
export const configured = () => !!config.apiUrl;
export async function request(action, data = {}) {
  if (!configured())
    throw Error("Сервер ще не підключений. Збережені графіки доступні офлайн.");
  const headers = { "Content-Type": "application/json" };
  if (!config.local) {
    const session=await sessionForRequest();
    headers.apikey = config.publishableKey;
    headers.Authorization = "Bearer " + session.access_token;
  }
  return post(config.apiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ action, ...data }),
    signal: AbortSignal.timeout(120000),
    cache: "no-store",
  });
}
export async function post(url, options, fetcher = fetch) {
  let r, payload;
  try {
    r = await fetcher(url, options);
    payload = await r.json();
  } catch {
    throw Error("Оновлення тимчасово недоступне. Спробуйте пізніше.");
  }
  if (!r.ok) {const error=Error(payload.error || "Перевірка тимчасово недоступна");error.status=r.status;throw error;}
  return payload;
}
export async function forgetSession() {
  if (!config.local && config.supabaseUrl) {
    const c = await client();
    await c.auth.signOut({ scope: "local" });
  }
}
