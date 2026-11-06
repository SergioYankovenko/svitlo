"use strict";
// UI254 presentation; live server search and canonical enrollment. No catalogue fixtures.
window.SvitloOnboarding = {
  create(ctx) {
    let flow = null,
      sequence = 0;
    const timers = new Set();
    let abortRequest=null;
    const renderContext = ctx.render;
    ctx = {
      ...ctx,
      render: (...args) => {
        remember();
        return renderContext(...args);
      },
    };
    function remember() {
      if (!flow) return;
      state().onboardingDraft = {
        initial: flow.initial,
        resume: flow.resume,
        phase: flow.phase,
        source: state().catalogSource,
        city: flow.city?.id || null,
        street: flow.street?.id || null,
        house: flow.house?.id || null,
        queries: { ...flow.queries },
        selected: Object.fromEntries(['city','street','house'].map(kind=>[kind,flow[kind]||null])),
        geography: flow.geography || null,
        lineId: flow.lineId || null,
        name: flow.name,
        remind: flow.remind,
        permission: flow.permission,
        range: flow.range,
        started: !!flow.started,
        revisiting: flow.revisiting || null,
        reviewed: !!flow.reviewed,
        inlineReview: !!flow.inlineReview,
        additionalEditing: !!flow.additionalEditing,
        editing: flow.editing || null,
        editBackup: flow.editBackup ? {
          city: flow.editBackup.city?.id, street: flow.editBackup.street?.id,
          house: flow.editBackup.house?.id, queries: flow.editBackup.queries,
          selected: Object.fromEntries(['city','street','house'].map(kind=>[kind,flow.editBackup[kind]||null])),
        } : null,
        failure:
          flow.request?.phase === "error"
            ? { kind: flow.request.kind, reason: flow.request.reason }
            : null,
      };
      ctx.save();
    }
    function restore() {
      const draft = state().onboardingDraft;
      if (
        !draft ||
        draft.source !== state().catalogSource ||
        !["address", "preferences"].includes(draft.phase) ||
        (!draft.initial && !draft.resume && !state().addresses.length && !state().liveOwner)
      ) {
        delete state().onboardingDraft;
        return false;
      }
      flow = {
        phase: draft.phase,
        initial: !!draft.initial,
        resume: !!draft.resume,
        city: null,
        street: null,
        house: null,
        queries: { city: "", street: "", house: "", ...draft.queries },
        results: {},
        name: String(draft.name || "").slice(0, 32),
        remind: draft.remind === true,
        permission:
          draft.permission === null ? null : draft.permission === true,
        range: !!draft.range,
        started: !!draft.started,
        revisiting: draft.revisiting || null,
        reviewed: !!draft.reviewed,
        inlineReview: !!draft.inlineReview,
        additionalEditing: !draft.initial && !!draft.additionalEditing,
        editing: ["city", "street", "house"].includes(draft.editing) ? draft.editing : null,
      };
      if(draft.geography){flow.geography=window.SvitloGeography?.restore(draft.geography);if(!flow.geography){flow=null;delete state().onboardingDraft;return false;}}
      if(/^[a-f0-9-]{36}$/i.test(draft.lineId||''))flow.lineId=draft.lineId;
      for (const kind of ["city", "street", "house"]) {
        if (!draft[kind]) continue;
        const record=draft.selected?.[kind];
        flow[kind] = record&&record.id===draft[kind]&&/^[a-f0-9-]{36}$/i.test(record.id)&&typeof record.name==='string'&&record.name.length<=500?record:null;
        if (!flow[kind]) {
          flow = null;
          delete state().onboardingDraft;
          return false;
        }
      }
      if (draft.editBackup) {
        const current = {city:flow.city,street:flow.street,house:flow.house};
        const backup = {queries:{...draft.editBackup.queries}};
        for (const kind of ["city","street","house"]) {
          const record=draft.editBackup.selected?.[kind] || draft.selected?.[kind];
          flow[kind] = record&&record.id===draft.editBackup[kind]&&/^[a-f0-9-]{36}$/i.test(record.id)&&typeof record.name==='string'&&record.name.length<=500?record:null;
          backup[kind] = flow[kind];
        }
        Object.assign(flow,current);
        if (backup.city && backup.street && backup.house) flow.editBackup = backup;
      }
      if (flow.house) flow.inlineReview = flow.initial || flow.additionalEditing;
      if (flow.initial && flow.house && !draft.reviewed) flow.phase = "address";
      if (flow.phase === "preferences" && !flow.resume && !flow.house) {
        flow = null;
        delete state().onboardingDraft;
        return false;
      }
      const failure = draft.failure;
      const stage = flow.house
        ? "submit"
        : flow.street
          ? "house"
          : flow.city
            ? "street"
            : "city";
      if (
        flow.phase === "address" &&
        failure?.kind === stage &&
        ["temporary", "timeout", "offline"].includes(failure.reason) && eligibleQuery(stage,flow.queries[stage])
      ) {
        flow.request = { kind: stage, phase: "error", reason: failure.reason };
      }
      if(flow.phase==='address'&&!flow.house)queueMicrotask(()=>geography?.active()?geography.start():beginRequest(stage));
      return true;
    }
    const after = (delay, callback) => {
      const id = setTimeout(() => {
        timers.delete(id);
        callback();
      }, delay);
      timers.add(id);
    };
    function cancelRequest() {
      sequence++; abortRequest?.abort(); abortRequest=null;
      timers.forEach(clearTimeout);
      timers.clear();
      if (flow) flow.request = null;
    }
    const pending = () =>
      flow?.request &&
      ["pending", "searching", "slow"].includes(flow.request.phase);
    const e = ctx.esc;
    const say = (id) =>
      window.SvitloPolicy.text(
        id,
        state(),
        document.getElementById("app").clientWidth,
      );
    const state = () => ctx.getState();
    const normalize = (value) =>
      String(value)
        .normalize("NFKC")
        .toLocaleLowerCase("uk")
        .replace(/[’ʼ'`"ˈ]/g, "")
        .replace(/[—–-]/g, " ")
        .replace(/^(?:с\.?|м\.?|вул\.?|улица|вулиця)\s+/, "")
        .replace(/\s+/g, " ")
        .trim();
    const eligibleQuery=(kind,query)=>kind==='submit'||kind==='city'&&normalize(query||'').length>=2||kind==='street'&&!!flow?.city||kind==='house'&&!!flow?.street;
    const geography=window.SvitloGeography?.create({get:()=>flow,render:ctx.render,remember,
      heading:()=>mascotGreeting(),
      onCity:record=>{cancelRequest();flow.city=record;flow.street=null;flow.house=null;flow.queries={city:'',street:'',house:''};flow.editing=flow.inlineReview?'street':null;delete flow.editBackup;flow.started=true;ctx.render(false);beginRequest('street');}});
    const latin = {
      а: "a",
      б: "b",
      в: "v",
      г: "h",
      ґ: "g",
      д: "d",
      е: "e",
      є: "ye",
      ж: "zh",
      з: "z",
      и: "y",
      і: "i",
      ї: "yi",
      й: "y",
      к: "k",
      л: "l",
      м: "m",
      н: "n",
      о: "o",
      п: "p",
      р: "r",
      с: "s",
      т: "t",
      у: "u",
      ф: "f",
      х: "kh",
      ц: "ts",
      ч: "ch",
      ш: "sh",
      щ: "shch",
      ь: "",
      ю: "yu",
      я: "ya",
    };
    const transliterate = (value) =>
      [...normalize(value)].map((c) => latin[c] ?? c).join("");
    const english = "qwertyuiop[]asdfghjkl;'zxcvbnm,.";
    const ukrainian = "йцукенгшщзхїфівапролджєячсмитьбю";
    const keyboard = (value) =>
      [...value.toLowerCase()]
        .map((c) => (english.includes(c) ? ukrainian[english.indexOf(c)] : c))
        .join("");
    function distance(a, b) {
      const rows = Array.from({ length: a.length + 1 }, () =>
        Array(b.length + 1).fill(0),
      );
      for (let i = 0; i <= a.length; i++) rows[i][0] = i;
      for (let j = 0; j <= b.length; j++) rows[0][j] = j;
      for (let i = 1; i <= a.length; i++)
        for (let j = 1; j <= b.length; j++) {
          rows[i][j] = Math.min(
            rows[i - 1][j] + 1,
            rows[i][j - 1] + 1,
            rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
          );
          if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
            rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
        }
      return rows[a.length][b.length];
    }
    const usingSnapshot=()=>true;
    const records=kind=>flow?.results?.[kind] || [];
    const matches=(kind,query)=>records(kind);
    const fieldLabel = (kind) =>
      ({ city: "Населений пункт", street: "Вулиця", house: "Будинок" })[kind];
    function emptyResultKind() {
      if (
        !flow ||
        flow.phase !== "address" ||
        flow.house ||
        state().scenario === "offline" ||
        (flow.request && flow.request.phase !== "ready")
      )
        return null;
      const kind = flow.street ? "house" : flow.city ? "street" : "city";
      if (!eligibleQuery(kind,flow.queries[kind]))
        return null;
      return Array.isArray(flow.results[kind]) && !flow.results[kind].length
        ? kind
        : null;
    }
    function emptyHTML(kind) {
      const unavailable = false;
      const missing = {
        city: "населених пунктів.",
        street: "вулиць цього населеного пункту.",
        house: "будинків цієї вулиці.",
      };
      const title = unavailable
        ? "У цій копії довідника ще немає " + missing[kind]
        : kind === "house"
          ? "Нічого не знайшов. Перевір номер."
          : "Нічого не знайшов. Перевір назву.";
      return `<div class="lookup-state lookup-empty" data-lookup-phase="empty" data-lookup-request="${sequence}"><div class="lookup-inline-host"><div class="lookup-message" role="status" aria-live="polite"><span class="lookup-portrait" aria-hidden="true"><img class="lookup-mascot" src="assets/onboarding-guide-search-catalog-empty-notice.webp" alt="" width="72" height="72"></span><div class="lookup-mini-speech"><strong>${title}</strong></div></div></div></div>`;
    }
    function loadingTitle(title) {
      const words = title.replace(/[.…]+$/u, "").split(" ");
      const last = words.pop();
      return `${words.length ? e(words.join(" ")) + " " : ""}<span class="lookup-ending">${e(last)}<span class="lookup-dots" aria-hidden="true"><i></i><i></i><i></i></span></span>`;
    }
    function requestHTML(request) {
      if (request.phase === "pending" && request.kind !== "submit")
        return '<div class="lookup-pending" role="status">Шукаю…</div>';
      const failed = request.phase === "error",
        submit = request.kind === "submit";
      const title = failed
        ? request.reason === "timeout"
          ? "Не вдалося отримати відповідь."
          : request.reason === "offline"
            ? "Немає з’єднання."
            : "Не вдалося завантажити дані."
        : submit
          ? "Дай мені секундочку, зараз усе знайду."
          : request.phase === "slow"
            ? "Ще шукаю…"
            : "Шукаю…";
      return `<div class="lookup-state ${failed ? "lookup-error" : "lookup-searching"}" data-lookup-phase="${request.phase}" data-lookup-request="${sequence}"><div class="lookup-inline-host"><div class="lookup-message" role="status" aria-live="polite"><span class="lookup-portrait" aria-hidden="true"><img class="lookup-mascot" src="assets/onboarding-guide-${failed ? "retry" : "search-catalog-open"}.webp" alt="" width="72" height="72"></span><div class="lookup-mini-speech"><strong>${failed ? title : loadingTitle(title)}</strong></div></div></div>${failed && !submit ? `<button class="action lookup-retry" data-action="onboard-retry" data-kind="${request.kind}">Спробувати ще</button>` : ""}</div>`;
    }
    function paintRequest() {
      if (!flow || flow.phase !== "address" || !flow.request) return;
      const request = flow.request,
        kind = request?.kind;
      if (kind === "submit") {
        ctx.render(false);
        return;
      }
      const target = document.getElementById(
        kind === "submit" ? "onboard-submit-status" : "onboard-results-" + kind,
      );
      if (target) {
        const previousScroll=target.scrollTop;
        target.innerHTML =
          kind === "submit" ? requestHTML(request) : resultHTML(kind);
        target.setAttribute("aria-busy", String(!!pending()));
        if(request.more)target.scrollTop=previousScroll;
      }
      const greeting = document.querySelector(".onboard-greeting");
      if (greeting) greeting.outerHTML = mascotGreeting();
      const footer = document.querySelector(".onboard-address-footer");
      const markup = errorFooter();
      if (footer) footer.outerHTML = markup;
      else
        document
          .querySelector(".onboard-address-flow")
          ?.insertAdjacentHTML("afterend", markup);
      if(flow.additionalEditing){const primary=document.querySelector('.onboard-primary');if(primary)primary.disabled=!flow.house||pending();}
      window.SvitloLookupUI?.sync();
      window.SvitloMascot?.sync();
      window.SvitloViewport?.refresh(true);
    }
    function beginRequest(kind, retry = false, more = false) {
      const cursor=more?flow?.cursors?.[kind]:null;
      if(more&&!cursor)return;
      cancelRequest();
      if (!flow) return;
      const query = kind === "submit" ? "" : flow.queries[kind];
      if (!eligibleQuery(kind,query)) {
        flow.results[kind] = [];
        flow.request = { kind, phase: "ready" };
        paintRequest();
        flow.request = null;
        return;
      }
      if (kind !== "submit" && !more) flow.results[kind] = [];
      const request = (flow.request = { kind, query, phase: "pending", more }),
        seq = sequence;
      const current = () =>
        !!flow && flow.request === request && seq === sequence;
      const settle = (reason = null) => {
        if (!current()) return;
        timers.forEach(clearTimeout);
        timers.clear();
        if (reason) {
          request.phase = "error";
          request.reason = reason;
          paintRequest();
          return;
        }
        if (kind === "submit") {
          flow.request = null;
          flow.graphFound = ctx.hasPublishedGraph?.() === true;
          if (flow.initial && state().target !== "pwa") {
            flow.phase = "preferences";
            flow.reviewed = true;
            ctx.render(false);
          } else finish();
        } else {
          request.phase = "ready";
          paintRequest();
          flow.request = null;
        }
      };
      after(600,()=>{if(current()){request.phase="searching";paintRequest();}});
      after(5000,()=>{if(current()){request.phase="slow";paintRequest();}});
      abortRequest=new AbortController();
      const timeout=after(30000,()=>{ if(current()){abortRequest?.abort();settle("timeout");} });
      const task=kind==="submit"
        ? window.SvitloLive.enroll(flow,abortRequest.signal)
        : window.SvitloLive.search(kind,flow,query,abortRequest.signal,cursor);
      task.then(result=>{
        if(!current())return;
        if(kind==='submit'&&result.requiresLine){cancelRequest();flow.lineChoices=result.lines;flow.queueUnresolved=true;flow.lineId=null;ctx.render(false);return;}
        if(kind==="submit") flow.savedProfile=result;
        else {
          flow.results[kind]=more?[...new Map([...flow.results[kind],...result].map(r=>[r.id,r])).values()]:result;
          flow.cursors ||= {};flow.cursors[kind]=result.nextCursor||null;
        }
        settle();
      }).catch(error=>{if(current())settle(navigator.onLine===false?"offline":error.name==="AbortError"?"timeout":"temporary");});
    }
    function selectedAddress(confirmed = false) {
      const district = window.SvitloDeviceUI.verifiedDistrict(flow.street);
      const districtSuffix = confirmed && district ? " · " + district : "";
      const detail = flow.street
        ? flow.street.name + (flow.house ? ", " + flow.house.name : "")
        : "";
      const full = flow.city.name + (detail ? ", " + detail : "") + districtSuffix;
      // Keep the house with the preceding street word; emergency wrapping remains available.
      const display = flow.house
        ? `${flow.city.name}, ${flow.street.name},\u00a0${flow.house.name}${districtSuffix}`
        : full;
      return `<div class="onboard-selected onboard-address-summary ${confirmed ? "onboard-confirmation-address" : ""}"><div><strong id="onboard-selected-address" title="${e(full)}">${e(display)}</strong><small>${e([flow.city.context,district].filter(Boolean).join(" · "))}</small></div>${flow.initial && flow.house ? "" : `<button class="onboard-clear" data-action="${flow.house ? "onboard-edit-address" : "onboard-clear"}" data-kind="city" aria-label="Змінити адресу">${flow.house ? ctx.icon("edit") : "×"}</button>`}</div>`;
    }
    function resultHTML(kind) {
      if (!eligibleQuery(kind,flow.queries[kind]))
        return kind==='city'?'<div class="onboard-search-hint">Введіть щонайменше 2 літери</div>':"";
      const request = flow.request;
      if (request && request.kind === kind && request.phase !== "ready" && !request.more)
        return requestHTML(request);
      if (state().scenario === "offline") {
        flow.results[kind] = [];
        return requestHTML({ kind, phase: "error", reason: "offline" });
      }
      const query = flow.queries[kind];
      if (kind === "city" && normalize(query).length < 2)
        return '<div class="onboard-search-hint">Введіть щонайменше 2 літери</div>';
      const list = matches(kind, query);
      flow.results[kind] = list;
      if (!list.length) return emptyHTML(kind);
      const markup = list.map(record => {
        const district = kind === "street" ? window.SvitloDeviceUI.verifiedDistrict(record) : "";
        const label = record.name + (district ? " · " + district : "");
        const context = kind === "city" ? record.context : record.previous ? "Колишня назва: " + record.previous : "";
        return `<button class="onboard-result" data-action="onboard-select" data-kind="${kind}" data-record="${e(record.id)}" aria-label="${e(label + (context ? ", " + context : ""))}"><strong class="${district ? "street-district" : ""}">${e(label)}</strong>${context ? `<small>${e(context)}</small>` : ""}</button>`;
      }).join("");
      return markup+(request?.more&&request.phase!=='ready'?requestHTML(request):'');
    }
    function search(kind) {
      return `<div class="onboard-search-group">${kind === "city" ? "" : `<label class="onboard-label" for="onboard-${kind}">${fieldLabel(kind)}</label>`}<input id="onboard-${kind}" class="field" type="search" maxlength="${kind === "house" ? 32 : 160}" data-onboard-query="${kind}" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="${kind === "house" ? "done" : "next"}" aria-label="${fieldLabel(kind)}" aria-controls="onboard-results-${kind}"${flow.city && !flow.inlineReview ? ' aria-describedby="onboard-selected-address"' : ""} placeholder="${kind === "city" ? "Введіть місто або село" : kind === "street" ? "Назва вулиці" : "Номер будинку"}" value="${e(flow.queries[kind])}"><div class="onboard-results" id="onboard-results-${kind}" aria-label="Підказки: ${fieldLabel(kind)}" aria-busy="${!!pending()}">${resultHTML(kind)}</div></div>`;
    }
    function mascotGreeting(preferences = false) {
      const additional = !flow.initial && !flow.resume;
      const stage = preferences
        ? "preferences"
        : flow.house
          ? "ready"
          : flow.street
            ? "house"
            : flow.city
              ? "street"
              : "city";
      const revisiting = flow.revisiting === stage;
      const copy = {
        city: flow.started
          ? ["", "Як називається твоє місто чи село?"]
          : additional
            ? [say("additionalIntro"), say("additionalQuestion")]
            : [say("cityIntro"), say("cityQuestion")],
        street: [
          revisiting
            ? ""
            : additional
              ? "Супер, продовжимо!"
              : "Чудово, гарний початок!",
          additional ? "Яка тут вулиця?" : "Яка вулиця?",
        ],
        house: [
          revisiting
            ? ""
            : additional
              ? "Чудово, вулицю обрано!"
              : "Гарно виходить!",
          "Який номер будинку?",
        ],
        ready: flow.initial
          ? ["Чудово, адресу обрано!", "Перевір, чи все правильно."]
          : ["Клас! Ще одну адресу обрано.", "Дамо їй назву?"],
        preferences: [
          flow.resume
            ? "Продовжимо налаштування."
            : flow.graphFound
              ? "Графік знайшов!"
              : "Адресу обрано.",
          flow.resume
            ? "Обери нагадування й вигляд часу."
            : "Давай налаштуємо «Світло» під тебе.",
        ],
      };
      const request =
        !preferences &&
        (flow.request ||
          (state().scenario === "offline" ? { phase: "error" } : null));
      const editingAdditional = !flow.initial && flow.additionalEditing;
      const empty = !preferences && !!emptyResultKind();
      const waiting = !editingAdditional && (
        empty ||
        (request &&
          (["searching", "slow", "error"].includes(request.phase) ||
            request.kind === "submit")));
      const extendedReview = !preferences && !waiting && flow.initial && (flow.house || flow.inlineReview);
      const picture = editingAdditional ? "house" : extendedReview ? "ready-extended-v1" : empty
        ? "search-catalog-empty-notice"
        : waiting
          ? request.phase === "error"
            ? "retry"
            : "search-catalog-open"
          : {
              city: "peeking-extended-v1",
              street: "street",
              house: "house",
              ready: "ready",
              preferences: "preferences-v2",
            }[stage];
      const [intro, question] = copy[stage];
      const streetFullBody = picture === "street";
      const speech = editingAdditional ? '<p>Щось не те? Зараз виправимо.</p>' : waiting
        ? '<div class="lookup-speech-host"></div>'
        : flow.initial && flow.inlineReview && !preferences
          ? '<p class="mascot-intro">Перевір адресу й продовжимо.</p>'
        : stage === "city"
          ? `<p class="mascot-intro" id="onboard-city-intro">${intro}${intro ? " " : ""}<strong class="mascot-question">${question}</strong></p>`
          : `${intro ? `<p>${intro}</p>` : ""}${stage === "ready" ? '<div class="confirmed-speech-host"></div>' : ""}<h1>${question}</h1>`;
      return `<div class="onboard-greeting ${extendedReview ? "review-mascot-extended" : ""} ${picture === "peeking-extended-v1" || streetFullBody ? "welcome-mascot-extended" : ""} ${empty ? "mascot-no-results" : waiting && request.phase !== "error" ? "mascot-is-searching" : ""}"><div class="mascot-speech ${waiting ? "lookup-speech" : ""}">${speech}</div><img class="onboard-mascot" src="${request?.kind === "submit" && pending() ? window.SvitloMascot?.submitFallback || "assets/mascot-submit-fallback.webp" : "assets/onboarding-guide-" + (picture === "peeking-extended-v1" ? "peeking-legs-v2" : streetFullBody ? "street-legs-v1" : picture) + ".webp"}" width="${picture === "peeking-extended-v1" || streetFullBody ? 384 : 1254}" height="${picture === "peeking-extended-v1" || streetFullBody ? 480 : 1254}" alt="" aria-hidden="true" draggable="false" decoding="async"></div>`;
    }
    function diagnosticContext() {
      const kind =
        flow?.request?.kind ||
        emptyResultKind() ||
        (!flow?.city
          ? "city"
          : !flow.street
            ? "street"
            : !flow.house
              ? "house"
              : "submit");
      return {
        stage: kind,
        code:
          state().scenario === "offline" || flow?.request?.reason === "offline"
            ? "offline"
            : flow?.request?.reason === "timeout"
              ? "timeout"
              : flow?.request?.phase === "error"
                ? "temporary"
                : "empty",
      };
    }
    function errorFooter() {
      const failed =
        flow.request?.phase === "error" ||
        state().scenario === "offline" ||
        !!emptyResultKind();
      const back = !flow.initial && state().addresses.length > 0;
      return failed || back
        ? `<footer class="onboard-address-footer ${failed && back ? "error-actions" : ""}">${back ? `<button class="action onboard-cancel" data-action="onboard-cancel" aria-label="Повернутись до графіка">${failed ? "До графіка" : "Повернутись до графіка"}</button>` : ""}${failed ? '<button class="action report-problem" data-action="onboard-report" aria-label="Повідомити про помилку">Повідомити</button>' : ""}</footer>`
        : "";
    }
    function additionalFields() {
      return `<div class="onboard-additional-fields">${["city","street","house"].map(kind=>{
        const enabled=kind==='city'||(kind==='street'?!!flow.city:!!flow.street);
        const value=flow[kind]?.name||flow.queries[kind]||'';
        return `<div class="onboard-search-group"><label class="onboard-label" for="onboard-${kind}">${fieldLabel(kind)}</label><input id="onboard-${kind}" class="field" type="search" data-onboard-query="${kind}" data-onboard-additional="true" maxlength="${kind==='house'?32:160}" autocomplete="off" spellcheck="false" aria-label="${fieldLabel(kind)}" aria-controls="onboard-results-${kind}" placeholder="${kind==='city'?'Введіть місто або село':kind==='street'?'Назва вулиці':'Номер будинку'}" value="${e(value)}" ${enabled?'':'disabled'}><div class="onboard-results" id="onboard-results-${kind}">${flow.editing===kind?resultHTML(kind):''}</div></div>`;
      }).join('')}</div>`;
    }
    function addressScreen() {
      if(geography?.active())return geography.html();
      if(flow.queueUnresolved)return `<section class="onboard-address-flow" aria-label="Уточнення нової адреси">${selectedAddress(true)}<div class="card outlined onboard-card geo-line-options"><h1>${flow.lineChoices?.length>1?'Уточнимо адресу':'Адресу обрано'}</h1><p class="onboard-support">${flow.lineChoices?.length>1?'Для цього будинку є кілька ліній. Спробуй уточнити номер або корпус. Якщо це не допомагає, можна продовжити без черги.':'Твоєї черги поки немає в нашій базі. Можеш продовжити й стежити за світлом за допомогою датчика.'}</p><div class="onboard-unresolved-actions">${flow.lineChoices?.length>1?'<button class="action" data-action="onboard-clear" data-kind="house">Уточнити будинок</button>':''}<button class="action" data-action="onboard-without-queue">Продовжити без черги</button><button class="action" data-action="onboard-sensor-info">Що таке датчик?</button></div></div></section>`;
      const submitting=flow.request?.kind==='submit'&&pending(),review=!!flow.house,additional=!flow.initial;
      const inline=flow.initial&&(flow.inlineReview||review),editingAdditional=additional&&flow.additionalEditing;
      if(review)window.SvitloMascot?.warmSubmit();
      let fields='';
      if(!submitting){
        if(editingAdditional)fields=additionalFields();
        else if(inline)fields=`<div class="onboard-inline-review">${['city','street','house'].map(kind=>{
          const value=flow[kind]||(flow.editing===kind?flow.editBackup?.[kind]:null);
          const enabled=kind==='city'||(kind==='street'?!!flow.city:!!flow.street);
          return `<div class="onboard-review-row"><button class="review-row-toggle" data-action="onboard-edit-kind" data-kind="${kind}" aria-expanded="${flow.editing===kind}" ${enabled?'':'disabled'}><span><small>${fieldLabel(kind)}</small><strong>${e(value?.name||'Обери зі списку')}</strong></span><span class="review-row-icon" aria-hidden="true">${window.SvitloNativeUI.icon(flow.editing===kind?'chevron':'edit')}</span></button>${flow.editing===kind?search(kind):''}</div>`;
        }).join('')}</div>`;
        else fields=`<div class="onboard-fields">${review?`<div class="confirmed-inline-host">${selectedAddress(true)}</div>`:flow.city?selectedAddress():''}${review?'':!flow.city?search('city'):!flow.street?search('street'):search('house')}${review&&additional?`<input class="field onboard-name" id="onboard-name" data-onboard-name maxlength="32" enterkeyhint="done" aria-label="Назва адреси (необов’язково)" placeholder="Назва адреси (необов’язково)" value="${e(flow.name)}">`:''}</div>`;
      }
      const status=flow.request?.kind==='submit'?`<div id="onboard-submit-status" aria-busy="${!!pending()}">${requestHTML(flow.request)}</div>`:'';
      const enabled=review&&!pending()&&(editingAdditional||!flow.editing);
      const actions=(review||inline||editingAdditional)&&!submitting?`<div class="onboard-review-actions ${inline?'first-review-actions':''}"><button class="action onboard-primary" ${enabled?'':'disabled'} data-action="${flow.request?.kind==='submit'&&flow.request.phase==='error'?'onboard-retry':'onboard-continue'}" data-kind="submit">${flow.request?.kind==='submit'&&flow.request.phase==='error'?'Спробувати ще':inline||editingAdditional?'Продовжити':'Показати графік'}</button></div>`:'';
      const content=submitting?status:inline?`${fields}${status}${actions}`:`<div class="card outlined onboard-card">${fields}${status}${actions}</div>`;
      const place=flow.geography?.settlement,route=flow.geography?.route;
      const location=''; // Administrative/source routing stays in the background.
      return `<section class="onboard-address-flow ${submitting?'is-submitting fullbody-pending':''} ${inline?'first-address-review':''} ${editingAdditional?'additional-address-edit':''} ${additional&&review&&!editingAdditional?'additional-address-review':''}" aria-label="Налаштування адреси">${mascotGreeting()}${content}${location}</section>${errorFooter()}`;
    }

    function preferenceScreen() {
      const allow = flow.remind === true,
        deny = flow.remind === false;
      return `<section class="onboard-address-flow onboard-preferences-flow" aria-label="Початкові налаштування">${mascotGreeting(true)}<div class="card outlined onboard-card"><div class="onboard-settings-section"><h2>Нагадувати про відключення?</h2><div class="onboard-support">Перед відключенням і відновленням, про аварії та зміни графіка.</div><div class="onboard-reminder-choice"><button class="choice ${allow ? "selected" : ""}" data-action="onboard-remind" data-value="yes" aria-pressed="${allow}">Так, нагадувати</button><button class="choice ${deny ? "selected" : ""}" data-action="onboard-remind" data-value="no" aria-pressed="${deny}">Ні, поки що</button></div>${allow && flow.permission !== true ? `<div class="onboard-support permission-result" role="status">${flow.permission === false ? "Дозвіл не надано. Його можна увімкнути в опціях." : "Очікуємо вибір дозволу"}</div>` : ""}</div><hr class="divider"><div class="onboard-settings-section"><h2>Як показувати час?</h2><div class="onboard-time-choices" role="group" aria-label="Формат часу">${[false, true].map((range) => `<button class="choice ${flow.range === range ? "selected" : ""}" data-action="onboard-time" data-range="${range}" aria-pressed="${flow.range === range}" aria-label="${range ? "Інтервал часу" : "Лише початок години"}"><span class="hour-tile onboard-preview-tile" aria-hidden="true"><span class="hour-label">${ctx.power()}<span class="hour-times"><span>13:00</span>${range ? "<span>14:00</span>" : ""}</span></span></span><small>${range ? "Інтервал" : "Початок"}</small></button>`).join("")}</div></div><div class="onboard-finish"><button class="action onboard-primary" data-action="onboard-finish">Готово</button><button class="action onboard-skip" data-action="onboard-finish" data-skip="true">Пропустити</button></div></div></section>`;
    }
    function open(initial = true, resume = false) {
      window.SvitloMascot?.warmEntry();
      cancelRequest();
      ctx.closeDialog();
      ctx.activateHome();
      if (initial && !resume && state().privacyNotice === "unread") {
        const text = say(
          state().target === "pwa" ? "privacyPwa" : "privacyAndroid",
        );
        ctx.dialog(
          "Твої дані",
          `<div class="privacy-conversation"><div class="privacy-speech" data-copy-id="${state().target === "pwa" ? "privacyPwa" : "privacyAndroid"}" role="status">${e(text)}</div><img class="privacy-mascot" src="assets/privacy-shield-guide-v1.webp" width="384" height="576" alt=""></div>`,
          ctx.dialogButton("Розумію", "onboard-privacy-accept"),
          "",
          {
            footerClass: "centered",
            character: true,
            className: "privacy-dialog",
          },
        );
        return;
      }
      flow = {
        phase: resume ? "preferences" : "address",
        initial,
        resume,
        city: null,
        street: null,
        house: null,
        queries: { city: "", street: "", house: "" },
        results: {},
        name: "",
        remind: resume
          ? ["before", "restore", "emergency", "changes"].some(
              (key) => !!state().switches[key],
            )
          : false,
        permission: resume ? state().permission : null,
        range: state().range,
        started: false,
        revisiting: null,
      };
      if(!resume&&state().target==='pwa'&&geography&&window.SvitloLive?.geography){flow.geography=window.SvitloGeography.fresh();queueMicrotask(()=>geography.start());}
      ctx.render(false);
    }
    function close() {
      geography?.cancel();
      cancelRequest();
      flow = null;
      delete state().onboardingDraft;
      ctx.save();
    }
    function permissionPrompt() {
      ctx.dialog(
        "Дозволити сповіщення?",
        "<p>«Світло» нагадуватиме про відключення та повідомлятиме про зміни графіка.</p>",
        ctx.dialogButton("Дозволити", "onboard-permission-allow") +
          ctx.dialogButton("Не дозволяти", "onboard-permission-deny", "cancel"),
        "",
        { footerClass: "vertical permission-footer" },
      );
    }
    function finish(skipped = false) {
      if (!flow) return;
      const initial = flow.initial,
        before = state().addresses.length;
      const current = state();
      if (flow.savedProfile) { window.SvitloLive.adopt(current); current.active=flow.savedProfile.id; }
      if ((flow.initial || flow.resume) && current.target !== "pwa") {
        if (!skipped) {
          current.range = flow.range;
          if (!flow.resume) current.reminder = 30;
          const enabled = flow.remind === true;
          for (const key of ["before", "restore", "emergency", "changes"])
            current.switches[key] = enabled;
          current.permission =
            flow.permission === null
              ? current.permission === true
              : flow.permission === true;
        }
        if (window.SvitloExperience)
          window.SvitloExperience.finishPreferences(current, skipped);
        else {
          current.preferencesStatus = skipped ? "pending" : "completed";
          current.setupNudgePending = false;
        }
        current.onboardingSeen = true;
      }
      if (initial && current.target === "pwa") {
        current.preferencesStatus = "completed";
        current.onboardingSeen = true;
      }
      window.SvitloExperience.added(current, before);
      if (initial) ctx.onInitialFinished?.();
      ctx.save();
      close();
      ctx.render(false);
      ctx.syncLab();
    }
    function handleAction(action, element) {
      if(geography?.handleAction(action,element))return true;
      if (!action.startsWith("onboard-")) return false;
      switch (action) {
        case 'onboard-sensor-info':window.SvitloNextUI.redirect('sensor');break;
        case 'onboard-without-queue':if(flow?.queueUnresolved){flow.continueWithoutQueue=true;flow.queueUnresolved=false;flow.lineChoices=null;beginRequest('submit');ctx.render(false);}break;
        case 'onboard-line':
          if(flow?.lineChoices?.some(x=>x.id===element.dataset.line)){flow.lineId=element.dataset.line;flow.lineChoices=null;beginRequest('submit');ctx.render(false);}break;
        case "onboard-report":
          if (
            flow &&
            (flow.request?.phase === "error" ||
              state().scenario === "offline" ||
              emptyResultKind())
          )
            ctx.reportProblem(diagnosticContext());
          break;
        case "onboard-privacy-accept":
          state().privacyNotice = "accepted";
          ctx.save();
          ctx.closeDialog();
          open(true);
          break;
        case "onboard-edit-address":
          if (flow?.house) {
            flow.additionalEditing = !flow.initial;
            flow.inlineReview = flow.initial || flow.additionalEditing;
            flow.editing = null;
            for(const kind of ['city','street','house']) flow.queries[kind]=flow[kind]?.name||'';
            ctx.render(false);
          }
          break;
        case "onboard-edit-kind":
          if (flow) {
            const kind = element.dataset.kind;
            if (!["city","street","house"].includes(kind)) break;
            if(kind==='city'&&flow.geography){cancelRequest();flow.city=null;flow.street=null;flow.house=null;flow.lineId=null;flow.lineChoices=null;flow.queueUnresolved=false;flow.continueWithoutQueue=false;flow.geography=window.SvitloGeography.fresh();flow.inlineReview=false;flow.additionalEditing=false;flow.editing=null;delete flow.editBackup;geography.start();break;}
            if (flow.inlineReview && flow.editing === kind && flow.editBackup) {
              Object.assign(flow, flow.editBackup);
              delete flow.editBackup;
              flow.editing = null;
              cancelRequest(); ctx.render(false); break;
            }
            if ((kind === "street" && !flow.city) || (kind === "house" && !flow.street)) break;
            flow.editBackup = {
              city: flow.city,
              street: flow.street,
              house: flow.house,
              queries: { ...flow.queries },
            };
            const fields = ["city", "street", "house"];
            flow.queries[kind] = flow[kind]?.name || "";
            for (const key of fields.slice(fields.indexOf(kind)))
              flow[key] = null;
            flow.reviewed = false;
            flow.inlineReview = true; flow.editing = kind;
            flow.revisiting = kind;
            cancelRequest();
            ctx.closeDialog();
            beginRequest(kind);
            ctx.render();
            document
              .getElementById("onboard-" + kind)
              ?.focus({ preventScroll: true });
          }
          break;
        case "onboard-select": {
          if (!flow || flow.phase !== "address") break;
          const kind = element.dataset.kind;
          if (
            (pending() && !flow.request?.more) ||
            (flow.request?.phase === "error" && !flow.request.more) ||
            state().scenario === "offline"
          )
            break;
          const record = (flow.results[kind] || []).find(
            (x) => x.id === element.dataset.record,
          );
          if (!record) break;
          if (!flow.additionalEditing && flow.editBackup && flow.editBackup[kind]?.id === record.id) {
            Object.assign(flow, flow.editBackup);
            delete flow.editBackup;
            flow.editing = null;
            cancelRequest();
            ctx.render(false);
            break;
          }
          const fields = ["city", "street", "house"];
          flow[kind] = record;
          flow.lineId=null;flow.lineChoices=null;flow.queueUnresolved=false;flow.continueWithoutQueue=false;
          flow.queries[kind] = "";
          flow.started = true;
          flow.revisiting = null;
          for (const child of fields.slice(fields.indexOf(kind) + 1)) {
            flow[child] = null;
            flow.queries[child] = "";
            flow.results[child] = [];
          }
          cancelRequest();
          if (kind === "house") {
            document.activeElement?.blur();
            delete flow.editBackup;
            flow.inlineReview = flow.initial || flow.additionalEditing;
            flow.editing = null;
            ctx.render(false);
            break;
          }
          const next = fields[fields.indexOf(kind) + 1];
          if (flow.inlineReview) flow.editing = next;
          if (next) beginRequest(next);
          ctx.render(kind !== "house");
          document
            .getElementById("onboard-" + fields[fields.indexOf(kind) + 1])
            ?.focus({ preventScroll: true });
          break;
        }
        case "onboard-clear": {
          if (!flow) break;
          const fields = ["city", "street", "house"],
            kind = element.dataset.kind;
          flow.started = true;
          flow.revisiting = kind;
          for (const key of fields.slice(fields.indexOf(kind))) {
            flow[key] = null;
            flow.queries[key] = "";
            flow.results[key] = [];
          }
          cancelRequest();
          flow.lineId=null;flow.lineChoices=null;flow.queueUnresolved=false;flow.continueWithoutQueue=false;
          if(kind==='city'&&flow.geography){flow.geography=window.SvitloGeography.fresh();flow.inlineReview=false;flow.additionalEditing=false;flow.editing=null;geography.start();break;}
          ctx.render();
          document
            .getElementById("onboard-" + kind)
            ?.focus({ preventScroll: true });
          break;
        }
        case "onboard-continue":
          if (flow?.additionalEditing && flow.house && !pending()) {
            flow.additionalEditing=false; flow.inlineReview=false; flow.editing=null;
            delete flow.editBackup; cancelRequest(); ctx.render(false); document.querySelector('[data-action="onboard-edit-address"]')?.focus({preventScroll:true}); break;
          }
          if (flow?.house && !flow.editing && !pending()) {
            document.activeElement?.blur();
            flow.reviewed = true;
            beginRequest("submit");
            ctx.render();
          }
          break;
        case "onboard-retry":
          if (
            flow?.request?.phase === "error" &&
            flow.request.kind === element.dataset.kind
          ) {
            beginRequest(element.dataset.kind, true, !!flow.request.more);
            ctx.render();
            if (element.dataset.kind !== "submit")
              document
                .getElementById("onboard-" + element.dataset.kind)
                ?.focus({ preventScroll: true });
          }
          break;
        case "onboard-cancel":
          state().onboardingSeen = true;
          close();
          ctx.render(false);
          break;
        case "onboard-remind":
          if (flow) {
            flow.remind = element.dataset.value === "yes";
            if (flow.remind && state().permission) flow.permission = true;
            ctx.render();
            if (flow.remind && flow.permission !== true) permissionPrompt();
          }
          break;
        case "onboard-permission-allow":
          if (flow) {
            flow.permission = true;
            ctx.closeDialog();
            ctx.render();
          }
          break;
        case "onboard-permission-deny":
          if (flow) {
            flow.permission = false;
            ctx.closeDialog();
            ctx.render();
          }
          break;
        case "onboard-time":
          if (flow) {
            flow.range = element.dataset.range === "true";
            ctx.render();
          }
          break;
        case "onboard-finish":
          finish(element.dataset.skip === "true");
          break;
      }
      return true;
    }
    function handleInput(event) {
      if (!flow) return;
      if(geography?.handleInput(event))return;
      if (event.target.hasAttribute("data-onboard-name")) {
        flow.name = event.target.value;
        remember();
        return;
      }
      const kind = event.target.dataset.onboardQuery;
      if (!kind) return;
      flow.queries[kind] = event.target.value;
      if (flow.additionalEditing) {
        flow.editing=kind;
        const fields=['city','street','house'];
        for(const key of fields.slice(fields.indexOf(kind))){
          flow[key]=null;
          if(key!==kind){flow.queries[key]='';flow.results[key]=[];const node=document.getElementById('onboard-'+key);if(node){node.value='';node.disabled=true;}}
        }
      }
      if (normalize(event.target.value).length >= 2) flow.started = true;
      remember();
      cancelRequest();
      const seq = sequence;
      // Invalidate old row ownership immediately, before the simulated debounce finishes.
      flow.results[kind] = [];
      if(flow.cursors)delete flow.cursors[kind];
      // The city minimum already belongs to beginRequest; don't flash a
      // pending/search scene during debounce for an ineligible query.
      if (!eligibleQuery(kind,flow.queries[kind])) {
        beginRequest(kind);
        return;
      }
      flow.request = { kind, phase: "pending" };
      paintRequest();
      after(250, () => {
        if (!flow || seq !== sequence) return;
        beginRequest(kind);
        paintRequest();
      });
    }
    function handleKey(event) {
      if (!flow || flow.phase !== "address" || event.key !== "Enter") return;
      const kind = event.target.dataset.onboardQuery;
      if (!kind) return;
      event.preventDefault();
      if (pending() || flow.request?.phase === "error") return;
      const candidates = flow.results[kind] || [];
      if (candidates.length === 1) {
        event.preventDefault();
        flow.results[kind] = candidates;
        handleAction("onboard-select", {
          dataset: { kind, record: candidates[0].id },
        });
      }
    }
    return {
      active: () => !!flow,
      open,
      close,
      restore,
      suspend: () => {
        geography?.cancel();
        remember();
        cancelRequest();
        flow = null;
      },
      handleAction,
      handleInput,
      handleKey,
      handleScroll(event){
        const node=event.target,kind=node?.id?.replace('onboard-results-','');
        if(!flow||!['city','street','house'].includes(kind)||pending()||flow.request?.phase==='error'||!flow.cursors?.[kind])return;
        if(node.scrollHeight-node.clientHeight-node.scrollTop<80)beginRequest(kind,false,true);
      },
      handleFocus(event){
        const kind=event.target.dataset?.onboardQuery;
        if(!flow?.additionalEditing||!['city','street','house'].includes(kind)||event.target.disabled||flow.editing===kind)return;
        cancelRequest();flow.editing=kind;flow.queries[kind]=event.target.value;
        for(const other of ['city','street','house'])if(other!==kind){const box=document.getElementById('onboard-results-'+other);if(box)box.replaceChildren();}
        beginRequest(kind);remember();
      },
      responseChanged: () => {
        if (flow?.phase === "address") {
          const kind =
            flow.request?.kind ||
            (!flow.city
              ? "city"
              : !flow.street
                ? "street"
                : !flow.house
                  ? "house"
                  : null);
          if (kind) {
            beginRequest(kind);
            ctx.render();
          }
        }
      },
      header: () =>
        `<div class="app-head onboarding-header">${window.SvitloExperience?.brand() || '<div class="app-title">Світло</div>'}<span class="onboard-step">${flow?.resume ? "Налаштування" : flow?.initial ? (state().target === "pwa" ? "Нова адреса" : flow.phase === "address" ? "Крок 1 із 2" : "Крок 2 із 2") : "Нова адреса"}</span></div>`,
      screen: () =>
        flow?.phase === "preferences" ? preferenceScreen() : addressScreen(),
    };
  },
};
