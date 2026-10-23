import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  civil,
  dayKey,
  monday,
  week,
  duration,
  sourceTime,
} from "../app/lib/time.js";
import {
  article,
  parsePlan,
  parseEmergency,
  parseOutages,
  mergeHistory,
} from "../app/lib/parsers.js";
import {
  dayState,
  emergencyPolicy,
  countdown,
  canNextWeek,
} from "../app/lib/schedule.js";
import { matchesAddress, latin, Source } from "../server/source.js";
const fixture = async (file) =>
  JSON.parse(
    await readFile(new URL("./fixtures/" + file, import.meta.url), "utf8"),
  );
const at = civil("2026-10-24", 82),
  a23 = article(await fixture("plan23.json")),
  a24 = article(await fixture("plan24.json")),
  em = article(await fixture("emergency23.json"));
const categories = Object.fromEntries(
  ["hourly", "planned", "emergency"].map((k) => [
    k,
    { checkedAt: at, sourceAt: at, events: [] },
  ]),
);
const data = {
  categories,
  queue: "3.2",
  failures: [],
  plans: parsePlan(a24, at),
  emergencies: [parseEmergency(em)],
  feedCheckedAt: at,
};
test("Kyiv civil time and DST days", () => {
  assert.equal(dayKey(Date.parse("2026-10-23T22:22Z")), "2026-10-24");
  assert.equal((civil("2026-10-26") - civil("2026-10-25")) / 3600000, 25);
  assert.equal((civil("2026-03-30") - civil("2026-03-29")) / 3600000, 23);
  assert.throws(() => civil("2026-10-25", 210));
  assert.throws(() => civil("2026-03-29", 210));
});
test("strict calendar and publication time", () => {
  assert.throws(() => civil("2026-02-30"));
  assert.equal(sourceTime("2026-10-23T10:40:00"), civil("2026-10-23", 640));
});
test("fixed Monday to Sunday", () => {
  assert.equal(monday("2026-10-25"), "2026-10-19");
  assert.deepEqual(week("2026-10-25"), [
    "2026-10-19",
    "2026-10-20",
    "2026-10-21",
    "2026-10-22",
    "2026-10-23",
    "2026-10-24",
    "2026-10-25",
  ]);
  assert.equal(monday("2026-10-26"), "2026-10-26");
});
test("duration does not display zero minutes", () => {
  assert.equal(duration(1050), "17 год 30 хв");
  assert.equal(duration(1020), "17 год");
  assert.equal(duration(0), "0 год");
});
test("real GPV article parses all twelve queues", () => {
  const plans = parsePlan(a23, at);
  assert.equal(plans.length, 12);
  assert.ok(plans.every((p) => !p.uncertain));
  assert.equal(plans.find((x) => x.queue === "3.2").events.length, 3);
});
test("real next day plan gives 20/4 and no false emergency banner", () => {
  const s = dayState(data, "2026-10-24", at);
  assert.equal(s.totals?.off, 240);
  assert.equal(s.totals?.on, 1200);
  assert.equal(s.policy.active, false);
  assert.equal(s.policy.validity, "active");
  assert.equal(
    s.hours.filter((h) => h.segments.some((s) => s.kind === "hourly")).length,
    4,
  );
});
test("unchanged stale emergency command does not renew on refresh", () => {
  const cmd = parseEmergency(em),
    now = cmd.effectiveAt + 4 * 3600000;
  assert.equal(
    emergencyPolicy({ ...data, feedCheckedAt: now }, now).active,
    false,
  );
});
test("recent command and fresh verification needed", () => {
  const cmd = parseEmergency(em),
    now = cmd.publishedAt + 1000;
  assert.equal(
    emergencyPolicy({ ...data, feedCheckedAt: now }, now).active,
    true,
  );
  assert.equal(
    emergencyPolicy({ ...data, feedCheckedAt: now - 3 * 3600000 }, now).active,
    false,
  );
});
test("explicit command end time honored", () => {
  const cmd = { ...parseEmergency(em), until: at + 3600000 };
  assert.equal(
    emergencyPolicy({ ...data, emergencies: [cmd] }, at).active,
    true,
  );
  assert.equal(
    emergencyPolicy(
      { ...data, emergencies: [cmd], feedCheckedAt: at + 7200000 },
      at + 7200000,
    ).active,
    false,
  );
});
test("mention in GPV footer is not emergency activation", () =>
  assert.equal(parseEmergency(a23), null));
test("hypothetical and negated emergency do not activate", () => {
  for (const t of [
    "Можуть бути введені графіки аварійних відключень",
    "Не застосовані графіки аварійних відключень",
  ])
    assert.equal(parseEmergency({ ...em, title: t }), null);
});
test("unsupported / incomplete plan stays uncertain", () => {
  const result = parsePlan({ ...a23, body: "3.2 08:00 - 10:00" }, at);
  assert.ok(result.every((x) => x.uncertain));
});
test("partial corrections affect only mentioned queues", () => {
  const result = parsePlan(
    {
      ...a23,
      title: "Оновлено графік погодинних відключень на 23 жовтня",
      body: "3.2 08:00 - 10:00",
    },
    at,
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].uncertain, false);
});
test("unknown or invalid intervals never turn green", () => {
  for (const text of [
    "24:30 - 25:00",
    "10:00 - 08:00",
    "08:00 - 10:00, 09:00 - 11:00",
    "за потреби",
  ]) {
    const p = parsePlan(
      {
        ...a23,
        title: "Оновлено графік ГПВ на 23 жовтня",
        body: "3.2 " + text,
      },
      at,
    )[0];
    assert.equal(p.uncertain, true);
  }
});
test("today empty only after complete successful checks; tomorrow unavailable", () => {
  const empty = { ...data, plans: [], emergencies: [] };
  assert.deepEqual(dayState(empty, "2026-10-24", at).totals, {
    off: 0,
    on: 1440,
  });
  assert.equal(dayState(empty, "2026-10-25", at).available, false);
  assert.equal(
    dayState({ ...empty, failures: ["hourly"] }, "2026-10-24", at).totals,
    null,
  );
});
test("failed refresh preserves displayed cached schedule", () => {
  const s = dayState(
    { ...data, failures: ["hourly"], feedFailed: true },
    "2026-10-24",
    at,
  );
  assert.equal(s.stale, true);
  assert.equal(s.totals.off, 240);
});
test("past outages remain colored", () => {
  const now = civil("2026-10-23", 1100),
    p = parsePlan(a23, now);
  const s = dayState({ ...data, plans: p, emergencies: [] }, "2026-10-23", now);
  assert.equal(s.hours[8].segments[0].kind, "hourly");
  assert.equal(s.hours[9].segments[0].kind, "hourly");
});
test("regional warning never colors entire address red", () => {
  const now = parseEmergency(em).publishedAt + 1000,
    s = dayState(
      { ...data, feedCheckedAt: now, plans: parsePlan(a23, now) },
      "2026-10-23",
      now,
    );
  assert.ok(
    s.hours.every((h) => h.segments.every((s) => s.kind !== "emergency")),
  );
});
test("confirmed open address emergency red to now, future uncertain", () => {
  const now = civil("2026-10-24", 90),
    s = dayState(
      {
        ...data,
        categories: {
          ...categories,
          emergency: {
            ...categories.emergency,
            events: [
              {
                category: "emergency",
                start: civil("2026-10-24", 30),
                end: null,
              },
            ],
          },
        },
      },
      "2026-10-24",
      now,
    );
  assert.equal(s.totals, null);
  assert.equal(s.hours[1].segments[0].kind, "emergency");
  assert.equal(s.hours[2].segments[0].kind, "unknown");
});
test("suspended plan disables countdown", () => {
  const cmd = {
    ...parseEmergency(em),
    publishedAt: at - 1000,
    effectiveAt: at - 1000,
    validity: "suspended",
  };
  assert.equal(
    countdown({ ...data, emergencies: [cmd] }, at).label,
    "Час відключень уточнюється",
  );
});
test("next week only if Monday is published", () => {
  assert.equal(canNextWeek(data, at), false);
  assert.equal(
    canNextWeek(
      {
        ...data,
        plans: [{ date: "2026-10-26", queue: "3.2", uncertain: false }],
      },
      at,
    ),
    true,
  );
  assert.equal(
    canNextWeek(
      {
        ...data,
        plans: [{ date: "2026-10-26", queue: "3.2", uncertain: true }],
      },
      at,
    ),
    false,
  );
});
test("feed retention and sort use actual update times", () => {
  const r = mergeHistory(
    [],
    [
      { id: "new", updatedAt: at - 1000 },
      { id: "old", updatedAt: at - 6 * 86400000 },
      { id: "expired", updatedAt: at - 8 * 86400000 },
    ],
    at,
  );
  assert.deepEqual(
    r.map((x) => x.id),
    ["new", "old"],
  );
});
test("operator malformed response throws, not empty success", () => {
  for (const root of [
    {},
    { DISCONNECTIONS: null },
    { DISCONNECTIONS: "bad" },
    { ERROR: "error", DISCONNECTIONS: [] },
  ])
    assert.throws(() => parseOutages(root, "hourly", at));
});
test("operator DATE_TIME overrides withdrawn end and queue exact", () => {
  const s = parseOutages(
    {
      DATETIME: "01:00 24.10.2026",
      DISCONNECTIONS: [
        {
          DATE_START: "00:30 24.10.2026",
          DATE_STOP: "02:00 24.10.2026",
          DATE_TIME: "уточнюється",
        },
      ],
      DISCONN_QUEUQ: [
        { QUEUE_INFO: "Графік погодинних відключень 3 черга 2 підчерга" },
      ],
    },
    "emergency",
    at,
  );
  assert.equal(s.events[0].end, null);
  assert.equal(s.queue, "3.2");
});
test("dictionary address match is exact", () => {
  const a = { city: "м. Христинівка", street: "вул. Соборна", house: "12" };
  assert.equal(
    matchesAddress(
      "<strong>м. Христинівка</strong><br>вул. Соборна 12, 14<br>",
      a,
    ),
    true,
  );
  assert.equal(
    matchesAddress("<strong>с. Христинівка</strong><br>вул. Соборна 12<br>", a),
    false,
  );
  assert.equal(
    matchesAddress(
      "<strong>м. Христинівка</strong><br>вул. Соборна 112<br>",
      a,
    ),
    false,
  );
  assert.throws(() =>
    matchesAddress(
      "<strong>м. Христинівка</strong><br>вул. Соборна 1-20<br>",
      a,
    ),
  );
});
test("weather transliteration fallback", () => {
  assert.equal(latin("Бойківщина"), "boikivshchyna");
  assert.equal(latin("Згурівка"), "zghurivka");
});
