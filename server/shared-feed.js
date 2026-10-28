import { SourceError, failureCode } from "./source-errors.js";

// One refresh owner across Edge workers; timestamps belong to the source result.
export class SharedFeed {
  constructor(db, { now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)), maxWaitMs = 28000 } = {}) {
    Object.assign(this, { db, now, sleep, maxWaitMs });
  }
  async load(previous, loader, signal) {
    // A caller's cancellation must not abort a refresh owned by another caller.
    const deadline = this.now() + this.maxWaitMs;
    while (true) {
      signal?.throwIfAborted();
      const claim = await this.db.feedClaim();
      if (claim.state === "fresh") return claim.value;
      if (claim.state === "owner") {
        try {
          const value = await loader(claim.value || previous, signal);
          // A valid source result remains usable if the optional cache write fails.
          await this.db.feedFinish(claim.token, value, null).catch(() => false);
          return value;
        } catch (error) {
          await this.db.feedFinish(claim.token, null, failureCode(error)).catch(() => {});
          throw error;
        }
      }
      // Existing data remains usable with its original timestamp; this is not a successful refresh.
      if (claim.value?.checkedAt) return { ...claim.value, partial: true, feedError: "refresh_in_progress" };
      if (this.now() >= deadline) throw new SourceError("timeout");
      await this.sleep(Math.min(150, Math.max(1, deadline - this.now())));
    }
  }
}
