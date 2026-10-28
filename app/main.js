import {appStorage,readJSON} from './lib/storage.js';
import {Lifecycle,readRoute,routeDate} from './lib/lifecycle.js';
import {validProfile} from './lib/cache-data.js';
import {bounded} from './lib/session.js';
import {DictionaryCache} from "./lib/dictionary-cache.js";
import {SyncClient, SYNC_KEY, cityKey, legacyEnvelope} from "./lib/sync-client.js";
import {messageTitle, shareText, canShareDay} from "./lib/notifications.js";
import {addressCard, appearance, notificationSettings, legend, outageCategory, categoryText, fitPairs, scheduleNotice} from "./lib/patch-ui.js";
import { slideDay } from "./lib/day-transition.js";
import { fitHeader } from "./lib/layout.js";
import { adjacentDay, bindHorizontalSwipe } from "./lib/navigation.js";
import { hourTile, fitHours, groupRepeatedHours } from "./lib/tiles.js";
import { refreshFailure } from "./lib/schedule.js";
import { enhancePickers } from "./lib/pickers.js";
import {
  summaryIcon,
  shareIcon,
  weatherIcon,
  weatherDescription,
} from "./lib/icons.js";
import { request, configured, forgetSession, identity, ensureIdentity, onIdentityChange } from "./api.js";
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
const read=(key,fallback)=>readJSON(key,fallback);
const save=(key,value)=>appStorage.setItem(key,JSON.stringify(value));
const lifecycle=new Lifecycle(),route=readRoute(location.search);
let routePending=true,lastMarkup='',pushCheck=null,pushRetryAt=0;
const state = {
  profiles: [],
  owner: null,
  active: route.profile||read("svitlo-active", null),
  theme: read("svitlo-theme", "dark")==="light"?"light":"dark",
  iconStyle: read("svitlo-icon-style", "bolt") === "bulb" ? "bulb" : "bolt",
  rangeTiles: read("svitlo-range-tiles", false) === true,
  weather: {},
  tab: "home",
  date: route.date||dayKey(),
  week: monday(route.date||dayKey()),
  busy: false,
  error: "",
  vapid: "",
  pushReady: false,
  push: false,
  explicit: !!route.date,
  addressOpen: false,
  pushChecked: false,
  pushError: "",
  pushBusy: false,
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
function bootContent(){
  const failed=lifecycle.phase==='error';
  return `<section class="card boot-state" aria-live="polite"><h2>${failed?'Не вдалося завантажити ваші адреси':'Завантажуємо ваші адреси…'}</h2>${failed?`<p>Перевірте підключення та спробуйте ще раз.</p>${action('retry','Спробувати ще раз')}`:''}</section>`;
}
function captureFocus(){
  const el=document.activeElement;if(!el||!document.querySelector('#app')?.contains(el))return null;
  let selector=el.id?'#'+CSS.escape(el.id):null;
  for(const key of ['pref','look','tab','action','profile','messageDate'])if(!selector&&el.dataset?.[key]){
    const attribute=key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase());selector=`[data-${attribute}="${CSS.escape(el.dataset[key])}"]`;
    if(key==='look')selector+=`[data-value="${CSS.escape(el.dataset.value)}"]`;
  }
  if(!selector&&el.matches('.address-trigger'))selector='.address-trigger';
  if(!selector&&el.matches('[data-notification-status]'))selector='[data-notification-status]';
  return selector?{selector,start:el.selectionStart,end:el.selectionEnd}:null;
}
function restoreFocus(focus){
  if(!focus)return;const el=document.querySelector(focus.selector);el?.focus({preventScroll:true});
  if(el&&Number.isInteger(focus.start))try{el.setSelectionRange(focus.start,focus.end);}catch{}
}
function persist() {
  save("svitlo-profiles", state.profiles);
  save("svitlo-active", state.active);
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
  const markup =
    `<div class="shell"><header class="top"><h1 class="brand">Світло</h1><p class="header-queue">${p?.snapshot?.queue ? "Черга " + esc(p.snapshot.queue) : ""}${p ? `<span class="header-category" title="${esc(categoryText(outageCategory(p.snapshot,state.date,now,true)))}">${outageCategory(p.snapshot,state.date,now,true)? (p.snapshot.queue?" | ":"")+esc(outageCategory(p.snapshot,state.date,now,true)==="hourly"?"За графіком":categoryText(outageCategory(p.snapshot,state.date,now,true))):""}</span>` : ""}</p>${timer ? `<p class="countdown-label">${esc(timer.label)}</p>${timer.minutes !== undefined ? `<p class="countdown-value">${duration(timer.minutes)}</p>` : ""}` : ""}</header>${!navigator.onLine ? `<div class="offline" role="status">Немає підключення до інтернету.${p?.snapshot?.checkedAt ? " Показуємо збережені дані." : " Збереженого графіка немає."}</div>` : ""}${state.error ? `<p class="notice" role="status">${esc(state.error)}</p>` : ""}${!appStorage.persistent?'<p class="storage-notice" role="status">Дані доступні до закриття цього вікна. Збереження на пристрої недоступне.</p>':""}${installNotice()}<main id="content">${state.tab === "home" ? home(p, now, timer?.label) : state.tab === "messages" ? messages(p, now) : options(p)}</main></div><nav class="nav" aria-label="Основне меню">${[
      ["home", "Головна"],
      ["messages", "Повідомлення"],
      ["options", "Опції"],
    ]
      .map(
        ([id, label]) =>
          `<button data-tab="${id}" ${state.tab === id ? 'aria-current="page"' : ""}>${label}</button>`,
      )
      .join("")}</nav>`;
  if(markup===lastMarkup)return;
  const focus=captureFocus();
  hideTooltip();stopDayAnimation?.();stopDayAnimation=null;
  lastMarkup=markup;$("#app").innerHTML=markup;
  bind();enhancePickers();restoreFocus(focus);
}
function home(p, now, currentLabel) {
  if(!p&&lifecycle.phase!=='empty'&&lifecycle.phase!=='ready')return bootContent();
  if (!p)
    return `<section class="card empty"><div class="sun" aria-hidden="true">☀</div><h2>Знайте, коли буде світло</h2><p>Додайте адресу, щоб бачити ваш графік, погоду та зміни відключень.</p>${action("add", "Додати адресу", 'class="primary"')}${!configured() ? '<p class="install-note">Вебзастосунок підготовлено. Підключення сервера триває.</p>' : ""}</section>`;
  const s = dayState(p.snapshot, state.date, now),
    notice = scheduleNotice(s,currentLabel),
    days = week(state.week),
    w = state.weather[cityKey(p.address)];
  const hours = groupRepeatedHours(s.displayHours)
    .map((h) => hourTile(h, state.date, now, state.rangeTiles, state.iconStyle))
    .join("");
  return `${addressCard(p,state.profiles,state.addressOpen)}<section class="card schedule" id="schedule" aria-label="Погодинний графік">${s.policy.active ? `<aside class="emergency"><h2>⚠ Аварійні відключення в області</h2><p>Погодинний графік: ${{ active: "діє", suspended: "не діє", unknown: "не підтверджено" }[s.policy.validity]}</p></aside>` : ""}<div class="week" role="tablist" aria-label="Дні тижня" style="--day-index:${days.indexOf(state.date)}"><span class="day-indicator" aria-hidden="true"></span>${days.map((d, i) => `<button role="tab" class="day" data-day="${d}" aria-label="${["Понеділок", "Вівторок", "Середа", "Четвер", "П’ятниця", "Субота", "Неділя"][i]}, ${d}" aria-selected="${d === state.date}" ${!dayState(p.snapshot, d, now).available ? "disabled" : ""}>${["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"][i]}</button>`).join("")}</div>${notice ? `<p class="notice" role="status">${esc(notice)}</p>` : ""}${maintenanceNotice(p.snapshot, now)}${s.available || s.reason === "queue_unknown" ? `<div class="hours-viewport"><div class="hours">${hours}</div></div>` : '<p class="empty">Графік на цю дату ще не опубліковано</p>'}${legend(state.iconStyle,outageCategory(p.snapshot,state.date,now))}<div class="row">${external(s.plan?.url || "https://www.cherkasyoblenergo.com/off", "Джерело")}${action("refresh", state.busy ? "Оновлюємо…" : "↻ Оновити", state.busy ? "disabled" : "")}</div>${state.week !== monday(dayKey(now)) || canNextWeek(p.snapshot, now) ? `<div class="week-control">${action("previous", "← Поточний тиждень", state.week === monday(dayKey(now)) ? "disabled" : "")}${action("next", "Наступний тиждень →", state.week !== monday(dayKey(now)) || !canNextWeek(p.snapshot, now) ? "disabled" : "")}</div>` : ""}</section>${
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
  }<section class="card weather"><small>СЬОГОДНІ</small><div class="weather-now"><span class="weather-current-icon">${weatherIcon(w?.code, w?.isDay !== false)}</span><strong class="temperature">${w ? Math.round(w.temperature) + "°" : "—°"}</strong><div><h2>${esc(p.address.city)}</h2><p class="muted">${w ? weatherDescription(w.code) : "Погода поки недоступна"}</p></div></div>${w ? `<div class="weather-hours" role="region" tabindex="0" aria-label="Погода на 24 години">${w.hours.map((h) => `<div class="weather-hour"><small>${clock(h.time)}</small>${weatherIcon(h.code, h.isDay !== false)}<b>${Math.round(h.temp)}°</b></div>`).join("")}</div>` : ""}<p class="weather-credit"><a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a> · <a href="https://www.geonames.org/" target="_blank" rel="noopener">GeoNames</a></p></section>${canShareDay(s) ? `<div class="row main-share">${action("share", `<span class="share-label">${shareIcon()}<span>Поділитись графіком</span></span>`)}</div>` : ""}<div class="stack main-donation">${external("https://send.monobank.ua/jar/5cWs9Zt1qa", "♡ Подякувати за додаток")}</div>`;
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
  return `<div class="settings">${appearance(state)}${notificationSettings(p,permission,state.push,{checking:!state.pushChecked,busy:state.pushBusy,error:state.pushError})}<section class="card"><h2>Ваші дані</h2><p class="privacy">Адреса та підписка зберігаються на сервері «Світло» для оновлень і сповіщень. Погода визначається для населеного пункту. На пристрої зберігається офлайн-копія. Очищення даних браузера може втратити доступ до збережених адрес.</p><div class="stack">${action('erase','Видалити мої дані','class="danger"')}</div></section>${legend(state.iconStyle,p&&outageCategory(p.snapshot,state.date,Date.now()),true)}</div>`;
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
      lifecycle.select();refreshToken++;state.busy=false;state.error='';state.active=id;state.date=dayKey();state.week=monday();state.explicit=false;persist();
      render();document.querySelector('.address-trigger')?.focus();await refresh('auto');
    });
  }
  document.querySelectorAll('.full-copy,[data-notification-status]').forEach(el=>{
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
        lifecycle.select();state.date = el.dataset.day;
        render();
      }),
  );
  document.querySelectorAll("[data-message-date]").forEach(
    (el) =>
      (el.onclick = () => {
        if(!routeDate(el.dataset.messageDate))return;
        lifecycle.select();state.tab = "home";
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
  const id=profile()?.id,scope=lifecycle.capture();
  prefsQueue=prefsQueue.catch(()=>{}).then(()=>lifecycle.current(scope)?savePrefs(id,change,scope):null);return prefsQueue;
}
async function savePrefs(id,change,scope=lifecycle.capture()) {
  if(!id||!scope.owner||!lifecycle.current(scope))return;
  try {
    const r = await ownedRequest("preferences", {
      id,
      preferences: change,
    },scope);
    if(!r)return;
    patchProfiles(profiles=>profiles.map(p=>p.id===id?r.profile:p));
    render();
  } catch (e) {
    if(!lifecycle.current(scope)||e.stale)return;
    toast(e.message);
    render();
  }
}
function navigateDay(direction) {
  const target = adjacentDay(profile()?.snapshot, state.date, direction);
  if (!target) return;
  stopDayAnimation = slideDay($(".hours"), direction, () => {
    lifecycle.select();state.date = target;
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
  lifecycle.select();state.explicit = false;
  render();
}
async function runAction(action) {
  try {
    if (action === "retry") return startup(true);
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
      const p=profile();
      if(!p)return;
      const selectedDay=dayState(p.snapshot,state.date);
      if(!canShareDay(selectedDay))return;
      const text=shareText(p.snapshot,state.date,selectedDay);
      if(navigator.share)await navigator.share({title:'Графік «Світло»',text});
      else {await navigator.clipboard.writeText(text);toast('Графік скопійовано');}
      return;
    }
    if (action === "erase") return eraseDialog();
  } catch (e) {
    toast(e.message);
  }
}
function hideTooltip(){document.querySelector('#full-text-tooltip')?.remove();document.querySelectorAll('[aria-describedby="full-text-tooltip"]').forEach(el=>el.removeAttribute('aria-describedby'));}
async function invalidation(id) {
  try {const c=await caches.open('svitlo-events-v1'),r=await c.match(new URL(`push-invalid/${id}.json`,new URL('./',location.href)).href);return r?(await r.json()).token:null;}catch{return null;}
}
let appliedValue='';
const cache=new SyncClient({request:(action,data)=>request(action,data,{owner:lifecycle.owner}),owner:identity,invalidation});
function adoptOwner(owner){
  const previous=lifecycle.owner;if(!lifecycle.setOwner(owner))return false;
  refreshToken++;state.busy=false;state.owner=owner;state.error='';state.addressOpen=false;state.pushBusy=false;state.subscription=null;state.push=false;
  if(previous){
    const next=owner&&cache.read(owner),active=read('svitlo-active',null);
    if(next)cache.invalidate();else cache.clear();
    state.profiles=[];state.weather={};state.active=next?.profiles.some(p=>p.id===active)?active:null;appliedValue='';
    if(!next){persist();save('svitlo-weather',{});}document.querySelector('dialog[open]')?.close();
  }
  if(!owner)state.tab='home';lifecycle.phase=owner?'loading':'empty';return true;
}
function applySync(value){
  if(!value||value.owner!==lifecycle.owner)return false;
  const signature=JSON.stringify([value.owner,value.profiles,value.weather,value.vapid,value.pushReady]);
  const changed=signature!==appliedValue;
  if(changed){state.owner=value.owner;state.profiles=value.profiles;state.weather=value.weather||{};state.vapid=value.vapid||'';state.pushReady=!!value.pushReady;appliedValue=signature;}
  if(!state.profiles.some(p=>p.id===state.active))state.active=state.profiles[0]?.id||null;
  if(routePending){
    if(route.profile&&state.profiles.some(p=>p.id===route.profile))state.active=route.profile;
    else if(route.profile)toast('Адреса з посилання недоступна. Показуємо збережену адресу.');
    routePending=false;
  }
  lifecycle.phase=state.profiles.length?'ready':'empty';persist();return changed;
}
function patchProfiles(update,extra={}){
  const owner=lifecycle.owner;if(!owner)return;
  const value=cache.patch(owner,old=>{
    const profiles=update(old.profiles.length?old.profiles:state.profiles),keys=new Set(profiles.map(p=>cityKey(p.address)));
    const weather=Object.fromEntries(Object.entries({...state.weather,...old.weather}).filter(([key])=>keys.has(key)));
    return {...old,profiles,weather,active:state.active,...extra};
  });
  applySync(value);return value;
}
async function currentOwner(create=false){
  const owner=await (create?ensureIdentity():identity());adoptOwner(owner);return owner?lifecycle.capture():null;
}
async function ownedRequest(action,data,scope,options={}){
  if(!lifecycle.current(scope,options.intent))return null;
  const stamp=cache.stamp();
  try{const result=await request(action,data,{...options,owner:scope.owner});
    return lifecycle.current(scope,options.intent)&&cache.current(stamp)?result:null;
  }catch(error){if(!lifecycle.current(scope,options.intent)||!cache.current(stamp))return null;throw error;}
}
async function subscriptionData(){
  const scope=lifecycle.capture();
  let sub=await bounded(registration.pushManager.getSubscription(),3000);
  if(read('svitlo-push-disabled',false)||globalThis.Notification?.permission!=='granted')sub=null;
  if(!lifecycle.current(scope))return null;
  if(sub?.options?.applicationServerKey&&state.vapid&&globalThis.Notification?.permission==='granted'&&scope.owner){
    const expected=state.vapid.replace(/-/g,'+').replace(/_/g,'/');
    const bytes=Uint8Array.from(atob(expected+'='.repeat((4-expected.length%4)%4)),c=>c.charCodeAt(0)),current=new Uint8Array(sub.options.applicationServerKey);
    if(current.length!==bytes.length||current.some((n,i)=>n!==bytes[i])){
      await bounded(sub.unsubscribe(),3000);if(!lifecycle.current(scope))return null;
      sub=await bounded(registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes}),5000);
    }
  }
  if(!lifecycle.current(scope))return null;
  state.push=!!sub;state.subscription=sub?.toJSON()||null;return state.subscription;
}
async function checkPush(force=false){
  if(pushCheck)return pushCheck;
  if(!registration){if(!('serviceWorker' in navigator)||!('PushManager' in window)){state.pushChecked=true;state.push=false;state.pushError='Push у цьому браузері недоступний';render();}return;}
  if(!force&&Date.now()<pushRetryAt)return;
  const scope=lifecycle.capture();
  const job=(async()=>{try{
    const subscription=await subscriptionData();if(!lifecycle.current(scope))return;
    state.pushError='';state.pushChecked=true;pushRetryAt=0;render();
    if(subscription&&profile()&&lifecycle.phase==='ready')await refresh('auto');
  }catch{if(lifecycle.current(scope)){state.pushChecked=true;state.push=false;state.subscription=null;state.pushError='Не вдалося перевірити стан сповіщень. Спробуйте пізніше.';pushRetryAt=Date.now()+30000;render();}}
  })();pushCheck=job;try{await job;}finally{if(pushCheck===job)pushCheck=null;}
}
async function refresh(reason='manual'){
  if(!configured())return;
  let token=++refreshToken,scope=lifecycle.capture(),id;
  try{
    const owner=await identity();if(token!==refreshToken)return;
    if(!owner){adoptOwner(null);lifecycle.phase='empty';render();return;}
    adoptOwner(owner);scope=lifecycle.capture();
    // adoptOwner may advance the refresh token on the first authenticated load.
    token=refreshToken;id=profile()?.id||state.active;
    const cached=cache.read(owner),needed=await cache.needed(cached,id,reason,state.subscription||null);
    if(!lifecycle.current(scope,true)||token!==refreshToken)return;
    if(!needed){applySync(cached);state.error='';render();return;}
    state.busy=true;state.error='';render();
    const value=await cache.sync({id,reason,subscription:state.subscription||null});
    if(!lifecycle.current(scope,true)||token!==refreshToken)return;
    if(value){applySync(value);state.error=value.errors?.profile||refreshFailure(profile()?.snapshot)||'';}
  }catch(error){
    if(!lifecycle.current(scope,true)||token!==refreshToken||error.stale)return;
    if(error.status===404&&id){
      if(profile())patchProfiles(profiles=>profiles.filter(p=>p.id!==id));
      state.active=profile()?.id||null;state.busy=false;render();return refresh('auto');
    }
    state.error=error.message;if(!profile())lifecycle.phase='error';
  }finally{if(lifecycle.current(scope,true)&&token===refreshToken){state.busy=false;render();}}
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
  let generation=0,address,scope,previewController;
  d.addEventListener('close',()=>{generation++;previewController?.abort();},{once:true});
  try{scope=await currentOwner(true);if(!scope||!d.open)return;}catch(e){d.querySelector('#form-error').textContent=e.message;return;}
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
      if(!lifecycle.current(scope)||!d.open)return;
      previewController?.abort();previewController=new AbortController();
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
          if (gen === generation&&lifecycle.current(scope)&&d.open) select(keys[i + 1], r.items);
        } else {
          d.querySelector("#preview").textContent = "Перевіряємо адресу…";
          address = {
            department: d.querySelector("#department").value,
            cityId: d.querySelector("#city").value,
            streetId: d.querySelector("#street").value,
            house: d.querySelector("#house").value,
          };
          const r = await ownedRequest("preview", { address },scope,{signal:previewController.signal});
          if (!r||gen !== generation||!lifecycle.current(scope)||!d.open) return;
          d.querySelector("#preview").innerHTML =
            `<p style="margin-top:20px">${esc(r.address.label)}</p><p class="muted">${r.queue ? "Черга " + esc(r.queue) : "Черга поки не визначена"}${!r.verified ? " · частина даних тимчасово недоступна" : ""}</p><label for="address-name">Назва (необов’язково)</label><input id="address-name" maxlength="60" placeholder="Мій дім"><div class="row"><button type="submit" class="primary">Так, це моя адреса</button></div>`;
        }
      } catch (e) {
        if (gen === generation&&lifecycle.current(scope)&&d.open&&e.name!=='AbortError') {
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
                if(gen!==generation||!lifecycle.current(scope)||!d.open)return;
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
      cache.invalidate();
      const r = await ownedRequest("save", {
        address,
        name: d.querySelector("#address-name").value,
        confirmed: true,
      },scope);
      if(!r||!lifecycle.current(scope))return;
      if(!validProfile(r.profile,scope.owner))throw Error('Отримано неповні дані адреси. Спробуйте ще раз.');
      patchProfiles(profiles=>[...profiles.filter(p=>p.id!==r.profile.id),r.profile]);
      state.active = r.profile.id;
      state.date = dayKey();
      state.week = monday();
      state.explicit=false;
      persist();
      d.close();
      render();
      await syncPush();
    } catch (e) {
      if(!lifecycle.current(scope)||!d.open)return;
      d.querySelector("#form-error").textContent = e.message;
      button.disabled = false;
      button.textContent = "Так, це моя адреса";
    }
  };
  try {
    const r=await dictionary({kind:'department'});
    if(lifecycle.current(scope)&&d.open)select('department',r.items);
  } catch (e) {
    if(lifecycle.current(scope)&&d.open)d.querySelector("#form-error").textContent = e.message;
  }
}
function manageDialog() {
  const scope=lifecycle.capture();
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
          cache.invalidate();
          const r=await ownedRequest("delete", { id: el.dataset.delete },scope);
          if(!r||!lifecycle.current(scope))return;
          patchProfiles(profiles=>profiles.filter(p=>p.id!==el.dataset.delete));
          state.active = profile()?.id || null;
          persist();
          save("svitlo-weather", state.weather);
          d.close();
          render();
          await syncPush();
        } catch (e) {
          if(!lifecycle.current(scope)||!d.open)return;
          el.disabled = false;
          toast(e.message);
        }
      }),
  );
}
function eraseDialog() {
  const scope=lifecycle.capture();
  const d = dialog(
    "Видалити ваші дані?",
    `<p class="install-note">Буде видалено всі ваші адреси, графіки та push-підписки на сервері й на цьому пристрої.</p><div class="row"><button id="confirm-erase" class="danger">Видалити все</button></div>`,
  );
  d.querySelector("#confirm-erase").onclick = async () => {
    try {
      const r=await ownedRequest("erase",{},scope);
      if(!r||!lifecycle.current(scope))return;
      lifecycle.invalidate();
      cache.clear();
      lifecycle.setOwner(null);lifecycle.phase='empty';
      void forgetSession();
      state.owner=null;
      state.profiles = [];
      state.weather = {};
      state.active = null;
      state.tab='home';
      state.push = false;
      state.subscription=null;appliedValue='';refreshToken++;state.busy=false;state.error='';
      persist();
      save("svitlo-weather", {});
      d.close();
      render();
      const cleared=lifecycle.capture();
      try{const sub=await bounded(registration?.pushManager.getSubscription(),2000);if(lifecycle.current(cleared))await bounded(sub?.unsubscribe(),2000);}catch{/* Server ACK already erased data. */}
    } catch (e) {
      if(lifecycle.current(scope))toast(e.message);
    }
  };
}
async function syncPush() {return refresh('auto');}
async function togglePush() {
  if(state.pushBusy)return;
  const scope=lifecycle.capture(),id=profile()?.id;let created;
  state.pushBusy=true;state.pushError='';render();
  try {
    if(!('Notification' in window)||!('PushManager' in window)||!registration)throw Error('Додайте «Світло» на Початковий екран і відкрийте його звідти. Цей браузер не підтримує push.');
    if(!state.pushReady||!scope.owner||!profile())throw Error('Сервер сповіщень ще не підключений');
    const old=await bounded(registration.pushManager.getSubscription(),3000);
    if(!lifecycle.current(scope))return;
    if(state.push&&old){
      const result=await ownedRequest('unsubscribe',{endpoint:old.endpoint},scope);
      if(!result)return;
      save('svitlo-push-disabled',true);state.push=false;state.subscription=null;state.pushChecked=true;
      patchProfiles(p=>p,{subscription:null,subscriptionAt:0});render();
      try{await bounded(old.unsubscribe(),3000);}catch{/* Server has already disabled delivery. */}
      return;
    }
    const permission=await Notification.requestPermission();
    if(!lifecycle.current(scope))return;
    if(permission!=='granted')throw Error('Дозвіл не надано. Його можна змінити в налаштуваннях браузера або системи.');
    const b64=state.vapid.replace(/-/g,'+').replace(/_/g,'/'),key=Uint8Array.from(atob(b64+'='.repeat((4-b64.length%4)%4)),c=>c.charCodeAt(0));
    const sub=old||await bounded(registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key}),8000);
    if(!old)created=sub;
    if(!lifecycle.current(scope))return;
    const result=await ownedRequest('subscribe',{subscription:sub.toJSON(),id},scope,{intent:true});
    if(!result)return;
    save('svitlo-push-disabled',false);state.push=true;state.subscription=sub.toJSON();state.pushChecked=true;
    patchProfiles(p=>p,{subscription:JSON.stringify([id,state.subscription,state.vapid]),subscriptionAt:Date.now()});render();
    toast('Сповіщення увімкнено для обраної адреси');
  }catch(e){
    if(created)void bounded(created.unsubscribe(),2000).catch(()=>{});
    if(lifecycle.current(scope)){state.pushError=e.message;state.pushChecked=true;toast(e.message);}
  }finally{if(lifecycle.current(scope)){state.pushBusy=false;render();}}
}
let workerPending=null,workerRetryAt=0;
async function registerWorker(){
  if(workerPending||registration||Date.now()<workerRetryAt)return;
  if(!('serviceWorker' in navigator)){void checkPush();return;}
  const job=(async()=>{try{
    registration=await bounded(navigator.serviceWorker.register('./sw.js',{scope:'./',updateViaCache:'none'}),8000);
    registration.addEventListener('updatefound',()=>{
      const worker=registration.installing;
      worker?.addEventListener('statechange',()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller)toast('Нова версія готова. Закрийте всі вікна «Світло» та відкрийте знову.');});
    });
    void checkPush(true);
  }catch{workerRetryAt=Date.now()+30000;state.pushChecked=true;state.pushError='Не вдалося підключити сповіщення. Спробуйте пізніше.';render();}
  })();workerPending=job;try{await job;}finally{workerPending=null;}
}
let starting=null;
async function startup(){
  void registerWorker();
  if(starting)return starting;
  const job=(async()=>{
    if(!profile())lifecycle.phase='loading';state.error='';render();
    try{
      if(!configured()){lifecycle.phase='empty';render();return;}
      const owner=await identity();adoptOwner(owner);
      if(!owner){cache.clear();state.profiles=[];state.weather={};state.active=null;appliedValue='';persist();save('svitlo-weather',{});lifecycle.phase='empty';render();return;}
      const scope=lifecycle.capture();
      if(!cache.read(owner)){
        const legacy=legacyEnvelope(owner,read('svitlo-profiles',[]),read('svitlo-weather',{}));if(legacy)cache.write(legacy);
      }
      if(!lifecycle.current(scope))return;
      applySync(cache.read(owner));render();
      await refresh('auto');void checkPush();
    }catch(e){state.error=e.message;if(!profile())lifecycle.phase='error';render();}
  })();starting=job;try{await job;}finally{if(starting===job)starting=null;}
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
  void startup();void checkPush(true);
});
window.addEventListener("offline", render);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    rollover();
    void startup();void registerWorker();void checkPush(true);
  }
});
function rollover() {
  const today = dayKey();
  if (calendarDay !== today) {
    lifecycle.select();calendarDay = today;
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
onIdentityChange(({owner,changed})=>{
  if(changed){adoptOwner(owner);render();if(owner&&!starting)void startup();}
});
appStorage.subscribe(()=>render());
window.addEventListener('storage',async e=>{
  if(!e.key)return;
  appStorage.external(e.key);cache.external(e.key);
  if(e.key==='svitlo-auth'){void startup();return;}
  if(e.key===SYNC_KEY||e.key==='svitlo-cache-epoch'){
    const scope=lifecycle.capture();
    try{const owner=await identity();if(!lifecycle.current(scope))return;if(owner!==scope.owner){adoptOwner(owner);void startup();return;}
      if(owner){applySync(cache.read(owner));render();if(!e.newValue&&!document.hidden)void refresh('auto');}
    }catch{/* A temporary Auth failure cannot clear displayed data. */}
  }
});
navigator.serviceWorker?.addEventListener('message',e=>{if(e.data?.type==='svitlo-invalidated'&&!document.hidden)refresh('push');});
const dictionaryCache=new DictionaryCache(request);
const dictionary=(body,force=false)=>dictionaryCache.load(body,force);
startup();
