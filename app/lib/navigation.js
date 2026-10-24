import { addDays, dayKey, monday } from "./time.js";
import { canNextWeek, dayState } from "./schedule.js";

// Move exactly one calendar date; an unavailable date is never skipped.
export function adjacentDay(snapshot, date, direction, now = Date.now()) {
  if (!snapshot || ![-1, 1].includes(direction)) return null;
  const target = addDays(date, direction), currentWeek = monday(dayKey(now));
  const targetWeek = monday(target), displayedWeek = monday(date);
  // Explicit history links may open an old week, but gestures cannot enter another old week.
  if (targetWeek < currentWeek && targetWeek !== displayedWeek) return null;
  if (targetWeek > currentWeek &&
      (targetWeek !== addDays(currentWeek, 7) || !canNextWeek(snapshot, now))) return null;
  return dayState(snapshot, target, now).available ? target : null;
}

// CSS pan-y/pinch-zoom leaves scrolling and zooming with the browser.
export function bindHorizontalSwipe(element, onSwipe, exclude = () => false) {
  if (!element) return () => {};
  let start = null, blocked = false;
  const pointers = new Set();
  const down = (e) => {
    pointers.add(e.pointerId);
    if (pointers.size > 1) { blocked = true; start = null; return; }
    if ((e.pointerType === "mouse" && e.button !== 0) || exclude(e.target)) return;
    start = { id: e.pointerId, x: e.clientX, y: e.clientY };
    element.setPointerCapture?.(e.pointerId);
  };
  const finish = (e) => {
    const origin = start;
    pointers.delete(e.pointerId);
    if (origin?.id === e.pointerId) start = null;
    if (!blocked && origin?.id === e.pointerId && e.type === "pointerup") {
      const dx = e.clientX - origin.x, dy = e.clientY - origin.y;
      if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.5)
        onSwipe(dx < 0 ? 1 : -1);
    }
    if (!pointers.size) blocked = false;
  };
  const move = (e) => {
    if (start?.id !== e.pointerId) return;
    const dx = Math.abs(e.clientX - start.x), dy = Math.abs(e.clientY - start.y);
    if (dy >= 16 && dy > dx) { blocked = true; start = null; }
  };
  element.addEventListener("pointerdown", down);
  element.addEventListener("pointermove", move);
  element.addEventListener("pointerup", finish);
  element.addEventListener("pointercancel", finish);
  element.addEventListener("lostpointercapture", finish);
  return () => {
    element.removeEventListener("pointerdown", down);
    element.removeEventListener("pointermove", move);
    element.removeEventListener("pointerup", finish);
    element.removeEventListener("pointercancel", finish);
    element.removeEventListener("lostpointercapture", finish);
  };
}
