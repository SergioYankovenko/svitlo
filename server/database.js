export class Database {
  constructor(client) {
    this.c = client;
  }
  async result(query) {
    const { data, error } = await query;
    if (error) throw Error("Помилка сховища");
    return data;
  }
  async profiles(owner) {
    return this.result(
      this.c
        .from("svitlo_profiles")
        .select("*")
        .eq("owner", owner)
        .order("created_at"),
    );
  }
  async saveProfile(p) {
    await this.result(this.c.from("svitlo_profiles").upsert(p));
  }
  async deleteProfile(owner, id) {
    await this.result(
      this.c.from("svitlo_profiles").delete().eq("owner", owner).eq("id", id),
    );
  }
  async feed() {
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
      this.c
        .from("svitlo_subscriptions")
        .upsert({
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
    await this.result(
      this.c.from("svitlo_subscriptions").delete().eq("owner", owner),
    );
    await this.result(
      this.c.from("svitlo_profiles").delete().eq("owner", owner),
    );
  }
  async enqueue(event) {
    await this.result(this.c.rpc("svitlo_enqueue", { event }));
  }
  async due(now, amount) {
    return this.result(
      this.c.rpc("svitlo_due", { now_ms: now, batch_size: amount }),
    );
  }
  async reminderProfiles(now, amount, offset = 0) {
    return this.result(
      this.c
        .from("svitlo_profiles")
        .select("*")
        .gt("last_checked", now - 7200000)
        .order("id")
        .range(offset, offset + amount - 1),
    );
  }
  async deliveries(now, amount) {
    return this.result(
      this.c.rpc("svitlo_deliveries", { now_ms: now, batch_size: amount }),
    );
  }
  async deliveryDone(id) {
    await this.result(
      this.c.from("svitlo_deliveries").update({ sent: true }).eq("id", id),
    );
  }
  async deliveryRetry(id, now) {
    await this.result(
      this.c
        .from("svitlo_deliveries")
        .update({ lease_until: now + 300000 })
        .eq("id", id),
    );
  }
  async cleanup(now) {
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
}
