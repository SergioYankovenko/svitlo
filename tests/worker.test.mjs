import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
function worker() {
  const handlers = {},
    calls = [],
    receipts = [],
    root = "https://example.com/svitlo/app/";
  const self = {
    location: { href: root + "sw.js" },
    addEventListener: (name, fn) => (handlers[name] = fn),
    registration: {
      showNotification: async (title, options) =>
        calls.push({ title, options }),
    },
    clients: {
      claim: async () => {},
      matchAll: async () => [],
      openWindow: async (url) => calls.push({ url }),
    },
  };
  const context = {
    URL,
    Response,
    self,
    caches: {
      open: async () => ({
        addAll: async (urls) => calls.push({ urls }),
        put: async (url, response) => receipts.push(await response.json()),
      }),
      match: async (key) => ({ offline: key }),
      keys: async () => [],
    },
    fetch: async () => {
      throw Error("offline");
    },
  };
  vm.runInNewContext(fs.readFileSync("app/sw.js", "utf8"), context);
  return { handlers, calls, context, root, receipts };
}
async function dispatch(fn, event = {}) {
  let pending;
  fn({
    ...event,
    waitUntil: (p) => (pending = p),
    respondWith: (p) => (pending = p),
  });
  return pending;
}
test("service worker precaches app shell inside GitHub Pages subpath", async () => {
  const w = worker();
  await dispatch(w.handlers.install);
  assert(w.calls[0].urls.includes(w.root + "vendor/supabase.js"));
  assert(w.calls[0].urls.every((u) => u.startsWith(w.root)));
});
test("offline navigation returns cached application shell", async () => {
  const w = worker(),
    r = await dispatch(w.handlers.fetch, {
      request: {
        method: "GET",
        url: w.root + "?date=2026-10-24",
        mode: "navigate",
      },
    });
  assert.equal(r.offline, w.root + "index.html");
});
test("API and other origins bypass the service worker cache", () => {
  const w = worker();
  let intercepted = false;
  w.handlers.fetch({
    request: { method: "GET", url: "https://api.example.com/private" },
    respondWith: () => (intercepted = true),
  });
  assert.equal(intercepted, false);
});
test("push shows notification and strips arbitrary click destinations", async () => {
  const w = worker();
  await dispatch(w.handlers.push, {
    data: {
      json: () => ({
        title: "Тест",
        body: "Нове оновлення",
        date: "bad",
        profile: "https://evil.test",
        url: "https://evil.test",
      }),
    },
  });
  assert.equal(w.calls[0].title, "Тест");
  assert.equal(w.calls[0].options.data.profile, null);
  assert.equal(w.calls[0].options.data.date, null);
});
test("notification click opens the requested day within app scope", async () => {
  const w = worker();
  await dispatch(w.handlers.notificationclick, {
    notification: {
      close() {},
      data: {
        date: "2026-10-26",
        profile: "12345678-1234-1234-1234-123456789abc",
      },
    },
  });
  const u = new URL(w.calls[0].url);
  assert.equal(u.pathname, "/svitlo/app/");
  assert.equal(u.searchParams.get("date"), "2026-10-26");
});
test("local diagnostics distinguish received push and created notification", async () => {
  const w = worker();
  await dispatch(w.handlers.push, {
    data: { json: () => ({ title: "Test" }) },
  });
  assert.deepEqual(
    w.receipts.map((r) => r.stage),
    ["received", "created"],
  );
});
test("local diagnostics record display failure without claiming success", async () => {
  const w = worker();
  w.context.self.registration.showNotification = async () => {
    throw new DOMException("Denied", "NotAllowedError");
  };
  await assert.rejects(() =>
    dispatch(w.handlers.push, { data: { json: () => ({}) } }),
  );
  assert.deepEqual(
    w.receipts.map((r) => r.stage),
    ["received", "failed"],
  );
  assert.equal(w.receipts[1].error, "NotAllowedError");
});
