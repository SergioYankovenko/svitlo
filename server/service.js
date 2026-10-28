import { SyncService } from "./sync.js";
import { preferences, messageTitle, notificationBody, reminderTitle } from "../app/lib/notifications.js";
export { preferences } from "../app/lib/notifications.js";
import { registryMatch } from "./queue-registry.js";
import { addressRecord, catalogAddress, addressResolution } from "./address-registry.js";
import { failureCode, failureMessage } from "./source-errors.js";
import { mergeHistory } from "../app/lib/parsers.js";
import { dayKey, addDays, fresh } from "../app/lib/time.js";
import { countdown, emergencyPolicy } from "../app/lib/schedule.js";
import { enrollmentKey, enrollmentProof, preparedSnapshot } from "./enrollment-preview.js";
import { retryDelay } from "./provider-transport.js";
import { runScaledJobs } from './scaled-jobs.js';
export const DEFAULT_PREFS = {
  schedule: true,
  emergency: true,
  reminder: true,
  restoration: true,
  lead: 30,
};
export function publicProfile(p) {
  const { account, ...address } = p.address;
  const {push_enabled,...safe}=p;
  return { ...safe, address };
}
export function validSubscription(s) {
  if (!s || typeof s.endpoint !== "string" || s.endpoint.length > 2048)
    return false;
  let u;
  try {
    u = new URL(s.endpoint);
  } catch {
    return false;
  }
  const host = u.hostname;
  return (
    u.protocol === "https:" &&
    !u.username &&
    !u.password &&
    !u.port &&
    (host === "fcm.googleapis.com" ||
      host === "updates.push.services.mozilla.com" ||
      host.endsWith(".notify.windows.com") ||
      host.endsWith(".push.apple.com")) &&
    /^[A-Za-z0-9_-]{87}=?$/.test(s.keys?.p256dh || "") &&
    /^[A-Za-z0-9_-]{22}=?=?$/.test(s.keys?.auth || "")
  );
}
export class Service {
  constructor({ db, source, push, now = () => Date.now(), vapid = "", jobBudgetMs = 45000 }) {
    Object.assign(this, { db, source, push, now, vapid, jobBudgetMs });
    this.validSubscription=validSubscription; this.publicProfile=publicProfile; this.sync=new SyncService(this);
  }
  async resolveAddress(input) {
    try {
      return await this.source.resolve(input);
    } catch (error) {
      const stored = catalogAddress(await addressRecord(this.db, input));
      if (stored) return stored;
      if(/^Невідом|^Оберіть повну адресу/.test(error.message))throw new ApiError(400,error.message);
      throw error;
    }
  }
  async queueResolution(address, now, knownRecord) {
    if(knownRecord===undefined&&this.db.addressResolutionData) {
      const data=await this.db.addressResolutionData(address);
      if(data.record)return addressResolution(data.record,data.registry,now);
      return registryMatch(await this.db.registry?.(),address,now);
    }
    const stored = knownRecord === undefined
      ? await addressRecord(this.db, address)
      : knownRecord;
    if (stored) {
      // Exclusions do not need PDFs; exact numeric matches need only definitions,
      // not the full 1.2 MB registry with extracted document contents and rules.
      const registry = stored.status === "numeric"
        ? await (this.db.registryMetadata ? this.db.registryMetadata() : this.db.registry?.())
        : null;
      return addressResolution(stored, registry, now);
    }
    return registryMatch(await this.db.registry?.(), address, now);
  }
  async refresh(profile, prepared = null, { signal, feedResult } = {}) {
    const now = this.now(),
      old = profile.snapshot || {};
    const [address, registry] = await Promise.all([
      prepared ? Promise.resolve(structuredClone(prepared)) : this.source.address(profile.address, now, old, { signal }),
      this.queueResolution(profile.address, now).catch(() => ({ queue: null, status: "unavailable" })),
    ]);
    const cachedApiQueue = address.failures.includes("hourly") ? address.queue : null;
    const apiExclusion = !address.failures.includes("hourly") && address.categories.hourly?.inclusion === "not_in_queue";
    if (cachedApiQueue) address.queue = null;
    address.queueResolution = apiExclusion
      ? { queue: null, status: "not_found", inclusion: "not_in_queue", source: "address_api", checkedAt: address.categories.hourly?.checkedAt }
      : address.queue
      ? {
          queue: address.queue,
          source: "address_api",
          status: "matched",
          checkedAt: address.categories.hourly?.checkedAt,
          ...(registry?.queue && registry.queue !== address.queue
            ? {
                conflict: {
                  registryQueue: registry.queue,
                  version: registry.version,
                },
              }
            : {}),
        }
      : registry;
    if (!apiExclusion && !address.queue && registry?.queue) address.queue = registry.queue;
    if (!address.queue && cachedApiQueue && !registry?.inclusion) {
      address.queue = cachedApiQueue;
      address.queueResolution = { queue: cachedApiQueue, status: "matched", source: "cached_address_api", checkedAt: address.categories.hourly?.checkedAt };
    }
    let feed,
      feedError,
      feedFailed = false;
    try {
      const shared=feedResult?await feedResult:null;
      if(shared?.error)throw shared.error;
      feed = shared ? shared.value : await this.source.feed(now, await this.db.feed(), { signal });
      if (!shared && !this.source.sharedFeed) await this.db.saveFeed(feed);
      feedFailed = !!feed.partial;
      feedError = feed.feedError;
    } catch (error) {
      feed = await this.db.feed();
      feedFailed = true;
      feedError = failureCode(error);
    }
    const snapshot = {
      ...address,
        plans: (feed.plans || []).filter(plan=>plan.queue===address.queue),
      emergencies: feed.emergencies || [],
      feedCheckedAt: feed.checkedAt || null,
      feedFailed,
      feedError,
      maintenance:
        (feed.maintenance || []).find((m) => m.from <= now && m.until > now) ||
        null,
      lastSuccessAt:
        !address.failures.length && !feedFailed
          ? (prepared ? Math.min(now, prepared.checkedAt) : now)
          : old.lastSuccessAt || null,
    };
    if(snapshot.queueResolution?.inclusion === "not_in_queue" && !snapshot.failures.length && !snapshot.feedFailed) {
      snapshot.verifiedNoQueueDays=[...new Set([...(old.verifiedNoQueueDays||[]),dayKey(now)])].filter(d=>d>=addDays(dayKey(now),-7));
    }
    const currentPolicy = emergencyPolicy(snapshot, now);
    const regional = currentPolicy.command;
    const regionalMessages = regional
      ? [
          {
            id: "regional:" + regional.id,
            kind: "emergency",
            scope: "region",
            title: regional.ended
              ? "Аварійні відключення в області скасовано"
              : "Аварійні відключення в області",
            date: dayKey(regional.effectiveAt),
            updatedAt: regional.publishedAt,
            url: regional.url,
          },
        ]
      : [];
    const relevant = (feed.messages || []).filter(m => m.queue === snapshot.queue).map(m => {
      if(m.kind!=="schedule")return m;
      const existing=(profile.messages||[]).find(x=>x.id===m.id);
      const prior=(profile.messages||[]).some(x=>x.kind==="schedule"&&x.date===m.date&&x.queue===m.queue&&x.id!==m.id&&x.updatedAt<m.updatedAt);
      const previousPlan=(old.plans||[]).find(x=>x.date===m.date&&x.queue===m.queue);
      const revisionType=m.revisionType || existing?.revisionType || ((prior || previousPlan && previousPlan.publishedAt<m.updatedAt) ? "change" : "publication");
      return {...m,revisionType};
    });
    relevant.push(...regionalMessages);
    const before = JSON.stringify(old.categories?.emergency?.events || []),
      after = JSON.stringify(snapshot.categories?.emergency?.events || []);
    if (
      before !== after &&
      !snapshot.failures.includes("emergency") &&
      fresh(snapshot.categories?.emergency?.sourceAt,now) &&
      fresh(snapshot.categories?.emergency?.checkedAt,now) &&
      snapshot.categories?.emergency?.events?.some(
        (e) => e.start <= now && (e.end === null || e.end > now),
      )
    )
      relevant.push({
        id: "address:" + after,
        kind: "emergency",
        scope: "address",
        title: "Аварійні відключення за адресою",
        date: dayKey(now),
        updatedAt: now,
        url: "https://www.cherkasyoblenergo.com/off",
      });
    let p = {
      ...profile,
      snapshot,
      messages: mergeHistory(profile.messages || [], relevant, now),
      last_checked: now,
      next_check:
        now +
        (!address.failures.length && !feedFailed
          ? 3600000
          : Math.min(
              3600000,
              300000 * 2 ** Math.min(old.failureCount || 0, 4),
            )),
    };
    snapshot.failureCount =
      !address.failures.length && !feedFailed ? 0 : (old.failureCount || 0) + 1;
    const committed = await this.db.commitProfile(p, profile.snapshot_revision || 0);
    if (committed.status === "missing") throw new ApiError(404, "Адресу не знайдено");
    if (committed.status === "conflict") return committed.profile;
    p = committed.profile;
    // Initial enrollment builds history without notifying about old publications.
    if (profile.last_checked) {
      const known = new Set((profile.messages || []).map((x) => x.id)),
        prefs = preferences(p.preferences);
      for (const message of p.messages.filter(
        (x) =>
          !known.has(x.id) &&
          x.updatedAt >= profile.last_checked &&
          prefs[x.kind === "schedule" ? x.revisionType || "publication" : x.kind] &&
          x.scope !== "region",
      ))
        await this.enqueue(p, message.id, messageTitle(message), message.date, message.kind === "schedule" ? message.revisionType || "publication" : "address_emergency");

    }
    return p;
  }
  async enqueue(p, key, title, date, channel = key.startsWith('regional:')||key.startsWith('address:')?'emergency':'schedule') {
    if(key.startsWith("regional:"))return;
    await this.db.enqueue({
      owner: p.owner,
      profile_id: p.id,
      event_key: key,
      title,
      body: notificationBody(p),
      date,
      expires_at: this.now() + 3600000,
      channel,
    });
  }
  async reminders(p) {
    const prefs = preferences(p.preferences);
    if (!prefs.reminder && !prefs.restoration) return;
    const now = this.now(),
      timer = countdown(p.snapshot, now);
    if (timer.minutes === undefined) return;
    const restore = timer.label === "До відновлення",
      enabled = restore ? prefs.restoration : prefs.reminder;
    if (!enabled || timer.minutes > prefs.lead || timer.minutes <= 0) return;
    const at = timer.target;
    await this.enqueue(
      p,
      `reminder:${restore}:${at}`,
      reminderTitle(restore, at),
      dayKey(now),
      restore ? "restoration" : "reminder",
    );
  }
  async handle(owner, body) {
    const now = this.now();
    if (!owner) throw new ApiError(401, "Потрібне підключення");
    if (
      !(await this.db.rate(
        owner,
        body.action === "dictionary" ? 120 : 40,
        60000,
      ))
    )
      throw new ApiError(429, "Забагато запитів. Спробуйте за хвилину.");
    const list = () => this.db.profiles(owner);
    const owned = async () => {
      const p = this.db.profile ? await this.db.profile(owner,body.id) : (await list()).find((p) => p.id === body.id);
      if (!p) throw new ApiError(404, "Адресу не знайдено");
      return p;
    };
    switch (body.action) {
      case "sync": return this.sync.run(owner,body,list);
      case "bootstrap":
        return {
          profiles: (await list()).map(publicProfile),
          vapid: this.vapid,
          pushReady: !!this.vapid,
        };
      case "resolve_queue": {
        if(!body.id&&this.db.addressResolutionData) {
          const data=await this.db.addressResolutionData(body.address);
          if(data.record)return {resolution:addressResolution(data.record,data.registry,now)};
          const address=await this.resolveAddress(body.address);
          return {resolution:registryMatch(await this.db.registry?.(),address,now)};
        }
        const stored = !body.id ? await addressRecord(this.db, body.address) : null;
        if (stored) return { resolution: await this.queueResolution(body.address, now, stored) };
        const address = body.id
          ? (await owned()).address
          : await this.resolveAddress(body.address);
        const result = await this.queueResolution(address, now);
        return { resolution: result };
      }
      case "dictionary": {
        try {
          return { items: await this.source.dictionary(body.kind, { parent: body.parent }) };
        } catch (error) {
          const items = await this.db.addressDictionary?.(body.kind, body.parent);
          if (items?.length) return { items };
          throw error;
        }
      }
      case "preview": {
        const address = await this.resolveAddress(body.address),
          p = await this.source.address(address, now);
        const reusable = preparedSnapshot(p), key = enrollmentKey(address);
        if (reusable && key && this.db.rememberPreview) {
          try { await this.db.rememberPreview(owner, key, await enrollmentProof(owner, address), reusable, reusable.checkedAt); }
          catch { /* Preview success does not depend on optional reuse storage. */ }
        }
        const excluded = !p.failures.includes("hourly") && p.categories?.hourly?.inclusion === "not_in_queue";
        return {
          address: { ...address, account: undefined },
          queue:
            excluded ? null : p.queue ||
            (await this.queueResolution(address, now)).queue,
          verified: p.failures.length === 0,
          checkedAt: p.checkedAt,
        };
      }
      case "save": {
        if (body.confirmed !== true)
          throw new ApiError(400, "Підтвердьте адресу");
        const address = await this.resolveAddress(body.address);
        const candidate = {
          id: crypto.randomUUID(),
          owner,
          address,
          name: String(body.name || "")
            .trim()
            .slice(0, 60),
          preferences: DEFAULT_PREFS,
          snapshot: {},
          messages: [],
          last_checked: 0,
        };
        const created = await this.db.createProfile(candidate);
        if (created.status === "limit") throw new ApiError(400, "Можна зберегти до 10 адрес");
        const p = created.profile;
        if (!p) throw new ApiError(404, "Адресу не знайдено");
        if (!created.created && p.last_checked) return { profile: publicProfile(p) };
        let prepared = null;
        if (this.db.takePreview) {
          try { prepared = await this.db.takePreview(owner, enrollmentKey(address), await enrollmentProof(owner, address)); }
          catch { /* Resolve from current sources when the short-lived preview is unavailable. */ }
        }
        if (prepared && (prepared.checkedAt > now || now - prepared.checkedAt >= 60000 || prepared.failures?.length !== 0)) prepared = null;
        if (prepared && !preparedSnapshot(prepared)) prepared = null;
        return { profile: publicProfile(await this.refresh(p, prepared)) };
      }
      case "refresh": {
        const p = await owned();
        if (now - p.last_checked < 60000) return { profile: publicProfile(p) };
        return { profile: publicProfile(await this.refresh(p)) };
      }
      case "weather": {
        const p = await owned();
        return { weather: await this.sync.weatherFor(p.address) };
      }
      case "delete": {
        const p = await owned();
        await this.db.deleteProfile(owner, p.id);
        return { ok: true };
      }
      case "preferences": {
        const p = await owned();
        const changed = await this.db.setPreferences(owner,p.id,body.preferences || {});
        if (!changed) throw new ApiError(404, "Адресу не знайдено");
        return { profile: publicProfile(changed) };
      }
      case "subscribe": {
        if (!this.vapid)
          throw new ApiError(503, "Сервер сповіщень ще не підключений");
        if (!validSubscription(body.subscription))
          throw new ApiError(400, "Некоректна підписка");
        if (body.id) await owned();
        await this.db.subscribe(owner, body.subscription, body.id || null);
        return { ok: true };
      }
      case "unsubscribe": {
        await this.db.unsubscribe(owner, body.endpoint);
        return { ok: true };
      }
      case "erase": {
        await this.db.erase(owner);
        return { ok: true };
      }
      default:
        throw new ApiError(400, "Невідома дія");
    }
  }
  async jobs() {
    if(this.db.reminderClaim)return runScaledJobs(this);
    const claim = await this.db.jobsClaim();
    if (!claim.granted) return { status:"busy",refreshed:0,sent:0 };
    const deadline = this.now() + this.jobBudgetMs;
    let cursor = claim.cursor || null;
    let refreshed = 0, failedRefreshes = 0, partialRefreshes = 0, skippedRefreshes = 0;
    let sent = 0, failedDeliveries = 0, expiredSubscriptions = 0, remindersChecked = 0;
    try {
      // Claim only work we can start. Failed/unclaimed work remains due for a later minute.
      const refreshDeadline = Math.min(deadline-15000,this.now()+25000);
      for (let attempt=0; attempt<5 && this.now()+2000<refreshDeadline; attempt++) {
        const [p] = await this.db.due(this.now(),1);
        if (!p) break;
        try {
          const updated = await this.refresh(p,null,{signal:AbortSignal.timeout(Math.max(1,refreshDeadline-this.now()-1000))});
          refreshed++;
          if (updated.snapshot?.failures?.length || updated.snapshot?.feedFailed) partialRefreshes++;
        } catch (error) {
          if (error.status === 404) skippedRefreshes++; else failedRefreshes++;
          await this.db.releaseProfile(p).catch(()=>{});
          // Do not hammer the same due row again in this run after a storage/source error.
          break;
        }
      }
      reminders: for (let page=0;page<3 && this.now()+12000<deadline;page++) {
        const batch = await this.db.reminderProfiles(this.now(),100,0,cursor);
        for (const p of batch) {
          if (this.now()+12000>=deadline) break reminders;
          await this.reminders(p); cursor=p.id; remindersChecked++;
        }
        if (batch.length<100) { cursor=null;break; }
      }
      let claimed=0;
      const deliver = async () => {
        while (claimed<10 && this.now()+11000<deadline) {
          claimed++;
          const [item] = await this.db.deliveries(this.now(),1);
          if (!item) break;
          if (this.now()+11000>=deadline) {
            await this.db.deliveryRelease(item.id,item.lease_token,this.now());break;
          }
          const remaining = item.expires_at === undefined ? 3600000 : item.expires_at-this.now();
          if (remaining<=0) { await this.db.deliveryRelease(item.id,item.lease_token,this.now());continue; }
          try {
            await this.push(item.subscription, {
              title: item.title,
              body: item.body,
              tag: item.event_key,
              date: item.date,
              profile: item.profile_id,
            }, {ttl:Math.max(1,Math.min(3600,Math.ceil(remaining/1000)))});
            await this.db.deliveryDone(item.id,item.lease_token);
            sent++;
          } catch (e) {
            if ([404, 410].includes(e.statusCode)) {
              await this.db.removeSubscription(item.subscription_id);
              expiredSubscriptions++;
            } else {
              const delay = Math.max(Math.min(300000,30000*2**Math.min(item.attempts || 1,4)),retryDelay(e.headers?.["retry-after"],this.now()));
              await this.db.deliveryRetry(item.id,this.now(),item.lease_token,delay);failedDeliveries++;
            }
          }
        }
      };
      await Promise.all([deliver(),deliver()]);
      await this.db.cleanup(this.now());
      return { refreshed,sent,failedRefreshes,partialRefreshes,failedDeliveries,expiredSubscriptions,skippedRefreshes,remindersChecked,
        budgetExhausted:this.now()+11000>=deadline };
    } finally { await this.db.jobsFinish(claim.token,cursor); }
  }
}
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export async function httpHandler(request, service, authenticate, origins) {
  const origin = request.headers.get("Origin"),
    allowed = !origin || origins.includes(origin),
    headers = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Vary: "Origin",
    };
  if (origin && allowed)
    Object.assign(headers, {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "authorization,apikey,content-type",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
    });
  if (!allowed)
    return new Response(JSON.stringify({ error: "Origin not allowed" }), {
      status: 403,
      headers,
    });
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers });
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers });
  try {
    if (Number(request.headers.get("content-length")) > 16000)
      throw new ApiError(413, "Завеликий запит");
    const raw = await request.text();
    if (raw.length > 16000) throw new ApiError(413, "Завеликий запит");
    const owner = await authenticate(request),
      data = await service.handle(owner, JSON.parse(raw));
    return new Response(JSON.stringify(data), { headers });
  } catch (e) {
    if (!(e instanceof ApiError))
      console.error(
        "API failure",
        String(e.message)
          .replace(/https?:\/\/\S+/g, "[source]")
          .replace(/\d{11,}/g, "[redacted]")
          .slice(0, 180),
      );
    return new Response(
      JSON.stringify({
        error:
          e instanceof ApiError ? e.message : failureMessage(failureCode(e)),
        code: e instanceof ApiError ? "request_error" : failureCode(e),
      }),
      { status: e.status || 502, headers },
    );
  }
}
