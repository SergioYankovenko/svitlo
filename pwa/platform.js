"use strict";
// QA product target. It never requests browser permissions or contacts the product API.
window.SvitloPlatform = (() => {
  const keys = [
    "support",
    "addresses",
    "active",
    "onboardingSeen",
    "onboardingDraft",
    "preferencesStatus",
    "guideTour",
    "privacyNotice",
    "addressHint",
    "permission",
    "pushSubscribed",
    "pushSupport",
    "pwaInstalled",
    "pwaBrowser",
    "pwaPermission",
    "widgets",
    "switches",
    "reminder",
    "addressCycle",
    "addressHintStep",
    "addressHintCycle",
  ];
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const fresh = () => ({
    addresses: [],
    active: null,
    onboardingSeen: false,
    preferencesStatus: "not-started",
    guideTour: { status: "unseen", step: 0, stepId: "address", version: 2 },
    privacyNotice: "unread",
    addressHint: "unseen",
    permission: false,
    pushSubscribed: false,
    pushSupport: "supported",
    pwaInstalled: false,
    pwaBrowser: "android",
    pwaPermission: "default",
    widgets: "none",
    switches: {
      before: false,
      restore: false,
      tomorrow: false,
      changes: false,
      emergency: false,
      versions: false,
    },
    reminder: 30,
    addressCycle: 0,
  });
  const snapshot = (state) =>
    Object.fromEntries(
      keys
        .filter((key) => state[key] !== undefined)
        .map((key) => [key, copy(state[key])]),
    );
  function select(state, target) {
    if (!["android", "pwa"].includes(target) || target === state.target) return;
    if (!state.targetStates || typeof state.targetStates !== "object" || Array.isArray(state.targetStates))
      state.targetStates = {};
    state.targetStates[state.target || "android"] = snapshot(state);
    const candidate = state.targetStates[target];
    const existing = candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate : null;
    const next = existing || fresh();
    if (existing && !existing.support)
      next.support = window.SvitloPolicy.supportMigrate(null, true);
    keys.forEach((key) => delete state[key]);
    Object.assign(state, copy(next));
    state.target = target;
  }
  return { fresh, snapshot, select, isPWA: (state) => state.target === "pwa" };
})();

window.SvitloClock = (() => {
  const local = () => {
    const parts = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Kyiv",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date());
    const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
    return {
      date: `${p.year}-${p.month}-${p.day}`,
      time: `${p.hour}:${p.minute}`,
    };
  };
  const validDate = (value) =>
    /^\d{4}-\d{2}-\d{2}$/.test(value || "") &&
    Number.isFinite(Date.parse(value + "T12:00:00Z")) &&
    new Date(value + "T12:00:00Z").toISOString().slice(0, 10) === value;
  const validTime = (value) => typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  const date = (value) => new Date(value + "T12:00:00Z");
  const key = (value) => value.toISOString().slice(0, 10);
  const weekday = (value) => (date(value).getUTCDay() + 6) % 7;
  const now = (state) =>
    state.clockMode === "live"
      ? local()
      : {
          date: validDate(state.clockDate) ? state.clockDate : local().date,
          time: validTime(state.time) ? state.time : "15:12",
        };
  const minutes = (state) => {
    const [h, m] = now(state).time.split(":").map(Number);
    return h * 60 + m;
  };
  const selected = (state) =>
    validDate(state.viewDate) ? state.viewDate : now(state).date;
  function choose(state, day) {
    const d = date(selected(state));
    d.setUTCDate(d.getUTCDate() - weekday(selected(state)) + day);
    state.viewDate = key(d);
  }
  function tomorrow(state) {
    const d = date(now(state).date);
    d.setUTCDate(d.getUTCDate() + 1);
    return key(d);
  }
  return {
    local,
    now,
    minutes,
    selected,
    choose,
    tomorrow,
    weekday,
    date,
    key,
    validDate,
    validTime,
    isToday: (state) => selected(state) === now(state).date,
  };
})();
