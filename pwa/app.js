"use strict";
(async () => {
  const live = await window.SvitloLiveReady;
  const $ = (id) => document.getElementById(id);
  const app = $("app");
  const STORE = "svitlo.pwa.v2.ui";
  const journey = window.SvitloExperience;
  const policy = window.SvitloPolicy;
  const defaultState = () => ({
    entryMode: "smart",
    catalogSource: "snapshot",
    responseMode: "normal",
    onboardingSeen: false,
    setupNudgePending: false,
    setupNudgeDismissed: true,
    theme: "dark",
    range: false,
    bulbs: false,
    font: 1,
    width: 414,
    scenario: "normal",
    widgets: "none",
    shellMode: "auto",
    target: "pwa",
    clockMode: "live",
    clockDate: window.SvitloClock.local().date,
    time: window.SvitloClock.local().time,
    proposed: false,
    gap: 14,
    radius: 16,
    accent: null,
    active: null,
    addresses: [],
    switches: {
      before: false,
      restore: false,
      tomorrow: false,
      changes: false,
      emergency: false,
      versions: false,
    },
    reminder: 30,
    permission: false,
  });
  let state = defaultState();
  let restoredState = false;
  try {
    const saved = JSON.parse(localStorage.getItem(STORE));
    if (Array.isArray(saved?.addresses) && saved?.switches) {
      state = { ...state, ...saved };
      restoredState = true;
    }
  } catch {}
  journey.migrate(state, restoredState);
  if (new URLSearchParams(location.search).get("start") === "1")
    journey.resetJourney(state);
  // One-time migration of older visual experiments to the approved native baseline.
  if (!state.nativeStyleBaseline) {
    state.gap = 14;
    state.radius = 16;
    state.accent = null;
    state.nativeStyleBaseline = 1;
  }
  state.target="pwa"; state.entryMode="smart"; state.clockMode="live"; state.scenario="live"; state.proposed=false;
  live.adopt(state);
  let tab = "home",
    day = window.SvitloClock.weekday(window.SvitloClock.selected(state)),
    expanded = false,
    wizard = null,
    modal = null,
    lastFocus = null,
    widgetPage = 0,
    toastTimer;
  let onboarding = null,
    guideTour = null,
    diagnostics = null,
    dayPager = null,
    sensor = null;
  const navMotion = window.SvitloMotionUI.nav(app.querySelector(".bottom-nav"));
  const days = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
  const monthNames = [
    "Січня",
    "Лютого",
    "Березня",
    "Квітня",
    "Травня",
    "Червня",
    "Липня",
    "Серпня",
    "Вересня",
    "Жовтня",
    "Листопада",
    "Грудня",
  ];
  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const save = () => {
    try {
      localStorage.setItem(STORE, JSON.stringify(state));
    } catch {}
  };
  const address = () =>
    state.addresses.find((x) => x.id === state.active) ||
    state.addresses[0] || { id: "", name: "", city: "", street: "", queue: "" };
  const fullAddress = (x) => `${x.city}, ${x.street}`;
  const addressTitle = (x) => x.name || x.city;
  const nowMinutes = () => window.SvitloClock.minutes(state);
  const todayIndex = () =>
    window.SvitloClock.weekday(window.SvitloClock.now(state).date);
  const isToday = () => window.SvitloClock.isToday(state);
  const hhmm = (x) =>
    `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`;
  const duration = (x) =>
    `${Math.floor(x / 60)} год${x % 60 ? ` ${x % 60} хв` : ""}`;
  const richDuration = (x) =>
    `<span class="duration-pair">${Math.floor(x / 60)}<span class="unit">&nbsp;год</span></span>${x % 60 ? ` <span class="duration-pair">${x % 60}<span class="unit">&nbsp;хв</span></span>` : ""}`;
  const icon = (name, cls = "") => window.SvitloNativeUI.icon(name, cls);
  const power = (off = false, unknown = false) =>
    window.SvitloNativeUI.power(off, unknown, state.bulbs);
  const needsAddress = () =>
    state.entryMode === "smart" && !state.addresses.length;
  function selectedDate() {
    return window.SvitloClock.date(window.SvitloClock.selected(state));
  }
  const fixtureContext = (date = window.SvitloClock.selected(state)) => ({
    date,
    today: window.SvitloClock.now(state).date,
    addressKey: address().catalogKey || address().id,
  });
  const schedule = (date = window.SvitloClock.selected(state)) => {
    const data = window.SvitloScenarios.schedule(
      state.scenario,
      window.SvitloClock.weekday(date),
      nowMinutes(),
      state.proposed,
      todayIndex(),
      date > window.SvitloClock.now(state).date,
      fixtureContext(date),
    );
    return data;
  };
  const dateAllowed = (date) =>
    policy.dateAllowed(
      date,
      window.SvitloClock.now(state).date,
      schedule(date).publication,
    );
  const hasGraph = () =>
    schedule().publication === "published" && schedule().unknown === 0;
  function recordActiveDay() {
    const date = window.SvitloClock.local().date;
    if (document.hidden || state.support.lastDate === date) return;
    policy.activeDay(state.support, date);
    save();
  }
  let supportObserver = null, supportPreview = false;
  const supportHint = window.SvitloSupportHint.create({app, page: $("page-scroll"), root: $("support-root")});
  function supportState(reset = false) {
    if (!["actual", "eligible", "clicked", "legacy"].includes(state.supportScenario))
      state.supportScenario = "actual";
    if (state.supportScenario === "actual") return state.support;
    const saved = state.supportLab;
    if (reset || !saved || typeof saved !== "object" || Array.isArray(saved) || saved.version !== 1) {
      state.supportLab = policy.supportMigrate(null);
      state.supportLab.days = ["2026-10-29", "2026-10-30", "2026-10-31"];
      if (state.supportScenario === "clicked") state.supportLab.clicked = true;
      if (state.supportScenario === "legacy") state.supportLab.hint = "legacy";
    } else state.supportLab = policy.supportMigrate(saved);
    return state.supportLab;
  }
  function supportSync(retain = false) {
    supportObserver?.disconnect();
    const button = app.querySelector("[data-action=donate]");
    if (retain && button) { supportHint.retarget(button); return; }
    supportHint.hide();
    if (!button) return;
    supportObserver = new IntersectionObserver(
      (entries) => {
        const support = supportState();
        if (!support && !supportPreview) return;
        const blocked =
          !!modal ||
          !!onboarding?.active() ||
          !!guideTour?.visible() ||
          !!context().warning ||
          ["offline", "unknown"].includes(state.scenario);
        const visible = entries.some(x => x.isIntersecting && x.intersectionRatio >= 0.99);
        if (supportPreview ? blocked || tab !== "home" || !visible :
          !policy.supportEligible(support, {
            home: tab === "home",
            visible: entries.some(
              (x) => x.isIntersecting && x.intersectionRatio >= 0.99,
            ),
            blocked,
          })
        )
          return;
        if (!supportPreview) { support.hint = "seen"; save(); }
        supportObserver.disconnect();
        supportHint.show(button, {text: policy.text("support", state, app.clientWidth), preview: supportPreview});
      },
      { root: $("page-scroll"), threshold: [1] },
    );
    supportObserver.observe(button);
  }
  const kindLabel = window.SvitloScenarios.label;
  function context() {
    const c = window.SvitloScenarios.context(
      state.scenario,
      day,
      nowMinutes(),
      state.proposed,
      todayIndex(),
      isToday(),
      window.SvitloClock.selected(state) > window.SvitloClock.now(state).date,
      fixtureContext(),
    );
    return {
      ...c,
      value: c.valueMinutes === null ? "" : duration(c.valueMinutes),
    };
  }
  function applyStyle() {
    app.dataset.theme = state.theme;
    app.style.setProperty("--scale", state.font);
    app.style.setProperty("--preview-width", state.width + "px");
    app.style.setProperty("--gap", state.gap + "px");
    app.style.setProperty("--action-radius", state.radius + "px");
    if (state.accent) app.style.setProperty("--accent", state.accent);
    else app.style.removeProperty("--accent");
    app.classList.toggle("large-text", state.font >= 1.5);
    app.classList.toggle(
      "narrow-large",
      state.font >= 1.5 && Math.min(state.width, window.innerWidth) <= 360,
    );
    document
      .querySelectorAll("[data-copy-id]")
      .forEach(
        (node) =>
          (node.textContent = policy.text(
            node.dataset.copyId,
            state,
            app.clientWidth,
          )),
      );
    document.querySelector("meta[name=theme-color]").content =
      state.theme === "dark" ? "#14251E" : "#EFF5EC";
  }
  function header() {
    const element = $("app-header"),
      host = $("onboarding-header-host"),
      page = $("page-scroll");
    // The onboarding title is chrome, not part of the form scrolled into view above the IME.
    const parent = onboarding?.active() ? host : page;
    if (element.parentElement !== parent) parent.prepend(element);
    if (onboarding?.active()) {
      element.innerHTML = onboarding.header();
      return;
    }
    const nowContext = window.SvitloScenarios.context(
      state.scenario,
      todayIndex(),
      nowMinutes(),
      state.proposed,
      todayIndex(),
      true,
      false,
      fixtureContext(window.SvitloClock.now(state).date),
    );
    let data = {
      ...nowContext,
      value:
        nowContext.valueMinutes === null
          ? ""
          : duration(nowContext.valueMinutes),
    };
    const profile = address(),
      queue =
        state.scenario === "clear" ||
        state.scenario === "unknown" ||
        !profile.queue
          ? ""
          : `Черга ${profile.queue}`;
    const populated = state.addresses.length > 0;
    const showQueue = tab === "home" && populated && !wizard,
      kind = data.warning ? null : data.kind;
    const meta =
      showQueue && (queue || kind)
        ? `<div class="queue-line">${esc(queue)}${queue && kind ? " | " : ""}${esc(kindLabel(kind))}</div>`
        : "";
    $("app-header").innerHTML =
      `<div class="app-head ${showQueue ? "home-header" : ""}"><div class="header-brand-block"><img class="app-logo" src="assets/app-logo.svg" alt="" width="30" height="30"><div class="header-copy"><div class="app-title">Світло</div>${meta}</div></div>${showQueue && !data.warning && data.label ? `<div class="header-status"><span class="header-status-label">${esc(data.label)}</span>${data.value ? `<strong>${esc(data.value)}</strong>` : ""}</div>` : ""}</div>`;
  }
  function grid(demo = false, date = window.SvitloClock.selected(state)) {
    // Decorative, inert welcome illustration only; never used for an address or calculation.
    const data = demo
        ? {at: minute=>minute>=480&&minute<600||minute>=840&&minute<960?'hourly':null,total:1440}
        : schedule(date),
      long = !demo && data.total === 1500,
      short = !demo && data.total === 1380;
    const hours = short
      ? [0, 1, 2, ...Array.from({ length: 20 }, (_, i) => i + 4)]
      : Array.from({ length: 24 }, (_, i) => i);
    return `<div class="grid-viewport" id="${demo ? "demo-grid" : "grid-swipe"}"><div class="hour-grid">${hours
      .map((hour, index) => {
        const repeated = long && hour === 3,
          start = (index + (long && hour > 3 ? 1 : 0)) * 60,
          count = repeated ? 4 : 2;
        const halves = Array.from({ length: count }, (_, j) =>
          data.at(start + j * 30 + 15, true),
        );
        const unique = [...new Set(halves)],
          one = unique.length === 1 ? unique[0] : null,
          unknown = unique.every((k) => k === "unknown");
        const current =
          !demo &&
          date === window.SvitloClock.now(state).date &&
          hour === Math.floor(nowMinutes() / 60);
        const off = halves.some((k) => k && k !== "unknown"),
          label = `${String(hour).padStart(2, "0")}:00`,
          next = `${String(hour + 1).padStart(2, "0")}:00`;
        const accessible = halves
          .map(
            (k, j) =>
              `${j + 1}-ша півгодина: ${k === "unknown" ? "стан невідомий" : k ? kindLabel(k) : "світло є"}`,
          )
          .join("; ");
        const tracks = !demo ? sensor?.tracks(date, start, start + count * 30, halves, current) || "" : "";
        const tile = `<div class="hour-tile ${current ? "current" + (sensor?.hasBinding() ? " sensor-current" : "") : ""} ${one && one !== "unknown" ? "colored" : ""} ${one === "unplanned" ? "purple-time" : ""} ${unknown ? "unknown" : ""}" role="${tracks ? "group" : "img"}" aria-label="${label}${current ? ", поточна година" : ""}${repeated ? ", зміна часу" : ""}: ${esc(accessible)}"><div class="tile-segments">${halves.map((k) => `<i class="${k === "unknown" ? "unknown" : ""}" style="background-color:${k && k !== "unknown" ? `var(--${k})` : "transparent"}"></i>`).join("")}</div>${tracks}<div class="hour-label">${power(off, unknown)}<span class="hour-times"><span>${label}</span>${repeated ? '<span class="clock-change">зміна часу</span>' : ""}${state.range ? `<span>${next}</span>` : ""}</span></div>${repeated && unique.length > 1 ? `<div style="position:absolute;bottom:2px;display:flex;gap:3px;z-index:1;font-size:8px">${halves.map((k) => power(!!k, k === "unknown")).join("")}</div>` : ""}</div>`;
        return tile;
      })
      .join("")}</div></div>`;
  }
  function summaryCards() {
    const d = policy.summary(schedule(), sensor?.observation(), sensor?.preferActual());
    if (!d) return "";
    const detail =
      d.source === "device_observation"
        ? `, за відомий період ${duration(d.coverage)}, до ${hhmm(d.through)}, решта часу невідома`
        : d.partial
          ? ", відома частина графіка, решта часу невідома"
          : ", за повним графіком";
    return `<section class="summary-grid" data-source="${d.source}" aria-label="Підсумки обраного дня${detail}">${[
      [false, d.on],
      [true, d.off],
    ]
      .map(
        ([off, min]) =>
          `<div class="card summary-card" aria-label="${off ? "Без світла" : "Зі світлом"}: ${min === null ? "невідомо" : duration(min)}${detail}"><div class="summary-heading"><span class="summary-icon">${icon(off ? "clock" : "sun")}</span><span>${off ? "Без світла" : "Зі світлом"}</span></div><div class="summary-value fit" ${min === null ? 'data-unknown="true"' : `data-duration="${min}"`}>${min === null ? "?" : richDuration(min)}</div><div class="summary-caption">${d.caption}</div></div>`,
      )
      .join("")}</section>`;
  }
  function dayContent(date) {
    const data = schedule(date),
      missing = data.publication === "unpublished";
    const dayContext = window.SvitloScenarios.context(
      state.scenario,
      window.SvitloClock.weekday(date),
      nowMinutes(),
      state.proposed,
      todayIndex(),
      date === window.SvitloClock.now(state).date,
      date > window.SvitloClock.now(state).date,
      fixtureContext(date),
    );
    if (missing)
      return journey.unpublished(
        date === window.SvitloClock.tomorrow(state),
        date === window.SvitloClock.now(state).date
          ? "сьогодні"
          : window.SvitloClock.date(date).toLocaleDateString("uk-UA", {
              day: "numeric",
              month: "long",
              timeZone: "UTC",
            }),
        state,
      );
    return `${grid(false, date)}<div class="legend"><span class="legend-item"><span class="legend-sample">${power()}</span>Світло є</span><span class="legend-item"><span class="legend-sample off" style="background:var(--${dayContext.kind || "hourly"})">${power(true)}</span>Світла немає</span><span class="legend-item"><span class="legend-sample now${sensor?.hasBinding() ? " sensor-current" : ""}"></span>Поточна година</span></div><div class="actions one schedule-feedback"><button class="action mismatch-action" disabled aria-disabled="true">${sensor?.hasBinding() ? "Придбати ще один датчик" : "Не співпадає графік?"}</button></div>`;
  }
  function scheduleCard(demo = false) {
    const date = window.SvitloClock.selected(state);
    const monday = window.SvitloClock.date(date);
    monday.setUTCDate(monday.getUTCDate() - day);
    return `<section class="card schedule-card"><div class="schedule-core"><div class="week" role="tablist" aria-label="Дні тижня" style="--day:${demo ? 4 : day}">${days
      .map((d, i) => {
        const key = new Date(monday);
        key.setUTCDate(key.getUTCDate() + i);
        return `<button role="tab" aria-label="${d}, ${window.SvitloClock.key(key)}" aria-selected="${i === (demo ? 4 : day)}" data-action="day" ${!demo && !dateAllowed(window.SvitloClock.key(key)) ? 'disabled aria-disabled="true"' : ""} data-day="${i}" data-date="${window.SvitloClock.key(key)}">${d}</button>`;
      })
      .join(
        "",
      )}<span class="day-indicator"></span></div>${!demo && context().warning ? journey.warning() : ""}${!demo && state.scenario === "unknown" ? '<div class="schedule-note">Дані графіка уточнюються</div>' : ""}${!demo && state.scenario === "offline" ? '<div class="schedule-note">Збережений графік · немає мережі</div>' : ""}${demo ? `${grid(true)}<div class="legend"><span class="legend-item"><span class="legend-sample">${power()}</span>Світло є</span><span class="legend-item"><span class="legend-sample off">${power(true)}</span>Світла немає</span></div>` : `<div id="day-pager" class="day-pager" tabindex="0" role="region" aria-label="Графік на ${date}. Стрілки перемикають сусідні дні"><div class="day-pane" data-date="${date}">${dayContent(date)}</div></div>`}</div></section>`;
  }

  function home() {
    if (wizard) return setup();
    if (needsAddress()) return journey.welcome(scheduleCard(true));
    const a = address();
    const city = a.city,
      sensorIndicator = sensor?.indicator() || { html: "", label: "" };
    return `<section class="card outlined address-card compact-address"><div class="address-top"><button class="address-trigger" data-action="expand-address" aria-label="${esc("Обрати адресу: " + fullAddress(a) + (sensorIndicator.label ? ", " + sensorIndicator.label : ""))}" aria-expanded="${expanded}"><div><div class="address-primary-row"><div class="address-primary">${esc(addressTitle(a))}</div>${sensorIndicator.html}</div><div class="address-subtitle">${esc(a.name ? fullAddress(a) : a.street)}</div></div>${state.addresses.length > 1 ? icon("chevron", "chevron") : ""}</button>${state.addresses.length === 1 ? '<button class="address-add" data-action="add-address" aria-label="Додати адресу"><span aria-hidden="true">+</span></button>' : ""}</div>${expanded ? addressList(a) : ""}</section>
      ${scheduleCard()}
      ${summaryCards()}${live.weatherHTML(esc)}<div class="home-bottom">${hasGraph() ? `<button class="action" data-action="share">${icon("share")}Поділитись графіком</button>` : ""}<button class="action" data-action="donate">♡ Подякувати за додаток</button></div>`;
  }
  function addressList(active) {
    return `<div class="address-list"><div class="address-list-rows">${state.addresses.map((x) => `<div class="address-list-row ${x.id === active.id ? "selected" : ""}"><button class="address-row" data-action="select-address" data-id="${esc(x.id)}" aria-pressed="${x.id === active.id}">${x.name ? `<strong>${esc(x.name)}</strong>` : ""}<span>${esc(fullAddress(x))}</span></button><button class="address-edit" data-action="address-actions" data-id="${esc(x.id)}" aria-label="${esc("Редагувати адресу " + (x.name || fullAddress(x)))}">${icon("edit")}</button></div>`).join("")}</div><button class="action address-list-add" data-action="add-address">Додати адресу</button></div>`;
  }
  function returnToAddresses() {
    closeDialog();
    tab = "home";
    expanded = state.addresses.length > 0;
    render();
    document.querySelector(".address-trigger")?.focus({ preventScroll: true });
  }
  function messages() { return live.messagesHTML(esc, icon); }
  function options() {
    const options = [
      [
        "theme",
        "Тема",
        [
          [
            "dark",
            `${icon("moon", "large-symbol")}<span class="native-theme-label">Темна</span>`,
          ],
          [
            "light",
            `${icon("sun", "large-symbol")}<span class="native-theme-label">Світла</span>`,
          ],
        ],
      ],
      [
        "range",
        "Час",
        [
          [false, "13:00"],
          [true, "13:00<br>14:00"],
        ],
      ],
      [
        "bulbs",
        "Значки",
        [
          [false, "bolt"],
          [true, "bulb"],
        ],
      ],
    ];
    const flags = [
      ["before", "Перед відключенням"],
      ["restore", "Перед очікуваним відновленням"],
      ["tomorrow", "Графік на завтра"],
      ["changes", "Зміни графіка"],
      ["emergency", "Аварії за адресою"],
      ["versions", "Нові версії застосунку"],
    ];
    const switchRow = ([key, title]) =>
      `<label class="switch-row"><span>${title}</span><input type="checkbox" data-switch="${key}" ${state.switches[key] ? "checked" : ""} aria-label="${title}"></label>`;
    return `<section class="card outlined"><h2>Вигляд</h2>${options
      .map(
        ([key, title, choices]) =>
          `<div class="choice-row"><div class="choice-label">${title}</div><div class="choice-group" role="group" aria-label="${title}">${choices
            .map(([value, html]) => {
              let content = html;
              if (html === "bolt") {
                const old = state.bulbs;
                state.bulbs = false;
                content = power();
                state.bulbs = old;
              }
              if (html === "bulb") {
                const old = state.bulbs;
                state.bulbs = true;
                content = power();
                state.bulbs = old;
              }
              return `<button class="choice ${key === "theme" ? "theme-choice" : ""} ${state[key] === value ? "selected" : ""}" data-action="choice" data-key="${key}" data-value="${value}" aria-pressed="${state[key] === value}" aria-label="${key === "bulbs" ? (value ? "Лампочки" : "Блискавки") : key === "range" ? (value ? "Початок і кінець години" : "Початок години") : value === "dark" ? "Темна тема" : "Світла тема"}">${content}</button>`;
            })
            .join("")}</div></div>`,
      )
      .join(
        "",
      )}</section><section class="card outlined"><div class="settings-title"><h2>Сповіщення</h2><button class="bell ${state.permission ? "" : "blocked"}" data-action="permission" aria-label="Стан дозволу на сповіщення">${icon(state.permission ? "bell" : "bell-off")}</button></div>${flags.slice(0, 2).map(switchRow).join("")}<div class="reminder-row"><div>Нагадувати за</div><button class="action reminder-value" data-action="reminder" ${!state.switches.before && !state.switches.restore ? "disabled" : ""}>${state.reminder} хв ▾</button><div class="reminder-caption">${state.switches.before || state.switches.restore ? "Оберіть час нагадування" : "Увімкніть нагадування, щоб вибрати час"}</div></div><hr class="divider">${flags.slice(2, 5).map(switchRow).join("")}${state.target === "pwa" ? "" : `<hr class="divider">${switchRow(flags[5])}`}</section>${state.target === "pwa" ? `<section class="card outlined"><h2>Твої дані</h2><p>Адреси й підписка зберігаються на сервері «Світло». На пристрої зберігається офлайн-копія.</p></section>` : `<section class="card outlined"><h2>Віджети</h2><div class="actions"><button class="action" data-action="widget" data-type="detailed">Детальний · 4×4</button><button class="action" data-action="widget" data-type="compact">Компактний · 4×2</button></div></section>`}${prototypeOptions()}<hr class="divider"><section class="full-legend"><h2>Умовні позначення</h2>${[
      ["hourly", "Погодинне відключення"],
      ["planned", "Планові роботи"],
      ["unplanned", "Позапланове відключення"],
      ["emergency", "Аварійне відключення"],
    ]
      .map(
        ([kind, label]) =>
          `<div class="full-legend-row"><span class="legend-sample off" style="background:var(--${kind})">${power(true)}</span><span>${label}</span></div>`,
      )
      .join(
        "",
      )}<div class="full-legend-row"><span class="legend-sample off" style="height:40px;background:linear-gradient(var(--hourly) 50%,var(--bg) 50%);border:1px solid var(--muted)">${power(true)}</span><span>30 хв без світла</span></div></section>`;
  }
  function pwaPermission(publication = false) {
    const supported =
        state.pushSupport !== "unsupported" && state.pwaBrowser !== "embedded",
      needsInstall = state.pwaBrowser === "ios" && !state.pwaInstalled,
      denied = state.pwaPermission === "denied";
    const body = !supported
      ? "Цей браузер не підтримує push-сповіщення. Графік залишається доступним."
      : needsInstall
        ? "У Safari натисни «Поділитися» → «На Початковий екран», потім відкрий «Світло» зі значка."
        : denied
          ? "Сповіщення заблоковані. Дозвіл можна змінити в налаштуваннях браузера або системи."
          : state.pwaPermission === "granted"
            ? state.pushSubscribed
              ? "Сповіщення підключені до активної адреси."
              : "Дозвіл надано. Підключити сповіщення для активної адреси?"
            : "Дозволити «Світлу» надсилати сповіщення для активної адреси?";
    dialog(
      "Сповіщення застосунку",
      `<p>${body}</p>`,
      supported && !needsInstall && !denied
        ? dialogButton(
            state.pwaPermission === "granted" ? "Підключити" : "Дозволити",
            publication ? "publication-pwa-allow" : "pwa-allow",
          ) + dialogButton("Не дозволяти", "pwa-deny", "cancel")
        : dialogButton("Зрозуміло", "close"),
    );
  }
  function prototypeOptions() {
    return `${sensor?.optionsHTML() || ""}<section class="card outlined prototype-options"><div class="prototype-option-actions"><button class="action" data-action="guide-start">${state.guideTour.status === "completed" ? "Повторити навчання" : "Як користуватися додатком"}</button>${isPrototypeInstalled() ? "" : '<button class="action" data-action="prototype-install">Додати на головний екран</button>'}</div></section>`;
  }

  function setup() { return ""; }
  function render(keepScroll = true) {
    const retainSupport = supportHint.visible() && tab === "home" && !onboarding?.active() && !modal && !guideTour?.visible();
    if (!retainSupport) supportHint.hide();
    if (tab !== "home" || onboarding?.active()) supportPreview = false;
    sensor?.pruneProfiles([
      ...state.addresses,
      ...Object.values(state.targetStates || {}).flatMap(s => Array.isArray(s?.addresses) ? s.addresses : []),
    ].map(x => x?.id));
    if (!dateAllowed(window.SvitloClock.selected(state))) state.viewDate = null;
    day = window.SvitloClock.weekday(window.SvitloClock.selected(state));
    applyStyle();
    const old = $("page-scroll").scrollTop;
    header();
    $("screen").innerHTML = onboarding?.active()
      ? onboarding.screen()
      : tab === "home"
        ? home()
        : tab === "messages"
          ? (sensor?.messagesHTML() || "") + messages()
          : optionEntryCards() + options();
    window.SvitloMascot?.sync();
    window.SvitloNativeUI?.fit();
    app.classList.toggle("in-onboarding", !!onboarding?.active());
    app.classList.remove("needs-setup");
    app.classList.toggle(
      "is-welcome",
      !onboarding?.active() && !wizard && tab === "home" && needsAddress(),
    );
    app.classList.toggle(
      "has-pending-preferences",
      state.preferencesStatus === "pending",
    );
    window.SvitloLookupUI?.sync();
    document.querySelectorAll("[data-tab]").forEach((button) => {
      if (button.dataset.tab === tab)
        button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
      if (button.dataset.tab === "options") {
        const pending = state.preferencesStatus === "pending";
        button.innerHTML =
          (pending
            ? '<span class="options-dot" aria-hidden="true"></span>'
            : "") + "<span>Опції</span>";
        if (pending)
          button.setAttribute(
            "aria-label",
            "Опції, є незавершені налаштування",
          );
        else button.removeAttribute("aria-label");
      }
    });
    $("page-scroll").scrollTop = keepScroll ? old : 0;
    navMotion.sync();
    dayPager?.mount();
    save();
    requestAnimationFrame(fitSummary);
    window.SvitloViewport?.refresh();
    guideTour?.sync();
    supportSync(retainSupport);
    sensor?.sync();
  }
  function optionEntryCards() {
    return state.preferencesStatus === "pending"
      ? '<button class="action complete-preferences" data-action="complete-preferences">Завершити налаштування</button>'
      : "";
  }
  function fitSummary() {
    window.SvitloNativeUI?.fitSummary();
  }
  function toast(text) {
    clearTimeout(toastTimer);
    $("status").innerHTML = `<div class="status-message">${esc(text)}</div>`;
    toastTimer = setTimeout(() => $("status").replaceChildren(), 2500);
  }
  function closeDialog() {
    window.SvitloSensorScanner?.dispose();
    window.SvitloSensorOverview?.dispose();
    diagnostics?.cancel();
    modal = null;
    $("modal-root").replaceChildren();
    if (lastFocus?.isConnected) lastFocus.focus({ preventScroll: true });
    guideTour?.sync();
  }
  function dialog(title, body, footer, contextText = "", options = {}) {
    window.SvitloSensorScanner?.dispose();
    window.SvitloSensorOverview?.dispose();
    supportObserver?.disconnect();
    supportHint.hide();
    supportPreview = false;
    if (!modal) lastFocus = document.activeElement;
    modal = { title };
    $("modal-root").innerHTML =
      `<div class="modal-backdrop ${options.className === "privacy-dialog" ? "privacy-backdrop" : ""}"><section class="dialog ${options.className || ""}" role="dialog" aria-modal="true" aria-label="${esc(options.accessibleLabel || title)}" ${options.character || options.accessibleLabel ? "" : 'aria-labelledby="dialog-title"'}>${options.character ? "" : '<div class="dialog-head">'}${options.character ? "" : `<h2 class="dialog-title" id="dialog-title">${esc(title)}</h2>${contextText ? `<div class="dialog-context">${esc(contextText)}</div>` : ""}${options.headerAction || ""}<hr class="divider"></div>`}<div class="dialog-body">${body}</div><div class="dialog-footer ${options.footerClass || "vertical"}">${footer}</div></section></div>`;
    // UI237: only opted-in information dialogs dismiss on an outside tap.
    // Wait for click (not pointerup) so the same gesture cannot reach the screen below.
    if (options.dismissOnBackdrop) {
      const backdrop = $("modal-root").firstElementChild;
      let outsideTap = null;
      backdrop.addEventListener("pointerdown", event => {
        outsideTap = event.target === backdrop && event.isPrimary && event.button === 0
          ? { id:event.pointerId, x:event.clientX, y:event.clientY } : null;
      });
      backdrop.addEventListener("pointermove", event => {
        if (outsideTap && (event.pointerId !== outsideTap.id ||
          Math.hypot(event.clientX-outsideTap.x,event.clientY-outsideTap.y) > 8)) outsideTap = null;
      });
      backdrop.addEventListener("pointercancel", () => { outsideTap = null; });
      backdrop.addEventListener("click", event => {
        const dismiss = outsideTap && event.target === backdrop;
        outsideTap = null;
        if (!dismiss) return;
        event.preventDefault();
        event.stopPropagation();
        closeDialog();
      });
    }
    const focusTarget = $("modal-root").querySelector(
      options.focus || "button,input,[tabindex]",
    );
    focusTarget?.focus({ preventScroll: true });
  }
  const dialogButton = (text, action, cls = "", data = "") =>
    `<button class="dialog-action ${cls}" data-action="${action}" ${data}>${text}</button>`;
  function addressActions(id) {
    const x = state.addresses.find((x) => x.id === id);
    if (!x) return;
    dialog(
      "Керування адресою",
      "",
      dialogButton("Перейменувати", "rename", "", `data-id="${esc(id)}"`) +
        dialogButton(
          "Видалити адресу",
          "delete-address",
          "",
          `data-id="${esc(id)}"`,
        ) +
        dialogButton("Скасувати", "address-list", "cancel"),
      x.name ? `${x.name} · ${fullAddress(x)}` : fullAddress(x),
    );
  }
  function reminderDialog() {
    dialog(
      "Нагадувати за",
      `<div class="picker-list">${[5, 15, 30, 60].map((m) => `<button class="picker-row ${state.reminder === m ? "selected" : ""}" data-action="set-reminder" data-minutes="${m}" aria-pressed="${state.reminder === m}">${m} хв</button>`).join("")}</div>`,
      dialogButton("Скасувати", "close", "cancel"),
    );
  }
  function shareText() {
    const d = schedule(),
      date = selectedDate();
    if (d.publication === "unpublished")
      return `Графік · ${date.toLocaleDateString("uk-UA", { timeZone: "UTC" })}\nГрафік ще не опубліковано.\nhttps://www.svitlo.guru`;
    const spans = d.events
      .filter((e) => e.end != null)
      .map((e) => ({
        start: state.proposed ? Math.round(e.start / 30) * 30 : e.start,
        end: state.proposed ? Math.round(e.end / 30) * 30 : e.end,
      }))
      .sort((a, b) => a.start - b.start);
    const merged = [];
    for (const span of spans) {
      const last = merged.at(-1);
      if (last && span.start <= last.end)
        last.end = Math.max(last.end, span.end);
      else merged.push({ ...span });
    }
    const intervals = merged.map((e) => `${hhmm(e.start)}–${hhmm(e.end)}`);
    return `Графік · ${date.getUTCDate()} ${monthNames[date.getUTCMonth()]}${address().queue ? " · Черга " + address().queue : ""}\n${d.unknown ? "Немає точних даних" : `Зі світлом: ${duration(d.clear)}\nБез світла: ${duration(d.out)}`}\n${intervals.join(", ")}\n-----------------\nВстановити собі\nhttps://www.svitlo.guru`;
  }
  async function action(name, element) {
    try { return await performAction(name, element); } catch(error) { toast(error.message || "Не вдалося виконати дію. Спробуйте ще раз."); }
  }
  async function performAction(name, element) {
    if (sensor?.handle(name, element)) return;
    if (diagnostics?.handle(name)) return;
    if (onboarding?.handleAction(name, element)) return;
    const id = element?.dataset.id;
    switch (name) {
      case "guide-start":
        state.guideTour = {
          status: "active",
          step: 0,
          stepId: state.addresses.length === 1 ? "add" : "address",
          version: 2,
        };
        tab = "home";
        render(false);
        break;
      case "expand-address":
        if (state.addresses.length) {
          expanded = !expanded;
          render();
        }
        break;
      case "select-address":
        state.active = id;
        expanded = false;
        render();
        break;
      case "address-list":
        returnToAddresses();
        break;
      case "complete-preferences":
        onboarding.open(false, true);
        break;
      case "prototype-install":
        installPrototype();
        break;
      case "address-actions":
        addressActions(id);
        break;
      case "rename": {
        const x = state.addresses.find((x) => x.id === id);
        dialog(
          "Перейменувати адресу",
          `<input class="field" id="rename-value" maxlength="32" aria-label="Назва адреси" placeholder="Назва адреси (необов’язково)" value="${esc(x.name)}">`,
          dialogButton("Зберегти", "save-name", "", `data-id="${id}"`) +
            dialogButton("Скасувати", "address-list", "cancel"),
          fullAddress(x),
          { focus: "#rename-value" },
        );
        break;
      }
      case "save-name":
        await live.rename(id,$("rename-value").value.trim()); live.adopt(state); returnToAddresses(); break;
      case "delete-address":
        dialog("Видалити адресу?","<p>Адресу буде видалено з цього облікового запису.</p>",dialogButton("Видалити","delete-confirm","",`data-id="${id}"`)+dialogButton("Скасувати","close","cancel")); break;
      case "delete-confirm":
        await live.remove(id); live.adopt(state); closeDialog(); tab="home";
        if (!state.addresses.length) { journey.emptied(state); state.onboardingSeen=false; }
        render(false); break;
      case "add-address":
        if (state.addresses.length >= 10) {
          toast("У тестовому доступі можна додати до 10 адрес");
          break;
        }
        if (state.entryMode === "smart") {
          onboarding.open(!state.addresses.length);
          break;
        }
        closeDialog();
        wizard = {};
        tab = "home";
        expanded = false;
        render(false);
        break;
      case "close":
        closeDialog();
        break;
      case "day": {
        const next = element.dataset.date;
        if (next) dayPager.go(next);
        break;
      }
      case "choice":
        state[element.dataset.key] =
          element.dataset.key === "theme"
            ? element.dataset.value
            : element.dataset.value === "true";
        state.accent = null;
        render();

        break;
      case "reminder":
        reminderDialog();
        break;
      case "set-reminder":
        state.reminder = Number(element.dataset.minutes);
        await live.preferences(state);
        closeDialog();
        render();
        break;
      case "permission": pwaPermission(); break;
      case "publication-enable": pwaPermission(true); break;
      case "pwa-allow": case "publication-pwa-allow":
        await live.enablePush(); live.adopt(state);
        if(name==='publication-pwa-allow'){state.switches.tomorrow=true;await live.preferences(state);}
        closeDialog(); render(); break;
      case "pwa-deny": await live.disablePush();live.adopt(state);closeDialog();render();break;
      case "source": live.openSource(); break;
      case "share":
        dialog(
          "Поділитись графіком",
          `<div class="share-copy" id="share-copy">${esc(shareText())}</div>`,
          dialogButton("Скопіювати", "copy-share", "center") +
            dialogButton("Закрити", "close", "center"),
          "",
          { footerClass: "stack-large" },
        );
        break;
      case "copy-share":
        if (navigator.clipboard?.writeText)
          navigator.clipboard
            .writeText(shareText())
            .then(() => toast("Текст скопійовано"))
            .catch(() => toast("Виділіть і скопіюйте текст повідомлення"));
        else toast("Виділіть і скопіюйте текст повідомлення");
        break;
      case "support-dismiss":
        supportPreview = false;
        supportHint.hide(true);
        break;
      case "donate":
        supportState().clicked = true;
        save();
        supportHint.hide();
        window.open(
          "https://send.monobank.ua/jar/5cWs9Zt1qa",
          "_blank",
          "noopener",
        );
        break;
      case "view-schedule":
        tab = "home";
        state.viewDate = null;
        day = todayIndex();
        wizard = null;
        render(false);
        break;
    }
  }
  app.addEventListener("click", (event) => {
    const element = event.target.closest("[data-action],[data-tab]");
    if (!element || element.disabled) return;
    if (element.dataset.action?.startsWith("tour-")) {
      guideTour?.handle(element.dataset.action);
      return;
    }
    if (guideTour?.visible() && !guideTour.isOffer()) {
      return;
    }
    if (element.dataset.tab) {
      closeDialog();
      tab = element.dataset.tab;
      wizard = null;
      render(false);
    } else action(element.dataset.action, element);
  });
  app.addEventListener("change", (event) => {
    const key = event.target.dataset.switch;
    if (key) {
      state.switches[key] = event.target.checked;
      live.preferences(state).catch(error=>toast(error.message));
      render();
    }
  });
  app.addEventListener("input", (event) => onboarding?.handleInput(event));
  app.addEventListener("keydown", (event) => onboarding?.handleKey(event));
  document.addEventListener("keydown", (event) => {
    if (!modal && event.key === "Escape" && supportHint.visible()) {
      supportPreview = false;
      supportHint.hide(true);
      return;
    }
    if (!modal) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeDialog();
    }
    if (event.key === "Tab") {
      const controls = [
        ...$("modal-root").querySelectorAll(
          'button:not(:disabled),input,[tabindex="0"]',
        ),
      ].filter((x) => !x.hidden && x.offsetParent !== null);
      if (!controls.length) return;
      const first = controls[0],
        last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  function syncLab() {}
  onboarding = window.SvitloOnboarding.create({
    getState: () => state,
    save,
    esc,
    icon,
    power,
    toast,
    render,
    dialog,
    closeDialog,
    dialogButton,
    syncLab,
    hasPublishedGraph: () => {
      const data = schedule();
      return data.publication === "published" && data.unknown === 0;
    },
    reportProblem: (context) => diagnostics.open(context),
    onInitialFinished: () => journey.beginTour(state),
    activateHome: () => {
      tab = "home";
      wizard = null;
      expanded = false;
      state.viewDate = null;
    },
  });
  guideTour = window.SvitloGuideTour.create({
    getState: () => state,
    save,
    esc,
    blocked: () =>
      !!modal ||
      !!onboarding.active() ||
      !state.addresses.length ||
      state.entryMode !== "smart",
    getTab: () => tab,
    go: (next) => {
      tab = next;
      render(false);
    },
    expandAddresses: () => {
      expanded = true;
      render(false);
    },
    collapseAddresses: () => {
      expanded = false;
      render();
    },
    cancelMotion: () => dayPager?.cancel(),
    hasGraph,
    canShare: hasGraph,
    hasSummary: hasGraph,
  });
  diagnostics = window.SvitloDiagnostics.create({
    getState: () => state,
    esc,
    dialog,
    button: dialogButton,
    close: closeDialog,
  });
  sensor = window.SvitloLiveSensors.create({
    state: () => state,
    address,
    addresses: () => state.addresses,
    selectAddress: id => { if (state.addresses.some(a => a.id === id)) { state.active = id; save(); tab = "home"; render(false); } },
    esc,
    date: () => window.SvitloClock.selected(state),
    now: () => window.SvitloClock.now(state),
    schedule,
    kindLabel,
    render,
    dialog,
    button: dialogButton,
    close: closeDialog,
    toast,
  });
  dayPager = window.SvitloMotionUI.pager({
    date: () => window.SvitloClock.selected(state),
    content: dayContent,
    allowed: dateAllowed,
    blocked: () =>
      !!modal ||
      (guideTour.visible() && !guideTour.isOffer()) ||
      !!onboarding.active(),
    commit: (date) => {
      if (!dateAllowed(date)) return;
      const focus =
        document.activeElement?.id === "day-pager"
          ? "pager"
          : document.activeElement?.dataset.action === "day"
            ? "day"
            : null;
      state.viewDate = date;
      render();
      if (focus === "pager")
        document.getElementById("day-pager")?.focus({ preventScroll: true });
      else if (focus === "day")
        app
          .querySelector(`[data-action=day][data-date="${date}"]`)
          ?.focus({ preventScroll: true });
    },
  });
  let prototypeInstallPrompt=null, prototypeInstalledThisSession=false;
  function isPrototypeInstalled() {
    return (
      state.shellMode === "pwa" ||
      (state.shellMode !== "browser" &&
        (prototypeInstalledThisSession ||
          window.matchMedia("(display-mode: standalone)").matches ||
          window.matchMedia("(display-mode: fullscreen)").matches ||
          navigator.standalone === true))
    );
  }
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    prototypeInstallPrompt = event;
  });
  window.addEventListener("appinstalled", () => {
    prototypeInstalledThisSession = true;
    prototypeInstallPrompt = null;
    if (tab === "options" && !onboarding.active()) render();
  });
  function registerWorker() {
      navigator.serviceWorker
        .register("sw.js", { scope: "./", updateViaCache: "none" })
        .then((registration) => {
          document.documentElement.dataset.pwaWorker = registration.active
            ? "active"
            : "registered";
          const worker = registration.installing || registration.waiting;
          worker?.addEventListener("statechange", () => {
            if (worker.state === "activated")
              document.documentElement.dataset.pwaWorker = "active";
          });
          return registration.update();
        })
        .catch((error) => {
          document.documentElement.dataset.pwaWorker = "error";
          console.warn("PWA worker: " + error.name);
        });
  }
  if ('serviceWorker' in navigator && window.isSecureContext) {
    let previous=navigator.serviceWorker.controller,updatePending=false;
    navigator.serviceWorker.addEventListener('controllerchange',()=>{
      if(previous)updatePending=true;
      previous=navigator.serviceWorker.controller;
    });
    setInterval(()=>{if(updatePending&&!document.hidden&&!modal&&!onboarding.active()){save();location.reload();}},1000);
    if(document.readyState==='complete')registerWorker();
    else window.addEventListener('load',registerWorker,{once:true});
  }
  async function installPrototype() {
    if (prototypeInstallPrompt) {
      const prompt = prototypeInstallPrompt;
      prototypeInstallPrompt = null;
      try {
        await prompt.prompt();
        await prompt.userChoice;
      } catch {
        toast("Скористайтеся меню браузера → Додати на головний екран.");
      }
    } else
      dialog(
        "Запуск як застосунок",
        "<p>Шапка браузера зникне після встановлення та запуску зі значка.</p><ol><li>У меню ⋮ оберіть «Відкрити у Chrome», якщо застосунок відкритий у вбудованому вікні.</li><li>У Chrome: ⋮ → «Додати на головний екран» → «Встановити».</li><li>Закрийте вкладку й запускайте «Світло» зі значка на головному екрані.</li></ol>",
        dialogButton("Закрити", "close", "center"),
      );
  }
  document.addEventListener("fullscreenchange", () => {
    if (tab === "options" && !onboarding.active()) render();
  });
  day = window.SvitloClock.weekday(window.SvitloClock.selected(state));
  let lastClock =
    window.SvitloClock.now(state).date +
    " " +
    window.SvitloClock.now(state).time;
  function tickClock() {
    const n = window.SvitloClock.now(state),
      key = n.date + " " + n.time;
    if (key !== lastClock) {
      lastClock = key;
      if (!onboarding.active() && !modal) render();
      else sensor?.refresh?.();
      syncLab();
    }
  }
  setInterval(() => {
    if (!document.hidden) tickClock();
  }, 15000);
  window.addEventListener("pageshow", tickClock);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) tickClock();
  });
  recordActiveDay();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      recordActiveDay();
      render();
    }
  });
  window.addEventListener("focus", recordActiveDay);
  app.addEventListener("pointerdown", recordActiveDay, { passive: true });
  app.addEventListener("keydown", recordActiveDay);
  live.onChange(() => { live.adopt(state); if(state.sessionReset){state.sessionReset=false;onboarding.close();closeDialog();tab='home';} sensor?.sync(); if (!modal && !onboarding.active()) render(); });
  onboarding.restore();
  render(false);
  live.start();
})();

