import { mergePreferences } from "./preferences.js";
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
    this.p.set(p.id, structuredClone({snapshot_revision:0,...p}));
  }
  async createProfile(p) {
    const key = a => JSON.stringify([a.department,a.cityId,a.streetId,a.house]);
    const existing=[...this.p.values()].find(x=>x.owner===p.owner&&key(x.address)===key(p.address));
    if (existing) return {created:false,profile:structuredClone(existing)};
    if ([...this.p.values()].filter(x=>x.owner===p.owner).length>=10) return {status:"limit"};
    // No await between quota/identity checks and insertion.
    this.p.set(p.id,structuredClone({snapshot_revision:0,...p}));
    return {created:true,profile:structuredClone(this.p.get(p.id))};
  }
  async commitProfile(p,revision) {
    const current=this.p.get(p.id);
    if (!current || current.owner!==p.owner) return {status:"missing",profile:null};
    if ((current.snapshot_revision||0)!==revision || current.last_checked>p.last_checked) return {status:"conflict",profile:structuredClone(current)};
    const updated={...current,snapshot:p.snapshot,messages:p.messages,last_checked:p.last_checked,next_check:p.next_check,
      snapshot_revision:revision+1,lease_until:0};
    this.p.set(p.id,structuredClone(updated));
    return {status:"updated",profile:structuredClone(updated)};
  }
  async setPreferences(owner,id,preferences) {
    const p=this.p.get(id);
    if (!p || p.owner!==owner) return null;
    p.preferences=mergePreferences(p.preferences,preferences);return structuredClone(p);
  }
  async releaseProfile() {}
  async jobsClaim() {
    if(this.jobClaimed)return {granted:false};
    this.jobClaimed=true;return {granted:true,token:"memory-claim",cursor:this.reminderCursor||null};
  }
  async jobsFinish(token,cursor) {
    this.jobClaimed=false;this.reminderCursor=cursor;
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
  async reminderProfiles(now, n, offset = 0, cursor = null) {
    return [...this.p.values()]
      .filter((p) => p.last_checked > now - 7200000)
      .filter((p) => p.preferences?.reminder !== false || p.preferences?.restoration !== false)
      .filter((p) => !cursor || p.id>cursor)
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(offset, offset + n);
  }
  async deliveries() {
    return [];
  }
  async cleanup() {}
}
