import { refreshSeeded } from "./helpers/seed-profile.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { Service } from "../server/service.js";
import { MemoryDatabase } from "../server/memory.js";
import { Database } from "../server/database.js";

const now = Date.parse("2026-10-26T15:00:00Z");
const address = { department: "18", cityId: "801", streetId: "11807", house: "10а/51" };
const metadata = {
  id: "registry-one", validFrom: "2026-10-01", validUntil: "2027-04-01",
  documents: [{ queue: "3.2", url: "https://www.cherkasyoblenergo.com/queue.pdf" }],
};
const record = {
  status: "numeric", queue: "3.2", is_estimate: false,
  batch: { import_key: "batch-one", reviewed_at: "2026-10-26T12:00:00Z" },
};

test("catalog resolutions use current compact metadata and read the exact address once", async () => {
  const db = new MemoryDatabase();
  let lookups = 0, definitionReads = 0, current = metadata;
  db.addressQueue = async () => { lookups++; return record; };
  db.registryMetadata = async () => { definitionReads++; return current; };
  db.registry = async () => { throw Error("must not transfer full registry"); };
  const service = new Service({ db, source: {}, now: () => now });
  const resolve = async () => (await service.handle("u", { action: "resolve_queue", address })).resolution;
  assert.equal((await resolve()).queue, "3.2");
  assert.equal(lookups, 1);
  current = { ...metadata, id: "registry-two", validUntil: "2026-10-25" };
  assert.equal((await resolve()).status, "unavailable");
  assert.equal(definitionReads, 2); // An activation or expiry must not be hidden by a cache.
});

test("explicit exclusions work without reading an unavailable PDF registry", async () => {
  const db = new MemoryDatabase();
  db.addressQueue = async () => ({ ...record, status: "not_in_queue", queue: null });
  db.registryMetadata = db.registry = async () => { throw Error("PDF registry unavailable"); };
  const service = new Service({ db, source: {}, now: () => now });
  const { resolution } = await service.handle("u", { action: "resolve_queue", address });
  assert.equal(resolution.queue, null);
  assert.equal(resolution.inclusion, "not_in_queue");
});

test("addresses outside the catalog retain full PDF rule matching", async () => {
  const db = new MemoryDatabase();
  db.addressQueue = async () => null;
  db.registryMetadata = async () => { throw Error("must use full rules for fallback"); };
  db.registry = async () => ({ ...metadata, rules: [{ city: "м. Христинівка", street: "вул. Тестова", houses: ["1"], scope: "house", queue: "3.2", url: metadata.documents[0].url, page: 2 }] });
  const service = new Service({ db, source: {}, now: () => now });
  const resolution = await service.queueResolution({ city: "м. Христинівка", street: "вул. Тестова", house: "1" }, now);
  assert.equal(resolution.queue, "3.2");
  assert.equal(resolution.page, 2);
});

test("profile refresh starts queue lookup while provider data is still pending", async () => {
  const db = new MemoryDatabase();
  let release, lookupStarted = false;
  const waiting = new Promise(resolve => { release = resolve; });
  db.addressQueue = async () => { lookupStarted = true; release(); return record; };
  db.registryMetadata = async () => metadata;
  const source = {
    address: async () => { await waiting; return { queue: "4.2", categories: {}, failures: [] }; },
    feed: async () => ({ plans: [], emergencies: [], messages: [], checkedAt: now }),
  };
  const service = new Service({ db, source, now: () => now });
  const result = await refreshSeeded(service,{ id: "p", owner: "u", address, snapshot: {}, preferences: {} });
  assert.equal(lookupStarted, true);
  assert.equal(result.snapshot.queue, "4.2");
  assert.equal(result.snapshot.queueResolution.source, "address_api");
});

test("database adapter calls the compact RPC without requesting the payload", async () => {
  let method;
  const db = new Database({ rpc: async name => { method = name; return { data: metadata, error: null }; } });
  assert.deepEqual(await db.registryMetadata(), metadata);
  assert.equal(method, "svitlo_queue_metadata");
});

test("compact metadata preserves active PDF definitions, omits document contents, and denies client execution", async () => {
  const db = new PGlite();
  try {
    await db.exec("create role anon; create role authenticated; create role service_role bypassrls; create table public.svitlo_queue_versions(active boolean, payload jsonb); alter table public.svitlo_queue_versions enable row level security; grant select on public.svitlo_queue_versions to service_role;");
    await db.exec(await readFile(new URL("../supabase/migrations/20261026153606_queue_registry_metadata.sql", import.meta.url), "utf8"));
    const payload = { ...metadata, documents: [{ ...metadata.documents[0], extractedText: "x".repeat(100000) }], rules: [{ private: "omit" }], mentions: ["omit"] };
    await db.query("insert into public.svitlo_queue_versions values (true,$1)", [payload]);
    await db.exec("set role service_role");
    assert.deepEqual((await db.query("select public.svitlo_queue_metadata() as value")).rows[0].value, metadata);
    await db.exec("reset role; set role authenticated");
    await assert.rejects(() => db.query("select public.svitlo_queue_metadata()"));
    await db.exec("reset role; set role anon");
    await assert.rejects(() => db.query("select public.svitlo_queue_metadata()"));
    await db.exec("reset role; update public.svitlo_queue_versions set active=false; set role service_role");
    assert.equal((await db.query("select public.svitlo_queue_metadata() as value")).rows[0].value, null);
  } finally { await db.close(); }
});

