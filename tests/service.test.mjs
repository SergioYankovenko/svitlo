import test from "node:test";
import assert from "node:assert/strict";
import { Service, validSubscription, httpHandler } from "../server/service.js";
import { MemoryDatabase } from "../server/memory.js";
const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/valid",
  keys: { p256dh: "A".repeat(87), auth: "A".repeat(22) },
};
test("push endpoint validation blocks SSRF and malformed keys", () => {
  assert.equal(validSubscription(subscription), true);
  for (const endpoint of [
    "http://localhost/",
    "https://127.0.0.1/",
    "https://fcm.googleapis.com.attacker.invalid/",
    "https://user@fcm.googleapis.com/",
    "https://fcm.googleapis.com:8443/",
  ])
    assert.equal(validSubscription({ ...subscription, endpoint }), false);
  assert.equal(validSubscription({ ...subscription, keys: {} }), false);
});
test("owner cannot read change or remove another device address", async () => {
  const db = new MemoryDatabase();
  await db.saveProfile({
    id: "one",
    owner: "alice",
    address: { account: "12345678901", city: "Черкаси" },
    snapshot: {},
  });
  const svc = new Service({ db, source: {} });
  assert.deepEqual(
    (await svc.handle("bob", { action: "bootstrap" })).profiles,
    [],
  );
  for (const action of ["refresh", "delete", "preferences", "weather"])
    await assert.rejects(
      () => svc.handle("bob", { action, id: "one" }),
      (e) => e.status === 404,
    );
  assert.equal(db.p.size, 1);
  assert.equal(
    (await svc.handle("alice", { action: "bootstrap" })).profiles[0].address
      .account,
    undefined,
  );
});
test("saving requires explicit confirmation", async () => {
  const svc = new Service({ db: new MemoryDatabase(), source: {} });
  await assert.rejects(
    () => svc.handle("user", { action: "save" }),
    (e) => e.status === 400,
  );
});
test("production HTTP requests require auth and approved origin", async () => {
  const svc = new Service({ db: new MemoryDatabase(), source: {} }),
    origins = ["https://example.com"];
  let r = await httpHandler(
    new Request("https://api.test", {
      method: "POST",
      headers: { origin: "https://evil.test" },
      body: "{}",
    }),
    svc,
    async () => "user",
    origins,
  );
  assert.equal(r.status, 403);
  r = await httpHandler(
    new Request("https://api.test", {
      method: "POST",
      headers: { origin: origins[0] },
      body: '{"action":"bootstrap"}',
    }),
    svc,
    async () => null,
    origins,
  );
  assert.equal(r.status, 401);
});
test("notification idempotency is per profile and owner", async () => {
  const db = new MemoryDatabase(),
    svc = new Service({ db, source: {}, now: () => 123456789 });
  const p = { id: "p", owner: "u" };
  await svc.enqueue(p, "revision", "Title", "2026-10-24");
  await svc.enqueue(p, "revision", "Title", "2026-10-24");
  await svc.enqueue({ ...p, id: "p2" }, "revision", "Title", "2026-10-24");
  assert.equal(db.events.length, 2);
});
test("profile switching does not re-stamp cached data", async () => {
  const db = new MemoryDatabase(),
    now = 100000;
  await db.saveProfile({
    id: "p",
    owner: "u",
    last_checked: now - 1000,
    address: { city: "A" },
    snapshot: { checkedAt: 50000 },
  });
  const svc = new Service({
    db,
    now: () => now,
    source: {
      address() {
        throw Error("should not run");
      },
    },
  });
  const result = await svc.handle("u", { action: "refresh", id: "p" });
  assert.equal(result.profile.snapshot.checkedAt, 50000);
});
test("subscribe binding and unsubscribe are owner-scoped", async () => {
  const db = new MemoryDatabase(),
    svc = new Service({ db, source: {}, vapid: "public" });
  await svc.handle("u", { action: "subscribe", subscription });
  await svc.handle("v", {
    action: "unsubscribe",
    endpoint: subscription.endpoint,
  });
  assert.equal(db.s.size, 1);
  await assert.rejects(() =>
    svc.handle("v", { action: "subscribe", subscription }),
  );
  await svc.handle("u", {
    action: "unsubscribe",
    endpoint: subscription.endpoint,
  });
  assert.equal(db.s.size, 0);
});
test("background reminders include profiles beyond the first page", async () => {
  const db = new MemoryDatabase(),
    now = 10000000;
  for (let i = 0; i < 205; i++)
    await db.saveProfile({ id: String(i).padStart(3, "0"), last_checked: now });
  const svc = new Service({ db, source: {}, now: () => now });
  const seen = [];
  svc.reminders = async (p) => seen.push(p.id);
  await svc.jobs();
  assert.equal(seen.length, 205);
  assert.equal(new Set(seen).size, 205);
});
