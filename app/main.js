import { hourTile, fitHours, tileClock, kindLabel } from "./lib/tiles.js";
import { refreshFailure } from "./lib/schedule.js";
import { enhancePickers } from "./lib/pickers.js";
import {
  powerIcon,
  summaryIcon,
  weatherIcon,
  weatherDescription,
} from "./lib/icons.js";
import { request, configured, forgetSession } from "./api.js";
import {
  dayKey,
  week,
  monday,
  addDays,
  clock,
  stamp,
  duration,
} from "./lib/time.js";
import {
  dayState,
  countdown,
  canNextWeek,
  dataReason,
} from "./lib/schedule.js";
import { mergeHistory } from "./lib/parsers.js";
const $ = (s) => document.querySelector(s),
  esc = (s) =>
    String(s ?? "").replace(
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
const read = (k, f) => {
    try {
      return JSON.parse(localStorage.getItem(k)) ?? f;
    } catch {
      return f;
    }
  },
  save = (k, v) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      toast("Недостатньо місця для офлайн-копії");
    }
  };
const state = {
  profiles: read("svitlo-profiles", []),
  active: read("svitlo-active", null),
  theme: read("svitlo-theme", "dark"),
  rangeTiles: read("svitlo-range-tiles", false) === true,
  weather: read("svitlo-weather", {}),
  tab: "home",
  date: dayKey(),
  week: monday(),
  busy: false,
  error: "",
  vapid: "",
  pushReady: false,
  push: false,
  explicit: false,
};
let installPrompt,
  installDismissed = false,
  installHelp = false,
  installed = false;
let registration,
  refreshToken = 0,
  calendarDay = dayKey(),
  statusTimer;
const profile = () =>
  state.profiles.find((p) => p.id === state.active) || state.profiles[0];
function persist() {
  save("svitlo-profiles", state.profiles);
  save("svitlo-active", state.active);
}
function store(p) {
  const index = state.profiles.findIndex((x) => x.id === p.id);
  if (index < 0) state.profiles.push(p);
  else state.profiles[index] = p;
  persist();
}
function toast(message) {
  $("#status").textContent = message;
  $("#status").classList.add("show");
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => $("#status").classList.remove("show"), 6500);
}
function theme() {
  document.documentElement.dataset.theme = state.theme;
  document.querySelector("meta[name=theme-color]").content =
    state.theme === "light" ? "#eff5ec" : "#14251e";
  save("svitlo-theme", state.theme);
}
const action = (id, label, extra = "") =>
  `<button data-action="${id}" ${extra}>${label}</button>`;
const external = (url, label) =>
  `<a class="button" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
function installNotice() {
  if (
    installed ||
    installDismissed ||
    navigator.standalone ||
    window.matchMedia("(display-mode: standalone)").matches
  )
    return "";
  const ios =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const help = ios
    ? "Натисніть «Поділитися» → «На Початковий екран» у Safari."
    : "Відкрийте меню браузера → «Встановити застосунок» або «Додати на головний екран». Якщо відкрито всередині іншого застосунку, спершу відкрийте посилання у браузері.";
  return `<aside class="install-banner" aria-label="Встановлення Світло"><strong>Встановіть «Світло» на телефон</strong><div class="actions">${action("install", "Встановити", 'class="primary"')}${action("dismiss-install", "Пізніше")}</div>${installHelp ? `<p class="install-note" role="status">${help}</p>` : ""}</aside>`;
}
function render() {
  theme();
  const p = profile(),
    now = Date.now(),
    timer = p ? countdown(p.snapshot, now) : null;
  state.profiles.forEach(
    (p) => (p.messages = mergeHistory(p.messages || [], [], now)),
  );
  $("#app").innerHTML =
    `<div class="shell"><header class="top"><h1 class="brand">Світло<span>${p?.snapshot?.queue ? "Черга " + esc(p.snapshot.queue) : "Для Черкащини"}</span></h1>${timer ? `<p class="countdown">${esc(timer.label)}${timer.minutes !== undefined ? "<br><strong>" + duration(timer.minutes) + "</strong>" : ""}</p>` : ""}</header>${!navigator.onLine ? `<div class="offline" role="status">Немає підключення до інтернету.${p?.snapshot?.checkedAt ? " Показуємо збережені дані." : " Збереженого графіка немає."}</div>` : ""}${state.error ? `<p class="notice" role="status">${esc(state.error)}</p>` : ""}${installNotice()}<main id="content">${state.tab === "home" ? home(p, now) : state.tab === "messages" ? messages(p, now) : options(p)}</main></div><nav class="nav" aria-label="Основне меню">${[
      ["home", "Головна"],
      ["messages", "Повідомлення"],
      ["options", "Опції"],
    ]
      .map(
        ([id, label]) =>
          `<button data-tab="${id}" ${state.tab === id ? 'aria-current="page"' : ""}>${label}</button>`,
      )
      .join("")}</nav>`;
  bind();
  enhancePickers();
}
function home(p, now) {
  if (!p)
    return `<section class="card empty"><div class="sun" aria-hidden="true">☀</div><h2>Знайте, коли буде світло</h2><p>Додайте адресу, щоб бачити ваш графік, погоду та зміни відключень.</p>${action("add", "Додати адресу", 'class="primary"')}${!configured() ? '<p class="install-note">Вебзастосунок підготовлено. Підключення сервера триває.</p>' : ""}</section>`;
  const s = dayState(p.snapshot, state.date, now),
    days = week(state.week),
    w = state.weather[p.id];
  const hours = s.displayHours
    .map((h) => hourTile(h, state.date, now, state.rangeTiles))
    .join("");
  return `<section class="card address"><label for="active-address" class="sr-only">Ваша адреса</label><div class="address-picker"><select class="address-select" id="active-address">${state.profiles.map((x) => `<option value="${x.id}" ${x.id === p.id ? "selected" : ""}>${esc(x.name ? x.name + ": " + x.address.label : x.address.label)}</option>`).join("")}</select></div><div class="row">${action("add", "Додати адресу")}${action("manage", "Керувати адресами")}</div></section><section class="card schedule" id="schedule" aria-label="Погодинний графік">${s.policy.active ? `<aside class="emergency"><h2>⚠ Аварійні відключення в області</h2><p>Погодинний графік: ${{ active: "діє", suspended: "не діє", unknown: "не підтверджено" }[s.policy.validity]}</p></aside>` : ""}<div class="week" role="tablist" aria-label="Дні тижня">${days.map((d, i) => `<button role="tab" class="day" data-day="${d}" aria-label="${["Понеділок", "Вівторок", "Середа", "Четвер", "П’ятниця", "Субота", "Неділя"][i]}, ${d}" aria-selected="${d === state.date}" ${!dayState(p.snapshot, d, now).available ? "disabled" : ""}>${["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"][i]}</button>`).join("")}</div>${dataReason(s) && s.reason !== "stale" ? `<p class="notice" role="status">${esc(dataReason(s))}</p>` : ""}${maintenanceNotice(p.snapshot, now)}${s.available || s.reason === "queue_unknown" ? `<div class="hours">${hours}</div>` : '<p class="empty">Графік на цю дату ще не опубліковано</p>'}<div class="legend"><span><i style="background:var(--hourly)"></i>ГПВ</span><span><i style="background:var(--planned)"></i>Планові роботи</span><span><i style="background:var(--emergency)"></i>Аварійні</span></div><div class="row">${external(s.plan?.url || "https://www.cherkasyoblenergo.com/off", "Джерело")}${action("refresh", state.busy ? "Оновлюємо…" : "↻ Оновити", state.busy ? "disabled" : "")}</div>${state.week !== monday(dayKey(now)) || canNextWeek(p.snapshot, now) ? `<div class="week-control">${action("previous", "← Поточний тиждень", state.week === monday(dayKey(now)) ? "disabled" : "")}${action("next", "Наступний тиждень →", state.week !== monday(dayKey(now)) || !canNextWeek(p.snapshot, now) ? "disabled" : "")}</div>` : ""}</section>${
    s.totals
      ? `<section class="stats" aria-label="Підсумок дня">${[
          ["☀", "Зі світлом", s.totals.on],
          ["◕", "Без світла", s.totals.off],
        ]
          .map(
            ([icon, label, n]) =>
              `<article class="card"><p class="stat-label"><i aria-hidden="true">${summaryIcon(label === "Зі світлом")}</i>${label}</p><p class="stat-value">${duration(n)}</p><small>за графіком</small></article>`,
          )
          .join("")}</section>`
      : '<section class="card"><h2>Немає точних даних</h2></section>'
  }<section class="card weather"><small>СЬОГОДНІ</small><div class="weather-now"><span class="weather-current-icon">${weatherIcon(w?.code, w?.isDay !== false)}</span><strong class="temperature">${w ? Math.round(w.temperature) + "°" : "—°"}</strong><div><h2>${esc(p.address.city)}</h2><p class="muted">${w ? weatherDescription(w.code) : "Погода поки недоступна"}</p></div></div>${w ? `<div class="weather-hours" aria-label="Погода на 24 години">${w.hours.map((h) => `<div class="weather-hour"><small>${clock(h.time)}</small>${weatherIcon(h.code, h.isDay !== false)}<b>${Math.round(h.temp)}°</b></div>`).join("")}</div><small>Оновлено ${stamp(w.checkedAt)}${Date.now() - w.checkedAt > 7200000 ? " · збережені дані" : ""}</small>` : ""}<p class="privacy"><a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> · CC BY 4.0 · GeoNames</p></section><div class="row">${action("share", "Поширити графік")}</div>`;
}
function messages(p) {
  const items = p?.messages || [];
  return items.length
    ? items
        .map(
          (m) =>
            `<article class="card message"><small>Оновлено · ${stamp(m.updatedAt)} · Подія ${esc(m.date.split("-").reverse().join("."))}${m.scope === "region" ? " · в області" : ""}</small><h2>${esc(m.title)}</h2><small>${esc(m.queue ? "Підчерга " + m.queue : p.address.city)}</small><div class="row"><button data-message-date="${m.date}">Графік на ${esc(m.date.slice(5).split("-").reverse().join("."))}</button>${external(m.url, "Офіційне джерело")}</div></article>`,
        )
        .join("")
    : '<section class="card empty"><h2>Поки немає повідомлень</h2><p>Тут зберігатимуться оновлення вашого графіка за останні сім днів.</p></section>';
}
function options(p) {
  const prefs = p?.preferences || {};
  return `<div class="settings"><section class="card"><h2>Вигляд</h2><label>Світла тема<input type="checkbox" id="light-theme" ${state.theme === "light" ? "checked" : ""}></label><label>Початок і кінець у плитці<input type="checkbox" id="range-tiles" ${state.rangeTiles ? "checked" : ""}></label></section><section class="card"><h2>Сповіщення</h2><p class="notice">Зміни графіка та нагадування для обраної адреси, навіть коли застосунок закрито.</p>${[
    ["schedule", "Публікації та зміни графіка"],
    ["emergency", "Аварійні відключення"],
    ["reminder", "Перед відключенням"],
    ["restoration", "Перед відновленням"],
  ]
    .map(
      ([key, label]) =>
        `<label>${label}<input type="checkbox" data-pref="${key}" ${prefs[key] !== false ? "checked" : ""} ${p ? "" : "disabled"}></label>`,
    )
    .join(
      "",
    )}<label>Нагадувати за<select id="lead" ${p ? "" : "disabled"}>${[5, 15, 30, 60].map((n) => `<option value="${n}" ${+(prefs.lead || 30) === n ? "selected" : ""}>${n} хв</option>`).join("")}</select></label><div class="stack">${action("push", state.push ? "Вимкнути push-сповіщення" : "Увімкнути push-сповіщення", !p ? "disabled" : "")}</div><p class="install-note">На iPhone сповіщення доступні з iOS 16.4 після додавання на Початковий екран. Дозвіл запитується лише після натискання кнопки. Час доставки залежить від системи.</p></section><section class="card"><h2>Оновлення</h2><p class="notice">Сервер перевіряє графіки щогодини. При відкритті завантажується останній результат.</p>${action("refresh", state.busy ? "Оновлюємо…" : "↻ Оновити зараз", state.busy || !p ? "disabled" : "")}</section><section class="card"><h2>Ваші дані</h2><p class="privacy">Адреса та підписка зберігаються на сервері «Світло» для оновлень і сповіщень. Погода визначається для населеного пункту. На пристрої зберігається офлайн-копія. Очищення даних браузера може втратити доступ до збережених адрес.</p><div class="stack">${action("erase", "Видалити мої дані", 'class="danger"')}</div></section><div class="stack">${external("https://send.monobank.ua/jar/5cWs9Zt1qa", "♡ Подякувати за додаток")}</div></div>`;
}

let stopHours, navObserver;
function maintenanceNotice(snapshot, now) {
  const m = snapshot.maintenance;
  if (
    !m ||
    now < m.from ||
    now >= m.until ||
    !(snapshot.failures?.length || snapshot.feedFailed)
  )
    return "";
  return `<aside class="notice" role="status">Черкасиобленерго повідомляє про технічні роботи · ${stamp(m.publishedAt)}${m.until ? " · заявлений строк до " + stamp(m.until) : ""}. ${external(m.url, "Офіційне повідомлення")}</aside>`;
}
function bind() {
  stopHours?.();
  stopHours = fitHours(document.querySelector(".hours"));
  navObserver?.disconnect();
  const nav = document.querySelector(".nav");
  if (nav) {
    navObserver = new ResizeObserver(() =>
      document.documentElement.style.setProperty(
        "--nav-height",
        nav.getBoundingClientRect().height + "px",
      ),
    );
    navObserver.observe(nav);
  }
  if ($("#range-tiles"))
    $("#range-tiles").onchange = (e) => {
      state.rangeTiles = e.target.checked;
      save("svitlo-range-tiles", state.rangeTiles);
      render();
    };
  document.querySelectorAll("[data-hour]").forEach(
    (el) =>
      (el.onclick = () => {
        const p = profile(),
          s = dayState(p.snapshot, state.date),
          h = s.hours.find((x) => x.start === +el.dataset.hour);
        if (!h) return;
        const rows = h.segments
          .map(
            (x) =>
              `<li>${tileClock(x.start, state.date)}–${tileClock(x.end, state.date)} — ${esc(kindLabel[x.kind])}</li>`,
          )
          .join("");
        dialog(
          "Точні інтервали",
          `<p>За даними джерела. Плитки округлено до 30 хвилин.</p><ul>${rows}</ul>`,
        );
      }),
  );
  document.querySelectorAll("[data-tab]").forEach(
    (el) =>
      (el.onclick = () => {
        state.tab = el.dataset.tab;
        if (state.tab === "home") {
          state.week = monday();
          state.date = dayKey();
          state.explicit = false;
        }
        render();
        window.scrollTo(0, 0);
      }),
  );
  document
    .querySelectorAll("[data-action]")
    .forEach((el) => (el.onclick = () => runAction(el.dataset.action)));
  document.querySelectorAll("[data-day]").forEach(
    (el) =>
      (el.onclick = () => {
        state.date = el.dataset.day;
        render();
      }),
  );
  document.querySelectorAll("[data-message-date]").forEach(
    (el) =>
      (el.onclick = () => {
        state.tab = "home";
        state.date = el.dataset.messageDate;
        state.week = monday(state.date);
        state.explicit = true;
        render();
        window.scrollTo(0, 0);
      }),
  );
  if ($("#active-address"))
    $("#active-address").onchange = async (e) => {
      refreshToken++;
      state.busy = false;
      state.error = "";
      state.active = e.target.value;
      state.date = dayKey();
      state.week = monday();
      state.explicit = false;
      persist();
      render();
      await syncPush();
      refresh();
    };
  if ($("#light-theme"))
    $("#light-theme").onchange = (e) => {
      state.theme = e.target.checked ? "light" : "dark";
      render();
    };
  document
    .querySelectorAll("[data-pref]")
    .forEach(
      (el) =>
        (el.onchange = () => updatePrefs({ [el.dataset.pref]: el.checked })),
    );
  if ($("#lead"))
    $("#lead").onchange = (e) => updatePrefs({ lead: +e.target.value });
  const chart = $("#schedule");
  if (chart) {
    let start;
    chart.addEventListener(
      "touchstart",
      (e) => {
        start = [e.touches[0].clientX, e.touches[0].clientY];
      },
      { passive: true },
    );
    chart.addEventListener(
      "touchend",
      (e) => {
        if (!start) return;
        const dx = e.changedTouches[0].clientX - start[0],
          dy = e.changedTouches[0].clientY - start[1];
        if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5)
          navigateWeek(dx < 0 ? 1 : -1);
        start = null;
      },
      { passive: true },
    );
  }
}
async function updatePrefs(change) {
  const p = profile();
  try {
    const r = await request("preferences", {
      id: p.id,
      preferences: { ...p.preferences, ...change },
    });
    store(r.profile);
    render();
  } catch (e) {
    toast(e.message);
    render();
  }
}
function navigateWeek(direction) {
  const p = profile(),
    current = monday();
  if (
    direction > 0 &&
    state.week === current &&
    canNextWeek(p.snapshot, Date.now())
  ) {
    state.week = addDays(current, 7);
    state.date = state.week;
  } else if (direction < 0 && state.week > current) {
    state.week = current;
    state.date = dayKey();
  } else return;
  state.explicit = false;
  render();
}
async function runAction(action) {
  try {
    if (action === "add") return addressDialog();
    if (action === "manage") return manageDialog();
    if (action === "refresh") return refresh();
    if (action === "previous") return navigateWeek(-1);
    if (action === "next") return navigateWeek(1);
    if (action === "push") return togglePush();
    if (action === "dismiss-install") {
      installDismissed = true;
      render();
      return;
    }
    if (action === "install") {
      if (installPrompt) {
        const prompt = installPrompt;
        installPrompt = null;
        await prompt.prompt();
        const choice = await prompt.userChoice;
        if (choice.outcome === "accepted") installed = true;
      } else installHelp = true;
      render();
      return;
    }
    if (action === "share") {
      const p = profile(),
        s = dayState(p.snapshot, state.date),
        text = `Світло · ${state.date}\n${s.totals ? "Зі світлом: " + duration(s.totals.on) + "\nБез світла: " + duration(s.totals.off) : "Немає точних даних"}\n${s.events.map((e) => clock(e.start) + "–" + (e.end ? clock(e.end) : "?")).join(", ")}`;
      if (navigator.share)
        await navigator.share({
          title: "Графік «Світло»",
          text,
          url: location.href.split("?")[0],
        });
      else {
        await navigator.clipboard.writeText(text);
        toast("Графік скопійовано");
      }
      return;
    }
    if (action === "erase") return eraseDialog();
  } catch (e) {
    toast(e.message);
  }
}
async function refresh() {
  const p = profile();
  if (!p || state.busy) return;
  const id = p.id,
    token = ++refreshToken;
  state.busy = true;
  state.error = "";
  render();
  weather(id);
  try {
    const r = await request("refresh", { id });
    store(r.profile);
    if (token === refreshToken && profile()?.id === id)
      state.error = refreshFailure(r.profile.snapshot);
  } catch (e) {
    if (token === refreshToken) state.error = e.message;
  } finally {
    if (token === refreshToken) {
      state.busy = false;
      render();
    }
  }
}
async function weather(id) {
  const p = state.profiles.find((x) => x.id === id);
  if (!p) return;
  const cached = state.weather[id];
  if (
    cached &&
    cached.city === p.address.city &&
    typeof cached.isDay === "boolean" &&
    Date.now() - cached.checkedAt < 3600000
  )
    return;
  try {
    const r = await request("weather", { id });
    if (
      state.profiles.some((x) => x.id === id) &&
      r.weather.city === p.address.city
    ) {
      state.weather[id] = r.weather;
      save("svitlo-weather", state.weather);
      if (profile()?.id === id && state.tab === "home") render();
    }
  } catch {
    /* no cross-address fallback */
  }
}
function dialog(title, html) {
  const d = $("#address-dialog");
  d.innerHTML = `<button class="dialog-close" aria-label="Закрити">×</button><h2 id="dialog-title">${title}</h2>${html}`;
  d.querySelector(".dialog-close").onclick = () => d.close();
  enhancePickers(d);
  d.showModal();
  return d;
}
async function addressDialog() {
  const d = dialog(
    "Додати адресу",
    `<form id="address-form"><label for="department">Філія</label><select id="department" required><option value="">Завантажуємо…</option></select><label for="city">Населений пункт</label><select id="city" required disabled></select><label for="street">Вулиця</label><select id="street" required disabled></select><label for="house">Будинок</label><select id="house" required disabled></select><div id="preview"></div><p class="error" id="form-error" role="alert"></p></form>`,
  );
  let generation = 0,
    address;
  const select = (key, items) => {
    const el = d.querySelector("#" + key);
    el.innerHTML =
      '<option value="">Оберіть…</option>' +
      items
        .map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`)
        .join("");
    el.disabled = false;
  };
  const keys = ["department", "city", "street", "house"];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    d.querySelector("#" + key).onchange = async () => {
      const gen = ++generation;
      d.querySelector("#preview").innerHTML = "";
      d.querySelector("#form-error").textContent = "";
      for (const later of keys.slice(i + 1)) {
        d.querySelector("#" + later).innerHTML = "";
        d.querySelector("#" + later).disabled = true;
      }
      if (!d.querySelector("#" + key).value) return;
      try {
        if (i < 3) {
          const r = await request("dictionary", {
            kind: keys[i + 1],
            parent: d.querySelector("#" + key).value,
          });
          if (gen === generation) select(keys[i + 1], r.items);
        } else {
          d.querySelector("#preview").textContent = "Перевіряємо адресу…";
          address = {
            department: d.querySelector("#department").value,
            cityId: d.querySelector("#city").value,
            streetId: d.querySelector("#street").value,
            house: d.querySelector("#house").value,
          };
          const r = await request("preview", { address });
          if (gen !== generation) return;
          d.querySelector("#preview").innerHTML =
            `<p style="margin-top:20px">${esc(r.address.label)}</p><p class="muted">${r.queue ? "Черга " + esc(r.queue) : "Черга поки не визначена"}${!r.verified ? " · частина даних тимчасово недоступна" : ""}</p><label for="address-name">Назва (необов’язково)</label><input id="address-name" maxlength="60" placeholder="Мій дім"><div class="row"><button type="submit" class="primary">Так, це моя адреса</button></div>`;
        }
      } catch (e) {
        if (gen === generation) {
          d.querySelector("#preview").innerHTML = "";
          d.querySelector("#form-error").textContent = e.message;
        }
      }
    };
  }
  d.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    const button = d.querySelector("[type=submit]");
    if (!button) return;
    button.disabled = true;
    button.textContent = "Зберігаємо…";
    try {
      const r = await request("save", {
        address,
        name: d.querySelector("#address-name").value,
        confirmed: true,
      });
      store(r.profile);
      state.active = r.profile.id;
      state.date = dayKey();
      state.week = monday();
      persist();
      d.close();
      render();
      weather(r.profile.id);
      await syncPush();
    } catch (e) {
      d.querySelector("#form-error").textContent = e.message;
      button.disabled = false;
      button.textContent = "Так, це моя адреса";
    }
  };
  try {
    select(
      "department",
      (await request("dictionary", { kind: "department" })).items,
    );
  } catch (e) {
    d.querySelector("#form-error").textContent = e.message;
  }
}
function manageDialog() {
  const d = dialog(
    "Ваші адреси",
    state.profiles
      .map(
        (p) =>
          `<div class="delete-row"><p>${esc(p.name || p.address.label)}</p><button data-delete="${p.id}" class="danger">Видалити</button></div>`,
      )
      .join(""),
  );
  d.querySelectorAll("[data-delete]").forEach(
    (el) =>
      (el.onclick = async () => {
        el.disabled = true;
        try {
          await request("delete", { id: el.dataset.delete });
          state.profiles = state.profiles.filter(
            (p) => p.id !== el.dataset.delete,
          );
          delete state.weather[el.dataset.delete];
          state.active = profile()?.id || null;
          persist();
          save("svitlo-weather", state.weather);
          d.close();
          render();
          await syncPush();
        } catch (e) {
          el.disabled = false;
          toast(e.message);
        }
      }),
  );
}
function eraseDialog() {
  const d = dialog(
    "Видалити ваші дані?",
    `<p class="install-note">Буде видалено всі ваші адреси, графіки та push-підписки на сервері й на цьому пристрої.</p><div class="row"><button id="confirm-erase" class="danger">Видалити все</button></div>`,
  );
  d.querySelector("#confirm-erase").onclick = async () => {
    try {
      await request("erase");
      const sub = await registration?.pushManager.getSubscription();
      await sub?.unsubscribe();
      await forgetSession();
      state.profiles = [];
      state.weather = {};
      state.active = null;
      state.push = false;
      persist();
      save("svitlo-weather", {});
      d.close();
      render();
    } catch (e) {
      toast(e.message);
    }
  };
}
async function syncPush() {
  if (!registration) return;
  const sub = await registration.pushManager?.getSubscription();
  state.push = !!sub;
  if (sub)
    await request("subscribe", {
      subscription: sub.toJSON(),
      id: profile()?.id,
    });
}
async function togglePush() {
  try {
    if (
      !("Notification" in window) ||
      !("PushManager" in window) ||
      !registration
    )
      throw Error(
        "Додайте «Світло» на Початковий екран і відкрийте його звідти. Цей браузер не підтримує push.",
      );
    if (!state.pushReady) throw Error("Сервер сповіщень ще не підключений");
    const old = await registration.pushManager.getSubscription();
    if (old) {
      await request("unsubscribe", { endpoint: old.endpoint });
      await old.unsubscribe();
      state.push = false;
      render();
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted")
      throw Error(
        "Дозвіл не надано. Його можна змінити в налаштуваннях браузера або системи.",
      );
    const b64 = state.vapid.replace(/-/g, "+").replace(/_/g, "/"),
      key = Uint8Array.from(
        atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)),
        (c) => c.charCodeAt(0),
      );
    const sub = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    });
    try {
      await request("subscribe", {
        subscription: sub.toJSON(),
        id: profile()?.id,
      });
    } catch (e) {
      await sub.unsubscribe();
      throw e;
    }
    state.push = true;
    render();
    toast("Сповіщення увімкнено для обраної адреси");
  } catch (e) {
    toast(e.message);
  }
}
async function startup() {
  render();
  try {
    if ("serviceWorker" in navigator) {
      registration = await navigator.serviceWorker.register("./sw.js", {
        scope: "./",
        updateViaCache: "none",
      });
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => {
          if (
            worker.state === "installed" &&
            navigator.serviceWorker.controller
          )
            toast(
              "Нова версія готова. Закрийте всі вікна «Світло» та відкрийте знову.",
            );
        });
      });
    }
    if (configured()) {
      const r = await request("bootstrap");
      state.profiles = r.profiles;
      state.vapid = r.vapid;
      state.pushReady = r.pushReady;
      state.active = profile()?.id;
      persist();
      const q = new URLSearchParams(location.search);
      if (
        q.get("profile") &&
        state.profiles.some((p) => p.id === q.get("profile"))
      )
        state.active = q.get("profile");
      if (/^\d{4}-\d{2}-\d{2}$/.test(q.get("date") || "")) {
        state.date = q.get("date");
        state.week = monday(state.date);
        state.explicit = true;
      }
      await syncPush();
      render();
      refresh();
    }
  } catch (e) {
    state.error = e.message;
    render();
  }
}
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  render();
});
window.addEventListener("appinstalled", () => {
  installed = true;
  installPrompt = null;
  render();
});
window
  .matchMedia("(display-mode: standalone)")
  .addEventListener("change", render);
window.addEventListener("online", () => {
  render();
  refresh();
});
window.addEventListener("offline", render);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    rollover();
    refresh();
  }
});
function rollover() {
  const today = dayKey();
  if (calendarDay !== today) {
    calendarDay = today;
    state.date = today;
    state.week = monday(today);
    state.explicit = false;
    render();
  }
}
setInterval(() => {
  rollover();
  if (state.tab === "home" && !document.querySelector("dialog[open]")) render();
}, 60000);
startup();
