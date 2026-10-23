import { mergeHistory } from "../app/lib/parsers.js";
import { dayKey, addDays } from "../app/lib/time.js";
import { countdown, emergencyPolicy } from "../app/lib/schedule.js";
export const DEFAULT_PREFS = {
  schedule: true,
  emergency: true,
  reminder: true,
  restoration: true,
  lead: 30,
};
export function publicProfile(p) {
  const { account, ...address } = p.address;
  return { ...p, address };
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
export function preferences(p = {}) {
  return {
    schedule: p.schedule !== false,
    emergency: p.emergency !== false,
    reminder: p.reminder !== false,
    restoration: p.restoration !== false,
    lead: [5, 15, 30, 60].includes(+p.lead) ? +p.lead : 30,
  };
}
export class Service {
  constructor({ db, source, push, now = () => Date.now(), vapid = "" }) {
    Object.assign(this, { db, source, push, now, vapid });
  }
  async refresh(profile) {
    const now = this.now(),
      old = profile.snapshot || {},
      address = await this.source.address(profile.address, now, old);
    let feed,
      feedFailed = false;
    try {
      feed = await this.source.feed(now, await this.db.feed());
      await this.db.saveFeed(feed);
    } catch {
      feed = await this.db.feed();
      feedFailed = true;
    }
    const snapshot = {
      ...address,
      plans: feed.plans || [],
      emergencies: feed.emergencies || [],
      feedCheckedAt: feed.checkedAt || null,
      feedFailed,
    };
    const relevant = (feed.messages || []).filter(
      (m) => m.queue === snapshot.queue,
    );
    const before = JSON.stringify(old.categories?.emergency?.events || []),
      after = JSON.stringify(snapshot.categories?.emergency?.events || []);
    if (
      before !== after &&
      snapshot.categories?.emergency?.events?.some(
        (e) => e.start <= now && (e.end === null || e.end > now),
      )
    )
      relevant.push({
        id: "address:" + after,
        kind: "emergency",
        title: "Аварійні відключення за адресою",
        date: dayKey(now),
        updatedAt: now,
        url: "https://www.cherkasyoblenergo.com/off",
      });
    const p = {
      ...profile,
      snapshot,
      messages: mergeHistory(profile.messages || [], relevant, now),
      last_checked: now,
    };
    await this.db.saveProfile(p);
    // Initial enrollment builds history without notifying about old publications.
    if (profile.last_checked) {
      const known = new Set((profile.messages || []).map((x) => x.id)),
        prefs = preferences(profile.preferences);
      for (const message of p.messages.filter(
        (x) =>
          !known.has(x.id) &&
          x.updatedAt >= profile.last_checked &&
          prefs[x.kind],
      ))
        await this.enqueue(p, message.id, message.title, message.date);
      const policy = emergencyPolicy(snapshot, now),
        previous = emergencyPolicy(old, now);
      if (
        prefs.emergency &&
        policy.active &&
        (!previous.active || previous.command?.id !== policy.command?.id)
      )
        await this.enqueue(
          p,
          "regional:" + policy.command.id,
          "Аварійні відключення в області",
          dayKey(now),
        );
    }
    return p;
  }
  async enqueue(p, key, title, date) {
    await this.db.enqueue({
      owner: p.owner,
      profile_id: p.id,
      event_key: key,
      title,
      body: "Відкрийте «Світло», щоб переглянути актуальний графік.",
      date,
      expires_at: this.now() + 3600000,
    });
  }
  async reminders(p) {
    const prefs = preferences(p.preferences),
      now = this.now(),
      timer = countdown(p.snapshot, now);
    if (timer.minutes === undefined) return;
    const restore = timer.label === "До відновлення",
      enabled = restore ? prefs.restoration : prefs.reminder;
    if (!enabled || timer.minutes > prefs.lead || timer.minutes <= 0) return;
    const at = timer.target;
    await this.enqueue(
      p,
      `reminder:${restore}:${at}`,
      `${timer.label} приблизно ${timer.minutes} хв`,
      dayKey(now),
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
      const p = (await list()).find((p) => p.id === body.id);
      if (!p) throw new ApiError(404, "Адресу не знайдено");
      return p;
    };
    switch (body.action) {
      case "bootstrap":
        return {
          profiles: (await list()).map(publicProfile),
          vapid: this.vapid,
          pushReady: !!this.vapid,
        };
      case "dictionary":
        return {
          items: await this.source.dictionary(body.kind, {
            parent: body.parent,
          }),
        };
      case "preview": {
        const address = await this.source.resolve(body.address),
          p = await this.source.address(address, now);
        return {
          address: { ...address, account: undefined },
          queue: p.queue,
          verified: p.failures.length === 0,
        };
      }
      case "save": {
        if (body.confirmed !== true)
          throw new ApiError(400, "Підтвердьте адресу");
        const profiles = await list();
        if (profiles.length >= 10)
          throw new ApiError(400, "Можна зберегти до 10 адрес");
        const address = await this.source.resolve(body.address);
        const old = profiles.find(
          (p) =>
            p.address.streetId === address.streetId &&
            p.address.house === address.house,
        );
        if (old) return { profile: publicProfile(old) };
        const p = {
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
        return { profile: publicProfile(await this.refresh(p)) };
      }
      case "refresh": {
        const p = await owned();
        if (now - p.last_checked < 60000) return { profile: publicProfile(p) };
        return { profile: publicProfile(await this.refresh(p)) };
      }
      case "weather": {
        const p = await owned();
        return { weather: await this.source.weather(p.address.city) };
      }
      case "delete": {
        const p = await owned();
        await this.db.deleteProfile(owner, p.id);
        return { ok: true };
      }
      case "preferences": {
        const p = await owned();
        p.preferences = preferences(body.preferences);
        await this.db.saveProfile(p);
        return { profile: publicProfile(p) };
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
    const now = this.now();
    let refreshed = 0;
    for (const p of await this.db.due(now, 5)) {
      try {
        await this.refresh(p);
        refreshed++;
      } catch {
        /* retry after lease expires */
      }
    }
    for (let offset = 0; ; offset += 100) {
      const batch = await this.db.reminderProfiles(now, 100, offset);
      for (const p of batch) await this.reminders(p);
      if (batch.length < 100) break;
    }
    let sent = 0;
    for (const item of await this.db.deliveries(now, 50)) {
      try {
        await this.push(item.subscription, {
          title: item.title,
          body: item.body,
          tag: item.event_key,
          date: item.date,
          profile: item.profile_id,
        });
        await this.db.deliveryDone(item.id);
        sent++;
      } catch (e) {
        if ([404, 410].includes(e.statusCode))
          await this.db.removeSubscription(item.subscription_id);
        else await this.db.deliveryRetry(item.id, now);
      }
    }
    await this.db.cleanup(now);
    return { refreshed, sent };
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
          e instanceof ApiError
            ? e.message
            : "Не вдалося отримати дані. Збережений графік залишається доступним.",
      }),
      { status: e.status || 502, headers },
    );
  }
}
