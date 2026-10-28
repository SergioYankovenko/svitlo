import { addressResolutionData } from './address-resolution-db.js';
export class Database {
  constructor(client, {scheduledMaintenance=false}={}) {
    this.c = client;
    this.scheduledMaintenance=scheduledMaintenance;
  }
  async result(query) {
    const { data, error } = await query;
    if (error) throw Error("Помилка сховища");
    return data;
  }
  async registry() {
    return (
      (
        await this.result(
          this.c
            .from("svitlo_queue_versions")
            .select("payload")
            .eq("active", true)
            .maybeSingle(),
        )
      )?.payload || null
    );
  }
  async addressQueue(address) {
    const row = await this.result(
      this.c.from("svitlo_effective_address_queues")
        .select("department,city_id,street_id,house,city,street,status,queue,is_estimate,confidence,evidence,batch")
        .eq("department", address.department)
        .eq("city_id", address.cityId)
        .eq("street_id", address.streetId)
        .eq("house", address.house)
        .maybeSingle(),
    );
    return row ? { ...row, batch: Array.isArray(row.batch) ? row.batch[0] : row.batch } : null;
  }
  async addressResolutionData(address) { return addressResolutionData(this,address); }
  async jobsWork(now) { return this.result(this.c.rpc('svitlo_jobs_work',{now_ms:now})); }
  async registryMetadata() {
    return this.result(this.c.rpc("svitlo_queue_metadata"));
  }
  async rememberPreview(owner, key, proof, prepared, checkedAt) {
    await this.result(this.c.rpc("svitlo_preview_put", {subject:owner,cache_key:key,proof,prepared_data:prepared,checked_ms:checkedAt}));
  }
  async takePreview(owner, key, proof) {
    return this.result(this.c.rpc("svitlo_preview_take", {subject:owner,cache_key:key,proof}));
  }
  async dictionaryClaim(key) { return this.result(this.c.rpc("svitlo_dictionary_claim",{cache_key:key})); }
  async dictionaryFinish(key, token, items, error) { return this.result(this.c.rpc("svitlo_dictionary_finish",{cache_key:key,claim:token,items,error_code:error})); }
  async providerAcquire(host) { return this.result(this.c.rpc("svitlo_provider_acquire",{provider_host:host})); }
  async providerFinish(token, status, error, retry) { await this.result(this.c.rpc("svitlo_provider_finish",{claim:token,http_status:status,error_code:error,retry_ms:retry})); }
  async registrySafety(candidate, reconciliation) {
    return this.result(this.c.rpc("svitlo_registry_safety",{candidate:reconciliation?{...candidate,addressReconciliation:reconciliation}:candidate}));
  }
  async holdRegistry(candidate, reconciliation, review) {
    const now=Date.now();
    const old=await this.result(this.c.from("svitlo_registry_candidates").select("created_at").eq("id",candidate.id).maybeSingle());
    await this.result(this.c.from("svitlo_registry_candidates").upsert({id:candidate.id,base_version:reconciliation?.previous_registry_id||null,
      created_at:old?.created_at||now,last_seen_at:now,status:"held",reason:review.reason,summary:review,
      payload:reconciliation?{...candidate,addressReconciliation:reconciliation}:candidate}));
  }
  async registryAccepted(id) {
    await this.result(this.c.from("svitlo_registry_candidates").update({status:"activated"}).eq("id",id));
    await this.result(this.c.from("svitlo_registry_candidates").update({status:"superseded"}).eq("status","held").neq("id",id));
  }
  async startJob(job, now) {
    return (await this.result(this.c.from("svitlo_job_runs").insert({job,started_at:now,status:"running"}).select("id").single())).id;
  }
  async finishJob(id, status, summary, error, now) {
    await this.result(this.c.from("svitlo_job_runs").update({status,summary,error_code:error,finished_at:now}).eq("id",id));
  }
  async opsCleanup() { await this.result(this.c.rpc("svitlo_ops_cleanup")); }
  async addressCatalogBatches() {
    return this.result(this.c.from("svitlo_address_queue_batches")
      .select("id,expected_total").eq("status", "active").order("department"));
  }
  async addressCatalogPage(batchId, offset) {
    return this.result(this.c.from("svitlo_effective_address_queues")
      .select("department,city_id,street_id,house,city,street,status,queue,is_estimate,confidence,evidence,batch,override_registry_id")
      .eq("batch_id", batchId).order("department").order("city_id").order("street_id").order("house")
      .range(offset, offset + 999));
  }
  async addressDictionary(kind, parent) {
    return this.result(this.c.rpc("svitlo_address_dictionary", {
      dictionary_kind: kind,
      parent_id: parent || "",
    }));
  }
  async registryState() {
    return (
      (
        await this.result(
          this.c
            .from("svitlo_cache")
            .select("value")
            .eq("key", "queue-registry-state")
            .maybeSingle(),
        )
      )?.value || {}
    );
  }
  async saveRegistryState(value) {
    await this.result(
      this.c
        .from("svitlo_cache")
        .upsert({ key: "queue-registry-state", value }),
    );
  }
  async activateRegistry(candidate, reconciliation = null) {
    await this.result(this.c.rpc("svitlo_activate_registry", {
      candidate: reconciliation ? { ...candidate, addressReconciliation: reconciliation } : candidate,
    }));
  }
  async profiles(owner) {
    return this.result(this.c.rpc('svitlo_profiles_read',{subject:owner}));
  }
  async profile(owner,id) {
    return (await this.result(this.c.rpc('svitlo_profiles_read',{subject:owner,profile_id:id})))[0] || null;
  }
  async saveProfile(p) {
    await this.result(this.c.from("svitlo_profiles").upsert(p));
  }
  async createProfile(p) {
    const result=await this.result(this.c.rpc("svitlo_profile_create",{subject:p.owner,profile_id:p.id,address_data:p.address,display_name:p.name,preference_data:p.preferences}));
    if(result.profile&&!result.created)result.profile=await this.profile(p.owner,result.profile.id);
    return result;
  }
  async commitProfile(p, expectedRevision) {
    return this.result(this.c.rpc("svitlo_profile_commit_v2",{subject:p.owner,profile_id:p.id,expected_revision:expectedRevision,
      profile_data:{snapshot:p.snapshot,messages:p.messages,last_checked:p.last_checked,next_check:p.next_check}}));
  }
  async setPreferences(owner,id,preferences) {
    await this.result(this.c.rpc("svitlo_preferences_patch",{subject:owner,profile_id:id,patch:preferences}));
    return this.profile(owner,id);
  }
  async releaseProfile(p) {
    await this.result(this.c.from("svitlo_profiles").update({lease_until:0}).eq("id",p.id).eq("owner",p.owner)
      .eq("snapshot_revision",p.snapshot_revision).eq("lease_until",p.lease_until));
  }
  async feedClaim() { return this.result(this.c.rpc("svitlo_feed_claim")); }
  async feedFinish(token,value,error) { return this.result(this.c.rpc("svitlo_feed_finish",{claim:token,feed_value:value,error_code:error})); }
  async jobsClaim() { return this.result(this.c.rpc("svitlo_jobs_claim")); }
  async jobsFinish(token,cursor) { return this.result(this.c.rpc("svitlo_jobs_finish",{claim:token,cursor_id:cursor})); }
  async deleteProfile(owner, id) {
    await this.result(
      this.c.from("svitlo_profiles").delete().eq("owner", owner).eq("id", id),
    );
  }
  async feed() {
    if(this.feedMemo&&this.feedMemo.until>Date.now())return this.feedMemo.promise;
    const promise=this.readFeed();this.feedMemo={until:Date.now()+5000,promise};
    try{return await promise;}catch(error){this.feedMemo=null;throw error;}
  }
  async readFeed() {
    return (
      (
        await this.result(
          this.c
            .from("svitlo_cache")
            .select("value")
            .eq("key", "feed")
            .maybeSingle(),
        )
      )?.value || {}
    );
  }
  async saveFeed(value) {
    await this.result(
      this.c.from("svitlo_cache").upsert({ key: "feed", value }),
    );
    this.feedMemo=null;
  }
  async rate(owner, limit, window) {
    return this.result(
      this.c.rpc("svitlo_rate", {
        subject: owner,
        max_count: limit,
        window_ms: window,
      }),
    );
  }
  async subscribe(owner, subscription, profile) {
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(subscription.endpoint),
    );
    const id = Array.from(new Uint8Array(hash), (x) =>
      x.toString(16).padStart(2, "0"),
    ).join("");
    const existing = await this.result(
      this.c
        .from("svitlo_subscriptions")
        .select("owner")
        .eq("id", id)
        .maybeSingle(),
    );
    if (existing && existing.owner !== owner)
      throw Error("Підписка належить іншому пристрою");
    await this.result(
      this.c.from("svitlo_subscriptions").upsert({
        id,
        owner,
        subscription,
        profile_id: profile,
        updated_at: new Date().toISOString(),
      }),
    );
  }
  async unsubscribe(owner, endpoint) {
    const subs = await this.result(
      this.c
        .from("svitlo_subscriptions")
        .select("id,subscription")
        .eq("owner", owner),
    );
    for (const s of subs)
      if (s.subscription.endpoint === endpoint)
        await this.removeSubscription(s.id);
  }
  async removeSubscription(id) {
    await this.result(
      this.c.from("svitlo_subscriptions").delete().eq("id", id),
    );
  }
  async erase(owner) {
    await this.result(this.c.from("svitlo_previews").delete().eq("owner", owner));
    await this.result(
      this.c.from("svitlo_subscriptions").delete().eq("owner", owner),
    );
    await this.result(
      this.c.from("svitlo_profiles").delete().eq("owner", owner),
    );
  }
  async enqueue(event) {
    await this.result(this.c.rpc("svitlo_enqueue_v2", { event }));
  }
  async due(now, amount) {
    return this.result(
      this.c.rpc("svitlo_due_v2", { now_ms: now, batch_size: amount }),
    );
  }
  async reminderProfiles(now, amount, offset = 0, cursor = null) {
    return this.result(this.c.rpc("svitlo_reminder_profiles", {
      now_ms: now, batch_size: amount, after_id: cursor,
    }));
  }
  async deliveries(now, amount) {
    return this.result(this.c.rpc("svitlo_delivery_claim", { now_ms: now }));
  }
  async deliveryDone(id,token) {
    await this.result(this.c.rpc("svitlo_delivery_finish",{delivery_id:id,claim:token,delivered:true,retry_at:0}));
  }
  async deliveryRelease(id,token,now) {
    await this.result(this.c.rpc("svitlo_delivery_finish",{delivery_id:id,claim:token,delivered:null,retry_at:now}));
  }
  async deliveryRetry(id, now, token, delay=300000) {
    await this.result(this.c.rpc("svitlo_delivery_finish",{delivery_id:id,claim:token,delivered:false,retry_at:now+delay}));
  }
  async cleanup(now) {
    await this.result(this.c.rpc('svitlo_scaling_cleanup'));
    await this.result(this.c.from('svitlo_source_cache').delete().lt('touched_at',now-86400000));
    await this.result(
      this.c
        .from("svitlo_deliveries")
        .delete()
        .lt("expires_at", now - 7 * 86400000),
    );
    await this.result(
      this.c
        .from("svitlo_limits")
        .delete()
        .lt("started_at", now - 86400000),
    );
  }
  async sourceClaim(key,now) { return this.result(this.c.rpc('svitlo_source_claim',{cache_key:key,now_ms:now})); }
  async sourceFinish(key,token,value,now,ttl) { return this.result(this.c.rpc('svitlo_source_finish',{cache_key:key,claim:token,cache_value:value,now_ms:now,ttl_ms:ttl})); }
  async reminderClaim(now,n) { return this.result(this.c.rpc('svitlo_reminder_claim',{now_ms:now,batch_size:n})); }
  async reminderFinish(items) { return this.result(this.c.rpc('svitlo_reminder_finish',{items})); }
  async deliveryBatch(now,n) { return this.result(this.c.rpc('svitlo_delivery_batch',{now_ms:now,batch_size:n})); }
  async deliveryActive(items,now) { return this.result(this.c.rpc('svitlo_delivery_active',{claims:items.map(i=>({id:i.id,token:i.lease_token})),now_ms:now})); }
  async deliveryFinishBatch(items) { return this.result(this.c.rpc('svitlo_delivery_finish_batch',{items})); }
}
