import {DictionaryCache} from "./lib/dictionary-cache.js";
import {SyncClient, SYNC_KEY, cityKey, legacyEnvelope} from "./lib/sync-client.js";
import {messageTitle, shareText} from "./lib/notifications.js";
import {addressCard, appearance, notificationSettings, legend, outageCategory, categoryText, fitPairs} from "./lib/patch-ui.js";
import { slideDay } from "./lib/day-transition.js";
import { fitHeader } from "./lib/layout.js";
import { adjacentDay, bindHorizontalSwipe } from "./lib/navigation.js";
import { hourTile, fitHours, groupRepeatedHours } from "./lib/tiles.js";
import { refreshFailure } from "./lib/schedule.js";
import { enhancePickers } from "./lib/pickers.js";
import {
  summaryIcon,
  weatherIcon,
  weatherDescription,
} from "./lib/icons.js";
import { request, configured, forgetSession, identity, ensureIdentity } from "./api.js";
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
  profiles: [],
  owner: null,
  active: read("svitlo-active", null),
  theme: read("svitlo-theme", "dark"),
  iconStyle: read("svitlo-icon-style", "bolt") === "bulb" ? "bulb" : "bolt",
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
  addressOpen: false,
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
  if(p.owner && p.owner!==state.owner)return false;
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
  hideTooltip();
  stopDayAnimation?.();
  stopDayAnimation = null;
  theme();
  const p = profile(),
    now = Date.now(),
    timer = p ? countdown(p.snapshot, now) : null;
  state.profiles.forEach(
    (p) => (p.messages = mergeHistory(p.messages || [], [], now)),
  );
  $("#app").innerHTML =
    `<div class="shell"><header class="top"><h1 class="brand">Світло</h1><p class="header-queue">${p?.snapshot?.queue ? "Черга " + esc(p.snapshot.queue) : ""}${p ? `<span class="header-category" title="${esc(categoryText(outageCategory(p.snapshot,state.date,now,true)))}">${outageCategory(p.snapshot,state.date,now,true)? (p.snapshot.queue?" | ":"")+esc(outageCategory(p.snapshot,state.date,now,true)==="hourly"?"За графіком":categoryText(outageCategory(p.snapshot,state.date,now,true))):""}</span>` : ""}</p>${timer ? `<p class="countdown-label">${esc(timer.label)}</p>${timer.minutes !== undefined ? `<p class="countdown-value">${duration(timer.minutes)}</p>` : ""}` : ""}</header>${!navigator.onLine ? `<div class="offline" role="status">Немає підключення до інтернету.${p?.snapshot?.checkedAt ? " Показуємо збережені дані." : " Збереженого графіка немає."}</div>` : ""}${state.error ? `<p class="notice" role="status">${esc(state.error)}</p>` : ""}${installNotice()}<main id="content">${state.tab === "home" ? home(p, now) : state.tab === "messages" ? messages(p, now) : options(p)}</main></div><nav class="nav" aria-label="Основне меню">${[
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
    w = state.weather[cityKey(p.address)];
  const hours = groupRepeatedHours(s.displayHours)
    .map((h) => hourTile(h, state.date, now, state.rangeTiles, state.iconStyle))
    .join("");
  return `${addressCard(p,state.profiles,state.addressOpen)}<section class="card schedule" id="schedule" aria-label="Погодинний графік">${s.policy.active ? `<aside class="emergency"><h2>⚠ Аварійні відключення в області</h2><p>Погодинний графік: ${{ active: "діє", suspended: "не діє", unknown: "не підтверджено" }[s.policy.validity]}</p></aside>` : ""}<div class="week" role="tablist" aria-label="Дні тижня" style="--day-index:${days.indexOf(state.date)}"><span class="day-indicator" aria-hidden="true"></span>${days.map((d, i) => `<button role="tab" class="day" data-day="${d}" aria-label="${["Понеділок", "Вівторок", "Середа", "Четвер", "П’ятниця", "Субота", "Неділя"][i]}, ${d}" aria-selected="${d === state.date}" ${!dayState(p.snapshot, d, now).available ? "disabled" : ""}>${["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"][i]}</button>`).join("")}</div>${dataReason(s) && s.reason !== "stale" ? `<p class="notice" role="status">${esc(dataReason(s))}</p>` : ""}${maintenanceNotice(p.snapshot, now)}${s.available || s.reason === "queue_unknown" ? `<div class="hours-viewport"><div class="hours">${hours}</div></div>` : '<p class="empty">Графік на цю дату ще не опубліковано</p>'}${legend(state.iconStyle,outageCategory(p.snapshot,state.date,now))}<div class="row">${external(s.plan?.url || "https://www.cherkasyoblenergo.com/off", "Джерело")}${action("refresh", state.busy ? "Оновлюємо…" : "↻ Оновити", state.busy ? "disabled" : "")}</div>${state.week !== monday(dayKey(now)) || canNextWeek(p.snapshot, now) ? `<div class="week-control">${action("previous", "← Поточний тиждень", state.week === monday(dayKey(now)) ? "disabled" : "")}${action("next", "Наступний тиждень →", state.week !== monday(dayKey(now)) || !canNextWeek(p.snapshot, now) ? "disabled" : "")}</div>` : ""}</section>${
    s.totals
      ? `<section class="stats" aria-label="Підсумок дня">${[
          ["☀", "Зі світлом", s.totals.on],
          ["◕", "Без світла", s.totals.off],
        ]
          .map(
            ([icon, label, n]) =>
              `<article class="card"><p class="stat-label"><i aria-hidden="true">${summaryIcon(label === "Зі світлом")}</i>${label}</p><p class="stat-value">${duration(n).replace(/(\d+) (год|хв)/g, '<span class="duration-part"><span class="duration-number">$1</span> <span class="duration-unit">$2</span></span>')}</p><small>за графіком</small></article>`,
          )
          .join("")}</section>`
      : '<section class="card"><h2>Немає точних даних</h2></section>'
  }<section class="card weather"><small>СЬОГОДНІ</small><div class="weather-now"><span class="weather-current-icon">${weatherIcon(w?.code, w?.isDay !== false)}</span><strong class="temperature">${w ? Math.round(w.temperature) + "°" : "—°"}</strong><div><h2>${esc(p.address.city)}</h2><p class="muted">${w ? weatherDescription(w.code) : "Погода поки недоступна"}</p></div></div>${w ? `<div class="weather-hours" role="region" tabindex="0" aria-label="Погода на 24 години">${w.hours.map((h) => `<div class="weather-hour"><small>${clock(h.time)}</small>${weatherIcon(h.code, h.isDay !== false)}<b>${Math.round(h.temp)}°</b></div>`).join("")}</div>` : ""}<p class="weather-credit"><a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a> · <a href="https://www.geonames.org/" target="_blank" rel="noopener">GeoNames</a></p></section><div class="row main-share">${action("share", "Поділитись графіком")}</div><div class="stack main-donation">${external("https://send.monobank.ua/jar/5cWs9Zt1qa", "♡ Подякувати за додаток")}</div>`;
}
function messages(p) {
  const items=p?.messages||[];
  return items.length ? items.map(m=>{
    const title=messageTitle(m), meta=`Оновлено · ${stamp(m.updatedAt)}${m.scope==='region'?' · в області':''}`;
    const context=m.queue?'Підчерга '+m.queue:m.scope==='region'?'В області':p.address.city;
    return `<article class="card message"><small class="message-meta full-copy" tabindex="0" data-full="${esc(meta)}" aria-label="${esc(meta)}">${esc(meta)}</small><h2 class="full-copy" tabindex="0" data-full="${esc(title)}" aria-label="${esc(title)}">${esc(title)}</h2><p class="message-context full-copy" tabindex="0" data-full="${esc(context)}" aria-label="${esc(context)}">${esc(context)}</p><div class="row fit-pair"><button data-message-date="${esc(m.date)}">Переглянути графік</button>${external(m.url,'Джерело')}</div></article>`;
  }).join('') : '<section class="card empty"><h2>Поки немає повідомлень</h2><p>Тут зберігатимуться оновлення вашого графіка за останні сім днів.</p></section>';
}
function options(p) {
  const permission='Notification' in window?Notification.permission:'unsupported';
  return `<div class="settings">${appearance(state)}${notificationSettings(p,permission,state.push)}<section class="card"><h2>Ваші дані</h2><p class="privacy">Адреса та підписка зберігаються на сервері «Світло» для оновлень і сповіщень. Погода визначається для населеного пункту. На пристрої зберігається офлайн-копія. Очищення даних браузера може втратити доступ до збережених адрес.</p><div class="stack">${action('erase','Видалити мої дані','class="danger"')}</div></section>${legend(state.iconStyle,p&&outageCategory(p.snapshot,state.date,Date.now()),true)}</div>`;
}

let stopPairs, stopHours, stopHeader, stopDaySwipe, stopWeekSwipe, stopDayAnimation, navObserver;
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
  stopPairs?.();stopPairs=fitPairs();
  document.querySelectorAll('[data-look]').forEach(el=>el.onclick=()=>{
    const key=el.dataset.look,value=el.dataset.value;
    if(key==='theme'){state.theme=value;save('svitlo-theme',value);}
    if(key==='range'){state.rangeTiles=value==='true';save('svitlo-range-tiles',state.rangeTiles);}
    if(key==='icons'){state.iconStyle=value;save('svitlo-icon-style',value);}
    render();document.querySelector(`[data-look="${key}"][data-value="${value}"]`)?.focus();
  });
  const addressTrigger=document.querySelector('.address-trigger');
  if(addressTrigger) {
    addressTrigger.onclick=()=>{state.addressOpen=!state.addressOpen;render();document.querySelector('.address-trigger')?.focus();};
    document.querySelector('.address').onkeydown=e=>{if(e.key==='Escape'&&state.addressOpen){state.addressOpen=false;render();document.querySelector('.address-trigger')?.focus();}};
    document.querySelectorAll('[data-profile]').forEach(el=>el.onclick=async()=>{
      const id=el.dataset.profile;state.addressOpen=false;
      if(id===profile()?.id){render();document.querySelector('.address-trigger')?.focus();return;}
      refreshToken++;state.busy=false;state.error='';state.active=id;state.date=dayKey();state.week=monday();state.explicit=false;persist();
      render();document.querySelector('.address-trigger')?.focus();await refresh('auto');
    });
  }
  document.querySelectorAll('.full-copy').forEach(el=>{
    const show=()=>{hideTooltip();const t=document.createElement('div');t.id='full-text-tooltip';t.className='text-tooltip';t.setAttribute('role','tooltip');t.textContent=el.dataset.full;document.body.append(t);el.setAttribute('aria-describedby',t.id);};
    el.onfocus=show;el.onclick=show;el.onblur=hideTooltip;el.onkeydown=e=>{if(e.key==='Escape')hideTooltip();};
  });
  stopHeader?.();
  stopHeader = fitHeader($(".top"));
  stopDaySwipe?.();
  stopWeekSwipe?.();
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
  document
    .querySelectorAll("[data-pref]")
    .forEach(
      (el) =>
        (el.onchange = () => updatePrefs({ [el.dataset.pref]: el.checked })),
    );
  if ($("#lead"))
    $("#lead").onchange = (e) => updatePrefs({ lead: +e.target.value });
  stopDaySwipe = bindHorizontalSwipe($(".hours-viewport"), navigateDay);
  stopWeekSwipe = bindHorizontalSwipe($("#schedule"), navigateWeek,
    (target) => !!target.closest(".hours-viewport, button, a"));
}
let prefsQueue=Promise.resolve();
function updatePrefs(change) {
  const id=profile()?.id;
  prefsQueue=prefsQueue.catch(()=>{}).then(()=>savePrefs(id,change));return prefsQueue;
}
async function savePrefs(id,change) {
  const focusKey=Object.keys(change)[0];
  try {
    const r = await request("preferences", {
      id,
      preferences: change,
    });
    cache.clear();
    store(r.profile);
    render();
    document.querySelector(focusKey==='lead'?'#picker-lead':`[data-pref="${focusKey}"]`)?.focus();
  } catch (e) {
    toast(e.message);
    render();
  }
}
function navigateDay(direction) {
  const target = adjacentDay(profile()?.snapshot, state.date, direction);
  if (!target) return;
  stopDayAnimation = slideDay($(".hours"), direction, () => {
    state.date = target;
    state.week = monday(target);
    state.explicit = false;
    render();
    return $(".hours");
  });
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
      const p=profile(), text=shareText(p.snapshot,state.date,dayState(p.snapshot,state.date));
      if(navigator.share)await navigator.share({title:'Графік «Світло»',text});
      else {await navigator.clipboard.writeText(text);toast('Графік скопійовано');}
      return;
    }
    if (action === "erase") return eraseDialog();
  } catch (e) {
    toast(e.message);
  }
}
function hideTooltip(){document.querySelector('#full-text-tooltip')?.remove();}
async function invalidation(id) {
  try {const c=await caches.open('svitlo-events-v1'),r=await c.match(new URL(`push-invalid/${id}.json`,new URL('./',location.href)).href);return r?(await r.json()).token:null;}catch{return null;}
}
let appliedAt=0;
const cache=new SyncClient({request,owner:ensureIdentity,invalidation});
async function subscriptionData() {
  let sub=await registration?.pushManager?.getSubscription();
  // A rotated server VAPID key requires a new browser subscription. Permission
  // is never requested automatically; repair only an already granted device.
  if(sub?.options?.applicationServerKey && state.vapid && Notification.permission==='granted') {
    const expected=state.vapid.replace(/-/g,'+').replace(/_/g,'/');
    const bytes=Uint8Array.from(atob(expected+'='.repeat((4-expected.length%4)%4)),c=>c.charCodeAt(0));
    const current=new Uint8Array(sub.options.applicationServerKey);
    if(current.length!==bytes.length || current.some((n,i)=>n!==bytes[i])) {
      await sub.unsubscribe();
      sub=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes});
    }
  }
  state.push=!!sub;return sub?.toJSON()||null;
}
function applySync(value) {
  if(!value)return;
  appliedAt=value.at;
  state.owner=value.owner;
  state.profiles=value.profiles;state.weather=value.weather||{};state.vapid=value.vapid;state.pushReady=value.pushReady;
  if(!state.profiles.some(p=>p.id===state.active))state.active=state.profiles[0]?.id||null;
  persist();
}
async function refresh(reason='manual') {
  if(!configured())return;
  let id=profile()?.id||state.active;
  const token=++refreshToken;
  try {
    const before=state.push,subscription=await subscriptionData(),owner=await ensureIdentity();
    if(state.owner&&state.owner!==owner){cache.clear();state.profiles=[];state.weather={};state.active=null;state.owner=owner;id=undefined;persist();render();}
    const cached=cache.read(owner);
    if(!await cache.needed(cached,id,reason,subscription)) {
      if(cached.at!==appliedAt||before!==state.push){applySync(cached);render();}
      return;
    }
    state.busy=true;state.error='';render();
    const value=await cache.sync({id,reason,subscription});
    applySync(value);
    if(token===refreshToken)state.error=value?.errors?.profile||refreshFailure(profile()?.snapshot)||'';
  }catch(e) {
    if(e.status===404&&id&&token===refreshToken){cache.clear();state.profiles=state.profiles.filter(p=>p.id!==id);state.active=state.profiles[0]?.id||null;persist();state.busy=false;return refresh('auto');}
    if(token===refreshToken){state.error=e.message;render();}
  }
  finally {if(token===refreshToken&&state.busy){state.busy=false;render();}}
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
  const repairedBranches=new Set();
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
          const r = await dictionary({
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
          if(i===3 && e.status===400) {
            const index=/філія/i.test(e.message)?0:/населений/i.test(e.message)?1:/вулиця/i.test(e.message)?2:3;
            const parent=index?d.querySelector('#'+keys[index-1]).value:'';
            const repairKey=keys[index]+':'+parent;
            if(!repairedBranches.has(repairKey)) {
              repairedBranches.add(repairKey);
              try {
                const r=await dictionary({kind:keys[index],parent},true);
                if(gen!==generation)return;
                select(keys[index],r.items);
                for(const later of keys.slice(index+1)){d.querySelector('#'+later).innerHTML='';d.querySelector('#'+later).disabled=true;}
                d.querySelector('#form-error').textContent='Довідник оновлено. Оберіть адресу ще раз.';
              }catch { /* Preserve the initial error, without recursive retries. */ }
            }
          }
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
      cache.clear();
      store(r.profile);
      state.active = r.profile.id;
      state.date = dayKey();
      state.week = monday();
      persist();
      d.close();
      render();
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
      (await dictionary({ kind: "department" })).items,
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
          cache.clear();
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
      cache.clear();
      await forgetSession();
      state.owner=null;
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
async function syncPush() {return refresh('auto');}
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
      cache.clear();
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
    cache.clear();
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
      const owner=await identity();
      if(owner) {
        if(!cache.read(owner)) {
          const legacy=legacyEnvelope(owner,read('svitlo-profiles',[]),read('svitlo-weather',{}));
          if(legacy)cache.write(legacy);
        }
        applySync(cache.read(owner));
      }
      render();
      const q = new URLSearchParams(location.search);
      if(/^[0-9a-f-]{36}$/.test(q.get('profile')||''))state.active=q.get('profile');
      if (/^\d{4}-\d{2}-\d{2}$/.test(q.get("date") || "")) {
        state.date = q.get("date");
        state.week = monday(state.date);
        state.explicit = true;
      }
      render();
      await refresh("auto");
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
  refresh("auto");
});
window.addEventListener("offline", render);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    rollover();
    refresh("auto");
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
    if(!document.hidden)refresh("rollover");
  }
}
setInterval(() => {
  if(document.hidden)return;
  rollover();
  refresh("auto");
  if (state.tab === "home" && !document.querySelector("dialog[open]")) render();
}, 60000);
window.addEventListener('storage',async e=>{
  if(e.key===SYNC_KEY){const owner=await identity();applySync(owner?cache.read(owner):null);render();if(!e.newValue&&!document.hidden)refresh('auto');}
  if(e.key==='svitlo-auth'){cache.clear();state.owner=null;state.profiles=[];state.weather={};state.active=null;persist();save('svitlo-weather',{});render();refresh('auto');}
});
navigator.serviceWorker?.addEventListener('message',e=>{if(e.data?.type==='svitlo-invalidated'&&!document.hidden)refresh('push');});
const dictionaryCache=new DictionaryCache(request);
const dictionary=(body,force=false)=>dictionaryCache.load(body,force);
startup();
