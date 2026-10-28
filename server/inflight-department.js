// Share only concurrent department requests. Completed raw responses are never cached.
// Three slots cover the three categories of one department; excess distinct requests
// use their normal transport without adding more retained entries to this map.
export class InflightDepartmentRequests {
  constructor({ maxEntries = 3 } = {}) {
    this.maxEntries = maxEntries;
    this.entries = new Map();
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
      // Attach consumers before invoking the loader so simultaneous callers can join.
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
        signal?.removeEventListener('abort', aborted);
        entry.consumers--;
        if (!entry.consumers && !entry.settled) {
          if (this.entries.get(key) === entry) this.entries.delete(key);
          entry.controller.abort(new DOMException('No remaining department consumers', 'AbortError'));
        }
        complete(value);
      };
      const aborted = () => finish(reject, signal.reason);
      entry.promise.then(value => finish(resolve, value), error => finish(reject, error));
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }
}
