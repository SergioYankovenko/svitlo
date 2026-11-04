"use strict";
// Browser-only journey state; no remote identity, permissions or provider calls.
window.SvitloExperience = {
  migrate(state, saved = false) {
    //180: stored prototype preferences can outlive several UI revisions.
    // Repair invalid shapes at this boundary, before any screen reads them.
    const seen = new Set();
    state.addresses = (Array.isArray(state.addresses) ? state.addresses : []).filter(x => {
      if (!x || typeof x.id !== "string" || !x.id || seen.has(x.id) ||
          typeof x.city !== "string" || typeof x.street !== "string") return false;
      seen.add(x.id);
      return true;
    }).slice(0, 10).map(x => ({ ...x, name: typeof x.name === "string" ? x.name : "" }));
    if (!state.addresses.some(x => x.id === state.active)) state.active = state.addresses[0]?.id ?? null;
    state.switches = Object.fromEntries(["before", "restore", "tomorrow", "changes", "emergency", "versions"].map(key => [key, state.switches?.[key] === true]));
    for (const [key, choices, fallback] of [
      ["font", [1, 1.5, 2], 1], ["width", [320, 360, 414, 600], 414],
      ["theme", ["dark", "light"], "dark"], ["entryMode", ["smart", "legacy"], "smart"],
      ["catalogSource", ["snapshot", "demo"], "snapshot"],
    ]) if (!choices.includes(state[key])) state[key] = fallback;
    if (!window.SvitloClock.validTime(state.time)) state.time = "15:12";
    state.support = window.SvitloPolicy.supportMigrate(state.support, saved);
    if (!["android", "pwa"].includes(state.target)) state.target = "android";
    if (!["live", "fixed"].includes(state.clockMode))
      state.clockMode = saved ? "fixed" : "live";
    if (!window.SvitloClock.validDate(state.clockDate))
      state.clockDate = window.SvitloClock.local().date;
    if (!["unread", "accepted", "legacy"].includes(state.privacyNotice))
      state.privacyNotice = saved ? "legacy" : "unread";
    if (!["unseen", "pending", "seen", "legacy"].includes(state.addressHint))
      state.addressHint =
        saved && state.addresses.length > 1 ? "legacy" : "unseen";
    if (!["android", "ios", "embedded"].includes(state.pwaBrowser))
      state.pwaBrowser = "android";
    if (!["default", "granted", "denied"].includes(state.pwaPermission))
      state.pwaPermission = "default";
    if (!["supported", "unsupported"].includes(state.pushSupport))
      state.pushSupport = "supported";
    if (!["none", "compact", "detailed", "both"].includes(state.widgets))
      state.widgets = "none";
    if (!["auto", "pwa", "browser"].includes(state.shellMode))
      state.shellMode = "auto";
    if (
      !["not-started", "pending", "completed"].includes(state.preferencesStatus)
    ) {
      state.preferencesStatus = state.setupNudgePending
        ? "pending"
        : saved
          ? "completed"
          : "not-started";
    }
    if (
      !state.guideTour ||
      ![
        "unseen",
        "awaiting",
        "offered",
        "deferred",
        "active",
        "completed",
        "skipped",
      ].includes(state.guideTour.status)
    ) {
      state.guideTour = { status: saved ? "completed" : "unseen", step: 0 };
    }
    if (state.guideTour.version !== 2) {
      const old = [
        "address",
        "week",
        "actions",
        "summary",
        "messages",
        "options",
      ];
      state.guideTour.stepId =
        old[Math.max(0, Math.min(5, Number(state.guideTour.step) || 0))];
      state.guideTour.version = 2;
    }
    state.guideTour.step = Math.max(
      0,
      Math.min(6, Number(state.guideTour.step) || 0),
    );
    // A deferred tour is a deliberate choice, never a completed tour or a new popup on upgrade.
    if (state.guideTour.status === "skipped")
      state.guideTour.status = "deferred";
    state.setupNudgePending = false;
    state.setupNudgeDismissed = true;
    return state;
  },
  finishPreferences(state, skipped) {
    state.preferencesStatus = skipped ? "pending" : "completed";
    state.setupNudgePending = false;
    state.setupNudgeDismissed = true;
  },
  beginTour(state) {
    if (state.guideTour?.status === "unseen")
      state.guideTour = {
        status: "awaiting",
        step: 0,
        stepId: "address",
        version: 2,
      };
  },
  resetJourney(state) {
    delete state.onboardingDraft;
    state.addresses = [];
    state.active = null;
    state.onboardingSeen = false;
    state.preferencesStatus = "not-started";
    state.guideTour = {
      status: "unseen",
      step: 0,
      stepId: "address",
      version: 2,
    };
    state.privacyNotice = "unread";
    state.addressHint = "unseen";
    state.addressHintStep = 0;
    state.addressCycle = (state.addressCycle || 0) + 1;
    state.addressHintCycle = state.addressCycle;
    state.setupNudgePending = false;
    state.setupNudgeDismissed = true;
  },
  emptied(state) {
    state.guideTour = {
      status: "unseen",
      step: 0,
      stepId: "address",
      version: 2,
    };
    state.addressCycle = (state.addressCycle || 0) + 1;
    state.addressHint = "unseen";
    state.addressHintStep = 0;
    state.addressHintCycle = state.addressCycle;
  },
  added(state, before) {
    if (
      before === 1 &&
      state.addresses.length === 2 &&
      state.addressHint === "unseen"
    ) {
      state.addressHint = "pending";
      state.addressHintStep = 0;
      state.addressHintCycle = state.addressCycle || 0;
    }
  },
  brand() {
    return '<div class="app-brand"><img class="app-logo" src="assets/app-logo.svg" alt="" aria-hidden="true" width="30" height="30"><span class="app-title">Світло</span></div>';
  },
  welcome(scheduleHTML) {
    return `<section class="welcome-screen" aria-labelledby="welcome-title"><div class="welcome-demo" aria-hidden="true" inert>${scheduleHTML}</div><div class="welcome-tint" aria-hidden="true"></div><div class="welcome-content"><div class="welcome-conversation"><div class="mascot-speech"><h1 id="welcome-title">Привіт! Ось так виглядатиме твій графік.</h1></div><span class="welcome-figure" aria-hidden="true"><img class="welcome-mascot" src="assets/welcome-card.webp" alt="" width="1254" height="1254" fetchpriority="high"></span></div><button class="action welcome-start" data-action="add-address">Додати мою адресу</button></div></section>`;
  },
  publicationEnabled(state) {
    if (!state.switches?.tomorrow || !state.permission) return false;
    return (
      state.target !== "pwa" ||
      (state.pwaPermission === "granted" &&
        state.pushSubscribed === true &&
        state.pushSupport !== "unsupported" &&
        state.pwaBrowser !== "embedded" &&
        (state.pwaBrowser !== "ios" || state.pwaInstalled))
    );
  },
  unpublished(tomorrow, date, state) {
    const title =
        "Ще не маю графіка " +
        (tomorrow
          ? "на завтра"
          : date === "сьогодні"
            ? "на сьогодні"
            : "на " + date) +
        ".",
      enabled = this.publicationEnabled(state);
    return `<div class="schedule-empty"><div class="schedule-empty-grid" aria-hidden="true">${"<i></i>".repeat(24)}</div><div class="schedule-empty-conversation"><span class="schedule-empty-portrait" aria-hidden="true"><img class="empty-mascot" data-ready-src="assets/schedule-unpublished.webp" src="data:image/webp;base64,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" width="768" height="768" alt=""></span><div class="schedule-empty-speech" role="status"><p>${title} ${enabled ? '<b class="schedule-arrival">Покажу тобі, коли отримаю.</b>' : "<strong>Повідомити тобі, коли з’явиться?</strong>"}</p></div></div>${enabled ? "" : '<button class="action schedule-empty-enable" data-action="publication-enable">Увімкнути сповіщення</button>'}</div>`;
  },
  warning() {
    return '<div class="warning emergency-warning"><span class="emergency-symbol" aria-hidden="true">⚠</span><div class="emergency-copy"><strong>Аварійні відключення</strong><p>Спеціалісти вже працюють над відновленням</p></div></div>';
  },
};
