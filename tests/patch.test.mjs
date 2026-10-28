import { refreshSeeded } from "./helpers/seed-profile.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  dayState,
  countdown,
  roundHalfHour,
  refreshFailure,
} from "../app/lib/schedule.js";
import { civil, clock } from "../app/lib/time.js";
import { hourTile } from "../app/lib/tiles.js";
import {
  registryMatch,
  rulesFromPages,
  syncRegistry,
  REGISTRY_INTERVAL,
} from "../server/queue-registry.js";
import { MemoryDatabase } from "../server/memory.js";
import { Service, httpHandler } from "../server/service.js";
import { Source, jsonFetch, parseMaintenance } from "../server/source.js";
const now = civil("2026-10-24", 901),
  date = "2026-10-24";
const cats = () =>
  Object.fromEntries(
    ["hourly", "planned", "emergency"].map((k) => [
      k,
      { events: [], checkedAt: now, sourceAt: now },
    ]),
  );
const data = (events = [], queue = "3.2") => ({
  queue,
  categories: { ...cats(), hourly: { events, checkedAt: now, sourceAt: now } },
  plans: [],
  emergencies: [],
  feedCheckedAt: now,
  failures: [],
});
const event = (s, e, category = "hourly") => ({
  start: civil(date, s),
  end: civil(date, e),
  category,
});
test("unknown queue plus empty success never yields confirmed clear day or reminders", async () => {
  const d = data([], null),
    s = dayState(d, date, now);
  assert.equal(s.known, false);
  assert.equal(s.totals, null);
  assert.equal(s.reason, "queue_unknown");
  assert.ok(
    s.displayHours.every((h) => h.segments.every((x) => x.kind === "unknown")),
  );
  assert.equal(countdown(d, now).label, "Немає точних даних");
  const db = new MemoryDatabase();
  await new Service({ db, now: () => now }).reminders({
    id: "x",
    owner: "u",
    snapshot: d,
  });
  assert.equal(db.events.length, 0);
});
test("address intervals remain visible when queue unknown, rest stays unknown", () => {
  const s = dayState(data([event(721, 842)], null), date, now);
  assert.equal(s.totals, null);
  assert.equal(s.hours[14].segments[0].kind, "hourly");
  assert.equal(s.displayHours[14].segments[0].kind, "unknown");
  assert.equal(s.displayHours[12].segments[0].kind, "hourly");
});
test("display rounding never mutates raw data, countdown or daily totals", () => {
  const d = data([event(721, 842)]);
  for (const c of Object.values(d.categories)) {
    c.checkedAt = civil(date, 841);
    c.sourceAt = civil(date, 841);
  }
  d.feedCheckedAt = civil(date, 841);
  const raw = JSON.stringify(d),
    s = dayState(d, date, civil(date, 841));
  assert.deepEqual(s.totals, { off: 121, on: 1319 });
  assert.equal(s.displayHours[14].segments[0].kind, "clear");
  assert.equal(countdown(d, civil(date, 841)).minutes, 1);
  assert.equal(JSON.stringify(d), raw);
});
test("half-hour boundaries, ties, midnight and collapsed short events", () => {
  for (const [m, expected] of [
    [0, 0],
    [14, 0],
    [15, 30],
    [16, 30],
    [29, 30],
    [30, 30],
    [44, 30],
    [45, 60],
    [46, 60],
    [59, 60],
  ])
    assert.equal(
      roundHalfHour(civil(date, 720 + m)),
      civil(date, 720 + expected),
    );
  assert.equal(roundHalfHour(civil(date, 1439)), civil("2026-10-25"));
  const s = dayState(data([event(721, 722)]), date, now);
  assert.equal(s.totals.off, 1);
  assert.ok(
    s.displayHours.every(
      (h) =>
        h.segments.length === 2 && h.segments.every((x) => x.kind === "clear"),
    ),
  );
});
test("first and second half have correct labels and icon position; old mode is single-time", () => {
  for (const [a, b, slot] of [
    [840, 870, 0],
    [870, 900, 1],
  ]) {
    const s = dayState(data([event(a, b)]), date, now),
      h = s.displayHours[14],
      html = hourTile(h, date, now, true);
    assert.match(html, new RegExp("half-" + slot));
    assert.ok(
      html.includes(clock(civil(date, a))) &&
        html.includes(clock(civil(date, b))),
    );
    assert.match(html, /to bottom/);
    const legacy = hourTile(h, date, now, false);
    assert.doesNotMatch(legacy, /tile-times/);
    assert.match(legacy, /to right/);
  }
});
test("category priority and two categories retain both halves and full-hour labels", () => {
  const d = data([event(840, 900), event(870, 900, "emergency")]),
    h = dayState(d, date, now).displayHours[14];
  assert.deepEqual(
    h.segments.map((x) => x.kind),
    ["hourly", "emergency"],
  );
  const html = hourTile(h, date, now, true);
  assert.match(html, /14:00/);
  assert.match(html, /15:00/);
  assert.match(html, /half-0/);
  assert.match(html, /half-1/);
});
test("DST retains 23/25 real hours and both repeated-hour instants", () => {
  for (const [date, n] of [
    ["2026-03-29", 23],
    ["2026-10-25", 25],
  ]) {
    const s = dayState(null, date, civil(date, 720));
    assert.equal(s.hours.length, n);
    assert.equal(s.displayHours.length, n);
    assert.equal(new Set(s.displayHours.map((h) => h.start)).size, n);
    assert.equal(s.displayHours.flatMap((h) => h.segments).length, n * 2);
  }
});
test("stale source timestamp cannot become complete through a new fetch timestamp", () => {
  const d = data();
  d.categories.hourly.sourceAt = now - 3 * 3600000;
  assert.equal(dayState(d, date, now).totals, null);
  assert.equal(dayState(d, date, now).stale, true);
});
const version = () => ({
  id: "v",
  validFrom: "2026-10-01",
  validUntil: "2027-04-01",
  checkedAt: now,
  rules: [
    {
      city: "м.Христинівка",
      street: "вул.Флорештська",
      scope: "street_all",
      queue: "3.2",
      url: "https://www.cherkasyoblenergo.com/x",
      page: 5,
    },
    { city: "с.Сичівка", scope: "settlement_all", queue: "5.2", page: 5 },
  ],
});
test("official registry matches exact street or explicit full settlement, never neighbors or same-name village", () => {
  const a = {
    city: "м. Христинівка",
    street: "вул. Флорештська",
    house: "10а/51",
  };
  assert.equal(registryMatch(version(), a, now).queue, "3.2");
  assert.equal(
    registryMatch(version(), { ...a, city: "с. Христинівка" }, now).queue,
    null,
  );
  assert.equal(
    registryMatch(version(), { ...a, street: "вул. Інша" }, now).queue,
    null,
  );
  assert.equal(
    registryMatch(
      version(),
      { city: "с. Сичівка", street: "вул. Грушевського", house: "1" },
      now,
    ).queue,
    "5.2",
  );
  const v = version();
  v.rules.push({ ...v.rules[0], queue: "4.2" });
  assert.equal(registryMatch(v, a, now).status, "ambiguous");
  assert.equal(
    registryMatch({ ...version(), validUntil: "2026-10-23" }, a, now).queue,
    null,
  );
});
test("conservative PDF extraction skips partial streets and business clauses", () => {
  const rules = rulesFromPages(
    [
      'м.Христинівка\nвул : Флорештська, С.Попика (від вул.А до вул.Б), Інша 1-10\nпров.: Миру\nТОВ "Завод"\nСела: с.Сичівка, с.Івангород, с.Синиця вул.Зарічна.',
    ],
    "3.2",
    "https://www.cherkasyoblenergo.com/test",
  );
  assert.equal(rules.find((r) => r.street === "вул.Флорештська")?.queue, "3.2");
  assert.equal(rules.length, 3);
});
test("failed registry import retains active version and schedules backed-off retry", async () => {
  const db = new MemoryDatabase();
  await db.activateRegistry(version());
  const r = await syncRegistry({
    db,
    now,
    fetcher: async () => new Response("bad", { status: 503 }),
  });
  assert.equal(r.status, "failed_retained");
  assert.equal((await db.registry()).id, "v");
  assert.ok((await db.registryState()).nextCheckAt > now);
});
test("registry interval guard avoids unnecessary PDF/network work", async () => {
  const db = new MemoryDatabase();
  await db.saveRegistryState({ nextCheckAt: now + REGISTRY_INTERVAL });
  assert.equal(
    (
      await syncRegistry({
        db,
        now,
        fetcher: () => {
          throw Error("must not fetch");
        },
      })
    ).status,
    "not_due",
  );
});

test("registry imports twelve documents and reparses only changed PDF bytes", async () => {
  const db = new MemoryDatabase();
  const links = Array.from(
    { length: 12 },
    (_, i) =>
      `https://www.cherkasyoblenergo.com/cherkasyoblenergo/uploads/pages/files/${(i + 1).toString(16)}.pdf`,
  );
  let changed = false,
    parsed = 0;
  const fetcher = async (url) => {
    const index = links.indexOf(url);
    return index < 0
      ? new Response(links.map((url) => `<a href="${url}">PDF</a>`).join(""))
      : new Response(`${index}:${changed && index === 5 ? "v2" : "v1"}`);
  };
  const pdfPages = async (bytes) => {
    parsed++;
    const i = +new TextDecoder().decode(bytes).split(":")[0];
    return [
      `${Math.floor(i / 2) + 1} черга ${i % 2 ? "ІІ" : "І"} підчерга\nз 1 жовтня 2026 р. по 1 квітня 2027\nм.Христинівка\nвул: ${i === 5 ? "Флорештська" : "Тест" + String.fromCharCode(65 + i)}`,
    ];
  };
  const first = await syncRegistry({ db, fetcher, pdfPages, now });
  assert.equal(first.status, "updated");
  assert.equal(parsed, 12);
  assert.equal((await db.registry()).documents.length, 12);
  assert.equal(
    (
      await syncRegistry({
        db,
        fetcher,
        pdfPages,
        now: now + REGISTRY_INTERVAL,
      })
    ).status,
    "unchanged",
  );
  assert.equal(parsed, 12);
  changed = true;
  const next = await syncRegistry({
    db,
    fetcher,
    pdfPages,
    now: now + 2 * REGISTRY_INTERVAL,
  });
  assert.equal(next.status, "updated");
  assert.equal(parsed, 13);
  assert.notEqual(next.version, first.version);
});
test("fallback registry integrates through service and guarded Android lookup", async () => {
  const db = new MemoryDatabase();
  await db.activateRegistry(version());
  const address = {
    city: "м.Христинівка",
    street: "вул.Флорештська",
    house: "10а/51",
  };
  const source = {
    address: async () => ({ ...data([], null), checkedAt: now }),
    feed: async () => ({
      checkedAt: now,
      plans: [],
      emergencies: [],
      messages: [],
    }),
  };
  const svc = new Service({ db, source, now: () => now });
  const p = await refreshSeeded(svc,{
    id: "p",
    owner: "u",
    address,
    snapshot: {},
    messages: [],
  });
  assert.equal(p.snapshot.queue, "3.2");
  assert.equal(p.snapshot.queueResolution.scope, "street_all");
  assert.equal(
    (await svc.handle("u", { action: "resolve_queue", id: "p" })).resolution
      .queue,
    "3.2",
  );
  await assert.rejects(
    () => svc.handle("other", { action: "resolve_queue", id: "p" }),
    (e) => e.status === 404,
  );
});
test("source failures keep old intervals with structured cause and no private URL", async () => {
  const old = data([event(720, 840)]);
  const source = new Source(async () => new Response("", { status: 429 }));
  const r = await source.address({ account: "12345678901" }, now, old);
  assert.deepEqual(r.categories.hourly.events, old.categories.hourly.events);
  assert.equal(r.errors.hourly, "rate_limited");
  assert.equal(JSON.stringify(r).includes("12345678901"), false);
});
test("explicit address API queue wins over registry while retaining conflict evidence", async () => {
  const db = new MemoryDatabase();
  await db.activateRegistry(version());
  const source = {
    address: async () => ({ ...data([], "4.2"), checkedAt: now }),
    feed: async () => ({
      checkedAt: now,
      plans: [],
      emergencies: [],
      messages: [],
    }),
  };
  const p = await refreshSeeded(new Service({ db, source, now: () => now }),{
    id: "p",
    owner: "u",
    address: {
      city: "м.Христинівка",
      street: "вул.Флорештська",
      house: "10а/51",
    },
    snapshot: {},
    messages: [],
  });
  assert.equal(p.snapshot.queue, "4.2");
  assert.equal(p.snapshot.queueResolution.conflict.registryQueue, "3.2");
});
test("only current household-specific official maintenance with explicit end is shown", () => {
  const a = {
    title: "Технічні роботи",
    body: "Кабінет побутового споживача недоступний до 18:00",
    publishedAt: now - 60000,
    url: "https://www.cherkasyoblenergo.com/media/test",
  };
  assert.ok(parseMaintenance(a, now));
  for (const change of [
    { body: "Кабінет непобутового споживача до 18:00" },
    { body: "Кабінет побутового споживача тимчасово недоступний" },
    { publishedAt: now - 2 * 86400000 },
    { title: "Технічні роботи завершено" },
  ])
    assert.equal(parseMaintenance({ ...a, ...change }, now), null);
});
test("maintenance about another date cannot explain a current API failure", () => {
  const a = {
    title: "Технічні роботи",
    body: "24.10.2026 Кабінет побутового споживача недоступний до 18:00",
    publishedAt: now - 60000,
    url: "https://www.cherkasyoblenergo.com/media/test",
  };
  assert.ok(parseMaintenance(a, now));
  assert.equal(
    parseMaintenance(
      { ...a, body: a.body.replace("24.10.2026", "25.10.2026") },
      now,
    ),
    null,
  );
});
test("refresh distinguishes operator failure causes and clears messages on recovery", () => {
  assert.match(
    refreshFailure({ failures: ["hourly"], errors: { hourly: "timeout" } }),
    /вчасно/,
  );
  assert.match(
    refreshFailure({
      failures: [],
      feedFailed: true,
      feedError: "rate_limited",
    }),
    /обмежив/,
  );
  assert.equal(
    refreshFailure({
      failures: [],
      errors: { hourly: "timeout" },
      feedFailed: false,
    }),
    "",
  );
  assert.doesNotMatch(
    refreshFailure({ failures: ["hourly"], errors: { hourly: "forbidden" } }),
    /інтернет|технічні роботи/i,
  );
});
test("repeated source failure backs off and recovery clears failure state", async () => {
  const db = new MemoryDatabase();
  const source = {
    address: async (a, t, old) => ({
      ...data(),
      checkedAt: now,
      failures: ["hourly"],
    }),
    feed: async () => ({
      checkedAt: now,
      plans: [],
      emergencies: [],
      messages: [],
    }),
  };
  const svc = new Service({ db, source, now: () => now });
  let p = {
    id: "p",
    owner: "u",
    address: {},
    messages: [],
    snapshot: {},
    last_checked: 0,
  };
  await db.saveProfile(p);
  p = await svc.refresh(p);
  const first = p.next_check;
  p = await svc.refresh(p);
  assert.ok(p.next_check > first);
  source.address = async () => ({ ...data(), checkedAt: now });
  p = await svc.refresh(p);
  assert.equal(p.snapshot.failureCount, 0);
  assert.equal(p.snapshot.lastSuccessAt, now);
});
