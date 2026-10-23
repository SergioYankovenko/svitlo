import config from "./config.js";
let clientPromise;
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
export const configured = () => !!config.apiUrl;
export async function request(action, data = {}) {
  if (!configured())
    throw Error("Сервер ще не підключений. Збережені графіки доступні офлайн.");
  const headers = { "Content-Type": "application/json" };
  if (!config.local) {
    const c = await client();
    let {
      data: { session },
    } = await c.auth.getSession();
    if (!session) {
      const result = await c.auth.signInAnonymously();
      if (result.error)
        throw Error("Не вдалося підключитися. Спробуйте пізніше.");
      session = result.data.session;
    }
    headers.apikey = config.publishableKey;
    headers.Authorization = "Bearer " + session.access_token;
  }
  const r = await fetch(config.apiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ action, ...data }),
    signal: AbortSignal.timeout(120000),
    cache: "no-store",
  });
  const payload = await r.json();
  if (!r.ok) throw Error(payload.error || "Перевірка тимчасово недоступна");
  return payload;
}
export async function forgetSession() {
  if (!config.local && config.supabaseUrl) {
    const c = await client();
    await c.auth.signOut({ scope: "local" });
  }
}
