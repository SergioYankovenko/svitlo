import test from "node:test";
import assert from "node:assert/strict";
import { slideDay } from "../app/lib/day-transition.js";

function scene(withIndicator = false) {
  const animations = [], overlays = [];
  const animate = function(frames, options) {
    let resolve, reject;
    const finished = new Promise((yes, no) => { resolve = yes; reject = no; });
    const animation = { frames, options, finished, resolve,
      cancel() { this.cancelled = true; reject(Error("cancelled")); } };
    animations.push(animation);
    return animation;
  };
  const viewport = { animate, getBoundingClientRect: () => ({ height: 350 }),
    append(node) { overlays.push(node); } };
  const previous = { animate, classList: { add() {} }, attributes: {},
    setAttribute(k, v) { this.attributes[k] = v; }, remove() { this.removed = true; } };
  const oldIndicator = { getBoundingClientRect: () => ({ left: 180 }) };
  const nextIndicator = { animate, getBoundingClientRect: () => ({ left: 220 }) };
  const oldGrid = { animate, parentElement: viewport, cloneNode: () => previous,
    closest: () => ({ querySelector: () => withIndicator ? oldIndicator : null }) };
  const nextGrid = { animate, parentElement: viewport, isConnected: true,
    closest: () => ({ querySelector: () => withIndicator ? nextIndicator : null }) };
  return { oldGrid, nextGrid, previous, animations, overlays, oldIndicator, nextIndicator };
}
test("slide follows swipe direction, commits once and removes decorative outgoing tiles", async () => {
  for (const direction of [-1, 1]) {
    const s = scene(); let changes = 0;
    slideDay(s.oldGrid, direction, () => { changes++; return s.nextGrid; });
    assert.equal(changes, 1);
    assert.equal(s.previous.attributes["aria-hidden"], "true");
    assert.equal(s.previous.inert, true);
    assert.equal(s.animations[0].frames[1].transform, `translateX(${-direction * 100}%)`);
    assert.equal(s.animations[1].frames[0].transform, `translateX(${direction * 100}%)`);
    for (const animation of s.animations) animation.resolve();
    await new Promise(setImmediate);
    assert.equal(s.previous.removed, true);
    assert.equal(changes, 1);
  }
});
test("interruption cleans every animation and cannot commit another date later", async () => {
  const s = scene(true); let changes = 0;
  const stop = slideDay(s.oldGrid, 1, () => { changes++; return s.nextGrid; });
  stop(); stop();
  await new Promise(setImmediate);
  assert.equal(s.previous.removed, true);
  assert.ok(s.animations.every(a => a.cancelled));
  assert.equal(changes, 1);
});
test("reduced motion switches instantly without creating outgoing content", (t) => {
  const original = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true });
  t.after(() => { if (original) globalThis.matchMedia = original; else delete globalThis.matchMedia; });
  const s = scene(true); let changes = 0;
  slideDay(s.oldGrid, 1, () => { changes++; return s.nextGrid; })();
  assert.equal(changes, 1);
  assert.equal(s.animations.length, 0);
  assert.equal(s.overlays.length, 0);
});

test("indicator travels from its visible position with the same timing as the tiles", () => {
  for (const [from, to] of [[180, 220], [220, 180], [260, 20]]) {
    const s = scene(true);
    s.oldIndicator.getBoundingClientRect = () => ({ left: from });
    s.nextIndicator.getBoundingClientRect = () => ({ left: to });
    const stop = slideDay(s.oldGrid, 1, () => s.nextGrid);
    assert.equal(s.animations.length, 4);
    assert.deepEqual(s.animations[3].frames, [
      { transform: `translateX(${from - to}px)` }, { transform: "translateX(0)" },
    ]);
    assert.deepEqual(s.animations[3].options, s.animations[0].options);
    stop();
  }
});

test("a rapid swipe reads the in-flight indicator before render cancels it", () => {
  const s = scene(true);
  let visible = 195;
  s.oldIndicator.getBoundingClientRect = () => ({ left: visible });
  const stop = slideDay(s.oldGrid, 1, () => {
    visible = 180; // render's cleanup resets the previous animation
    return s.nextGrid;
  });
  assert.equal(s.animations[3].frames[0].transform, "translateX(-25px)");
  stop();
});
test("missing animation support or disconnected destination still navigates without effects", () => {
  let changes = 0;
  slideDay(null, 1, () => { changes++; return null; })();
  const s = scene(); s.nextGrid.isConnected = false;
  slideDay(s.oldGrid, 1, () => { changes++; return s.nextGrid; })();
  assert.equal(changes, 2);
  assert.equal(s.animations.length, 0);
});
