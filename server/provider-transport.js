import { SourceError, failureCode } from "./source-errors.js";
const HOSTS = new Set(["cabinet.cherkasyoblenergo.com", "www.cherkasyoblenergo.com"]);
export function retryDelay(value, now = Date.now()) {
  if (!value) return 0;
  const delay = /^\d+$/.test(value.trim()) ? +value * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, Math.min(900000, delay)) : 0;
}
export function providerTransport(db, fetcher = fetch, { now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)), maxWaitMs = 20000 } = {}) {
  return async (url, options = {}) => {
    const host = new URL(url).hostname;
    if (!HOSTS.has(host)) return fetcher(url, options);
    if (!options.signal) options = {...options,signal:AbortSignal.timeout(20000)};
    const deadline = now() + maxWaitMs;
    let claim;
    while (true) {
      options.signal?.throwIfAborted();
      claim = await db.providerAcquire(host);
      if (claim.granted) break;
      if (claim.reason === "cooldown") throw new SourceError(claim.code || "rate_limited", claim.code === "forbidden" ? 403 : 429);
      if (now() >= deadline) throw new SourceError("rate_limited", 429);
      await sleep(Math.min(Math.max(25, claim.waitMs || 100), 250, Math.max(1, deadline-now())));
    }
    let finished = false, response, started = false;
    const finish = async (status, error = null, retry = 0) => {
      if (finished) return; finished = true;
      await db.providerFinish(claim.token, status, error, retry).catch(() => {});
    };
    try {
      options.signal?.throwIfAborted();
      started = true;
      response = await fetcher(url, options);
      if (!response.ok) {
        if (response.body) await response.body.cancel().catch(() => {});
        await finish(response.status, null, retryDelay(response.headers.get("Retry-After"), now()));
        return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
      }
      if (!response.body) { await finish(response.status); return response; }
      const reader = response.body.getReader();
      const body = new ReadableStream({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) { await finish(response.status); controller.close(); }
            else controller.enqueue(next.value);
          } catch (error) { await finish(null, failureCode(error)); controller.error(error); }
        },
        async cancel(reason) { try { await reader.cancel(reason); } finally { await finish(response.status); } },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { await finish(null, started ? failureCode(error) : null); throw error; }
  };
}
