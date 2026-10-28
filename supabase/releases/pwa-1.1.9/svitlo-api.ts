// supabase/functions/svitlo-api/index.ts
import { createClient } from "npm:@supabase/supabase-js@2.106.1";

// server/address-resolution-db.js
async function addressResolutionData(db2, address) {
  if (!address || ["department", "cityId", "streetId", "house"].some((k) => typeof address[k] !== "string" || !address[k] || address[k].length > 120))
    return { record: null, registry: null };
  return db2.result(db2.c.rpc("svitlo_address_resolution_data", {
    department_id: address.department,
    city_id: address.cityId,
    street_id: address.streetId,
    house_number: address.house
  }));
}

// server/database.js
var Database = class {
  constructor(client2, { scheduledMaintenance = false } = {}) {
    this.c = client2;
    this.scheduledMaintenance = scheduledMaintenance;
  }
  async result(query) {
    const { data, error } = await query;
    if (error) throw Error("\u041F\u043E\u043C\u0438\u043B\u043A\u0430 \u0441\u0445\u043E\u0432\u0438\u0449\u0430");
    return data;
  }
  async registry() {
    return (await this.result(
      this.c.from("svitlo_queue_versions").select("payload").eq("active", true).maybeSingle()
    ))?.payload || null;
  }
  async addressQueue(address) {
    const row = await this.result(
      this.c.from("svitlo_effective_address_queues").select("department,city_id,street_id,house,city,street,status,queue,is_estimate,confidence,evidence,batch").eq("department", address.department).eq("city_id", address.cityId).eq("street_id", address.streetId).eq("house", address.house).maybeSingle()
    );
    return row ? { ...row, batch: Array.isArray(row.batch) ? row.batch[0] : row.batch } : null;
  }
  async addressResolutionData(address) {
    return addressResolutionData(this, address);
  }
  async jobsWork(now) {
    return this.result(this.c.rpc("svitlo_jobs_work", { now_ms: now }));
  }
  async registryMetadata() {
    return this.result(this.c.rpc("svitlo_queue_metadata"));
  }
  async rememberPreview(owner, key, proof, prepared, checkedAt) {
    await this.result(this.c.rpc("svitlo_preview_put", { subject: owner, cache_key: key, proof, prepared_data: prepared, checked_ms: checkedAt }));
  }
  async takePreview(owner, key, proof) {
    return this.result(this.c.rpc("svitlo_preview_take", { subject: owner, cache_key: key, proof }));
  }
  async dictionaryClaim(key) {
    return this.result(this.c.rpc("svitlo_dictionary_claim", { cache_key: key }));
  }
  async dictionaryFinish(key, token, items, error) {
    return this.result(this.c.rpc("svitlo_dictionary_finish", { cache_key: key, claim: token, items, error_code: error }));
  }
  async providerAcquire(host) {
    return this.result(this.c.rpc("svitlo_provider_acquire", { provider_host: host }));
  }
  async providerFinish(token, status, error, retry) {
    await this.result(this.c.rpc("svitlo_provider_finish", { claim: token, http_status: status, error_code: error, retry_ms: retry }));
  }
  async registrySafety(candidate, reconciliation) {
    return this.result(this.c.rpc("svitlo_registry_safety", { candidate: reconciliation ? { ...candidate, addressReconciliation: reconciliation } : candidate }));
  }
  async holdRegistry(candidate, reconciliation, review) {
    const now = Date.now();
    const old = await this.result(this.c.from("svitlo_registry_candidates").select("created_at").eq("id", candidate.id).maybeSingle());
    await this.result(this.c.from("svitlo_registry_candidates").upsert({
      id: candidate.id,
      base_version: reconciliation?.previous_registry_id || null,
      created_at: old?.created_at || now,
      last_seen_at: now,
      status: "held",
      reason: review.reason,
      summary: review,
      payload: reconciliation ? { ...candidate, addressReconciliation: reconciliation } : candidate
    }));
  }
  async registryAccepted(id) {
    await this.result(this.c.from("svitlo_registry_candidates").update({ status: "activated" }).eq("id", id));
    await this.result(this.c.from("svitlo_registry_candidates").update({ status: "superseded" }).eq("status", "held").neq("id", id));
  }
  async startJob(job, now) {
    return (await this.result(this.c.from("svitlo_job_runs").insert({ job, started_at: now, status: "running" }).select("id").single())).id;
  }
  async finishJob(id, status, summary, error, now) {
    await this.result(this.c.from("svitlo_job_runs").update({ status, summary, error_code: error, finished_at: now }).eq("id", id));
  }
  async opsCleanup() {
    await this.result(this.c.rpc("svitlo_ops_cleanup"));
  }
  async addressCatalogBatches() {
    return this.result(this.c.from("svitlo_address_queue_batches").select("id,expected_total").eq("status", "active").order("department"));
  }
  async addressCatalogPage(batchId, offset) {
    return this.result(this.c.from("svitlo_effective_address_queues").select("department,city_id,street_id,house,city,street,status,queue,is_estimate,confidence,evidence,batch,override_registry_id").eq("batch_id", batchId).order("department").order("city_id").order("street_id").order("house").range(offset, offset + 999));
  }
  async addressDictionary(kind, parent) {
    return this.result(this.c.rpc("svitlo_address_dictionary", {
      dictionary_kind: kind,
      parent_id: parent || ""
    }));
  }
  async registryState() {
    return (await this.result(
      this.c.from("svitlo_cache").select("value").eq("key", "queue-registry-state").maybeSingle()
    ))?.value || {};
  }
  async saveRegistryState(value) {
    await this.result(
      this.c.from("svitlo_cache").upsert({ key: "queue-registry-state", value })
    );
  }
  async activateRegistry(candidate, reconciliation = null) {
    await this.result(this.c.rpc("svitlo_activate_registry", {
      candidate: reconciliation ? { ...candidate, addressReconciliation: reconciliation } : candidate
    }));
  }
  async profiles(owner) {
    return this.result(this.c.rpc("svitlo_profiles_read", { subject: owner }));
  }
  async profile(owner, id) {
    return (await this.result(this.c.rpc("svitlo_profiles_read", { subject: owner, profile_id: id })))[0] || null;
  }
  async saveProfile(p) {
    await this.result(this.c.from("svitlo_profiles").upsert(p));
  }
  async createProfile(p) {
    const result = await this.result(this.c.rpc("svitlo_profile_create", { subject: p.owner, profile_id: p.id, address_data: p.address, display_name: p.name, preference_data: p.preferences }));
    if (result.profile && !result.created) result.profile = await this.profile(p.owner, result.profile.id);
    return result;
  }
  async commitProfile(p, expectedRevision) {
    return this.result(this.c.rpc("svitlo_profile_commit_v2", {
      subject: p.owner,
      profile_id: p.id,
      expected_revision: expectedRevision,
      profile_data: { snapshot: p.snapshot, messages: p.messages, last_checked: p.last_checked, next_check: p.next_check }
    }));
  }
  async setPreferences(owner, id, preferences2) {
    await this.result(this.c.rpc("svitlo_preferences_patch", { subject: owner, profile_id: id, patch: preferences2 }));
    return this.profile(owner, id);
  }
  async releaseProfile(p) {
    await this.result(this.c.from("svitlo_profiles").update({ lease_until: 0 }).eq("id", p.id).eq("owner", p.owner).eq("snapshot_revision", p.snapshot_revision).eq("lease_until", p.lease_until));
  }
  async feedClaim() {
    return this.result(this.c.rpc("svitlo_feed_claim"));
  }
  async feedFinish(token, value, error) {
    return this.result(this.c.rpc("svitlo_feed_finish", { claim: token, feed_value: value, error_code: error }));
  }
  async jobsClaim() {
    return this.result(this.c.rpc("svitlo_jobs_claim"));
  }
  async jobsFinish(token, cursor) {
    return this.result(this.c.rpc("svitlo_jobs_finish", { claim: token, cursor_id: cursor }));
  }
  async deleteProfile(owner, id) {
    await this.result(
      this.c.from("svitlo_profiles").delete().eq("owner", owner).eq("id", id)
    );
  }
  async feed() {
    if (this.feedMemo && this.feedMemo.until > Date.now()) return this.feedMemo.promise;
    const promise = this.readFeed();
    this.feedMemo = { until: Date.now() + 5e3, promise };
    try {
      return await promise;
    } catch (error) {
      this.feedMemo = null;
      throw error;
    }
  }
  async readFeed() {
    return (await this.result(
      this.c.from("svitlo_cache").select("value").eq("key", "feed").maybeSingle()
    ))?.value || {};
  }
  async saveFeed(value) {
    await this.result(
      this.c.from("svitlo_cache").upsert({ key: "feed", value })
    );
    this.feedMemo = null;
  }
  async rate(owner, limit, window) {
    return this.result(
      this.c.rpc("svitlo_rate", {
        subject: owner,
        max_count: limit,
        window_ms: window
      })
    );
  }
  async subscribe(owner, subscription, profile) {
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(subscription.endpoint)
    );
    const id = Array.from(
      new Uint8Array(hash),
      (x) => x.toString(16).padStart(2, "0")
    ).join("");
    const existing = await this.result(
      this.c.from("svitlo_subscriptions").select("owner").eq("id", id).maybeSingle()
    );
    if (existing && existing.owner !== owner)
      throw Error("\u041F\u0456\u0434\u043F\u0438\u0441\u043A\u0430 \u043D\u0430\u043B\u0435\u0436\u0438\u0442\u044C \u0456\u043D\u0448\u043E\u043C\u0443 \u043F\u0440\u0438\u0441\u0442\u0440\u043E\u044E");
    await this.result(
      this.c.from("svitlo_subscriptions").upsert({
        id,
        owner,
        subscription,
        profile_id: profile,
        updated_at: (/* @__PURE__ */ new Date()).toISOString()
      })
    );
  }
  async unsubscribe(owner, endpoint) {
    const subs = await this.result(
      this.c.from("svitlo_subscriptions").select("id,subscription").eq("owner", owner)
    );
    for (const s of subs)
      if (s.subscription.endpoint === endpoint)
        await this.removeSubscription(s.id);
  }
  async removeSubscription(id) {
    await this.result(
      this.c.from("svitlo_subscriptions").delete().eq("id", id)
    );
  }
  async erase(owner) {
    await this.result(this.c.from("svitlo_previews").delete().eq("owner", owner));
    await this.result(
      this.c.from("svitlo_subscriptions").delete().eq("owner", owner)
    );
    await this.result(
      this.c.from("svitlo_profiles").delete().eq("owner", owner)
    );
  }
  async enqueue(event) {
    await this.result(this.c.rpc("svitlo_enqueue_v2", { event }));
  }
  async due(now, amount) {
    return this.result(
      this.c.rpc("svitlo_due_v2", { now_ms: now, batch_size: amount })
    );
  }
  async reminderProfiles(now, amount, offset = 0, cursor = null) {
    return this.result(this.c.rpc("svitlo_reminder_profiles", {
      now_ms: now,
      batch_size: amount,
      after_id: cursor
    }));
  }
  async deliveries(now, amount) {
    return this.result(this.c.rpc("svitlo_delivery_claim", { now_ms: now }));
  }
  async deliveryDone(id, token) {
    await this.result(this.c.rpc("svitlo_delivery_finish", { delivery_id: id, claim: token, delivered: true, retry_at: 0 }));
  }
  async deliveryRelease(id, token, now) {
    await this.result(this.c.rpc("svitlo_delivery_finish", { delivery_id: id, claim: token, delivered: null, retry_at: now }));
  }
  async deliveryRetry(id, now, token, delay = 3e5) {
    await this.result(this.c.rpc("svitlo_delivery_finish", { delivery_id: id, claim: token, delivered: false, retry_at: now + delay }));
  }
  async cleanup(now) {
    await this.result(this.c.rpc("svitlo_scaling_cleanup"));
    await this.result(this.c.from("svitlo_source_cache").delete().lt("touched_at", now - 864e5));
    await this.result(
      this.c.from("svitlo_deliveries").delete().lt("expires_at", now - 7 * 864e5)
    );
    await this.result(
      this.c.from("svitlo_limits").delete().lt("started_at", now - 864e5)
    );
  }
  async sourceClaim(key, now) {
    return this.result(this.c.rpc("svitlo_source_claim", { cache_key: key, now_ms: now }));
  }
  async sourceFinish(key, token, value, now, ttl) {
    return this.result(this.c.rpc("svitlo_source_finish", { cache_key: key, claim: token, cache_value: value, now_ms: now, ttl_ms: ttl }));
  }
  async reminderClaim(now, n) {
    return this.result(this.c.rpc("svitlo_reminder_claim", { now_ms: now, batch_size: n }));
  }
  async reminderFinish(items) {
    return this.result(this.c.rpc("svitlo_reminder_finish", { items }));
  }
  async deliveryBatch(now, n) {
    return this.result(this.c.rpc("svitlo_delivery_batch", { now_ms: now, batch_size: n }));
  }
  async deliveryActive(items, now) {
    return this.result(this.c.rpc("svitlo_delivery_active", { claims: items.map((i) => ({ id: i.id, token: i.lease_token })), now_ms: now }));
  }
  async deliveryFinishBatch(items) {
    return this.result(this.c.rpc("svitlo_delivery_finish_batch", { items }));
  }
};

// server/source-errors.js
var SourceError = class extends Error {
  constructor(code, status) {
    super("\u0414\u0430\u043D\u0456 \u0434\u0436\u0435\u0440\u0435\u043B\u0430 \u0442\u0438\u043C\u0447\u0430\u0441\u043E\u0432\u043E \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0456");
    this.code = code;
    this.status = status;
  }
};
function failureCode(error) {
  if (error instanceof SourceError) return error.code;
  if (error?.name === "TimeoutError" || error?.name === "AbortError")
    return "timeout";
  if (error instanceof SyntaxError) return "invalid_response";
  return "unreachable";
}
var failureMessage = (code) => ({
  timeout: "\u0421\u0435\u0440\u0432\u0456\u0441 \u0427\u0435\u0440\u043A\u0430\u0441\u0438\u043E\u0431\u043B\u0435\u043D\u0435\u0440\u0433\u043E \u043D\u0435 \u0432\u0456\u0434\u043F\u043E\u0432\u0456\u0432 \u0432\u0447\u0430\u0441\u043D\u043E. \u0421\u043F\u0440\u043E\u0431\u0443\u0454\u043C\u043E \u043F\u0456\u0437\u043D\u0456\u0448\u0435.",
  forbidden: "\u0421\u0435\u0440\u0432\u0456\u0441 \u0427\u0435\u0440\u043A\u0430\u0441\u0438\u043E\u0431\u043B\u0435\u043D\u0435\u0440\u0433\u043E \u0432\u0456\u0434\u0445\u0438\u043B\u0438\u0432 \u0437\u0430\u043F\u0438\u0442. \u0421\u043F\u0440\u043E\u0431\u0443\u0454\u043C\u043E \u043F\u0456\u0437\u043D\u0456\u0448\u0435.",
  rate_limited: "\u0421\u0435\u0440\u0432\u0456\u0441 \u0442\u0438\u043C\u0447\u0430\u0441\u043E\u0432\u043E \u043E\u0431\u043C\u0435\u0436\u0438\u0432 \u0437\u0430\u043F\u0438\u0442\u0438. \u0421\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 \u043F\u0456\u0437\u043D\u0456\u0448\u0435.",
  invalid_response: "\u0421\u0435\u0440\u0432\u0456\u0441 \u0427\u0435\u0440\u043A\u0430\u0441\u0438\u043E\u0431\u043B\u0435\u043D\u0435\u0440\u0433\u043E \u043F\u043E\u0432\u0435\u0440\u043D\u0443\u0432 \u043D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0456 \u0434\u0430\u043D\u0456. \u0421\u043F\u0440\u043E\u0431\u0443\u0454\u043C\u043E \u043F\u0456\u0437\u043D\u0456\u0448\u0435."
})[code] || "\u041D\u0435 \u0432\u0434\u0430\u043B\u043E\u0441\u044F \u043E\u043D\u043E\u0432\u0438\u0442\u0438 \u0434\u0430\u043D\u0456 \u0427\u0435\u0440\u043A\u0430\u0441\u0438\u043E\u0431\u043B\u0435\u043D\u0435\u0440\u0433\u043E. \u0421\u043F\u0440\u043E\u0431\u0443\u0454\u043C\u043E \u043F\u0456\u0437\u043D\u0456\u0448\u0435.";

// app/lib/time.js
var ZONE = "Europe/Kyiv";
var fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
});
function parts(ms) {
  return Object.fromEntries(
    fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value])
  );
}
function dayKey(ms = Date.now()) {
  const p = parts(ms);
  return `${p.year}-${p.month}-${p.day}`;
}
function addDays(day, n) {
  return new Date(Date.parse(day + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
}
function civil(day, minute = 0) {
  if (minute === 1440) return civil(addDays(day, 1), 0);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || minute < 0 || minute >= 1440)
    throw Error("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0430 \u0434\u0430\u0442\u0430");
  const expected = `${day}T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  const utc = Date.parse(expected + ":00Z"), candidates = [];
  for (const offset of [120, 180]) {
    const t = utc - offset * 6e4, p = parts(t);
    if (`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}` === expected)
      candidates.push(t);
  }
  if (candidates.length !== 1) throw Error("\u041D\u0435\u043E\u0434\u043D\u043E\u0437\u043D\u0430\u0447\u043D\u0438\u0439 \u0447\u0430\u0441 \u0434\u0436\u0435\u0440\u0435\u043B\u0430");
  return candidates[0];
}
function sourceTime(s) {
  if (typeof s !== "string") throw Error("\u0427\u0430\u0441 \u0432\u0456\u0434\u0441\u0443\u0442\u043D\u0456\u0439");
  const m = s.match(/(\d{2}):(\d{2})\s+(\d{2})\.(\d{2})\.(\d{4})/);
  if (m)
    return civil(`${m[5]}-${m[4]}-${m[3]}`, Number(m[1]) * 60 + Number(m[2]));
  if (/(?:Z|[+-]\d{2}:\d{2})$/.test(s)) {
    const t = Date.parse(s);
    if (Number.isFinite(t)) return t;
  }
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/);
  if (iso) return civil(iso[1], +iso[2] * 60 + +iso[3]);
  throw Error("\u041D\u0435\u0432\u0456\u0434\u043E\u043C\u0438\u0439 \u0447\u0430\u0441 \u0434\u0436\u0435\u0440\u0435\u043B\u0430");
}
function clock(ms) {
  return new Intl.DateTimeFormat("uk-UA", {
    timeZone: ZONE,
    hour: "2-digit",
    minute: "2-digit"
  }).format(ms);
}
function fresh(t, now = Date.now()) {
  return Number.isFinite(t) && t <= now + 3e5 && t >= now - 72e5;
}

// app/lib/outage-types.js
var OUTAGE_TYPES_VERSION = 1;
var categoryPriority = { emergency: 3, planned: 2, hourly: 1 };
var eventKind = (e) => e?.category === "planned" && e.unplanned === true ? "unplanned" : e?.category;
var needsOutageTypes = (snapshot) => {
  const c = snapshot?.categories?.planned;
  return !!c && c.outageTypesVersion !== OUTAGE_TYPES_VERSION && !!c.events?.some((e) => e.category === "planned" && typeof e.unplanned !== "boolean");
};

// app/lib/parsers.js
var ORIGIN = "https://www.cherkasyoblenergo.com";
var QUEUES = Array.from({ length: 6 }, (_, i) => [
  `${i + 1}.1`,
  `${i + 1}.2`
]).flat();
function plain(html) {
  return String(html).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<\/?(?:p|div|br|tr|li|h[1-6])\b[^>]*>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;|&#160;|\u00a0/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).split("\n").map((x) => x.replace(/[\t ]+/g, " ").trim()).filter(Boolean).join("\n");
}
function rows(value) {
  const r = Array.isArray(value) ? value : value && typeof value === "object" ? Object.values(value) : null;
  if (!r || r.some((x) => !x || typeof x !== "object" || Array.isArray(x)))
    throw Error("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0430 \u0432\u0456\u0434\u043F\u043E\u0432\u0456\u0434\u044C \u0434\u0436\u0435\u0440\u0435\u043B\u0430");
  return r;
}
function article(root) {
  const d = root?.data;
  if (!root?.success || !d || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,199}$/.test(d.slug) || typeof d.content !== "string")
    throw Error("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0430 \u043F\u0443\u0431\u043B\u0456\u043A\u0430\u0446\u0456\u044F");
  return {
    id: String(d.id),
    title: plain(d.title),
    body: plain(d.content),
    publishedAt: sourceTime(d.publishedAt),
    url: `${ORIGIN}/media/${d.slug}`
  };
}
var months = "\u0441\u0456\u0447\u043D\u044F \u043B\u044E\u0442\u043E\u0433\u043E \u0431\u0435\u0440\u0435\u0437\u043D\u044F \u043A\u0432\u0456\u0442\u043D\u044F \u0442\u0440\u0430\u0432\u043D\u044F \u0447\u0435\u0440\u0432\u043D\u044F \u043B\u0438\u043F\u043D\u044F \u0441\u0435\u0440\u043F\u043D\u044F \u0432\u0435\u0440\u0435\u0441\u043D\u044F \u0436\u043E\u0432\u0442\u043D\u044F \u043B\u0438\u0441\u0442\u043E\u043F\u0430\u0434\u0430 \u0433\u0440\u0443\u0434\u043D\u044F".split(
  " "
);
function dates(text, published) {
  const result = [];
  for (const m of text.matchAll(/(?<!\d)(\d{1,2})[.](\d{1,2})[.](20\d{2})/g))
    result.push(`${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`);
  for (const m of text.matchAll(
    new RegExp(
      `(?<!\\d)(\\d{1,2})\\s+(${months.join("|")})(?:\\s+(20\\d{2}))?`,
      "gi"
    )
  )) {
    const year = +dayKey(published).slice(0, 4), mon = months.indexOf(m[2].toLowerCase()) + 1;
    const options = (m[3] ? [+m[3]] : [year - 1, year, year + 1]).map(
      (y) => `${y}-${String(mon).padStart(2, "0")}-${m[1].padStart(2, "0")}`
    ).sort(
      (a, b) => Math.abs(Date.parse(a) - published) - Math.abs(Date.parse(b) - published)
    );
    result.push(options[0]);
  }
  return [...new Set(result)];
}
function parsePlan(a, checkedAt) {
  if (!/гпв|погодинн[а-яіїєґ]*\s+відключ/i.test(a.title) || /гоп|обмеженн.*потужност/i.test(a.title))
    return [];
  const ds = dates(a.title, a.publishedAt), fallback = ds.length ? ds : dates(a.body, a.publishedAt);
  if (fallback.length !== 1) return [];
  const date = fallback[0], rowRe = /^\s*(?:(?:під)?черг[а-яіїєґ]*\s*)?([1-6])\s*\.\s*([12])\s*[:–—-]?\s*(.*?)\s*$/i;
  const lines = [];
  for (const line of a.body.split("\n")) {
    if (/^[,;]?\s*\d{1,2}\s*:/.test(line) && lines.length && rowRe.test(lines.at(-1)))
      lines[lines.length - 1] += ", " + line;
    else lines.push(line);
  }
  const matches = lines.map((x) => x.match(rowRe)).filter(Boolean), found = /* @__PURE__ */ new Map();
  for (const m of matches) {
    const q = m[1] + "." + m[2];
    found.set(q, [...found.get(q) || [], m[3]]);
  }
  const partial = /^(оновлено|оновлення|змінено|уточнено|коригування|зміни до)/i.test(
    a.title
  );
  return (partial ? [...found.keys()] : QUEUES).map((queue) => {
    const list = found.get(queue) || [], text = list[0] || "", cancellation = /^(?:скасовано|без відключень|не застосовуються)[.!]?$/i.test(text);
    let uncertain = list.length !== 1 || !partial && found.size !== 12, events = [];
    if (!cancellation) {
      const re = /(?<!\d)(\d{1,2}):\s*(\d{2})\s*[-–—−]\s*(\d{1,2}):\s*(\d{2})(?!\d)/g, spans = [...text.matchAll(re)];
      if (!spans.length || !/^[\s,;.!]*$/.test(text.replace(re, "")))
        uncertain = true;
      try {
        for (const m of spans) {
          const [h, s, H, S] = m.slice(1).map(Number);
          if (h > 23 || s > 59 || H > 24 || S > 59 || H === 24 && S)
            throw Error();
          const start = civil(date, h * 60 + s), end = civil(date, H * 60 + S);
          if (end <= start) throw Error();
          events.push({ start, end, category: "hourly" });
        }
        events.sort((a2, b) => a2.start - b.start);
        if (events.some((x, i) => i && x.start < events[i - 1].end))
          throw Error();
      } catch {
        uncertain = true;
      }
    }
    if (uncertain) events = [];
    return {
      date,
      queue,
      events,
      uncertain,
      publishedAt: a.publishedAt,
      checkedAt,
      url: a.url,
      revision: JSON.stringify([uncertain, events])
    };
  });
}
function parseOutages(root, category, checkedAt) {
  if (!root || root.error || root.ERROR || !("DISCONNECTIONS" in root))
    throw Error("\u041D\u0435\u043C\u0430\u0454 \u043F\u0435\u0440\u0435\u043B\u0456\u043A\u0443 \u0432\u0456\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u044C");
  const events = rows(root.DISCONNECTIONS).filter(
    (x) => !/скасован|відмін|cancelled|canceled/i.test(x.STATE_CHAR || "")
  ).map((x) => {
    const start = sourceTime(x.DATE_START), raw = plain(x.DATE_TIME || x.DATE_STOP || ""), match = raw.match(/\d{2}:\d{2}\s+\d{2}\.\d{2}\.\d{4}/), end = match ? sourceTime(match[0]) : null;
    if (end !== null && end <= start) throw Error("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u0439 \u0456\u043D\u0442\u0435\u0440\u0432\u0430\u043B");
    return {
      start,
      end,
      category,
      plannedEnd: /план/i.test(raw),
      ...category === "planned" ? {
        unplanned: typeof x.DISCONN_TYPE === "string" && /позаплан/i.test(x.DISCONN_TYPE)
      } : {}
    };
  });
  const info = root.DISCONN_QUEUQ ? rows(root.DISCONN_QUEUQ).map((x) => x.QUEUE_INFO || "").filter((s) => /погодин/i.test(s)) : [];
  const queues = [
    ...new Set(
      info.flatMap(
        (s) => [...s.matchAll(/([1-6])\s*черга\s*([12])\s*підчерга/gi)].map(
          (m) => m[1] + "." + m[2]
        )
      )
    )
  ];
  return {
    events,
    ...category === "planned" ? { outageTypesVersion: OUTAGE_TYPES_VERSION } : {},
    queue: queues.length === 1 ? queues[0] : null,
    checkedAt,
    sourceAt: root.DATETIME ? sourceTime(root.DATETIME) : null
  };
}
function parseEmergency(a) {
  const text = a.title + "\n" + a.body;
  if (!/графік[а-яіїєґ]*\s+аварійн[а-яіїєґ]*\s+відключ/i.test(a.title))
    return null;
  const ended = /скасован|відмінено|припинено|не застосовуються/i.test(a.title);
  if (!ended && !/застосован|введен|запроваджен/i.test(a.title)) return null;
  if (!ended && /можлив|можуть|у разі|навчан|тренуван|не\s+(?:застосован|введен)/i.test(
    text
  ))
    return null;
  const ds = dates(a.body, a.publishedAt), time = a.body.match(/(?:з|із|о)\s*(\d{1,2}):(\d{2})/i);
  let effectiveAt = a.publishedAt;
  try {
    if (ds.length === 1 && time)
      effectiveAt = civil(ds[0], +time[1] * 60 + +time[2]);
  } catch {
    return null;
  }
  const scope = [
    ...new Set(
      [...text.matchAll(/(?:підчерг[а-яіїєґ]*\s*)([1-6]\.[12])/gi)].map(
        (m) => m[1]
      )
    )
  ];
  if (!/по області|по Черкаській області|у Черкаській області|на території.*област/i.test(
    text
  ) && !scope.length)
    return null;
  let validity = "unknown";
  if (/(?:продовжують діяти|діють).*графік[а-яіїєґ]* погодинн|погодинн[а-яіїєґ]*.*(?:продовжує діяти|продовжують діяти)/i.test(
    text
  ))
    validity = "active";
  if (/погодинн[а-яіїєґ]*.*(?:не діють|не діє|призупин|не застосов)|(?:призупинено|не діють).*погодинн/i.test(
    text
  ))
    validity = "suspended";
  let until = null;
  const end = a.body.match(/до\s+(\d{1,2}):(\d{2})/i);
  if (end && ds.length === 1) {
    try {
      until = civil(ds[0], +end[1] * 60 + +end[2]);
      if (until <= effectiveAt) until = null;
    } catch {
    }
  }
  return {
    id: a.id,
    publishedAt: a.publishedAt,
    effectiveAt,
    until,
    ended,
    validity,
    queues: scope,
    url: a.url
  };
}
function mergeHistory(old, next, now) {
  const byId = /* @__PURE__ */ new Map();
  for (const x of [...old, ...next])
    if (x.updatedAt >= now - 7 * 864e5 && x.updatedAt <= now + 3e5 && (!byId.has(x.id) || x.updatedAt > byId.get(x.id).updatedAt))
      byId.set(x.id, x);
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 150);
}

// server/provider-queue.js
function providerQueue(root) {
  const hourly = rows(root.DISCONN_QUEUQ || []).map((r) => r.QUEUE_INFO).filter((s) => typeof s === "string" && /погодин/i.test(s));
  const numbers = [...new Set(hourly.flatMap((s) => [...s.matchAll(/([1-6])\s*черга\s*([12])\s*підчерга/gi)].map((m) => m[1] + "." + m[2])))];
  const excluded = hourly.filter((s) => /в\s+чергу\s+не\s+включено/i.test(s)).length;
  const unknown = hourly.filter((s) => !/в\s+чергу\s+не\s+включено/i.test(s) && !/[1-6]\s*черга\s*[12]\s*підчерга/i.test(s)).length;
  if (numbers.length > 1 || numbers.length && excluded) return { queue: null, queueStatus: "ambiguous" };
  if (numbers.length === 1 && !unknown) return { queue: numbers[0], queueStatus: "matched" };
  if (hourly.length && excluded === hourly.length) return { queue: null, queueStatus: "not_in_queue", inclusion: "not_in_queue" };
  return { queue: null, queueStatus: numbers.length ? "partial_queue" : "queue_missing" };
}

// server/inflight-department.js
var InflightDepartmentRequests = class {
  constructor({ maxEntries = 3 } = {}) {
    this.maxEntries = maxEntries;
    this.entries = /* @__PURE__ */ new Map();
  }
  load(key, loader, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { controller: new AbortController(), consumers: 0, settled: false };
      if (this.entries.size < this.maxEntries) this.entries.set(key, entry);
      const remove = () => {
        entry.settled = true;
        if (this.entries.get(key) === entry) this.entries.delete(key);
      };
      entry.promise = Promise.resolve().then(() => {
        entry.controller.signal.throwIfAborted();
        return loader(entry.controller.signal);
      });
      entry.promise.then(remove, remove);
    }
    entry.consumers++;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (complete, value) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener("abort", aborted);
        entry.consumers--;
        if (!entry.consumers && !entry.settled) {
          if (this.entries.get(key) === entry) this.entries.delete(key);
          entry.controller.abort(new DOMException("No remaining department consumers", "AbortError"));
        }
        complete(value);
      };
      const aborted = () => finish(reject, signal.reason);
      entry.promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }
};

// server/source.js
var CABINET = "https://cabinet.cherkasyoblenergo.com/api_new/disconn.php";
async function jsonFetch(url, fetcher = fetch, limit = 8e6, signal) {
  const r = await fetcher(url, {
    headers: { Accept: "application/json" },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(2e4)]) : AbortSignal.timeout(2e4),
    redirect: "error"
  });
  if (!r.ok)
    throw new SourceError(
      r.status === 403 ? "forbidden" : r.status === 429 ? "rate_limited" : r.status >= 500 ? "server_error" : "http_error",
      r.status
    );
  const reader = r.body.getReader();
  let size = 0, chunks = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw Error("\u0417\u0430\u0432\u0435\u043B\u0438\u043A\u0430 \u0432\u0456\u0434\u043F\u043E\u0432\u0456\u0434\u044C");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let i = 0;
  for (const c of chunks) {
    all.set(c, i);
    i += c.length;
  }
  return JSON.parse(new TextDecoder().decode(all));
}
var norm = (s) => plain(s).toLowerCase().replace(/[’ʼ]/g, "'").replace(/^(місто|м\.)\s*/, "\u043C ").replace(/^(село|с\.)\s*/, "\u0441 ").replace(/^(вулиця|вул\.)\s*/, "\u0432\u0443\u043B ").replace(/^(провулок|пров\.)\s*/, "\u043F\u0440\u043E\u0432 ").replace(/\s+/g, " ").trim();
function matchesAddress(html, a) {
  const sections = [
    ...String(html).matchAll(/<strong\b[^>]*>(.*?)<\/strong>/gis)
  ];
  if (!sections.length || html.slice(0, sections[0].index).trim())
    throw Error("\u041D\u0435\u0432\u0456\u0434\u043E\u043C\u0438\u0439 \u0444\u043E\u0440\u043C\u0430\u0442 \u0430\u0434\u0440\u0435\u0441\u0438");
  let found = false;
  for (let i = 0; i < sections.length; i++) {
    const m = sections[i], body = html.slice(
      m.index + m[0].length,
      sections[i + 1]?.index ?? html.length
    );
    if (norm(m[1]) !== norm(a.city)) continue;
    for (const line of body.split(/<br\s*\/?>/i).map(norm).filter(Boolean)) {
      const prefix = norm(a.street) + " ";
      if (!line.startsWith(prefix)) continue;
      const hs = line.slice(prefix.length).split(",").map((x) => x.replace(/\s/g, ""));
      if (hs.some(
        (x) => !/^\d+[\p{L}]?(?:[/-][\d\p{L}]+)?$/u.test(x) || /^\d+-\d+$/.test(x)
      ))
        throw Error("\u041D\u0435\u043E\u0434\u043D\u043E\u0437\u043D\u0430\u0447\u043D\u0438\u0439 \u043F\u0435\u0440\u0435\u043B\u0456\u043A \u0431\u0443\u0434\u0438\u043D\u043A\u0456\u0432");
      if (hs.includes(norm(a.house).replace(/\s/g, ""))) found = true;
    }
  }
  return found;
}
var Source = class {
  constructor(fetcher = fetch, { dictionaries = null, feed = null, categories = null } = {}) {
    this.fetcher = fetcher;
    this.publicCache = null;
    this.pending = null;
    this.dictionaries = /* @__PURE__ */ new Map();
    this.sharedDictionaries = dictionaries;
    this.sharedFeed = feed;
    this.sharedCategories = categories;
    this.departmentRequests = new InflightDepartmentRequests();
  }
  request(params, signal) {
    const search = new URLSearchParams(params);
    const load = (requestSignal) => jsonFetch(CABINET + "?" + search, this.fetcher, 8e6, requestSignal);
    if (params.op !== "disconn_by_dept") return load(signal);
    const canonical = new URLSearchParams(search);
    canonical.sort();
    return this.departmentRequests.load(canonical.toString(), load, signal);
  }
  async dictionary(kind, args = {}) {
    const ops = {
      department: { op: "department_list" },
      city: { op: "city_list", dept_id: args.parent },
      street: { op: "street_list", city_id: args.parent, search_name: "" },
      house: { op: "house_list", street_id: args.parent, search_name: "" }
    };
    if (!ops[kind] || kind !== "department" && !/^[\w-]{1,100}$/.test(args.parent || ""))
      throw Error("\u041E\u0431\u0435\u0440\u0456\u0442\u044C \u0430\u0434\u0440\u0435\u0441\u0443");
    const key = JSON.stringify(ops[kind]), cached = this.dictionaries.get(key);
    if (cached && cached.at > Date.now() - 36e5) return cached.value;
    const load = async () => rows(await this.request(ops[kind])).map((x) => {
      const id = String(kind === "house" ? x.HOUSE : x.ID), name = String(kind === "house" ? x.HOUSE : x.NAME);
      if (id === "undefined" || name === "undefined")
        throw Error("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u0439 \u0434\u043E\u0432\u0456\u0434\u043D\u0438\u043A");
      return { id, name };
    });
    const result = this.sharedDictionaries ? await this.sharedDictionaries.load(`dictionary:${kind}:${kind === "department" ? "" : args.parent || ""}`, load) : { items: await load(), checkedAt: Date.now() };
    if (this.dictionaries.size > 300) this.dictionaries.clear();
    this.dictionaries.set(key, { at: result.checkedAt, value: result.items });
    return result.items;
  }
  async resolve(input) {
    const a = {};
    for (const k of ["department", "cityId", "streetId", "house"]) {
      if (typeof input[k] !== "string" || input[k].length > 120 || !input[k])
        throw Error("\u041E\u0431\u0435\u0440\u0456\u0442\u044C \u043F\u043E\u0432\u043D\u0443 \u0430\u0434\u0440\u0435\u0441\u0443");
      a[k] = input[k];
    }
    const depts = await this.dictionary("department");
    if (!depts.some((x) => x.id === a.department))
      throw Error("\u041D\u0435\u0432\u0456\u0434\u043E\u043C\u0430 \u0444\u0456\u043B\u0456\u044F");
    const cities = await this.dictionary("city", { parent: a.department }), city = cities.find((x) => x.id === a.cityId);
    if (!city) throw Error("\u041D\u0435\u0432\u0456\u0434\u043E\u043C\u0438\u0439 \u043D\u0430\u0441\u0435\u043B\u0435\u043D\u0438\u0439 \u043F\u0443\u043D\u043A\u0442");
    const streets = await this.dictionary("street", { parent: a.cityId }), street = streets.find((x) => x.id === a.streetId);
    if (!street) throw Error("\u041D\u0435\u0432\u0456\u0434\u043E\u043C\u0430 \u0432\u0443\u043B\u0438\u0446\u044F");
    const houses = await this.dictionary("house", { parent: a.streetId });
    if (!houses.some((x) => x.id === a.house)) throw Error("\u041D\u0435\u0432\u0456\u0434\u043E\u043C\u0438\u0439 \u0431\u0443\u0434\u0438\u043D\u043E\u043A");
    Object.assign(a, {
      city: city.name,
      street: street.name,
      label: `${city.name}, ${street.name}, ${a.house}`
    });
    const accounts = rows(
      await this.request({
        op: "ls_list_by_addr",
        street_id: a.streetId,
        house: a.house
      })
    ).map((x) => ({ account: String(x.LS), address: x.ADDRESS }));
    if (accounts.some(
      (x) => !/^\d{11}$/.test(x.account) || typeof x.address !== "string"
    ))
      throw Error("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0456 \u0434\u0430\u043D\u0456 \u0430\u0434\u0440\u0435\u0441\u0438");
    const unique = [...new Set(accounts.map((x) => x.account))];
    if (unique.length === 1) a.account = unique[0];
    return a;
  }
  async feed(now = Date.now(), previous = {}, { signal, force = false } = {}) {
    signal?.throwIfAborted();
    if (!force && this.publicCache && !this.publicCache.partial && this.publicCache.checkedAt > now - 36e5)
      return this.publicCache;
    if (!force && !previous.partial && previous.checkedAt > now - 36e5 && Array.isArray(previous.plans))
      return this.publicCache = previous;
    if (this.sharedFeed) {
      const value = await this.sharedFeed.load(previous, (old, ownedSignal) => this.loadFeed(now, old, ownedSignal), signal);
      if (!this.publicCache || (value.attemptedAt || value.checkedAt || 0) >= (this.publicCache.attemptedAt || this.publicCache.checkedAt || 0)) this.publicCache = value;
      return value;
    }
    if (this.pending) return this.pending;
    this.pending = this.loadFeed(now, previous, signal).then((v) => (this.publicCache = v, v)).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  async loadFeed(now, previous = {}, callerSignal) {
    const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(25e3)]) : AbortSignal.timeout(25e3);
    const items = [];
    for (let page = 0; page < 4; page++) {
      const r = await jsonFetch(
        `${ORIGIN}/api/v1/posts/category/news?lang=uk&page=${page}&size=10`,
        this.fetcher,
        8e6,
        signal
      );
      if (!r.success || !Array.isArray(r.data?.content))
        throw Error("\u041D\u0435\u0432\u0456\u0434\u043E\u043C\u0438\u0439 \u0444\u043E\u0440\u043C\u0430\u0442 \u043D\u043E\u0432\u0438\u043D");
      items.push(...r.data.content);
    }
    const candidates = items.filter(
      (x) => /гпв|погодинн.*відключ|аварійн.*відключ|технічн.*робот/i.test(
        x.title || ""
      )
    ).slice(0, 24), plans = new Map(
      (previous.plans || []).filter((p) => p.date >= addDays(dayKey(now), -7)).map((p) => [p.date + "/" + p.queue, p])
    ), emergencies = new Map((previous.emergencies || []).map((x) => [x.id, x])), messages = [], maintenance = (previous.maintenance || []).filter((m) => m.until > now);
    let failedArticles = 0, successfulArticles = 0, feedError;
    for (let offset = 0; offset < candidates.length; offset += 4) {
      const batch = await Promise.allSettled(
        candidates.slice(offset, offset + 4).map(async (item) => {
          if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,199}$/.test(item.slug))
            throw Error("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0435 \u0434\u0436\u0435\u0440\u0435\u043B\u043E");
          return article(
            await jsonFetch(
              `${ORIGIN}/api/v1/posts/${item.slug}?lang=uk`,
              this.fetcher,
              8e6,
              signal
            )
          );
        })
      );
      for (const result of batch) {
        if (result.status === "rejected") {
          failedArticles++;
          feedError ||= result.reason instanceof SourceError || ["TimeoutError", "AbortError"].includes(result.reason?.name) ? failureCode(result.reason) : "invalid_response";
          continue;
        }
        const a = result.value;
        if (a.publishedAt > now + 3e5) continue;
        try {
          for (const p of parsePlan(a, now)) {
            const key = p.date + "/" + p.queue, old = plans.get(key);
            if (!old || p.publishedAt >= old.publishedAt) {
              plans.set(key, p);
              const changed = old && old.revision !== p.revision;
              messages.push({
                id: `plan:${key}:${p.revision}`,
                date: p.date,
                queue: p.queue,
                title: `${changed || /оновлен/i.test(a.title) ? "\u041E\u043D\u043E\u0432\u043B\u0435\u043D\u043E" : "\u041E\u043F\u0443\u0431\u043B\u0456\u043A\u043E\u0432\u0430\u043D\u043E"} \u0433\u0440\u0430\u0444\u0456\u043A \u043D\u0430 ${p.date}`,
                updatedAt: changed && p.publishedAt <= old.publishedAt ? now : p.publishedAt,
                url: p.url,
                kind: "schedule",
                revisionType: changed ? "change" : (previous.messages || []).find((m) => m.id === `plan:${key}:${p.revision}`)?.revisionType || "publication"
              });
            }
          }
          const notice = parseMaintenance(a, now);
          if (notice) maintenance.push(notice);
          const e = parseEmergency(a);
          if (e) emergencies.set(e.id, e);
          successfulArticles++;
        } catch {
          failedArticles++;
          feedError ||= "invalid_response";
        }
      }
      if (signal.aborted) break;
    }
    if (candidates.length && !successfulArticles) throw new SourceError(feedError || "invalid_response");
    const partial = failedArticles > 0 || signal.aborted;
    return {
      plans: [...plans.values()],
      emergencies: [...emergencies.values()].filter(
        (e) => e.publishedAt > now - 7 * 864e5
      ),
      checkedAt: partial ? previous.checkedAt || null : now,
      attemptedAt: now,
      partial,
      failedArticles,
      ...partial ? { feedError: feedError || "timeout" } : {},
      messages,
      maintenance: [...new Map(maintenance.map((m) => [m.url, m])).values()]
    };
  }
  async address(a, now = Date.now(), previous = {}, { signal } = {}) {
    const format = (d) => d.split("-").reverse().join("."), base = {
      n_date: format(addDays(dayKey(now), -7)),
      k_date: format(addDays(dayKey(now), 1))
    };
    const categories = { ...previous.categories }, failures = [], errors = {};
    await Promise.all(
      ["planned", "emergency", "hourly"].map(async (category, selector) => {
        try {
          const load = async () => {
            const raw = await this.request({
              ...base,
              disconn_selector: String(selector),
              ...a.account ? { op: "disconn_by_ls", abon_ls: a.account } : { op: "disconn_by_dept", dept_id: a.department }
            }, signal);
            let root = raw;
            if (!a.account) {
              parseOutages(raw, category, now);
              const events = rows(raw.DISCONNECTIONS).filter((x) => {
                if (typeof x.ADDRESS !== "string") throw Error("\u041D\u0435\u043C\u0430\u0454 \u0430\u0434\u0440\u0435\u0441\u0438");
                return matchesAddress(x.ADDRESS, a);
              });
              root = { ...raw, DISCONNECTIONS: events, DISCONN_QUEUQ: [] };
            }
            const next2 = parseOutages(root, category, now);
            if (category === "hourly") Object.assign(next2, providerQueue(root));
            return next2;
          };
          const scope = [category === "planned" ? "address-types-v2" : "address-v1", a.account ? ["account", a.account] : ["address", a.department, a.cityId, a.streetId, a.house, a.city, a.street], category, base.n_date, base.k_date];
          const next = this.sharedCategories ? await this.sharedCategories.load(scope, load, signal) : await load();
          const historical = (previous.categories?.[category]?.events || []).filter(
            (e) => e.end && e.end <= now && e.start >= now - 7 * 864e5
          );
          next.events = [
            ...new Map(
              [...historical, ...next.events].map((e) => [
                `${e.start}/${e.end}`,
                e
              ])
            ).values()
          ];
          categories[category] = next;
        } catch (error) {
          errors[category] = error instanceof TypeError || error?.name === "TimeoutError" || error?.name === "AbortError" || error instanceof SourceError ? failureCode(error) : "invalid_response";
          failures.push(category);
        }
      })
    );
    return {
      categories,
      failures,
      errors,
      queue: categories.hourly?.queue || null,
      checkedAt: now
    };
  }
  async weather(city) {
    const name = city.replace(/^(м\.|с\.|смт\.?|с-ще|місто|село|селище)\s*/i, "").trim();
    let location;
    if (name.toLowerCase() === "\u0445\u0440\u0438\u0441\u0442\u0438\u043D\u0456\u0432\u043A\u0430" && /^(м\.|місто)/i.test(city))
      location = { latitude: 48.81282, longitude: 29.96885 };
    if (name.toLowerCase() === "\u0445\u0440\u0438\u0441\u0442\u0438\u043D\u0456\u0432\u043A\u0430" && /^(с\.|село)/i.test(city))
      location = { latitude: 48.84958, longitude: 29.96641 };
    if (!location) {
      for (const query of [.../* @__PURE__ */ new Set([name, latin(name)])]) {
        const geo = await jsonFetch(
          "https://geocoding-api.open-meteo.com/v1/search?" + new URLSearchParams({
            name: query,
            count: "100",
            language: "uk",
            format: "json"
          }),
          this.fetcher
        );
        const exact = (geo.results || []).filter(
          (x) => x.country_code === "UA" && /Cherkasy|Черкаськ/i.test(x.admin1 || "") && latin(x.name) === latin(name)
        );
        const unique = [
          ...new Map(
            exact.map((x) => [`${x.latitude},${x.longitude}`, x])
          ).values()
        ];
        if (unique.length === 1) {
          location = unique[0];
          break;
        }
      }
    }
    if (!location)
      throw Error("\u041D\u0435 \u0432\u0434\u0430\u043B\u043E\u0441\u044F \u043E\u0434\u043D\u043E\u0437\u043D\u0430\u0447\u043D\u043E \u0432\u0438\u0437\u043D\u0430\u0447\u0438\u0442\u0438 \u043D\u0430\u0441\u0435\u043B\u0435\u043D\u0438\u0439 \u043F\u0443\u043D\u043A\u0442");
    const forecast = await jsonFetch(
      "https://api.open-meteo.com/v1/forecast?" + new URLSearchParams({
        latitude: String(location.latitude),
        longitude: String(location.longitude),
        current: "temperature_2m,weather_code,is_day",
        hourly: "temperature_2m,weather_code,is_day",
        forecast_days: "2",
        timezone: "UTC",
        timeformat: "unixtime"
      }),
      this.fetcher
    );
    if (!Number.isFinite(forecast.current?.temperature_2m))
      throw Error("\u041D\u0435\u043C\u0430\u0454 \u043F\u043E\u0433\u043E\u0434\u0438");
    return {
      city,
      checkedAt: Date.now(),
      temperature: forecast.current.temperature_2m,
      code: forecast.current.weather_code,
      isDay: forecast.current.is_day === 1,
      hours: forecast.hourly.time.map((t, i) => ({
        time: t * 1e3,
        temp: forecast.hourly.temperature_2m[i],
        code: forecast.hourly.weather_code[i],
        isDay: forecast.hourly.is_day[i] === 1
      })).filter((x) => x.time >= Date.now() - 36e5).slice(0, 24)
    };
  }
};
function latin(text) {
  const letters = {
    \u0430: "a",
    \u0431: "b",
    \u0432: "v",
    \u0433: "h",
    \u0491: "g",
    \u0434: "d",
    \u0435: "e",
    \u0436: "zh",
    \u0437: "z",
    \u0438: "y",
    \u0456: "i",
    \u043A: "k",
    \u043B: "l",
    \u043C: "m",
    \u043D: "n",
    \u043E: "o",
    \u043F: "p",
    \u0440: "r",
    \u0441: "s",
    \u0442: "t",
    \u0443: "u",
    \u0444: "f",
    \u0445: "kh",
    \u0446: "ts",
    \u0447: "ch",
    \u0448: "sh",
    \u0449: "shch",
    \u044C: ""
  }, special = {
    \u0454: ["ye", "ie"],
    \u0457: ["yi", "i"],
    \u0439: ["y", "i"],
    \u044E: ["yu", "iu"],
    \u044F: ["ya", "ia"]
  };
  const n = text.toLowerCase().replace(/[’'ʼ]/g, "");
  return [...n].map(
    (c, i) => special[c]?.[!i || /[ -]/.test(n[i - 1]) ? 0 : 1] ?? (c === "\u0433" && n[i - 1] === "\u0437" ? "gh" : letters[c] ?? c)
  ).join("");
}
function parseMaintenance(a, now) {
  const text = a.title + " " + a.body;
  if (!/технічн.*робот/i.test(a.title) || /непобутов|юридичн/i.test(text) || !/(?:кабінет[а-яіїєґ]* побутов|api_new|api побутов)/i.test(text) || /завершено|відновлено|скасовано/i.test(a.title) || now < a.publishedAt || now - a.publishedAt > 864e5)
    return null;
  const date = dayKey(a.publishedAt), untilText = a.body.match(/до\s+(\d{1,2}):(\d{2})/i);
  if (!untilText) return null;
  const mentioned = [...text.matchAll(/\b(\d{2})\.(\d{2})\.(20\d{2})\b/g)].map(
    (m) => `${m[3]}-${m[2]}-${m[1]}`
  );
  mentioned.push(
    ...[...text.matchAll(/\b20\d{2}-\d{2}-\d{2}\b/g)].map((m) => m[0])
  );
  if (mentioned.some((d) => d !== date)) return null;
  try {
    const end = civil(date, +untilText[1] * 60 + +untilText[2]);
    if (end <= now || end <= a.publishedAt) return null;
    return {
      url: a.url,
      publishedAt: a.publishedAt,
      from: a.publishedAt,
      until: end,
      service: "household"
    };
  } catch {
    return null;
  }
}

// server/operator-chain.js
var operator_chain_default = [{ "fromDate": "2021-03-22T00:00:00+00:00", "toDate": "2036-03-21T23:59:59+00:00", "tbs": "MIIENKADAgECAhA5embMJ1Y2Lg2qh8puq+OxMA0GCSqGSIb3DQEBDAUAMF8xCzAJBgNVBAYTAkdCMRgwFgYDVQQKEw9TZWN0aWdvIExpbWl0ZWQxNjA0BgNVBAMTLVNlY3RpZ28gUHVibGljIFNlcnZlciBBdXRoZW50aWNhdGlvbiBSb290IFI0NjAeFw0yMTAzMjIwMDAwMDBaFw0zNjAzMjEyMzU5NTlaMGAxCzAJBgNVBAYTAkdCMRgwFgYDVQQKEw9TZWN0aWdvIExpbWl0ZWQxNzA1BgNVBAMTLlNlY3RpZ28gUHVibGljIFNlcnZlciBBdXRoZW50aWNhdGlvbiBDQSBEViBSMzYwggGiMA0GCSqGSIb3DQEBAQUAA4IBjwAwggGKAoIBgQCWNl/YcjPv5I9Q9AJA5tlhyvEtMdh1/Vm0xF7th6pE9LDKDPXqon1wBa1Y1Ny4gJz76nwNy3vM0bEKmqYS2qJ87s2+4Hl0RV7Fef1EUUfXYeb4209FCBcgWPHoxIlw1a5U7dcYTnsvWYeVxBiP6DiGfL3RoWHZIJkIMRWQCNoQwx9g8q4KMe64X5vMcVv/2BXw/356RwcQ0XadHV58ZZIrCd8blFrCWRpAOlG1lOYzrhMiy/+vtzIU7idKOzWMt1dh3PmrdrgvQ2hptl9t3FVv4JQQd8HRum6VlC0fVG/fx7+Uh0/s5NMiVmHo5gvo2HE/xKjT+yG3/gn2aogbFEVzT+kLyy6Nr7BwhSdrQcGlcp9dMqnOCKz7OZcMvToBIl/kTgDb+b4enpvzix88DBDvrqsjrmaHnRLQOL0Tc+fZZxolz48guwGZimC2aBZNH15X2i18pFQF/MdQdxWBqu5v9eW4SlGVO1m51TnFsU3HH8OAytctQA9ojrR9nrAD49MCAwEAAaOCAYEwggF9MB8GA1UdIwQYMBaAFFZzWGSV+ZIasBIqBGJ5oUAViCFJMB0GA1UdDgQWBBRowBIWGA6vzvaHpjJXo0ZRXcsHJzAOBgNVHQ8BAf8EBAMCAYYwEgYDVR0TAQH/BAgwBgEB/wIBADAdBgNVHSUEFjAUBggrBgEFBQcDAQYIKwYBBQUHAwIwGwYDVR0gBBQwEjAGBgRVHSAAMAgGBmeBDAECATBUBgNVHR8ETTBLMEmgR6BFhkNodHRwOi8vY3JsLnNlY3RpZ28uY29tL1NlY3RpZ29QdWJsaWNTZXJ2ZXJBdXRoZW50aWNhdGlvblJvb3RSNDYuY3JsMIGEBggrBgEFBQcBAQR4MHYwTwYIKwYBBQUHMAKGQ2h0dHA6Ly9jcnQuc2VjdGlnby5jb20vU2VjdGlnb1B1YmxpY1NlcnZlckF1dGhlbnRpY2F0aW9uUm9vdFI0Ni5wN2MwIwYIKwYBBQUHMAGGF2h0dHA6Ly9vY3NwLnNlY3RpZ28uY29t", "signature": "YtOC9Fy+TqECFw40IospI92kLGgoSZGPOSQXMBqmsGWZUQ7rux7cj1du6d9rD6C8ze1B2eQjkrGkIL/OF1s7vSmgYVafsRoZd/IHUrkoQvX8FZwUsmPu7amgBfaY3g+dq1x0jNGKb6I6Bzdl6LgMD9qxp+3i7GQOnd9J8LFSietY6Z4jUBzVoOoz8iAU84OFh2HhAuiPw1ai0VnY38RTI+8kepGWVfGxfBWzwH9uIjeooIeaosVFvE8cmYUB4TSH5dUyD0jHct2+8ceKEtIoFU/FfHq/mDaVnvcDCZXtIgitdMFQdMZaVehmObyhRdDD4NQCs0gaI9AAgFj4L9QtkARzhQLNyRf87Kln+YU0lgCGr9HLg3rGO8q+Y4ppLsOdunQZ6ZxPNGIfOApbPVf5hCe58EZwiWdHIMn9lPP6+F404y8NNugbQixBber+x536WrZhFZLjEkhp7fFXf9r32rNPfb74X/U90Bdy4lzp3+X1ukh1BuMxA/EEhDoTOS3l7ABvc7BYSQubQ2490OcdkIzUh3ZwDrakMVrbaTxUM2p24N6dB+ns2zptWCva6jzWr8IWKIMxzxLPv5Kt3ePKcUdvkBU/smqujSczTzzSjIoR5QqQA6lN1ZRSnuHIWCvhJEltkYnTAH41QJ6SAWO66GrrUESwN/cgZzL4JLEqz1Y=", "issuerKey": "MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAk77VNlJ12AEjoBxHQknuY7a3If3EldVIKyZ8FFMQ2nn9K7ctpNQs+uoy3UnCub0PSD17WphUr55dMXRPB/xQId2kz2hPGxJjbSWZTCqZ80gwYfqBfB6nCErcPiscHxhMcao1jK34bug7StnllALWiYQTqm3ITzPMUJY3kjPcX4jnn1TZSPCYQ9Zm/Z8XOEPFAVEL1+MjDxRdWxTnS77d9MjaAzfR1jmhIVEwg7Bt1zBOlluR8HAkq79FgWRDDb0hOi886Z4NyyC1QifM2m+b7mQwkDnNk2WBITG1I1AzNyLjOO34MTDMRf5i+dFdMnlCh99qzFYZQE3Oqrv5tXZJlPEn+JGlg+UGs2MOgNzgElWApjtmtDmHLcjw0NEU6eQNTQ72XVdyxTscR1ad4tX7gWGMzE2AkDRbt9cUddzYBEifwMEoiLTpHMqnsfFWt3tJTFnlIBWohAIp+jiUaZpJBo/NH3kUFxIMg3reH7GX7vmXeCikyESS6X0mBaZYcpt5E9gRX67FOGI0aLKGMI74kGGeMmz1BzbNokxu7Io27fLmmRVEcMN8vJw5wLTha/eDJSNX2RKA5UnwdQ/vjescm1QotCE8/HwK/+97a3X/ix2gGQWr+vgrgULoOLq7+6r9PeDzyt9Ol5cp7fMYVumllqy9w5CYsuD5otSmR0N8bc8CAwEAAQ==", "hash": "SHA-384" }, { "fromDate": "2021-03-22T00:00:00+00:00", "toDate": "2038-01-18T23:59:59+00:00", "tbs": "MIIEfaADAgECAhEA0n+7wd41nlIWrWFJWGCZxDANBgkqhkiG9w0BAQwFADCBiDELMAkGA1UEBhMCVVMxEzARBgNVBAgTCk5ldyBKZXJzZXkxFDASBgNVBAcTC0plcnNleSBDaXR5MR4wHAYDVQQKExVUaGUgVVNFUlRSVVNUIE5ldHdvcmsxLjAsBgNVBAMTJVVTRVJUcnVzdCBSU0EgQ2VydGlmaWNhdGlvbiBBdXRob3JpdHkwHhcNMjEwMzIyMDAwMDAwWhcNMzgwMTE4MjM1OTU5WjBfMQswCQYDVQQGEwJHQjEYMBYGA1UEChMPU2VjdGlnbyBMaW1pdGVkMTYwNAYDVQQDEy1TZWN0aWdvIFB1YmxpYyBTZXJ2ZXIgQXV0aGVudGljYXRpb24gUm9vdCBSNDYwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQCTvtU2UnXYASOgHEdCSe5jtrch/cSV1UgrJnwUUxDaef0rty2k1Cz66jLdScK5vQ9IPXtamFSvnl0xdE8H/FAh3aTPaE8bEmNtJZlMKpnzSDBh+oF8HqcIStw+KxwfGExxqjWMrfhu6DtK2eWUAtaJhBOqbchPM8xQljeSM9xfiOefVNlI8JhD1mb9nxc4Q8UBUQvX4yMPFF1bFOdLvt30yNoDN9HWOaEhUTCDsG3XME6WW5HwcCSrv0WBZEMNvSE6Lzzpng3LILVCJ8zab5vuZDCQOc2TZYEhMbUjUDM3IuM47fgxMMxF/mL50V0yeUKH32rMVhlATc6qu/m1dkmU8Sf4kaWD5QazYw6A3OASVYCmO2a0OYctyPDQ0RTp5A1NDvZdV3LFOxxHVp3i1fuBYYzMTYCQNFu31xR13NgESJ/AwSiItOkcyqex8Va3e0lMWeUgFaiEAin6OJRpmkkGj80feRQXEgyDet4fsZfu+Zd4KKTIRJLpfSYFplhym3kT2BFfrsU4YjRosoYwjviQYZ4ybPUHNs2iTG7sijbt8uaZFURww3y8nDnAtOFr94MlI1fZEoDlSfB1D++N6xybVCi0ITz8fAr/73trdf+LHaAZBav6+CuBQug4urv7qv094PPK306Xlynt8xhW6aWWrL3DkJiy4Pmi1KZHQ3xtzwIDAQABo4IBIDCCARwwHwYDVR0jBBgwFoAUU3m/WqorSs9UgOHYm8Cd8rIDZsswHQYDVR0OBBYEFFZzWGSV+ZIasBIqBGJ5oUAViCFJMA4GA1UdDwEB/wQEAwIBhjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdJQQWMBQGCCsGAQUFBwMBBggrBgEFBQcDAjARBgNVHSAECjAIMAYGBFUdIAAwUAYDVR0fBEkwRzBFoEOgQYY/aHR0cDovL2NybC51c2VydHJ1c3QuY29tL1VTRVJUcnVzdFJTQUNlcnRpZmljYXRpb25BdXRob3JpdHkuY3JsMDUGCCsGAQUFBwEBBCkwJzAlBggrBgEFBQcwAYYZaHR0cDovL29jc3AudXNlcnRydXN0LmNvbQ==", "signature": "Om8EiWrtsxTRwUNP/0/34GyAKRGBCzRLoF/u8lKVYwfBvLRUa/EJLSGtuLQrYEg1lsRuxWyClCrTjjfXLKhWfceV2iuCrbhGV1EM46KkRkNMUH3AL0di3W2EcXTRd4bYLwoLWmXCgTMoAiE+958j8LdxPQJ9Ncm4WNRsoiBLCM2PDpge0uCjL+F3n4ktSUtyj+DMVf+pZtPu0Sq44ximw0pZmPxMuo+rrMyIbg1rp94Rm17pg9casxaVNY3fjW8N51z7LFCpK6Dv0clRBw5mzsrINbO2Zp5DGw8Tj1RX/xfCt9m1lpjKuzgWkP3hnhDx3NcYvz6oQmPGBzNrtbo9E5oKW5tq93VUo+bz5oJbvu7tLGlHZMUYvqQ93GwrIWKOly6dHlXv2xTJE5813OOsBwVZlcryxtv0WWfC5Ubrvsku/5lVNfkDEu9bk4HjO3m5L7MHrbAn9a/6NcYC21IBwl5ziIWAJYdG92L+MmhLNEtrecTPHqkUjNyVIKeHS7XEJ4txQHKlKI+Brxb7o+S6jJCrxT2qz0SjEbk2+u+XKyHBRL3K9xlEbDsuOXHiMkf8GEg9HyQgEJCPW+dr1POJk6vDU5/yENRscoUb0+bwOna9uPP/Ykff2q/GyE8pWWUZ+r7mSU+bvJlFRhOIIwBurA10v+eyoXZGefKnnxdFK0k=", "issuerKey": "MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAgBJlFzYOw9sIs9CsVw127c0n00ytUINh4qogTQktZAnczomfzD2p7PbPwdzx07HWezcoEStH2jnGvDoZtF+mvX2do2NCtnbyqTsrkfjib9DsFiCQCT7i6HTJGLSR1GJk23+jBvGIGGqQIjy8/hPwhxR79uQfjtTkUcYRZ0YIUcuGFFQ/vDP+fmyc/xadGL1RjjWmp2bIcmfbIWax1Jt4A8BQOujM8Ny8nkz+rwWWNR9XWrf/zvk9tyy29lTdyOcSOk2uTIq3XJq0tyA9yn8iNK5+O2hmAUTnAU5GU5szYPeUvlM3kHND8zLDU+/bqv50TmnHa4xgk97Exwzf4TKuzJM7UXiVZ4vuPVb+DNBpDxsP8yUmazNt925H+nND5X4OpWaxKXwyhGNVicQNwZNUMBkTrNN9N6frXTpsNVzbQdcS2qlJC9/YgIoJk2KOtWbPJYjNhLixP6Q5D9kCnusSTJV882sFqV4Wg8y4Z+LoE53MW4LTTLPtW//e5XOsIzstAL81VXQJSdhJWBp/kjbmUZIO8yZ9HE0XvMnsQybQv0FfQKlERPSZ51eHnlAfV1SoPv10Yy+xUGUJ5lhCLkMaTLTwJUdZ+gQek9QmRkpQgbLevni3/GcV4clXhB4PY9bpYrrWX1Uu6lzGKAgEJTm4Diup8kyXHAc/DVL17e8vgg8CAwEAAQ==", "hash": "SHA-384" }];

// server/operator-certificates.js
var operator_certificates_default = ["-----BEGIN CERTIFICATE-----\nMIIGTDCCBDSgAwIBAgIQOXpmzCdWNi4NqofKbqvjsTANBgkqhkiG9w0BAQwFADBf\nMQswCQYDVQQGEwJHQjEYMBYGA1UEChMPU2VjdGlnbyBMaW1pdGVkMTYwNAYDVQQD\nEy1TZWN0aWdvIFB1YmxpYyBTZXJ2ZXIgQXV0aGVudGljYXRpb24gUm9vdCBSNDYw\nHhcNMjEwMzIyMDAwMDAwWhcNMzYwMzIxMjM1OTU5WjBgMQswCQYDVQQGEwJHQjEY\nMBYGA1UEChMPU2VjdGlnbyBMaW1pdGVkMTcwNQYDVQQDEy5TZWN0aWdvIFB1Ymxp\nYyBTZXJ2ZXIgQXV0aGVudGljYXRpb24gQ0EgRFYgUjM2MIIBojANBgkqhkiG9w0B\nAQEFAAOCAY8AMIIBigKCAYEAljZf2HIz7+SPUPQCQObZYcrxLTHYdf1ZtMRe7Yeq\nRPSwygz16qJ9cAWtWNTcuICc++p8Dct7zNGxCpqmEtqifO7NvuB5dEVexXn9RFFH\n12Hm+NtPRQgXIFjx6MSJcNWuVO3XGE57L1mHlcQYj+g4hny90aFh2SCZCDEVkAja\nEMMfYPKuCjHuuF+bzHFb/9gV8P9+ekcHENF2nR1efGWSKwnfG5RawlkaQDpRtZTm\nM64TIsv/r7cyFO4nSjs1jLdXYdz5q3a4L0NoabZfbdxVb+CUEHfB0bpulZQtH1Rv\n38e/lIdP7OTTIlZh6OYL6NhxP8So0/sht/4J9mqIGxRFc0/pC8suja+wcIUna0HB\npXKfXTKpzgis+zmXDL06ASJf5E4A2/m+Hp6b84sfPAwQ766rI65mh50S0Di9E3Pn\n2WcaJc+PILsBmYpgtmgWTR9eV9otfKRUBfzHUHcVgarub/XluEpRlTtZudU5xbFN\nxx/DgMrXLUAPaI60fZ6wA+PTAgMBAAGjggGBMIIBfTAfBgNVHSMEGDAWgBRWc1hk\nlfmSGrASKgRieaFAFYghSTAdBgNVHQ4EFgQUaMASFhgOr872h6YyV6NGUV3LBycw\nDgYDVR0PAQH/BAQDAgGGMBIGA1UdEwEB/wQIMAYBAf8CAQAwHQYDVR0lBBYwFAYI\nKwYBBQUHAwEGCCsGAQUFBwMCMBsGA1UdIAQUMBIwBgYEVR0gADAIBgZngQwBAgEw\nVAYDVR0fBE0wSzBJoEegRYZDaHR0cDovL2NybC5zZWN0aWdvLmNvbS9TZWN0aWdv\nUHVibGljU2VydmVyQXV0aGVudGljYXRpb25Sb290UjQ2LmNybDCBhAYIKwYBBQUH\nAQEEeDB2ME8GCCsGAQUFBzAChkNodHRwOi8vY3J0LnNlY3RpZ28uY29tL1NlY3Rp\nZ29QdWJsaWNTZXJ2ZXJBdXRoZW50aWNhdGlvblJvb3RSNDYucDdjMCMGCCsGAQUF\nBzABhhdodHRwOi8vb2NzcC5zZWN0aWdvLmNvbTANBgkqhkiG9w0BAQwFAAOCAgEA\nYtOC9Fy+TqECFw40IospI92kLGgoSZGPOSQXMBqmsGWZUQ7rux7cj1du6d9rD6C8\nze1B2eQjkrGkIL/OF1s7vSmgYVafsRoZd/IHUrkoQvX8FZwUsmPu7amgBfaY3g+d\nq1x0jNGKb6I6Bzdl6LgMD9qxp+3i7GQOnd9J8LFSietY6Z4jUBzVoOoz8iAU84OF\nh2HhAuiPw1ai0VnY38RTI+8kepGWVfGxfBWzwH9uIjeooIeaosVFvE8cmYUB4TSH\n5dUyD0jHct2+8ceKEtIoFU/FfHq/mDaVnvcDCZXtIgitdMFQdMZaVehmObyhRdDD\n4NQCs0gaI9AAgFj4L9QtkARzhQLNyRf87Kln+YU0lgCGr9HLg3rGO8q+Y4ppLsOd\nunQZ6ZxPNGIfOApbPVf5hCe58EZwiWdHIMn9lPP6+F404y8NNugbQixBber+x536\nWrZhFZLjEkhp7fFXf9r32rNPfb74X/U90Bdy4lzp3+X1ukh1BuMxA/EEhDoTOS3l\n7ABvc7BYSQubQ2490OcdkIzUh3ZwDrakMVrbaTxUM2p24N6dB+ns2zptWCva6jzW\nr8IWKIMxzxLPv5Kt3ePKcUdvkBU/smqujSczTzzSjIoR5QqQA6lN1ZRSnuHIWCvh\nJEltkYnTAH41QJ6SAWO66GrrUESwN/cgZzL4JLEqz1Y=\n-----END CERTIFICATE-----\n", "-----BEGIN CERTIFICATE-----\nMIIGlTCCBH2gAwIBAgIRANJ/u8HeNZ5SFq1hSVhgmcQwDQYJKoZIhvcNAQEMBQAw\ngYgxCzAJBgNVBAYTAlVTMRMwEQYDVQQIEwpOZXcgSmVyc2V5MRQwEgYDVQQHEwtK\nZXJzZXkgQ2l0eTEeMBwGA1UEChMVVGhlIFVTRVJUUlVTVCBOZXR3b3JrMS4wLAYD\nVQQDEyVVU0VSVHJ1c3QgUlNBIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MB4XDTIx\nMDMyMjAwMDAwMFoXDTM4MDExODIzNTk1OVowXzELMAkGA1UEBhMCR0IxGDAWBgNV\nBAoTD1NlY3RpZ28gTGltaXRlZDE2MDQGA1UEAxMtU2VjdGlnbyBQdWJsaWMgU2Vy\ndmVyIEF1dGhlbnRpY2F0aW9uIFJvb3QgUjQ2MIICIjANBgkqhkiG9w0BAQEFAAOC\nAg8AMIICCgKCAgEAk77VNlJ12AEjoBxHQknuY7a3If3EldVIKyZ8FFMQ2nn9K7ct\npNQs+uoy3UnCub0PSD17WphUr55dMXRPB/xQId2kz2hPGxJjbSWZTCqZ80gwYfqB\nfB6nCErcPiscHxhMcao1jK34bug7StnllALWiYQTqm3ITzPMUJY3kjPcX4jnn1TZ\nSPCYQ9Zm/Z8XOEPFAVEL1+MjDxRdWxTnS77d9MjaAzfR1jmhIVEwg7Bt1zBOlluR\n8HAkq79FgWRDDb0hOi886Z4NyyC1QifM2m+b7mQwkDnNk2WBITG1I1AzNyLjOO34\nMTDMRf5i+dFdMnlCh99qzFYZQE3Oqrv5tXZJlPEn+JGlg+UGs2MOgNzgElWApjtm\ntDmHLcjw0NEU6eQNTQ72XVdyxTscR1ad4tX7gWGMzE2AkDRbt9cUddzYBEifwMEo\niLTpHMqnsfFWt3tJTFnlIBWohAIp+jiUaZpJBo/NH3kUFxIMg3reH7GX7vmXeCik\nyESS6X0mBaZYcpt5E9gRX67FOGI0aLKGMI74kGGeMmz1BzbNokxu7Io27fLmmRVE\ncMN8vJw5wLTha/eDJSNX2RKA5UnwdQ/vjescm1QotCE8/HwK/+97a3X/ix2gGQWr\n+vgrgULoOLq7+6r9PeDzyt9Ol5cp7fMYVumllqy9w5CYsuD5otSmR0N8bc8CAwEA\nAaOCASAwggEcMB8GA1UdIwQYMBaAFFN5v1qqK0rPVIDh2JvAnfKyA2bLMB0GA1Ud\nDgQWBBRWc1hklfmSGrASKgRieaFAFYghSTAOBgNVHQ8BAf8EBAMCAYYwDwYDVR0T\nAQH/BAUwAwEB/zAdBgNVHSUEFjAUBggrBgEFBQcDAQYIKwYBBQUHAwIwEQYDVR0g\nBAowCDAGBgRVHSAAMFAGA1UdHwRJMEcwRaBDoEGGP2h0dHA6Ly9jcmwudXNlcnRy\ndXN0LmNvbS9VU0VSVHJ1c3RSU0FDZXJ0aWZpY2F0aW9uQXV0aG9yaXR5LmNybDA1\nBggrBgEFBQcBAQQpMCcwJQYIKwYBBQUHMAGGGWh0dHA6Ly9vY3NwLnVzZXJ0cnVz\ndC5jb20wDQYJKoZIhvcNAQEMBQADggIBADpvBIlq7bMU0cFDT/9P9+BsgCkRgQs0\nS6Bf7vJSlWMHwby0VGvxCS0hrbi0K2BINZbEbsVsgpQq04431yyoVn3Hldorgq24\nRldRDOOipEZDTFB9wC9HYt1thHF00XeG2C8KC1plwoEzKAIhPvefI/C3cT0CfTXJ\nuFjUbKIgSwjNjw6YHtLgoy/hd5+JLUlLco/gzFX/qWbT7tEquOMYpsNKWZj8TLqP\nq6zMiG4Na6feEZte6YPXGrMWlTWN341vDedc+yxQqSug79HJUQcOZs7KyDWztmae\nQxsPE49UV/8XwrfZtZaYyrs4FpD94Z4Q8dzXGL8+qEJjxgcza7W6PROaClubavd1\nVKPm8+aCW77u7SxpR2TFGL6kPdxsKyFijpcunR5V79sUyROfNdzjrAcFWZXK8sbb\n9FlnwuVG677JLv+ZVTX5AxLvW5OB4zt5uS+zB62wJ/Wv+jXGAttSAcJec4iFgCWH\nRvdi/jJoSzRLa3nEzx6pFIzclSCnh0u1xCeLcUBypSiPga8W+6PkuoyQq8U9qs9E\noxG5NvrvlyshwUS9yvcZRGw7Ljlx4jJH/BhIPR8kIBCQj1vna9TziZOrw1Of8hDU\nbHKFG9Pm8Dp2vbjz/2JH39qvxshPKVllGfq+5klPm7yZRUYTiCMAbqwNdL/nsqF2\nRnnyp58XRStJ\n-----END CERTIFICATE-----\n", "-----BEGIN CERTIFICATE-----\nMIIF3jCCA8agAwIBAgIQAf1tMPyjylGoG7xkDjUDLTANBgkqhkiG9w0BAQwFADCB\niDELMAkGA1UEBhMCVVMxEzARBgNVBAgTCk5ldyBKZXJzZXkxFDASBgNVBAcTC0pl\ncnNleSBDaXR5MR4wHAYDVQQKExVUaGUgVVNFUlRSVVNUIE5ldHdvcmsxLjAsBgNV\nBAMTJVVTRVJUcnVzdCBSU0EgQ2VydGlmaWNhdGlvbiBBdXRob3JpdHkwHhcNMTAw\nMjAxMDAwMDAwWhcNMzgwMTE4MjM1OTU5WjCBiDELMAkGA1UEBhMCVVMxEzARBgNV\nBAgTCk5ldyBKZXJzZXkxFDASBgNVBAcTC0plcnNleSBDaXR5MR4wHAYDVQQKExVU\naGUgVVNFUlRSVVNUIE5ldHdvcmsxLjAsBgNVBAMTJVVTRVJUcnVzdCBSU0EgQ2Vy\ndGlmaWNhdGlvbiBBdXRob3JpdHkwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIK\nAoICAQCAEmUXNg7D2wiz0KxXDXbtzSfTTK1Qg2HiqiBNCS1kCdzOiZ/MPans9s/B\n3PHTsdZ7NygRK0faOca8Ohm0X6a9fZ2jY0K2dvKpOyuR+OJv0OwWIJAJPuLodMkY\ntJHUYmTbf6MG8YgYapAiPLz+E/CHFHv25B+O1ORRxhFnRghRy4YUVD+8M/5+bJz/\nFp0YvVGONaanZshyZ9shZrHUm3gDwFA66Mzw3LyeTP6vBZY1H1dat//O+T23LLb2\nVN3I5xI6Ta5MirdcmrS3ID3KfyI0rn47aGYBROcBTkZTmzNg95S+UzeQc0PzMsNT\n79uq/nROacdrjGCT3sTHDN/hMq7MkztReJVni+49Vv4M0GkPGw/zJSZrM233bkf6\nc0Plfg6lZrEpfDKEY1WJxA3Bk1QwGROs0303p+tdOmw1XNtB1xLaqUkL39iAigmT\nYo61Zs8liM2EuLE/pDkP2QKe6xJMlXzzawWpXhaDzLhn4ugTncxbgtNMs+1b/97l\nc6wjOy0AvzVVdAlJ2ElYGn+SNuZRkg7zJn0cTRe8yexDJtC/QV9AqURE9JnnV4ee\nUB9XVKg+/XRjL7FQZQnmWEIuQxpMtPAlR1n6BB6T1CZGSlCBst6+eLf8ZxXhyVeE\nHg9j1uliutZfVS7qXMYoCAQlObgOK6nyTJccBz8NUvXt7y+CDwIDAQABo0IwQDAd\nBgNVHQ4EFgQUU3m/WqorSs9UgOHYm8Cd8rIDZsswDgYDVR0PAQH/BAQDAgEGMA8G\nA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQEMBQADggIBAFzUfA3P9wF9QZllDHPF\nUp/L+M+ZBn8b2kMVn54CVVeWFPFSPCeHlCjtHzoBN6J2/FNQwISbxmtOuowhT6KO\nVWKR82kV2LyI48SqC/3vqOlLVSoGIG1VeCkZ7l8wXEskEVX/JJpuXior7gtNn3/3\nATiUFJVDBwn7YKnuHKsSjKCaXqeYalltiz8I+8jRRa8YFWSQEg9zKC7F4iRO/Fjs\n8PRF/iKz6y+O0tlFYQXBl2+odnKPi4w2r78NBc5xjeambx9spnFixdjQg3IM8WcR\niQycE0xyNN+81XHfqnHd4blsjDwSXWXavVcStkNr/+XeTWYRUc+ZruwXtuhxkYze\nSf7dNXGiFSeUHM9h4ya7b6NnJSFd5t0dCy5oGzuCr+yDZ4XUmFF0sbmZgIn/f3gZ\nXHlKYC6SQK5MNyosycdiyA5d9zZbyuAlJQG03RoHnHcAP9Dc1ew91Pq7P8yF1m9/\nqS3fuQL39ZeatTXaw2ewh0qpKJ4jjv9cJ2vhsE/zB+4ALtRZh8tSQZXq9EfX7mRB\nVXyNWQKV3WKdwrnuWih0hKWbt5DHDAff9Yk2dDLWKMGwsAvgnEzDHNb842m1R0aB\nL6KCq9NjRHDEjf8tM7qtj3u1cIiuPhnPQCjY/MiQu12ZIvVS5ljFH4gxQ+6IHdfG\njjxDah2nGN59PRbxYvnKkKj9\n-----END CERTIFICATE-----\n"];

// server/transport.js
var client;
async function operatorFetch(url, options) {
  try {
    if (typeof Deno === "undefined" || new URL(url).hostname !== "cabinet.cherkasyoblenergo.com")
      return fetch(url, options);
    if (!client) {
      const now = Date.now(), bytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      for (const check of operator_chain_default) {
        if (Date.parse(check.fromDate) > now || Date.parse(check.toDate) < now)
          throw Error("Certificate chain expired");
        const key = await crypto.subtle.importKey(
          "spki",
          bytes(check.issuerKey),
          { name: "RSASSA-PKCS1-v1_5", hash: check.hash },
          false,
          ["verify"]
        );
        if (!await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          key,
          bytes(check.signature),
          bytes(check.tbs)
        ))
          throw Error("Invalid certificate chain");
      }
      client = Deno.createHttpClient({ caCerts: operator_certificates_default });
    }
    return await fetch(url, { ...options, client });
  } catch (error) {
    console.error(
      "Operator TLS failure:",
      String(error.message).replace(/https?:\/\/\S+/g, "[source]").slice(0, 180)
    );
    throw error;
  }
}

// server/shared-categories.js
var SharedCategories = class {
  constructor(db2, secret, { now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), ttl = 6e5 } = {}) {
    Object.assign(this, { db: db2, now, sleep, ttl });
    this.key = crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    this.pending = /* @__PURE__ */ new Map();
  }
  async load(scope, loader, signal) {
    const key = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", await this.key, new TextEncoder().encode(JSON.stringify(scope)))), (x) => x.toString(16).padStart(2, "0")).join("");
    if (this.pending.has(key)) return structuredClone(await this.pending.get(key));
    const promise = this.run(key, loader, signal);
    this.pending.set(key, promise);
    try {
      return structuredClone(await promise);
    } finally {
      this.pending.delete(key);
    }
  }
  async run(key, loader, signal) {
    const end = this.now() + 22e3;
    while (true) {
      signal?.throwIfAborted();
      const c = await this.db.sourceClaim(key, this.now());
      if (c.state === "fresh") return c.value;
      if (c.state === "owner") {
        try {
          const value = await loader();
          await this.db.sourceFinish(key, c.token, value, this.now(), this.ttl).catch(() => {
          });
          return value;
        } catch (error) {
          await this.db.sourceFinish(key, c.token, null, this.now(), 0).catch(() => {
          });
          throw error;
        }
      }
      if (this.now() >= end) throw new SourceError("timeout");
      await this.sleep(200);
    }
  }
};

// server/sync.js
var cityKey = (a) => JSON.stringify([a.department, a.cityId, a.city]);
var SyncService = class {
  constructor(service2) {
    this.service = service2;
    this.pending = /* @__PURE__ */ new Map();
    this.weather = /* @__PURE__ */ new Map();
    this.weatherPending = /* @__PURE__ */ new Map();
  }
  async weatherFor(address) {
    const { db: db2, source, now } = this.service, key = cityKey(address), old = this.weather.get(key);
    if (old && now() - old.checkedAt < 36e5) return old;
    if (this.weatherPending.has(key)) return this.weatherPending.get(key);
    if (!this.shared && db2.sourceClaim) this.shared = new SharedCategories(db2, "svitlo-public-weather-v1", { now, ttl: 36e5 });
    const load = () => source.weather(address.city);
    const pending = (this.shared ? this.shared.load(["weather-v1", key], load) : load()).then((value) => {
      this.weather.set(key, value);
      return value;
    }).finally(() => this.weatherPending.delete(key));
    this.weatherPending.set(key, pending);
    return pending;
  }
  run(owner, body, list) {
    const key = JSON.stringify([owner, body]);
    if (this.pending.has(key)) return this.pending.get(key);
    const task = this.load(owner, body, list).finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }
  async load(owner, body, list) {
    const s = this.service, now = s.now(), profiles = await list();
    let active = body.id ? profiles.find((p) => p.id === body.id) : profiles[0];
    if (body.id && !active) {
      const e = Error("\u0410\u0434\u0440\u0435\u0441\u0443 \u043D\u0435 \u0437\u043D\u0430\u0439\u0434\u0435\u043D\u043E");
      e.status = 404;
      throw e;
    }
    const errors = {};
    if (active) {
      const interval = body.reason === "manual" || body.reason === "push" || body.reason === "rollover" ? 6e4 : 36e5;
      if (!active.last_checked || now - active.last_checked >= interval || needsOutageTypes(active.snapshot) && now - active.last_checked >= 6e4 && (!active.snapshot?.failures?.length || now >= active.next_check) || body.reason !== "manual" && now >= active.next_check && now - active.last_checked >= 6e4) {
        try {
          active = await s.refresh(active);
        } catch (e) {
          if (e.status === 404) throw e;
          errors.profile = "\u041E\u043D\u043E\u0432\u043B\u0435\u043D\u043D\u044F \u0442\u0438\u043C\u0447\u0430\u0441\u043E\u0432\u043E \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0435";
        }
      }
    }
    let weather = null, subscription = null;
    await Promise.all([
      active ? this.weatherFor(active.address).then((w) => weather = w).catch(() => errors.weather = "\u041F\u043E\u0433\u043E\u0434\u0430 \u043F\u043E\u043A\u0438 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430") : null,
      body.subscription ? (async () => {
        if (!s.vapid || !s.validSubscription(body.subscription)) {
          errors.subscription = "\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0430 \u043F\u0456\u0434\u043F\u0438\u0441\u043A\u0430";
          return;
        }
        try {
          await s.db.subscribe(owner, body.subscription, active?.id || null);
          subscription = true;
        } catch {
          errors.subscription = "\u041D\u0435 \u0432\u0434\u0430\u043B\u043E\u0441\u044F \u0437\u0431\u0435\u0440\u0435\u0433\u0442\u0438 \u043F\u0456\u0434\u043F\u0438\u0441\u043A\u0443";
        }
      })() : null
    ]);
    const current = await list();
    if (active && !current.some((p) => p.id === active.id)) {
      const e = Error("\u0410\u0434\u0440\u0435\u0441\u0443 \u043D\u0435 \u0437\u043D\u0430\u0439\u0434\u0435\u043D\u043E");
      e.status = 404;
      throw e;
    }
    return {
      profiles: current.map(s.publicProfile),
      active: active?.id || null,
      vapid: s.vapid,
      pushReady: !!s.vapid,
      weather,
      weatherKey: active ? cityKey(active.address) : null,
      subscription,
      errors,
      serverTime: now
    };
  }
};

// app/lib/schedule.js
function emergencyPolicy(data, now) {
  const commands = (data?.emergencies || []).filter(
    (x) => (!x.queues.length || x.queues.includes(data.queue)) && x.effectiveAt <= now && x.publishedAt <= now + 3e5
  ).sort(
    (a, b) => b.effectiveAt - a.effectiveAt || b.publishedAt - a.publishedAt
  );
  const command = commands[0];
  if (!command) return { active: false, validity: "active" };
  const active = !command.ended && fresh(data.feedCheckedAt, now) && data.feedCheckedAt >= command.publishedAt && now < (command.until ?? Math.max(command.effectiveAt, command.publishedAt) + 72e5);
  let validity = active || command.ended ? command.validity : "active";
  if (command.ended && validity === "unknown") {
    const prior = commands.find((x) => !x.ended);
    validity = prior?.validity === "suspended" ? "suspended" : "active";
  }
  return { active, validity, command };
}
function dayState(data, date, now = Date.now()) {
  const from = civil(date), until = civil(addDays(date, 1)), plan = /^[1-6]\.[12]$/.test(data?.queue) ? data?.plans?.find((x) => x.date === date && x.queue === data.queue) : null, policy = emergencyPolicy(data, now);
  let validity = policy.validity;
  if (plan && !plan.uncertain && plan.publishedAt > (policy.command?.publishedAt || 0))
    validity = "active";
  const categories = data?.categories || {};
  const complete = ["hourly", "planned", "emergency"].every(
    (k) => fresh(categories[k]?.checkedAt, now) && fresh(categories[k]?.sourceAt, now) && !data?.failures?.includes(k)
  ) && fresh(data?.feedCheckedAt, now) && !data?.feedFailed;
  let events = Object.values(categories).flatMap((x) => x.events || []).filter((x) => x.start < until && (x.end === null || x.end > from));
  if (plan && !plan.uncertain)
    events = [...events.filter((x) => x.category !== "hourly"), ...plan.events];
  const excluded = data?.queueResolution?.inclusion === "not_in_queue" && !data?.queue;
  const checkedDate = date === dayKey(now) || !!data?.verifiedNoQueueDays?.includes(date);
  const known = plan ? !plan.uncertain : (excluded || /^[1-6]\.[12]$/.test(data?.queue)) && complete && (checkedDate || !excluded && events.some((x) => x.category === "hourly" && x.end));
  if (validity !== "active")
    events = events.filter(
      (x) => x.category !== "hourly" || x.start < Math.min(now, policy.command?.effectiveAt ?? now)
    ).map(
      (x) => x.category === "hourly" ? {
        ...x,
        end: Math.min(x.end ?? now, policy.command?.effectiveAt ?? now)
      } : x
    );
  const open = events.some((x) => x.end === null && x.start <= now);
  const uncertain = !known || validity !== "active" || open;
  const stale = !complete;
  const hours = [];
  for (let t = from; t < until; t += 36e5) {
    const end = Math.min(t + 36e5, until), bounds = /* @__PURE__ */ new Set([t, end]);
    for (const e of events) {
      if (e.start > t && e.start < end) bounds.add(e.start);
      const eEnd = e.end ?? now;
      if (eEnd > t && eEnd < end) bounds.add(eEnd);
    }
    if (now > t && now < end) bounds.add(now);
    const b = [...bounds].sort((a, b2) => a - b2), segments = [];
    for (let i = 0; i < b.length - 1; i++) {
      const s = b[i], e = b[i + 1], matches = events.filter((x) => x.start < e && (x.end ?? now) > s).sort(
        (a, b2) => categoryPriority[b2.category] - categoryPriority[a.category]
      );
      segments.push({
        start: s,
        end: e,
        kind: eventKind(matches[0]) || (uncertain ? "unknown" : "clear")
      });
    }
    hours.push({ start: t, end, segments });
  }
  const lost = hours.flatMap((x) => x.segments).filter((x) => isOutage(x.kind)).reduce((n, x) => n + (x.end - x.start) / 6e4, 0);
  return {
    date,
    plan,
    policy: { ...policy, validity },
    hours,
    displayHours: displayHours(events, from, until, uncertain, now),
    reason: excluded && known && !uncertain ? "no_queue" : !data?.queue ? "queue_unknown" : stale ? "stale" : plan?.uncertain ? "plan_incomplete" : !known ? "not_published" : uncertain ? "uncertain" : "ready",
    events,
    known,
    excluded,
    uncertain,
    stale,
    available: !!plan || events.length > 0 || checkedDate && complete,
    totals: uncertain ? null : { off: lost, on: (until - from) / 6e4 - lost }
  };
}
function countdown(data, now) {
  const state = dayState(data, dayKey(now), now);
  if (state.events.some((x) => x.start <= now && x.end === null))
    return { label: "\u0427\u0430\u0441 \u0432\u0456\u0434\u043D\u043E\u0432\u043B\u0435\u043D\u043D\u044F \u0443\u0442\u043E\u0447\u043D\u044E\u0454\u0442\u044C\u0441\u044F" };
  if (!data?.queue && !state.excluded) return { label: "\u041D\u0435\u043C\u0430\u0454 \u0442\u043E\u0447\u043D\u0438\u0445 \u0434\u0430\u043D\u0438\u0445" };
  if (state.uncertain || state.stale)
    return { label: "\u0427\u0430\u0441 \u0432\u0456\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u044C \u0443\u0442\u043E\u0447\u043D\u044E\u0454\u0442\u044C\u0441\u044F" };
  const tomorrow = dayState(data, addDays(dayKey(now), 1), now), events = [...state.events, ...!tomorrow.uncertain ? tomorrow.events : []].filter((x) => x.end > now).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const e of events) {
    const last = merged.at(-1);
    if (last && e.start <= last.end) last.end = Math.max(last.end, e.end);
    else merged.push({ ...e });
  }
  const current = merged.find((x) => x.start <= now && x.end > now);
  if (current)
    return {
      label: "\u0414\u043E \u0432\u0456\u0434\u043D\u043E\u0432\u043B\u0435\u043D\u043D\u044F",
      target: current.end,
      minutes: Math.ceil((current.end - now) / 6e4)
    };
  const next = merged.find((x) => x.start > now);
  return next ? {
    label: "\u0414\u043E \u0432\u0456\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u043D\u044F",
    target: next.start,
    minutes: Math.ceil((next.start - now) / 6e4)
  } : { label: state.excluded ? "\u0423 \u0432\u0430\u0441 \u0432\u0456\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u044C \u043F\u043E\u043A\u0438 \u043D\u0435\u043C\u0430\u0454" : "\u041D\u0435 \u0437\u0430\u043F\u043B\u0430\u043D\u043E\u0432\u0430\u043D\u043E" };
}
var roundHalfHour = (t) => Math.floor((t + 9e5) / 18e5) * 18e5;
var isOutage = (kind) => ["hourly", "planned", "unplanned", "emergency"].includes(kind);
function displayHours(events, from, until, uncertain, now) {
  const rounded = events.map((e) => ({
    ...e,
    start: roundHalfHour(e.start),
    end: e.end === null ? Math.floor(now / 18e5) * 18e5 : roundHalfHour(e.end)
  })).filter((e) => e.end > e.start);
  const priority = categoryPriority;
  const result = [];
  for (let start = from; start < until; start += 36e5) {
    const end = Math.min(start + 36e5, until), segments = [];
    for (let t = start; t < end; t += 18e5) {
      const stop = Math.min(t + 18e5, end);
      const matches = rounded.filter((e) => e.start < stop && e.end > t).sort((a, b) => priority[b.category] - priority[a.category]);
      segments.push({
        start: t,
        end: stop,
        kind: eventKind(matches[0]) || (uncertain ? "unknown" : "clear")
      });
    }
    result.push({ start, end, segments });
  }
  return result;
}

// app/lib/notifications.js
function preferences(value = {}) {
  return {
    schedule: value.schedule !== false,
    publication: (value.publication ?? value.schedule) !== false,
    change: (value.change ?? value.schedule) !== false,
    emergency: value.emergency !== false,
    reminder: value.reminder !== false,
    restoration: value.restoration !== false,
    lead: [5, 15, 30, 60].includes(+value.lead) ? +value.lead : 30
  };
}
function dateLabel(date, capital = false) {
  const [y, m, d] = String(date).split("-").map(Number);
  if (!y || !m || !d) return "";
  const months2 = ["\u0441\u0456\u0447\u043D\u044F", "\u043B\u044E\u0442\u043E\u0433\u043E", "\u0431\u0435\u0440\u0435\u0437\u043D\u044F", "\u043A\u0432\u0456\u0442\u043D\u044F", "\u0442\u0440\u0430\u0432\u043D\u044F", "\u0447\u0435\u0440\u0432\u043D\u044F", "\u043B\u0438\u043F\u043D\u044F", "\u0441\u0435\u0440\u043F\u043D\u044F", "\u0432\u0435\u0440\u0435\u0441\u043D\u044F", "\u0436\u043E\u0432\u0442\u043D\u044F", "\u043B\u0438\u0441\u0442\u043E\u043F\u0430\u0434\u0430", "\u0433\u0440\u0443\u0434\u043D\u044F"];
  const month = months2[m - 1];
  return month ? `${d} ${capital ? month[0].toUpperCase() + month.slice(1) : month}` : "";
}
function messageTitle(m) {
  if (m.kind !== "schedule" || m.special || /скас|непевн|уточн|невизнач/i.test(m.title || "")) return m.title;
  return `\u0413\u0440\u0430\u0444\u0456\u043A \u043D\u0430 ${dateLabel(m.date)}${m.revisionType === "change" || !m.revisionType && /оновлен/i.test(m.title || "") ? " \u043E\u043D\u043E\u0432\u043B\u0435\u043D\u043E" : ""}`;
}
function notificationBody(p) {
  return p.snapshot?.queue ? `\u041F\u0456\u0434\u0447\u0435\u0440\u0433\u0430 ${p.snapshot.queue}` : p.address?.city || "\u0412\u0430\u0448\u0430 \u0430\u0434\u0440\u0435\u0441\u0430";
}
function reminderTitle(restore, target) {
  return `${restore ? "\u041E\u0447\u0456\u043A\u0443\u0432\u0430\u043D\u0435 \u0432\u0456\u0434\u043D\u043E\u0432\u043B\u0435\u043D\u043D\u044F" : "\u0412\u0456\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u043D\u044F"} \u043E ${clock(target)}`;
}

// server/queue-registry.js
var REGISTRY_INTERVAL = 14 * 864e5;
var normAddress = (s) => String(s || "").normalize("NFKC").toLowerCase().replace(/[’ʼ]/g, "'").replace(/\s+/g, " ").replace(/^(місто|м\.)\s*/, "\u043C.").replace(/^(село|с\.)\s*/, "\u0441.").replace(/^(вулиця|вул\.)\s*/, "\u0432\u0443\u043B.").replace(/^(провулок|пров\.)\s*/, "\u043F\u0440\u043E\u0432.").replace(/\s*\.\s*/g, ".").trim();
function registryMatch(version, address, now = Date.now()) {
  if (!version || version.validFrom > dayKey(now) || version.validUntil < dayKey(now))
    return { queue: null, status: "unavailable" };
  const city = normAddress(address.city), street = normAddress(address.street), house = normAddress(address.house).replace(/\s/g, "");
  if (!city || !street || !house)
    return { queue: null, status: "incomplete_address" };
  const matches = (version.rules || []).filter(
    (r) => normAddress(r.city) === city && (r.scope === "settlement_all" || normAddress(r.street) === street) && (!r.houses?.length || r.houses.map((x) => normAddress(x).replace(/\s/g, "")).includes(house)) && !r.excluded?.map(normAddress).includes(house)
  );
  const queues = [...new Set(matches.map((r) => r.queue))];
  if (queues.length !== 1)
    return { queue: null, status: queues.length ? "ambiguous" : "not_found" };
  const match = matches.sort(
    (a, b) => ({ house: 3, street_all: 2, settlement_all: 1 })[b.scope] - { house: 3, street_all: 2, settlement_all: 1 }[a.scope]
  )[0];
  if ((version.mentions || []).some(
    (m) => m.queue !== match.queue && normAddress(m.text).includes(city) && (match.scope === "settlement_all" || normAddress(m.text).includes(street.replace(/^вул\./, "")))
  ))
    return { queue: null, status: "ambiguous" };
  return {
    queue: match.queue,
    status: "matched",
    source: "official_registry",
    scope: match.scope,
    url: match.url,
    page: match.page,
    version: version.id,
    validUntil: version.validUntil,
    checkedAt: version.checkedAt
  };
}

// server/address-registry.js
var validKey = (a) => a && ["department", "cityId", "streetId", "house"].every(
  (k) => typeof a[k] === "string" && a[k].length > 0 && a[k].length <= 120
);
async function addressRecord(db2, address) {
  if (!validKey(address) || !db2.addressQueue) return null;
  return db2.addressQueue(address);
}
function catalogAddress(record) {
  if (!record || record.status === "service") return null;
  return {
    department: record.department,
    cityId: record.city_id,
    streetId: record.street_id,
    house: record.house,
    city: record.city,
    street: record.street,
    label: `${record.city}, ${record.street}, ${record.house}`
  };
}
function addressResolution(record, registry, now = Date.now()) {
  if (!record) return null;
  const meta = {
    addressRegistryVersion: record.batch.import_key,
    decisionSource: record.evidence?.origin || "curated_address_registry",
    estimated: record.is_estimate === true,
    confidence: record.confidence || null,
    addressReviewedAt: record.evidence?.address_reviewed_at || record.batch.reviewed_at,
    ...record.evidence?.needsReview ? { needsReview: true, reviewReason: record.evidence.review_reason } : {}
  };
  if (record.status !== "numeric") return {
    queue: null,
    status: "not_found",
    inclusion: record.status === "not_in_queue" ? "not_in_queue" : "service",
    ...meta
  };
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(now);
  const document = registry?.documents?.find((d) => d.queue === record.queue);
  if (!document || registry.validFrom > today || registry.validUntil < today)
    return { queue: null, status: "unavailable", ...meta };
  return {
    queue: record.queue,
    status: "matched",
    source: "official_registry",
    scope: record.evidence?.pdf_mapping?.scope || "house",
    url: document.url,
    page: record.evidence?.pdf_mapping?.page || 1,
    referenceRole: record.evidence?.pdf_mapping ? "address_mapping" : "queue_definition_only",
    version: `addresses:${record.batch.import_key}:${registry.id}`,
    validUntil: registry.validUntil,
    checkedAt: now,
    ...meta
  };
}

// server/enrollment-preview.js
function enrollmentKey(address) {
  const values = [address?.department, address?.cityId, address?.streetId, address?.house];
  if (values.some((v) => typeof v !== "string" || !v || v.length > 120)) return null;
  return JSON.stringify(values);
}
async function enrollmentProof(owner, address) {
  const input = JSON.stringify([owner, enrollmentKey(address), address.account || "", address.city, address.street]);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))), (b) => b.toString(16).padStart(2, "0")).join("");
}
function preparedSnapshot(value) {
  if (!value?.categories || value.failures?.length !== 0 || !Number.isFinite(value.checkedAt) || needsOutageTypes(value)) return null;
  const { categories, failures, errors, queue, checkedAt } = value;
  return { categories, failures, errors, queue, checkedAt };
}

// server/provider-transport.js
var HOSTS = /* @__PURE__ */ new Set(["cabinet.cherkasyoblenergo.com", "www.cherkasyoblenergo.com"]);
function retryDelay(value, now = Date.now()) {
  if (!value) return 0;
  const delay = /^\d+$/.test(value.trim()) ? +value * 1e3 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, Math.min(9e5, delay)) : 0;
}
function providerTransport(db2, fetcher = fetch, { now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxWaitMs = 2e4 } = {}) {
  return async (url, options = {}) => {
    const host = new URL(url).hostname;
    if (!HOSTS.has(host)) return fetcher(url, options);
    if (!options.signal) options = { ...options, signal: AbortSignal.timeout(2e4) };
    const deadline = now() + maxWaitMs;
    let claim;
    while (true) {
      options.signal?.throwIfAborted();
      claim = await db2.providerAcquire(host);
      if (claim.granted) break;
      if (claim.reason === "cooldown") throw new SourceError(claim.code || "rate_limited", claim.code === "forbidden" ? 403 : 429);
      if (now() >= deadline) throw new SourceError("rate_limited", 429);
      await sleep(Math.min(Math.max(25, claim.waitMs || 100), 250, Math.max(1, deadline - now())));
    }
    let finished = false, response, started = false;
    const finish = async (status, error = null, retry = 0) => {
      if (finished) return;
      finished = true;
      await db2.providerFinish(claim.token, status, error, retry).catch(() => {
      });
    };
    try {
      options.signal?.throwIfAborted();
      started = true;
      response = await fetcher(url, options);
      if (!response.ok) {
        if (response.body) await response.body.cancel().catch(() => {
        });
        await finish(response.status, null, retryDelay(response.headers.get("Retry-After"), now()));
        return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
      }
      if (!response.body) {
        await finish(response.status);
        return response;
      }
      const reader = response.body.getReader();
      const body = new ReadableStream({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) {
              await finish(response.status);
              controller.close();
            } else controller.enqueue(next.value);
          } catch (error) {
            await finish(null, failureCode(error));
            controller.error(error);
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            await finish(response.status);
          }
        }
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      await finish(null, started ? failureCode(error) : null);
      throw error;
    }
  };
}

// server/scaled-jobs.js
function reminderWork(p, now, timer = countdown(p.snapshot, now)) {
  const prefs = p.preferences || {}, lead = [5, 15, 30, 60].includes(+prefs.lead) ? +prefs.lead : 30;
  let next = now + 3e5, event = null;
  if (Number.isFinite(timer.target) && timer.target > now && timer.minutes !== void 0) {
    const restore = timer.label === "\u0414\u043E \u0432\u0456\u0434\u043D\u043E\u0432\u043B\u0435\u043D\u043D\u044F", channel = restore ? "restoration" : "reminder";
    next = timer.target - lead * 6e4;
    if (next <= now || prefs[channel] === false) next = timer.target + 1e3;
    if (prefs[channel] !== false && timer.minutes > 0 && timer.minutes <= lead) event = {
      event_key: `reminder:${restore}:${timer.target}`,
      channel,
      title: reminderTitle(restore, timer.target),
      body: notificationBody(p),
      date: dayKey(now),
      expires_at: timer.target
    };
  }
  return { id: p.id, token: p.token, generation: p.generation, next_due: Math.max(now + 1e3, next), event };
}
async function runScaledJobs(service2) {
  const { db: db2 } = service2, claim = await db2.jobsClaim();
  if (!claim.granted) return { status: "busy", refreshed: 0, sent: 0 };
  const deadline = service2.now() + service2.jobBudgetMs;
  const stats = { refreshed: 0, sent: 0, failedRefreshes: 0, partialRefreshes: 0, failedDeliveries: 0, expiredSubscriptions: 0, skippedRefreshes: 0, remindersChecked: 0 };
  try {
    let feedResult = null;
    if (db2.scheduledMaintenance) {
      const work = await db2.jobsWork(service2.now());
      if (work.feed) feedResult = (async () => {
        stats.feedChecks = 1;
        try {
          const value = await service2.source.feed(service2.now(), await db2.feed(), { force: true, signal: AbortSignal.timeout(Math.max(1, deadline - service2.now() - 2e3)) });
          if (!service2.source.sharedFeed) await db2.saveFeed(value);
          if (value.partial) stats.failedFeeds = 1;
          return { value };
        } catch (error) {
          stats.failedFeeds = 1;
          return { error };
        }
      })();
    }
    const refresh = async () => {
      const end = deadline - 3e3;
      let count = 0;
      const worker = async () => {
        while (count < 60 && service2.now() + 2500 < end) {
          count++;
          const [p] = await db2.due(service2.now(), 1);
          if (!p) break;
          if (service2.now() + 2e3 >= end) {
            await db2.releaseProfile(p);
            break;
          }
          try {
            const result = await service2.refresh(p, null, { signal: AbortSignal.timeout(Math.max(1, end - service2.now() - 1e3)), feedResult });
            stats.refreshed++;
            if (result.snapshot?.failures?.length || result.snapshot?.feedFailed) stats.partialRefreshes++;
          } catch (e) {
            if (e.status === 404) stats.skippedRefreshes++;
            else stats.failedRefreshes++;
            await db2.releaseProfile(p).catch(() => {
            });
            break;
          }
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
    };
    const notify = async () => {
      const memo = /* @__PURE__ */ new Map();
      for (let page = 0; page < 3 && service2.now() + 15e3 < deadline; page++) {
        const batch = await db2.reminderClaim(service2.now(), 300);
        const items = batch.map((p) => {
          const key = JSON.stringify(p.snapshot);
          let timer = memo.get(key);
          if (!timer) {
            timer = countdown(p.snapshot, service2.now());
            memo.set(key, timer);
          }
          return reminderWork(p, service2.now(), timer);
        });
        if (items.length) stats.remindersChecked += await db2.reminderFinish(items);
        if (batch.length < 300) break;
      }
      let claimed = 0;
      while (claimed < 600 && service2.now() + 11e3 < deadline) {
        const batch = await db2.deliveryBatch(service2.now(), Math.min(16, 600 - claimed));
        if (!batch.length) break;
        claimed += batch.length;
        const finished = [];
        for (let i = 0; i < batch.length; i += 4) {
          const wave = batch.slice(i, i + 4);
          if (service2.now() + 11e3 >= deadline) {
            finished.push(...batch.slice(i).map((x) => ({ id: x.id, token: x.lease_token, delivered: null, retry_at: service2.now() })));
            break;
          }
          const valid = new Set(await db2.deliveryActive(wave, service2.now()));
          await Promise.all(wave.map(async (item) => {
            const result = { id: item.id, token: item.lease_token, delivered: null, retry_at: service2.now() };
            finished.push(result);
            const remaining = item.expires_at - service2.now();
            if (!valid.has(item.id) || remaining < 1e3) return;
            try {
              await service2.push(
                item.subscription,
                { title: item.title, body: item.body, tag: item.event_key, date: item.date, profile: item.profile_id },
                { ttl: Math.max(1, Math.min(3600, Math.floor(remaining / 1e3))) }
              );
              result.delivered = true;
              result.retry_at = 0;
              stats.sent++;
            } catch (e) {
              if ([404, 410].includes(e.statusCode)) {
                await db2.removeSubscription(item.subscription_id);
                stats.expiredSubscriptions++;
              } else {
                result.delivered = false;
                result.retry_at = service2.now() + Math.max(Math.min(3e5, 3e4 * 2 ** Math.min(item.attempts || 1, 4)), retryDelay(e.headers?.["retry-after"], service2.now()));
                stats.failedDeliveries++;
              }
            }
          }));
        }
        await db2.deliveryFinishBatch(finished);
      }
    };
    const results = await Promise.allSettled([refresh(), notify(), feedResult]);
    for (const r of results) if (r.status === "rejected") throw r.reason;
    if (!db2.scheduledMaintenance) await db2.cleanup(service2.now());
    return { ...stats, budgetExhausted: service2.now() + 11e3 >= deadline };
  } finally {
    await db2.jobsFinish(claim.token, null);
  }
}

// server/service.js
var DEFAULT_PREFS = {
  schedule: true,
  emergency: true,
  reminder: true,
  restoration: true,
  lead: 30
};
function publicProfile(p) {
  const { account, ...address } = p.address;
  const { push_enabled, ...safe } = p;
  return { ...safe, address };
}
function validSubscription(s) {
  if (!s || typeof s.endpoint !== "string" || s.endpoint.length > 2048)
    return false;
  let u;
  try {
    u = new URL(s.endpoint);
  } catch {
    return false;
  }
  const host = u.hostname;
  return u.protocol === "https:" && !u.username && !u.password && !u.port && (host === "fcm.googleapis.com" || host === "updates.push.services.mozilla.com" || host.endsWith(".notify.windows.com") || host.endsWith(".push.apple.com")) && /^[A-Za-z0-9_-]{87}=?$/.test(s.keys?.p256dh || "") && /^[A-Za-z0-9_-]{22}=?=?$/.test(s.keys?.auth || "");
}
var Service = class {
  constructor({ db: db2, source, push, now = () => Date.now(), vapid = "", jobBudgetMs = 45e3 }) {
    Object.assign(this, { db: db2, source, push, now, vapid, jobBudgetMs });
    this.validSubscription = validSubscription;
    this.publicProfile = publicProfile;
    this.sync = new SyncService(this);
  }
  async resolveAddress(input) {
    try {
      return await this.source.resolve(input);
    } catch (error) {
      const stored = catalogAddress(await addressRecord(this.db, input));
      if (stored) return stored;
      if (/^Невідом|^Оберіть повну адресу/.test(error.message)) throw new ApiError(400, error.message);
      throw error;
    }
  }
  async queueResolution(address, now, knownRecord) {
    if (knownRecord === void 0 && this.db.addressResolutionData) {
      const data = await this.db.addressResolutionData(address);
      if (data.record) return addressResolution(data.record, data.registry, now);
      return registryMatch(await this.db.registry?.(), address, now);
    }
    const stored = knownRecord === void 0 ? await addressRecord(this.db, address) : knownRecord;
    if (stored) {
      const registry = stored.status === "numeric" ? await (this.db.registryMetadata ? this.db.registryMetadata() : this.db.registry?.()) : null;
      return addressResolution(stored, registry, now);
    }
    return registryMatch(await this.db.registry?.(), address, now);
  }
  async refresh(profile, prepared = null, { signal, feedResult } = {}) {
    const now = this.now(), old = profile.snapshot || {};
    const [address, registry] = await Promise.all([
      prepared ? Promise.resolve(structuredClone(prepared)) : this.source.address(profile.address, now, old, { signal }),
      this.queueResolution(profile.address, now).catch(() => ({ queue: null, status: "unavailable" }))
    ]);
    const cachedApiQueue = address.failures.includes("hourly") ? address.queue : null;
    const apiExclusion = !address.failures.includes("hourly") && address.categories.hourly?.inclusion === "not_in_queue";
    if (cachedApiQueue) address.queue = null;
    address.queueResolution = apiExclusion ? { queue: null, status: "not_found", inclusion: "not_in_queue", source: "address_api", checkedAt: address.categories.hourly?.checkedAt } : address.queue ? {
      queue: address.queue,
      source: "address_api",
      status: "matched",
      checkedAt: address.categories.hourly?.checkedAt,
      ...registry?.queue && registry.queue !== address.queue ? {
        conflict: {
          registryQueue: registry.queue,
          version: registry.version
        }
      } : {}
    } : registry;
    if (!apiExclusion && !address.queue && registry?.queue) address.queue = registry.queue;
    if (!address.queue && cachedApiQueue && !registry?.inclusion) {
      address.queue = cachedApiQueue;
      address.queueResolution = { queue: cachedApiQueue, status: "matched", source: "cached_address_api", checkedAt: address.categories.hourly?.checkedAt };
    }
    let feed, feedError, feedFailed = false;
    try {
      const shared = feedResult ? await feedResult : null;
      if (shared?.error) throw shared.error;
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
      plans: (feed.plans || []).filter((plan) => plan.queue === address.queue),
      emergencies: feed.emergencies || [],
      feedCheckedAt: feed.checkedAt || null,
      feedFailed,
      feedError,
      maintenance: (feed.maintenance || []).find((m) => m.from <= now && m.until > now) || null,
      lastSuccessAt: !address.failures.length && !feedFailed ? prepared ? Math.min(now, prepared.checkedAt) : now : old.lastSuccessAt || null
    };
    if (snapshot.queueResolution?.inclusion === "not_in_queue" && !snapshot.failures.length && !snapshot.feedFailed) {
      snapshot.verifiedNoQueueDays = [.../* @__PURE__ */ new Set([...old.verifiedNoQueueDays || [], dayKey(now)])].filter((d) => d >= addDays(dayKey(now), -7));
    }
    const currentPolicy = emergencyPolicy(snapshot, now);
    const regional = currentPolicy.command;
    const regionalMessages = regional ? [
      {
        id: "regional:" + regional.id,
        kind: "emergency",
        scope: "region",
        title: regional.ended ? "\u0410\u0432\u0430\u0440\u0456\u0439\u043D\u0456 \u0432\u0456\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u043D\u044F \u0432 \u043E\u0431\u043B\u0430\u0441\u0442\u0456 \u0441\u043A\u0430\u0441\u043E\u0432\u0430\u043D\u043E" : "\u0410\u0432\u0430\u0440\u0456\u0439\u043D\u0456 \u0432\u0456\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u043D\u044F \u0432 \u043E\u0431\u043B\u0430\u0441\u0442\u0456",
        date: dayKey(regional.effectiveAt),
        updatedAt: regional.publishedAt,
        url: regional.url
      }
    ] : [];
    const relevant = (feed.messages || []).filter((m) => m.queue === snapshot.queue).map((m) => {
      if (m.kind !== "schedule") return m;
      const existing = (profile.messages || []).find((x) => x.id === m.id);
      const prior = (profile.messages || []).some((x) => x.kind === "schedule" && x.date === m.date && x.queue === m.queue && x.id !== m.id && x.updatedAt < m.updatedAt);
      const previousPlan = (old.plans || []).find((x) => x.date === m.date && x.queue === m.queue);
      const revisionType = m.revisionType || existing?.revisionType || (prior || previousPlan && previousPlan.publishedAt < m.updatedAt ? "change" : "publication");
      return { ...m, revisionType };
    });
    relevant.push(...regionalMessages);
    const before = JSON.stringify(old.categories?.emergency?.events || []), after = JSON.stringify(snapshot.categories?.emergency?.events || []);
    if (before !== after && !snapshot.failures.includes("emergency") && fresh(snapshot.categories?.emergency?.sourceAt, now) && fresh(snapshot.categories?.emergency?.checkedAt, now) && snapshot.categories?.emergency?.events?.some(
      (e) => e.start <= now && (e.end === null || e.end > now)
    ))
      relevant.push({
        id: "address:" + after,
        kind: "emergency",
        scope: "address",
        title: "\u0410\u0432\u0430\u0440\u0456\u0439\u043D\u0456 \u0432\u0456\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u043D\u044F \u0437\u0430 \u0430\u0434\u0440\u0435\u0441\u043E\u044E",
        date: dayKey(now),
        updatedAt: now,
        url: "https://www.cherkasyoblenergo.com/off"
      });
    let p = {
      ...profile,
      snapshot,
      messages: mergeHistory(profile.messages || [], relevant, now),
      last_checked: now,
      next_check: now + (!address.failures.length && !feedFailed ? 36e5 : Math.min(
        36e5,
        3e5 * 2 ** Math.min(old.failureCount || 0, 4)
      ))
    };
    snapshot.failureCount = !address.failures.length && !feedFailed ? 0 : (old.failureCount || 0) + 1;
    const committed = await this.db.commitProfile(p, profile.snapshot_revision || 0);
    if (committed.status === "missing") throw new ApiError(404, "\u0410\u0434\u0440\u0435\u0441\u0443 \u043D\u0435 \u0437\u043D\u0430\u0439\u0434\u0435\u043D\u043E");
    if (committed.status === "conflict") return committed.profile;
    p = committed.profile;
    if (profile.last_checked) {
      const known = new Set((profile.messages || []).map((x) => x.id)), prefs = preferences(p.preferences);
      for (const message of p.messages.filter(
        (x) => !known.has(x.id) && x.updatedAt >= profile.last_checked && prefs[x.kind === "schedule" ? x.revisionType || "publication" : x.kind] && x.scope !== "region"
      ))
        await this.enqueue(p, message.id, messageTitle(message), message.date, message.kind === "schedule" ? message.revisionType || "publication" : "address_emergency");
    }
    return p;
  }
  async enqueue(p, key, title, date, channel = key.startsWith("regional:") || key.startsWith("address:") ? "emergency" : "schedule") {
    if (key.startsWith("regional:")) return;
    await this.db.enqueue({
      owner: p.owner,
      profile_id: p.id,
      event_key: key,
      title,
      body: notificationBody(p),
      date,
      expires_at: this.now() + 36e5,
      channel
    });
  }
  async reminders(p) {
    const prefs = preferences(p.preferences);
    if (!prefs.reminder && !prefs.restoration) return;
    const now = this.now(), timer = countdown(p.snapshot, now);
    if (timer.minutes === void 0) return;
    const restore = timer.label === "\u0414\u043E \u0432\u0456\u0434\u043D\u043E\u0432\u043B\u0435\u043D\u043D\u044F", enabled = restore ? prefs.restoration : prefs.reminder;
    if (!enabled || timer.minutes > prefs.lead || timer.minutes <= 0) return;
    const at = timer.target;
    await this.enqueue(
      p,
      `reminder:${restore}:${at}`,
      reminderTitle(restore, at),
      dayKey(now),
      restore ? "restoration" : "reminder"
    );
  }
  async handle(owner, body) {
    const now = this.now();
    if (!owner) throw new ApiError(401, "\u041F\u043E\u0442\u0440\u0456\u0431\u043D\u0435 \u043F\u0456\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u043D\u044F");
    if (!await this.db.rate(
      owner,
      body.action === "dictionary" ? 120 : 40,
      6e4
    ))
      throw new ApiError(429, "\u0417\u0430\u0431\u0430\u0433\u0430\u0442\u043E \u0437\u0430\u043F\u0438\u0442\u0456\u0432. \u0421\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 \u0437\u0430 \u0445\u0432\u0438\u043B\u0438\u043D\u0443.");
    const list = () => this.db.profiles(owner);
    const owned = async () => {
      const p = this.db.profile ? await this.db.profile(owner, body.id) : (await list()).find((p2) => p2.id === body.id);
      if (!p) throw new ApiError(404, "\u0410\u0434\u0440\u0435\u0441\u0443 \u043D\u0435 \u0437\u043D\u0430\u0439\u0434\u0435\u043D\u043E");
      return p;
    };
    switch (body.action) {
      case "sync":
        return this.sync.run(owner, body, list);
      case "bootstrap":
        return {
          profiles: (await list()).map(publicProfile),
          vapid: this.vapid,
          pushReady: !!this.vapid
        };
      case "resolve_queue": {
        if (!body.id && this.db.addressResolutionData) {
          const data = await this.db.addressResolutionData(body.address);
          if (data.record) return { resolution: addressResolution(data.record, data.registry, now) };
          const address2 = await this.resolveAddress(body.address);
          return { resolution: registryMatch(await this.db.registry?.(), address2, now) };
        }
        const stored = !body.id ? await addressRecord(this.db, body.address) : null;
        if (stored) return { resolution: await this.queueResolution(body.address, now, stored) };
        const address = body.id ? (await owned()).address : await this.resolveAddress(body.address);
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
        const address = await this.resolveAddress(body.address), p = await this.source.address(address, now);
        const reusable = preparedSnapshot(p), key = enrollmentKey(address);
        if (reusable && key && this.db.rememberPreview) {
          try {
            await this.db.rememberPreview(owner, key, await enrollmentProof(owner, address), reusable, reusable.checkedAt);
          } catch {
          }
        }
        const excluded = !p.failures.includes("hourly") && p.categories?.hourly?.inclusion === "not_in_queue";
        return {
          address: { ...address, account: void 0 },
          queue: excluded ? null : p.queue || (await this.queueResolution(address, now)).queue,
          verified: p.failures.length === 0,
          checkedAt: p.checkedAt
        };
      }
      case "save": {
        if (body.confirmed !== true)
          throw new ApiError(400, "\u041F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u044C\u0442\u0435 \u0430\u0434\u0440\u0435\u0441\u0443");
        const address = await this.resolveAddress(body.address);
        const candidate = {
          id: crypto.randomUUID(),
          owner,
          address,
          name: String(body.name || "").trim().slice(0, 60),
          preferences: DEFAULT_PREFS,
          snapshot: {},
          messages: [],
          last_checked: 0
        };
        const created = await this.db.createProfile(candidate);
        if (created.status === "limit") throw new ApiError(400, "\u041C\u043E\u0436\u043D\u0430 \u0437\u0431\u0435\u0440\u0435\u0433\u0442\u0438 \u0434\u043E 10 \u0430\u0434\u0440\u0435\u0441");
        const p = created.profile;
        if (!p) throw new ApiError(404, "\u0410\u0434\u0440\u0435\u0441\u0443 \u043D\u0435 \u0437\u043D\u0430\u0439\u0434\u0435\u043D\u043E");
        if (!created.created && p.last_checked) return { profile: publicProfile(p) };
        let prepared = null;
        if (this.db.takePreview) {
          try {
            prepared = await this.db.takePreview(owner, enrollmentKey(address), await enrollmentProof(owner, address));
          } catch {
          }
        }
        if (prepared && (prepared.checkedAt > now || now - prepared.checkedAt >= 6e4 || prepared.failures?.length !== 0)) prepared = null;
        if (prepared && !preparedSnapshot(prepared)) prepared = null;
        return { profile: publicProfile(await this.refresh(p, prepared)) };
      }
      case "refresh": {
        const p = await owned();
        if (now - p.last_checked < 6e4) return { profile: publicProfile(p) };
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
        const changed = await this.db.setPreferences(owner, p.id, body.preferences || {});
        if (!changed) throw new ApiError(404, "\u0410\u0434\u0440\u0435\u0441\u0443 \u043D\u0435 \u0437\u043D\u0430\u0439\u0434\u0435\u043D\u043E");
        return { profile: publicProfile(changed) };
      }
      case "subscribe": {
        if (!this.vapid)
          throw new ApiError(503, "\u0421\u0435\u0440\u0432\u0435\u0440 \u0441\u043F\u043E\u0432\u0456\u0449\u0435\u043D\u044C \u0449\u0435 \u043D\u0435 \u043F\u0456\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0439");
        if (!validSubscription(body.subscription))
          throw new ApiError(400, "\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0430 \u043F\u0456\u0434\u043F\u0438\u0441\u043A\u0430");
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
        throw new ApiError(400, "\u041D\u0435\u0432\u0456\u0434\u043E\u043C\u0430 \u0434\u0456\u044F");
    }
  }
  async jobs() {
    if (this.db.reminderClaim) return runScaledJobs(this);
    const claim = await this.db.jobsClaim();
    if (!claim.granted) return { status: "busy", refreshed: 0, sent: 0 };
    const deadline = this.now() + this.jobBudgetMs;
    let cursor = claim.cursor || null;
    let refreshed = 0, failedRefreshes = 0, partialRefreshes = 0, skippedRefreshes = 0;
    let sent = 0, failedDeliveries = 0, expiredSubscriptions = 0, remindersChecked = 0;
    try {
      const refreshDeadline = Math.min(deadline - 15e3, this.now() + 25e3);
      for (let attempt = 0; attempt < 5 && this.now() + 2e3 < refreshDeadline; attempt++) {
        const [p] = await this.db.due(this.now(), 1);
        if (!p) break;
        try {
          const updated = await this.refresh(p, null, { signal: AbortSignal.timeout(Math.max(1, refreshDeadline - this.now() - 1e3)) });
          refreshed++;
          if (updated.snapshot?.failures?.length || updated.snapshot?.feedFailed) partialRefreshes++;
        } catch (error) {
          if (error.status === 404) skippedRefreshes++;
          else failedRefreshes++;
          await this.db.releaseProfile(p).catch(() => {
          });
          break;
        }
      }
      reminders: for (let page = 0; page < 3 && this.now() + 12e3 < deadline; page++) {
        const batch = await this.db.reminderProfiles(this.now(), 100, 0, cursor);
        for (const p of batch) {
          if (this.now() + 12e3 >= deadline) break reminders;
          await this.reminders(p);
          cursor = p.id;
          remindersChecked++;
        }
        if (batch.length < 100) {
          cursor = null;
          break;
        }
      }
      let claimed = 0;
      const deliver = async () => {
        while (claimed < 10 && this.now() + 11e3 < deadline) {
          claimed++;
          const [item] = await this.db.deliveries(this.now(), 1);
          if (!item) break;
          if (this.now() + 11e3 >= deadline) {
            await this.db.deliveryRelease(item.id, item.lease_token, this.now());
            break;
          }
          const remaining = item.expires_at === void 0 ? 36e5 : item.expires_at - this.now();
          if (remaining <= 0) {
            await this.db.deliveryRelease(item.id, item.lease_token, this.now());
            continue;
          }
          try {
            await this.push(item.subscription, {
              title: item.title,
              body: item.body,
              tag: item.event_key,
              date: item.date,
              profile: item.profile_id
            }, { ttl: Math.max(1, Math.min(3600, Math.ceil(remaining / 1e3))) });
            await this.db.deliveryDone(item.id, item.lease_token);
            sent++;
          } catch (e) {
            if ([404, 410].includes(e.statusCode)) {
              await this.db.removeSubscription(item.subscription_id);
              expiredSubscriptions++;
            } else {
              const delay = Math.max(Math.min(3e5, 3e4 * 2 ** Math.min(item.attempts || 1, 4)), retryDelay(e.headers?.["retry-after"], this.now()));
              await this.db.deliveryRetry(item.id, this.now(), item.lease_token, delay);
              failedDeliveries++;
            }
          }
        }
      };
      await Promise.all([deliver(), deliver()]);
      await this.db.cleanup(this.now());
      return {
        refreshed,
        sent,
        failedRefreshes,
        partialRefreshes,
        failedDeliveries,
        expiredSubscriptions,
        skippedRefreshes,
        remindersChecked,
        budgetExhausted: this.now() + 11e3 >= deadline
      };
    } finally {
      await this.db.jobsFinish(claim.token, cursor);
    }
  }
};
var ApiError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
};
async function httpHandler(request, service2, authenticate, origins) {
  const origin = request.headers.get("Origin"), allowed = !origin || origins.includes(origin), headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    Vary: "Origin"
  };
  if (origin && allowed)
    Object.assign(headers, {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "authorization,apikey,content-type",
      "Access-Control-Allow-Methods": "POST,OPTIONS"
    });
  if (!allowed)
    return new Response(JSON.stringify({ error: "Origin not allowed" }), {
      status: 403,
      headers
    });
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers });
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers });
  try {
    if (Number(request.headers.get("content-length")) > 16e3)
      throw new ApiError(413, "\u0417\u0430\u0432\u0435\u043B\u0438\u043A\u0438\u0439 \u0437\u0430\u043F\u0438\u0442");
    const raw = await request.text();
    if (raw.length > 16e3) throw new ApiError(413, "\u0417\u0430\u0432\u0435\u043B\u0438\u043A\u0438\u0439 \u0437\u0430\u043F\u0438\u0442");
    const owner = await authenticate(request), data = await service2.handle(owner, JSON.parse(raw));
    return new Response(JSON.stringify(data), { headers });
  } catch (e) {
    if (!(e instanceof ApiError))
      console.error(
        "API failure",
        String(e.message).replace(/https?:\/\/\S+/g, "[source]").replace(/\d{11,}/g, "[redacted]").slice(0, 180)
      );
    return new Response(
      JSON.stringify({
        error: e instanceof ApiError ? e.message : failureMessage(failureCode(e)),
        code: e instanceof ApiError ? "request_error" : failureCode(e)
      }),
      { status: e.status || 502, headers }
    );
  }
}

// server/shared-dictionaries.js
var SharedDictionaries = class {
  constructor(db2, { now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxWaitMs = 22e3 } = {}) {
    Object.assign(this, { db: db2, now, sleep, maxWaitMs });
    this.pending = /* @__PURE__ */ new Map();
  }
  load(key, loader) {
    if (this.pending.has(key)) return this.pending.get(key);
    const request = this.obtain(key, loader).finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }
  async obtain(key, loader) {
    const deadline = this.now() + this.maxWaitMs;
    while (true) {
      const claim = await this.db.dictionaryClaim(key);
      if (claim.state === "fresh") return { items: claim.items, checkedAt: claim.checkedAt };
      if (claim.state === "owner") {
        let items;
        try {
          items = await loader();
        } catch (error) {
          await this.db.dictionaryFinish(key, claim.token, null, failureCode(error)).catch(() => {
          });
          if (Array.isArray(claim.items)) return { items: claim.items, checkedAt: claim.checkedAt };
          throw error;
        }
        await this.db.dictionaryFinish(key, claim.token, items, null).catch(() => {
        });
        return { items, checkedAt: this.now() };
      }
      if (Array.isArray(claim.items)) return { items: claim.items, checkedAt: claim.checkedAt };
      if (this.now() >= deadline) throw new SourceError("timeout");
      await this.sleep(Math.min(150, Math.max(1, deadline - this.now())));
    }
  }
};

// server/shared-feed.js
var SharedFeed = class {
  constructor(db2, { now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxWaitMs = 28e3 } = {}) {
    Object.assign(this, { db: db2, now, sleep, maxWaitMs });
  }
  async load(previous, loader, signal) {
    const deadline = this.now() + this.maxWaitMs;
    while (true) {
      signal?.throwIfAborted();
      const claim = await this.db.feedClaim();
      if (claim.state === "fresh") return claim.value;
      if (claim.state === "owner") {
        try {
          const value = await loader(claim.value || previous, signal);
          await this.db.feedFinish(claim.token, value, null).catch(() => false);
          return value;
        } catch (error) {
          await this.db.feedFinish(claim.token, null, failureCode(error)).catch(() => {
          });
          throw error;
        }
      }
      if (claim.value?.checkedAt) return { ...claim.value, partial: true, feedError: "refresh_in_progress" };
      if (this.now() >= deadline) throw new SourceError("timeout");
      await this.sleep(Math.min(150, Math.max(1, deadline - this.now())));
    }
  }
};

// supabase/functions/svitlo-api/index.ts
var env = (k) => Deno.env.get(k) || "";
var admin = createClient(
  env("SUPABASE_URL"),
  env("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false, autoRefreshToken: false } }
);
var db = new Database(admin);
var service = new Service({
  db,
  source: new Source(providerTransport(db, operatorFetch), { dictionaries: new SharedDictionaries(db), feed: new SharedFeed(db), categories: new SharedCategories(db, env("SUPABASE_SERVICE_ROLE_KEY")) }),
  vapid: env("VAPID_PUBLIC_KEY")
});
Deno.serve(
  (request) => httpHandler(
    request,
    service,
    async (req) => {
      const token = req.headers.get("Authorization")?.replace(/^Bearer /, "");
      if (!token) throw new ApiError(401, "\u041F\u043E\u0442\u0440\u0456\u0431\u043D\u0435 \u043F\u0456\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u043D\u044F");
      const { data, error } = await admin.auth.getUser(token);
      if (error || !data.user)
        throw new ApiError(
          401,
          "\u0421\u0435\u0430\u043D\u0441 \u0437\u0430\u0432\u0435\u0440\u0448\u0438\u0432\u0441\u044F. \u0412\u0456\u0434\u043A\u0440\u0438\u0439\u0442\u0435 \u0437\u0430\u0441\u0442\u043E\u0441\u0443\u043D\u043E\u043A \u043F\u043E\u0432\u0442\u043E\u0440\u043D\u043E."
        );
      return data.user.id;
    },
    env("ALLOWED_ORIGINS").split(",").filter(Boolean)
  )
);
