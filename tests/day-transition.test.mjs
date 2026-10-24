import test from "node:test";
import assert from "node:assert/strict";
import { slideDay } from "../app/lib/day-transition.js";

function scene() {
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
  const oldGrid = { animate, parentElement: viewport, cloneNode: () => previous };
  const nextGrid = { animate, parentElement: viewport, isConnected: true };
  return { oldGrid, nextGrid, previous, animations, overlays };
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
  const s = scene(); let changes = 0;
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
  const s = scene(); let changes = 0;
  slideDay(s.oldGrid, 1, () => { changes++; return s.nextGrid; })();
  assert.equal(changes, 1);
  assert.equal(s.animations.length, 0);
  assert.equal(s.overlays.length, 0);
});
test("missing animation support or disconnected destination still navigates without effects", () => {
  let changes = 0;
  slideDay(null, 1, () => { changes++; return null; })();
  const s = scene(); s.nextGrid.isConnected = false;
  slideDay(s.oldGrid, 1, () => { changes++; return s.nextGrid; })();
  assert.equal(changes, 2);
  assert.equal(s.animations.length, 0);
});
