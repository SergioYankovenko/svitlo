// Local preview and tests only. Never imported by the production Edge Functions.
export class MemoryDatabase {
  constructor() {
    this.p = new Map();
    this.f = {};
    this.s = new Map();
    this.events = [];
    this.limits = new Map();
  }
  async registry() {
    return structuredClone(this.registryVersion || null);
  }
  async registryState() {
    return structuredClone(this.registryStatus || {});
  }
  async saveRegistryState(value) {
    this.registryStatus = structuredClone(value);
  }
  async activateRegistry(value) {
    this.registryVersion = structuredClone(value);
  }
  async profiles(owner) {
    return [...this.p.values()]
      .filter((p) => p.owner === owner)
      .map((p) => structuredClone(p));
  }
  async saveProfile(p) {
    this.p.set(p.id, structuredClone(p));
  }
  async deleteProfile(owner, id) {
    if (this.p.get(id)?.owner === owner) {
      this.p.delete(id);
      for (const [key, s] of this.s)
        if (s.profile_id === id) this.s.delete(key);
    }
  }
  async feed() {
    return structuredClone(this.f);
  }
  async saveFeed(f) {
    this.f = structuredClone(f);
  }
  async rate(owner, max, window) {
    const t = Date.now(),
      l = this.limits.get(owner) || { at: t, n: 0 };
    if (t - l.at > window) {
      l.at = t;
      l.n = 0;
    }
    this.limits.set(owner, l);
    return ++l.n <= max;
  }
  async subscribe(owner, subscription, profile_id) {
    const old = this.s.get(subscription.endpoint);
    if (old && old.owner !== owner) throw Error();
    this.s.set(subscription.endpoint, { owner, subscription, profile_id });
  }
  async unsubscribe(owner, endpoint) {
    if (this.s.get(endpoint)?.owner === owner) this.s.delete(endpoint);
  }
  async erase(owner) {
    for (const p of await this.profiles(owner))
      await this.deleteProfile(owner, p.id);
    for (const [key, s] of this.s) if (s.owner === owner) this.s.delete(key);
  }
  async enqueue(e) {
    if (
      !this.events.some(
        (x) =>
          x.owner === e.owner &&
          x.profile_id === e.profile_id &&
          x.event_key === e.event_key,
      )
    )
      this.events.push(e);
  }
  async due(now, n) {
    return [...this.p.values()]
      .filter((p) =>
        p.next_check ? p.next_check <= now : p.last_checked < now - 3600000,
      )
      .slice(0, n);
  }
  async reminderProfiles(now, n, offset = 0) {
    return [...this.p.values()]
      .filter((p) => p.last_checked > now - 7200000)
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(offset, offset + n);
  }
  async deliveries() {
    return [];
  }
  async cleanup() {}
}
