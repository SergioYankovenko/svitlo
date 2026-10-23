import test from "node:test";
import assert from "node:assert/strict";
import {
  weatherKind,
  weatherIcon,
  powerIcon,
  summaryIcon,
} from "../app/lib/icons.js";
import { Source } from "../server/source.js";
test("weather distinguishes day night fog snow and thunderstorms", () => {
  assert.equal(weatherKind(0, true), "sun");
  assert.equal(weatherKind(0, false), "moon");
  assert.equal(weatherKind(2, false), "partly-night");
  for (const c of [71, 73, 75, 77, 85, 86])
    assert.equal(weatherKind(c), "snow");
  for (const c of [95, 96, 99]) assert.equal(weatherKind(c), "storm");
  assert.equal(weatherKind(48), "fog");
  assert.equal(weatherKind(undefined), "unknown");
});
test("all weather conditions use self-contained decorative vectors", () => {
  for (const c of [
    0,
    1,
    2,
    3,
    45,
    48,
    51,
    53,
    55,
    56,
    57,
    61,
    63,
    65,
    66,
    67,
    71,
    73,
    75,
    77,
    80,
    81,
    82,
    85,
    86,
    95,
    96,
    99,
    undefined,
  ]) {
    assert.match(weatherIcon(c), /^<svg/);
    assert.match(weatherIcon(c), /aria-hidden="true"/);
    assert.doesNotMatch(weatherIcon(c), /<image|<script|https?:/);
  }
});
test("power and summary icons do not depend on device font glyphs", () => {
  assert.notEqual(powerIcon(false), powerIcon(true));
  assert.notEqual(powerIcon(false), powerIcon(false, true));
  assert.match(summaryIcon(false), /<circle/);
});
test("cold backend uses persisted fresh shared feed without upstream calls", async () => {
  const now = 10000000,
    source = new Source(() => {
      throw Error("unnecessary request");
    }),
    cached = { checkedAt: now - 1000, plans: [], messages: [] };
  assert.equal(await source.feed(now, cached), cached);
  assert.equal((await source.feed(now, cached)).checkedAt, now - 1000);
});
