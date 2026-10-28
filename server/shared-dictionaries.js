import { failureCode, SourceError } from "./source-errors.js";
export class SharedDictionaries {
  constructor(db, { now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)), maxWaitMs = 22000 } = {}) {
    Object.assign(this, { db, now, sleep, maxWaitMs }); this.pending = new Map();
  }
  load(key, loader) {
    if (this.pending.has(key)) return this.pending.get(key);
    const request = this.obtain(key, loader).finally(() => this.pending.delete(key));
    this.pending.set(key, request); return request;
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
          await this.db.dictionaryFinish(key, claim.token, null, failureCode(error)).catch(() => {});
          if (Array.isArray(claim.items)) return { items: claim.items, checkedAt: claim.checkedAt };
          throw error;
        }
        await this.db.dictionaryFinish(key, claim.token, items, null).catch(() => {});
        return { items, checkedAt: this.now() };
      }
      if (Array.isArray(claim.items)) return { items: claim.items, checkedAt: claim.checkedAt };
      if (this.now() >= deadline) throw new SourceError("timeout");
      await this.sleep(Math.min(150, Math.max(1, deadline - this.now())));
    }
  }
}
