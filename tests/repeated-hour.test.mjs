import test from "node:test";
import assert from "node:assert/strict";
import { groupRepeatedHours, hourTile } from "../app/lib/tiles.js";
import { dayState, countdown } from "../app/lib/schedule.js";
import { civil, clock } from "../app/lib/time.js";

const date = "2026-10-25", start = Date.parse(date + "T03:00:00+03:00");
function data(now) {
  const events = ["hourly", "planned", "emergency"].map((category, i) =>
    ({ start: start + i * 1800000, end: start + (i + 1) * 1800000, category }));
  return { queue: "3.2", failures: [], emergencies: [], feedCheckedAt: now,
    categories: Object.fromEntries(["hourly", "planned", "emergency"].map(k =>
      [k, { checkedAt: now, sourceAt: now, events: events.filter(e => e.category === k) }])),
    plans: [{ date, queue: "3.2", publishedAt: now, events: events.filter(e => e.category === "hourly") }] };
}
test("25 real hours become 24 visual tiles, one 03:00 with four real half-hours", () => {
  const now = start + 75 * 60000, snapshot = data(now), original = structuredClone(snapshot);
  const state = dayState(snapshot, date, now), before = structuredClone(state);
  const tiles = groupRepeatedHours(state.displayHours), repeated = tiles.filter(h => clock(h.start) === "03:00");
  assert.equal(state.hours.length, 25);
  assert.equal(tiles.length, 24);
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0].end - repeated[0].start, 120 * 60000);
  assert.equal(repeated[0].segments.length, 4);
  assert.ok(repeated[0].segments.every(p => p.end - p.start === 1800000));
  assert.deepEqual(repeated[0].segments.map(p => p.kind), ["hourly", "planned", "emergency", "clear"]);
  assert.deepEqual(state.totals, { off: 90, on: 1410 });
  assert.deepEqual(snapshot, original);
  assert.deepEqual(state, before);
  assert.deepEqual(countdown(snapshot, now), countdown(original, now));
});
test("single-time and range tiles mark clock change and preserve four category segments", () => {
  const now = start + 75 * 60000;
  const tile = groupRepeatedHours(dayState(data(now), date, now).displayHours).find(h => h.clockChange);
  for (const range of [false, true]) for (const icons of ["bolt", "bulb"]) {
    const html = hourTile(tile, date, now, range, icons);
    assert.match(html, /clock-shift/);
    assert.match(html, /зміна часу/);
    assert.match(html, /current/);
    assert.equal((html.match(/class="tile-time /g) || []).length, range ? 2 : 1);
    assert.match(html, /03:00/);
    if (range) assert.match(html, /04:00/);
    for (const [color, from, until] of [["hourly",0,25],["planned",25,50],["emergency",50,75],["button",75,100]])
      assert.ok(html.includes(`var(--${color}) ${from}% ${until}%`));
    for (const position of [12.5, 37.5, 62.5, 87.5]) assert.ok(html.includes(`top:${position}%`));
  }
});
test("ordinary and spring days keep 24/23 tiles without a false clock-change badge", () => {
  for (const [day, length] of [["2026-10-24",24],["2026-03-29",23]]) {
    const now = civil(day, 600), snapshot = data(now);
    snapshot.plans = [{ date: day, queue: "3.2", publishedAt: now, events: [] }];
    const tiles = groupRepeatedHours(dayState(snapshot, day, now).displayHours);
    assert.equal(tiles.length, length);
    assert.ok(tiles.every(h => !h.clockChange));
  }
});

test("uniform repeated hour keeps one regular icon beside the time in both display modes", () => {
  const now = start + 75 * 60000;
  const repeated = groupRepeatedHours(dayState(data(now), date, now).displayHours).find(h => h.clockChange);
  for (const kind of ["clear", "hourly", "unknown"]) {
    const tile = { ...repeated, segments: repeated.segments.map(p => ({ ...p, kind })) };
    for (const range of [false, true]) for (const icons of ["bolt", "bulb"]) {
      const html = hourTile(tile, date, now, range, icons);
      assert.equal((html.match(/<svg /g) || []).length, 1);
      assert.match(html, /class="clock-main"/);
      assert.doesNotMatch(html, /class="tile-icon/);
      assert.match(html, /зміна часу/);
      assert.equal((html.match(/class="tile-time /g) || []).length, range ? 2 : 1);
      assert.equal(tile.segments.length, 4);
    }
  }
});
