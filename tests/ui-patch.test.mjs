import test from "node:test";
import assert from "node:assert/strict";
import { adjacentDay, bindHorizontalSwipe } from "../app/lib/navigation.js";
import { hourTile } from "../app/lib/tiles.js";
import { powerIcon } from "../app/lib/icons.js";
import { civil } from "../app/lib/time.js";
import { dayState } from "../app/lib/schedule.js";

const now = civil("2026-10-24", 600);
const snapshot = (...dates) => ({ queue: "3.2", categories: {}, emergencies: [],
  plans: dates.map(date => ({ date, queue: "3.2", events: [], publishedAt: now, checkedAt: now })) });

test("day gestures select adjacent available dates without skipping gaps", () => {
  const data = snapshot("2026-10-23", "2026-10-24", "2026-10-26", "2026-10-28");
  assert.equal(adjacentDay(data, "2026-10-24", -1, now), "2026-10-23");
  assert.equal(adjacentDay(data, "2026-10-24", 1, now), null);
  assert.equal(adjacentDay(data, "2026-10-26", 1, now), null);
  assert.equal(adjacentDay(data, "2026-10-24", 0, now), null);
});
test("week boundaries require Monday publication and reject previous calendar week after rollover", () => {
  const data = snapshot("2026-10-25", "2026-10-26");
  assert.equal(adjacentDay(data, "2026-10-25", 1, now), "2026-10-26");
  assert.equal(adjacentDay(data, "2026-10-26", -1, now), "2026-10-25");
  assert.equal(adjacentDay(data, "2026-10-26", -1, civil("2026-10-26", 60)), null);
  data.plans[1].uncertain = true;
  assert.equal(adjacentDay(data, "2026-10-25", 1, now), null);
});
test("explicit historical week stays navigable but cannot enter another historical week", () => {
  const data = snapshot("2026-10-11", "2026-10-12", "2026-10-13");
  assert.equal(adjacentDay(data, "2026-10-12", 1, now), "2026-10-13");
  assert.equal(adjacentDay(data, "2026-10-12", -1, now), null);
});
test("day navigation across DST uses calendar dates, retaining 23/25 actual hours", () => {
  for (const [date, previous, count] of [["2026-03-29", "2026-03-28", 23], ["2026-10-25", "2026-10-24", 25]]) {
    const instant = civil(previous, 600), data = snapshot(previous, date);
    assert.equal(adjacentDay(data, previous, 1, instant), date);
    assert.equal(dayState(data, date, instant).displayHours.length, count);
  }
});

class Surface extends EventTarget { setPointerCapture() {} }
const pointer = (surface, type, x, y, id = 1, extra = {}) => {
  const event = new Event(type);
  Object.assign(event, { clientX: x, clientY: y, pointerId: id, pointerType: "touch", button: 0 }, extra);
  surface.dispatchEvent(event);
};
test("horizontal gesture direction, one action per gesture, cleanup and exclusion", () => {
  const surface = new Surface(), directions = [];
  const stop = bindHorizontalSwipe(surface, d => directions.push(d));
  pointer(surface, "pointerdown", 180, 100); pointer(surface, "pointerup", 80, 110);
  pointer(surface, "pointerup", 80, 110);
  pointer(surface, "pointerdown", 80, 100); pointer(surface, "pointerup", 180, 110);
  assert.deepEqual(directions, [1, -1]);
  stop();
  pointer(surface, "pointerdown", 180, 100); pointer(surface, "pointerup", 80, 100);
  assert.equal(directions.length, 2);
  bindHorizontalSwipe(surface, d => directions.push(d), () => true);
  pointer(surface, "pointerdown", 180, 100); pointer(surface, "pointerup", 80, 100);
  assert.equal(directions.length, 2);
});
test("tap, short, vertical, diagonal, cancelled, and multi-pointer gestures never change date", () => {
  const surface = new Surface(), directions = [];
  bindHorizontalSwipe(surface, d => directions.push(d));
  for (const [dx, dy] of [[0, 0], [20, 0], [10, 120], [80, 75]]) {
    pointer(surface, "pointerdown", 100, 100); pointer(surface, "pointerup", 100 + dx, 100 + dy);
  }
  pointer(surface, "pointerdown", 100, 100); pointer(surface, "pointercancel", 200, 100);
  pointer(surface, "pointerdown", 100, 100); pointer(surface, "lostpointercapture", 200, 100);
  pointer(surface, "pointerup", 200, 100);
  pointer(surface, "pointerdown", 100, 100); pointer(surface, "pointerdown", 150, 100, 2);
  pointer(surface, "pointerup", 200, 100, 2); pointer(surface, "pointerup", 200, 100);
  pointer(surface, "pointerdown", 100, 100); pointer(surface, "pointermove", 100, 150);
  pointer(surface, "pointerup", 250, 150);
  assert.deepEqual(directions, []);
});
test("both tile modes are informational, retain state descriptions and support bulb selection", () => {
  const h = { start: civil("2026-10-24", 840), end: civil("2026-10-24", 900), segments: [
    { start: civil("2026-10-24", 840), end: civil("2026-10-24", 870), kind: "hourly" },
    { start: civil("2026-10-24", 870), end: civil("2026-10-24", 900), kind: "emergency" },
  ] };
  for (const range of [false, true]) for (const style of ["bolt", "bulb"]) {
    const html = hourTile(h, "2026-10-24", now, range, style);
    assert.match(html, /role="img"/);
    assert.doesNotMatch(html, /<button|tabindex|data-hour|Відкрити точні/);
    assert.match(html, /14:00–14:30: погодинне відключення/);
    assert.match(html, /14:30–15:00: аварійне відключення/);
    assert.match(html, /var\(--hourly\).*var\(--emergency\)/);
    assert.equal(html.includes("icon-bulb"), style === "bulb");
  }
});
test("default bolt is unchanged; bulb on has fill/rays, off outline, unknown stays separate", () => {
  assert.equal(powerIcon(false), powerIcon(false, false, "bolt"));
  assert.match(powerIcon(false, false, "bulb"), /fill="currentColor"/);
  assert.match(powerIcon(false, false, "bulb"), /M12 1v1/);
  assert.doesNotMatch(powerIcon(true, false, "bulb"), /fill="currentColor"|M12 1v1/);
  assert.equal(powerIcon(false, true, "bulb"), powerIcon(false, true));
});
