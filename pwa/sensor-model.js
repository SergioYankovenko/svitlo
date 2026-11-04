"use strict";
// BE-06 reference math, not a device driver, authentication service or prediction model.
window.SvitloSensorModel = (() => {
  const STATES = new Set(["on", "off"]);
  function normalize(intervals, end, dayLength = 1440) {
    if (![1380, 1440, 1500].includes(dayLength) || !Number.isFinite(end))
      return { available: false, reason: "clock", intervals: [], covered: 0 };
    const limit = Math.max(0, Math.min(dayLength, end));
    if (!Array.isArray(intervals) || intervals.length > 500)
      return { available: false, reason: "schema", intervals: [], covered: 0 };
    const sorted = intervals
      .map((i) => ({ ...i }))
      .sort((a, b) => a.start - b.start);
    let previous = -1;
    for (const i of sorted) {
      if (
        !STATES.has(i.state) ||
        !Number.isFinite(i.start) ||
        !Number.isFinite(i.end) ||
        i.start < 0 ||
        i.start >= i.end ||
        i.end > dayLength ||
        i.start < previous
      )
        return {
          available: false,
          reason: "schema",
          intervals: [],
          covered: 0,
        };
      previous = i.end;
    }
    const known = sorted
      .filter((i) => i.start < limit)
      .map((i) => ({ ...i, end: Math.min(limit, i.end) }));
    let on = 0,
      off = 0;
    for (const i of known) {
      if (i.state === "on") on += i.end - i.start;
      else off += i.end - i.start;
    }
    return {
      available: known.length > 0,
      intervals: known,
      on,
      off,
      covered: on + off,
      unknown: dayLength - on - off,
      through: known.at(-1)?.end || 0,
      dayLength,
      limit,
    };
  }
  function compare(plan, observation, dayLength = 1440) {
    if (!observation?.available || !Array.isArray(plan)) return null;
    const normalized = normalize(plan, dayLength, dayLength);
    if (!normalized.available) return null;
    const extraOn = [],
      extraOff = [];
    for (const a of observation.intervals)
      for (const p of normalized.intervals) {
        const start = Math.max(a.start, p.start),
          end = Math.min(a.end, p.end);
        if (end <= start || a.state === p.state) continue;
        (a.state === "on" ? extraOn : extraOff).push({ start, end });
      }
    const sum = (list) => list.reduce((n, i) => n + i.end - i.start, 0);
    return {
      extraOn,
      extraOff,
      extraOnMinutes: sum(extraOn),
      extraOffMinutes: sum(extraOff),
      plannedOff: normalized.off,
      observedOff: observation.off,
    };
  }
  function signal({
    state = "waiting",
    member = true,
    entitled = true,
    quality = true,
    age = 0,
    maxAgeMinutes = 0,
  }) {
    if (!member) return { live: false, label: "Доступ відкликано" };
    if (!entitled)
      return { live: false, label: "Доступ до функції завершився" };
    if (!quality || state === "clock")
      return { live: false, label: "Час сигналу ненадійний" };
    const labels = {
      none: "Датчик не підключений",
      connecting: "Підключення",
      waiting: "Очікую перший сигнал",
      on: "Світло є",
      off: "Світла немає",
      offline: "Зв’язок втрачено",
      error: "Сервіс недоступний",
      replaced: "Датчик замінено",
    };
    // Production adapters must supply their server policy; no invented freshness window.
    const live =
      ["on", "off"].includes(state) &&
      age >= 0 &&
      Number.isFinite(maxAgeMinutes) &&
      age <= maxAgeMinutes;
    return {
      live,
      label:
        !live && ["on", "off"].includes(state)
          ? "Сигнал застарів"
          : labels[state] || labels.waiting,
    };
  }
  // UI226 / BE-06: an ordered, complete time axis, without inventing power in
  // gaps. Callers supply an explicit coverage limit; prediction is not a fact.
  function daySeries(intervals, limit, dayLength = 1440) {
    const result = normalize(intervals, limit, dayLength);
    if (result.reason) return { ...result, segments: [] };
    const segments = [];
    let cursor = 0;
    for (const row of result.intervals) {
      if (cursor < row.start) segments.push({ start: cursor, end: row.start, state: "unknown" });
      const previous = segments.at(-1);
      if (previous?.state === row.state && previous.end === row.start) previous.end = row.end;
      else segments.push({ start: row.start, end: row.end, state: row.state });
      cursor = row.end;
    }
    if (cursor < dayLength) segments.push({ start: cursor, end: dayLength, state: "unknown" });
    return { ...result, segments };
  }
  return Object.freeze({normalize,compare,signal,daySeries});
})();
