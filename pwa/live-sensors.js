"use strict";
// UI254 sensor presentation. All ownership, history and invitations come from the server.
window.SvitloLiveSensors={create(ctx){
  const live=window.SvitloLive,M=window.SvitloSensorModel,e=ctx.esc,icon=window.SvitloNativeUI.icon;
  let managedAddressId=null,signals=new Map(),views=new Map(),fetched=new Map(),pending=new Map(),generation=0,selectedDate=null,noticePrefs=new Map();
  const prefKey='svitlo.pwa.v2.sensor-preferences';
  let preferences={};try{preferences=JSON.parse(localStorage.getItem(prefKey)||'{}');}catch{}
  const key=s=>`${s.sensorId}:${s.bindingEpoch}`;
  const binding=(id=ctx.address().id)=>live.sensors().find(s=>s.readerProfileId===id);

  const addressRecord=s=>ctx.addresses().find(p=>p.id===s?.readerProfileId);
  const label=s=>{const p=addressRecord(s);return p?.name||[p?.city,p?.street].filter(Boolean).join(', ')||'Датчик';};
  const viewKey=(s,date)=>key(s)+':'+date;
  const signal=s=>{const v=signals.get(key(s));return v?live.signalView(v.data,Date.now()-v.at):{state:'unknown',label:'Стан живлення невідомий'};};
  const button=(text,action,cls="",attrs="")=>ctx.button(text,"sensor-"+action,cls,attrs);
  async function call(action,data){return live.sensor(action,{requestId:crypto.randomUUID(),...data});}
  async function load(s,date){
    if(!s)return;const k=viewKey(s,date);if(pending.has(k))return pending.get(k);const g=generation;
    const job=(async()=>{
    try{const [r,v]=await Promise.all([live.sensor('signal',{sensorId:s.sensorId,bindingEpoch:s.bindingEpoch}),live.sensor('overview',{sensorId:s.sensorId,bindingEpoch:s.bindingEpoch,date})]);
      if(g!==generation||!live.sensors().some(x=>key(x)===key(s)))return;
      signals.set(key(s),{data:r.signal,at:Date.now()});views.set(k,v.overview);fetched.set(k,Date.now());ctx.render();
    }catch{/* No extrapolation from a failed/stale read. */signals.delete(key(s));views.delete(k);fetched.set(k,Date.now());}finally{pending.delete(k);}
    })();pending.set(k,job);return job;
  }
  function observation(date=ctx.date(),id=ctx.address().id){const s=binding(typeof id==="object"?id.readerProfileId:id),o=s&&views.get(viewKey(s,date));if(!o||o.observation?.semantics!=='explicit_coverage_only')return null;
    const from=Date.parse(o.dayStartUtc),until=Math.min(Date.parse(o.asOf),Date.parse(o.dayEndUtc));
    const end=Math.max(0,Math.min(o.dayLengthMinutes,(Date.parse(o.asOf)-from)/60000));
    const rows=(o.observation.intervals||[]).filter(r=>['on','off'].includes(r.powerState)&&Date.parse(r.start)>=from&&Date.parse(r.end)<=until).map(r=>({start:(Date.parse(r.start)-from)/60000,end:(Date.parse(r.end)-from)/60000,state:r.powerState}));
    return M.normalize(rows,end,o.dayLengthMinutes);
  }

  // A stable presentation record projects server DTOs. It grants no rights locally.
  const records=new Map(),reader='self';
  let listExpanded=false,pendingBinding=null,scanPending=null,hubView=null,hubViewport=null,hourContext=null;
  const bindings=()=>ctx.addresses().filter(a=>binding(a.id));
  const member=p=>!!p&&live.sensors().some(s=>key(s)===key(p));
  const owner=p=>member(p)&&p.role==='owner';
  const managedAddress=()=>ctx.addresses().find(a=>a.id===managedAddressId)||ctx.address();
  const profile=(id=ctx.address().id)=>{
    const s=binding(id);if(!s)return null;const k=key(s),p=records.get(k)||{};records.set(k,p);
    const current=signal(s),packet=signals.get(k)?.data;
    Object.assign(p,s,{epoch:s.bindingEpoch,entitled:true,actualSummary:!!preferences[s.readerProfileId],
      state:current.state==='unknown'?(packet?.transportState==='offline'?'offline':'waiting'):current.state,
      signalTime:packet?.lastConfirmedAt?new Intl.DateTimeFormat('uk-UA',{timeZone:'Europe/Kyiv',hour:'2-digit',minute:'2-digit'}).format(new Date(packet.lastConfirmedAt)):'',
      notificationReaders:{[reader]:noticePrefs.get(k)===true},members:{[reader]:s.role}});return p;
  };
  const managed=()=>profile(managedAddressId)||profile(),record=()=>profile();
  const hasBinding=()=>!!record();
  const reading=p=>{if(!p)return{label:'Стан невідомий',live:false,state:'unknown'};const s=signal(p);return{...s,live:['on','off'].includes(s.state)};};
  const time=m=>{const date=hubView?hubDate(managed()||{}):ctx.date(),d=live.schedule(date);if(m===d.total)return '24:00';return new Intl.DateTimeFormat('uk-UA',{timeZone:'Europe/Kyiv',hour:'2-digit',minute:'2-digit'}).format(new Date(d.from+m*60000));};
  const duration=m=>`${Math.floor(m/60)} год${m%60?' '+Math.round(m%60)+' хв':''}`;
  const save=()=>{for(const p of records.values())preferences[p.readerProfileId]=p.actualSummary;try{localStorage.setItem(prefKey,JSON.stringify(preferences));}catch{}};
  const overviewPrediction=()=>({reason:'Поки немає надійних даних для прогнозу.'});
  const pruneProfiles=()=>{if(!bindings().length)listExpanded=false;};
  function bindingError(id){if(!ctx.addresses().some(a=>a.id===id)){ctx.toast('Спочатку додай адресу');return true;}if(binding(id)){ctx.toast('До цієї адреси вже підключено датчик');return true;}return false;}
    const shiftDate = (date, offset) => { const d = window.SvitloClock.date(date); d.setUTCDate(d.getUTCDate()+offset); return window.SvitloClock.key(d); };
    // UI241: keep a Home date outside the ordinary three-day hub as an explicit tab.
    // The context is ephemeral and bound to this sensor, never a new data source.
    function hubDays() {
      const days = [-1,0,1].map((offset,index) => ({date:shiftDate(ctx.now().date,offset),label:["Вчора","Сьогодні","Завтра"][index]}));
      if (hourContext?.addressId === managedAddressId && !days.some(day => day.date === hourContext.date))
        days.push({date:hourContext.date,label:hourContext.date.slice(8)+"."+hourContext.date.slice(5,7)});
      return days.sort((a,b) => a.date.localeCompare(b.date));
    }
    function hubDate(p) {
      return hubDays().some(day => day.date === p.overviewDate) ? p.overviewDate : ctx.now().date;
    }
    function hubDialog(title, body, footer, options = {}) {
      const address = managedAddress();
      ctx.dialog(title,body,footer,[address.city,address.street].filter(Boolean).join(", ") || address.name || "Адреса",{
        className:"sensor-details-dialog sensor-overview-dialog",footerClass:"sensor-hub-footer",...options});
    }
    function settings() {
      const p = managed(); if (!p) return connect();
      hubView = "settings";
      hubDialog("Налаштування датчика",member(p) && p.entitled
        ? `<fieldset class="sensor-summary-choice"><legend>Підсумки дня</legend><div role="group" aria-label="Джерело підсумків дня">${[["plan","За графіком"],["actual","За датчиком"]].map(([source,label])=>`<button type="button" data-action="sensor-summary-source" data-source="${source}" aria-pressed="${p.actualSummary === (source === "actual")}">${label}</button>`).join("")}</div><p>Якщо графіка немає, покажу доступні виміри датчика.</p></fieldset><div class="sensor-settings-rows"><label class="switch-row"><span>Сповіщення про світло та зв’язок</span><input type="checkbox" data-sensor-layer="notifications" aria-label="Сповіщення про світло та зв’язок" ${p.notificationReaders?.[reader] ? "checked" : ""}></label></div>`
        : "<p>Налаштування недоступні без чинного доступу до датчика.</p>",
        button("До огляду","overview"));
    }
    function sharing() {
      const p = managed(); if (!p) return connect();
      hubView = "sharing";
      const actions = owner(p) ? button("Запросити телефон","invite")+button("Учасники","members")+
        button("Передати власність","transfer","",'disabled aria-disabled="true"')+button("Від’єднати для всіх","disconnect","cancel")
        : member(p) ? button("Прибрати у себе","leave","cancel") : button("Прийняти запрошення","join")+button("Відновити доступ","recover");
      hubDialog("Доступ до датчика",`<p>Ви: ${owner(p) ? "власник" : member(p) ? "глядач" : "доступу немає"}.</p><div class="sensor-menu-actions">${actions}</div>`,button("До огляду","overview"));
    }
    function help() {
      const p = managed(); if (!p) return connect(); hubView = "help";
      const date = hubDate(p), actual = observation(date,p), allowed = member(p) && p.entitled;
      const summary = allowed && actual?.available
        ? `<div class="sensor-help-totals">${[["Зі світлом",actual.on],["Без світла",actual.off],["Невідомо",actual.unknown]].map(([label,value])=>`<div><small>${label}</small><strong>${duration(value)}</strong></div>`).join("")}</div>`
        : `<p>${!allowed ? "Виміри недоступні для цього телефона." : date > ctx.now().date ? "За майбутній день вимірів ще немає." : "Підтверджених вимірів ще немає."}</p>`;
      const example = (name,cls,text) => `<div class="sensor-help-example"><span class="sensor-help-sample ${cls}" aria-hidden="true"></span><div><strong>${name}</strong><small>${text}</small></div></div>`;
      hubDialog("Про датчик",`<section class="sensor-help-summary"><h3>${e(new Intl.DateTimeFormat("uk-UA",{day:"numeric",month:"long",timeZone:"UTC"}).format(window.SvitloClock.date(date)))}</h3>${summary}</section><div class="sensor-help-folds"><details open><summary>Як читати плитку</summary>${example("За графіком","plan","Колір показує офіційний план.")}${example("За датчиком","actual","Зелений означає «є», кораловий «немає».")}<div class="sensor-help-example"><div class="sensor-help-current" aria-hidden="true"><span></span></div><p class="sensor-help-caption">Контур показує історію за хвилинами. Крапка лише на поточній годині показує свіжий стан датчика.</p></div></details><details><summary>Прогноз і невідомий час</summary>${example("Прогноз в огляді датчика","prediction","Пунктир показує орієнтовний прогноз за минулими вимірами.")}${example("Невідомо","unknown","Тут вимірів немає. Це не підтвердження відключення.")}</details><details><summary>Що саме бачить датчик</summary><p class="sensor-help-boundary">Лише свою точку, а не весь будинок. Наприклад, розетка після UPS може показувати резервне живлення.</p></details></div>`,button("До огляду","overview"),{className:"sensor-details-dialog sensor-overview-dialog sensor-help-dialog",dismissOnBackdrop:true});
    }
    function indicator() {
      const p = record();
      if (!p) return { html: "", label: "" };
      const s = reading(p),
        tone = !member(p) || !p.entitled
          ? "unavailable"
          : s.live
            ? s.state
            : ["offline", "error", "clock"].includes(p.state)
              ? "warning"
              : "waiting",
        mark = s.live ? "" : tone === "warning" ? "!" : "?",
        label = `Датчик: ${s.label}`;
      return {
        label,
        html: `<span class="sensor-indicator" data-tone="${tone}" role="img" aria-label="${e(label)}" title="${e(label)}">${window.SvitloNativeUI.icon("sensor", "sensor-glyph")}<span class="sensor-indicator-mark" aria-hidden="true">${mark}</span></span>`,
      };
    }

    function tileIntervals(list, start, end) {
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
      return list.filter(i => i.end > start && i.start < end).map(i => ({
        ...i, start: Math.max(start, i.start), end: Math.min(end, i.end),
      }));
    }
    function tracks(date, start, end, planHalves = [], current = false) {
      const p = record();
      if (!member(p) || !p.entitled) return "";
      const actual = tileIntervals(observation(date)?.intervals || [], start, end);
      const minute = live.elapsedMinutes(),
        signal = reading(p),
        currentState = current && date === ctx.now().date &&
          minute >= start && minute < end && signal.live ? signal.state : null,
        combined = current && date === ctx.now().date && minute >= start && minute < end &&
          (actual.length > 0 || !!currentState);
      if (!actual.length && !currentState) return "";
      const render = (list, kind) => list.flatMap(interval => {
        // Only split paint for contrast; original measurement timestamps are unchanged.
        const boundaries = [interval.start, interval.end];
        for (let m = start + 30; m < end; m += 30)
          if (m > interval.start && m < interval.end) boundaries.push(m);
        boundaries.sort((a, b) => a - b);
        return boundaries.slice(0, -1).map((from, index) => {
          const through = boundaries[index + 1],
            top = 100 * (from - start) / (end - start),
            height = 100 * (through - from) / (end - start),
            background = planHalves[Math.floor(((from + through) / 2 - start) / 30)],
            colored = background && background !== "unknown" ? " over-color" : "";
          // The tick locates a subpixel interval; it never stretches its duration.
          const tick = height < 3
            ? `<i class="sensor-short-mark ${kind} ${interval.state}${colored}" style="--sensor-position:${top + height / 2}%" aria-hidden="true"></i>` : "";
          return `<i class="sensor-trace ${kind} ${interval.state}${colored}" data-start="${from}" data-end="${through}" style="--sensor-top:${top}%;--sensor-bottom:${100 - top - height}%" aria-hidden="true"></i>${tick}`;
        });
      }).join("");
      const description = list => list.map(i => `${time(i.start)}–${time(i.end)}: ${i.state === "on" ? "світло є" : "світла немає"}`).join("; ") || "немає даних";
      // A live point and a measured interval can meet at a state change now.
      // Match the address indicator; do not turn a point into an hour of history.
      const liveLabel = currentState ? `Актуальний сигнал о ${time(minute)}: ${currentState === "on" ? "світло є" : "світла немає"}. ` : "";
      const dot = currentState
        ? `<i class="sensor-current-dot ${currentState}" data-state="${currentState}" data-through="${minute}" data-plan="${e(planHalves[0] || "on")}" aria-hidden="true"></i>` : "";
      const label = `${liveLabel}За датчиком: ${description(actual)}. Прогалини означають невідомий час.`;
      return `<span class="sensor-overlay${combined ? " current-combined" : ""}" role="img" aria-label="${e(label)}">${render(actual, "actual")}${dot}</span><button type="button" class="sensor-tile-details" data-action="sensor-hour" data-date="${e(date)}" data-address="${e(ctx.address().id)}" data-start="${start}" data-end="${end}" aria-label="${e(`План і датчик: ${time(start)}–${time(end)}. ${label}`)}"></button>`;
    }
    function hourDetails(el) {
      const date = el.dataset.date, start = Number(el.dataset.start), end = Number(el.dataset.end), p = record();
      if (el.dataset.address !== ctx.address().id || date !== ctx.date() ||
          !member(p) || !p.entitled || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > 1500 || end <= start) return;
      const data = ctx.schedule(date),
        observed = observation(date)?.intervals || [],
        through = date === ctx.now().date ? live.elapsedMinutes() : date < ctx.now().date ? end : start;
      const plan = [];
      for (let from = start; from < end; from += 30) {
        const through = Math.min(from + 30, end), kind = data.at((from + through) / 2, true);
        plan.push({start:from,end:through,state:kind === "unknown" ? "unknown" : kind ? "off" : "on",kind:kind || "on"});
      }
      const timeline = window.SvitloDeviceUI.timeline({start,end,plan,actual:observed,through,factEnabled:true});
      const labels = {on:"Світло є",off:"Світла немає",unknown:"Немає вимірів",future:"Вимірів ще немає",disabled:"Шар вимірів вимкнено"};
      const description = (rows, plan = false) => rows.map(i => `${time(i.start)}–${time(i.end)}: ${plan && i.state === "unknown" ? "Стан за графіком невідомий" : labels[i.state]}`).join("; ");
      const track = (rows,label) => `<div class="hour-track" aria-label="${e(label + ": " + description(rows,label === "За графіком"))}">${rows.map(i => `<span class="hour-track-part ${i.state}" data-start="${i.start}" data-end="${i.end}" style="width:${100*(i.end-i.start)/(end-start)}%"></span>`).join("")}<span class="hour-track-label">${label}</span></div>`;
      const ratio = timeline.now === null ? null : 100*(timeline.now-start)/(end-start);
      const marker = ratio === null ? "" : `<div class="hour-now ${ratio<10?"edge-start":ratio>90?"edge-end":""}" style="--hour-now:${ratio}%"><span>${time(timeline.now)}</span></div>`;
      const suffix = timeline.transition ? ` · ${timeline.transition.state === "on" ? "Увімкнули" : "Вимкнули"} о ${time(timeline.transition.at)}` : "";
      const rows = timeline.fact.map(i => `<div class="hour-fact-row"><span class="hour-fact-range">${time(i.start)}–${time(i.end)}</span><span class="hour-fact-state ${i.state}">${i.state === "on" ? window.SvitloNativeUI.power(false) : i.state === "off" ? window.SvitloNativeUI.power(true) : window.SvitloNativeUI.icon("clock")}${labels[i.state]}</span></div>`).join("");
      ctx.dialog(`Деталі за год${suffix}`,
        `<section class="hour-comparison"><div class="hour-time-area">${marker}<div class="hour-combined-band">${track(timeline.plan,"За графіком")}${track(timeline.fact,"За датчиком")}</div><div class="hour-axis"><span>${time(start)}</span><span>${time(end)}</span></div></div><div class="hour-facts">${rows}</div></section>`,
        ctx.button("Зрозуміло", "close", "center"), "", {className:"sensor-hour-dialog",dismissOnBackdrop:true,headerAction:`<button type="button" class="sensor-hour-more" data-action="sensor-hour-overview" data-address="${e(el.dataset.address)}" data-date="${e(date)}" aria-label="Детальніше про графіки датчика">Детальніше</button>`,accessibleLabel:`Деталі години ${time(start)}–${time(end)} за ${date}. ${suffix}`});
    }
    function changeHubDay(nextDate) {
      const p = managed(), days = hubDays();
      if (!p || !days.some(day => day.date === nextDate) || nextDate === hubDate(p)) return;
      const previous = hubDate(p), motion = window.SvitloSensorOverview.capture(document.querySelector(".sensor-hub-overview"));
      p.overviewDate = nextDate; save();
      details({ ...motion, direction:nextDate > previous ? 1 : -1 });
    }
    async function details(motion) {
      const p = managed(); if (!p) return connect();
      hubView = "overview";
      const date = hubDate(p), today = ctx.now().date, allowed = member(p) && p.entitled;
      await load(p,date);
      const actual = observation(date,p), forecast = date >= today ? overviewPrediction(date,p) : null;
      const observed = M.daySeries(actual?.intervals || [],actual?.limit ?? 0,actual?.dayLength || 1440), current = reading(p);
      const signalTime = allowed && current.live ? `Сигнал о ${e(p.signalTime)}`
        : allowed && p.state === "offline" ? p.signalTime ? `Останній сигнал о ${e(p.signalTime)}` : "" : "";
      const days = hubDays();
      const nav = days.map(day => `<button type="button" data-action="sensor-view-day" data-date="${day.date}" aria-pressed="${date === day.date}">${day.label}</button>`).join("");
      const dayOverview=views.get(viewKey(p,date));
      window.SvitloSensorOverview.configure(dayOverview?.dayLengthMinutes,dayOverview?.dayStartUtc);
      let charts = '<p class="sensor-unavailable">Дані датчика недоступні для цього телефона.</p>';
      if (allowed) {
        charts = "";
        if (date >= today) charts += window.SvitloSensorOverview.chart({title:"Прогноз",kind:"prediction",
          data:forecast?.segments ? forecast : M.daySeries([],0,actual?.dayLength || 1440), note:forecast?.reason || ""});
        if (date <= today) charts += window.SvitloSensorOverview.chart({title:"Історія вимірів",kind:"actual",data:observed,
          note:observed.available ? "" : "Підтверджених вимірів ще немає."});
      }
      const key = p.sensorId+":"+p.epoch+":"+date;
      if (hubViewport?.key !== key) hubViewport = {key,start:0,end:dayOverview?.dayLengthMinutes||1440};
      hubDialog("Датчик",`<nav class="sensor-day-nav" style="--sensor-days:${days.length}" aria-label="День датчика">${nav}</nav><div class="sensor-day-stage"><div class="sensor-day-pane"><p class="sensor-hub-date">${e(new Intl.DateTimeFormat("uk-UA",{day:"numeric",month:"long",year:"numeric",timeZone:"UTC"}).format(window.SvitloClock.date(date)))}</p><div class="sensor-charts">${charts}</div></div></div>`,
        button("Довідка","help")+ctx.button("Закрити","close","center"),{
          className:"sensor-details-dialog sensor-overview-dialog sensor-hub-overview",dismissOnBackdrop:true,
          headerAction:`<p class="sensor-hub-status ${current.state || ""}"><strong>${e(current.label)}</strong><span>${signalTime}</span></p>`});
      const root=document.querySelector(".sensor-hub-overview"),overview=views.get(viewKey(p,date));root.dataset.dayLength=overview?.dayLengthMinutes||1440;root.dataset.dayStart=overview?.dayStartUtc||"";
      window.SvitloSensorOverview.mount(root,{
        viewport:hubViewport,motion,onViewport:range => { hubViewport = {key,...range}; },
        onDay:direction => {
          const index = days.findIndex(day=>day.date === date), next = days[index+direction];
          if (next) changeHubDay(next.date);
        }
      });
    }

    function connect(addressId) {
      pendingBinding = null;
      scanPending = null;
      const free = ctx.addresses().filter(a => !profile(a.id));
      const address = free.find(a => a.id === addressId) || (free.length === 1 ? free[0] : null);
      managedAddressId = address?.id || null;
      ctx.dialog("Підключити датчик",
        window.SvitloSensorScanner.html(),
        ctx.button("Скасувати","close","cancel")+button("Перевірити","check","","disabled"),address ? [address.city,address.street].filter(Boolean).join(", ") : "Адресу обереш після сканування",{className:"sensor-connect-dialog",footerClass:"paired"});
      window.SvitloSensorScanner.mount(document.querySelector(".sensor-connect-dialog"));
    }
    function confirmConnection(code) {
      const sensorId=JSON.parse(code).sensorId;
      if (bindingError(managedAddressId,sensorId)) return;
      pendingBinding = {addressId:managedAddressId,sensorId,qr:JSON.parse(code),requestId:crypto.randomUUID()};
      ctx.dialog("Підтвердити точку",`<p>${e(managedAddress().city)}, ${e(managedAddress().street)}</p><p>Мережа до резервного живлення · фаза 1.</p>`,
        ctx.button("Скасувати","close","cancel")+button("Підключити","confirm"),"",{footerClass:"paired"});
    }
    function optionsHTML() {
      if (!true) return "";
      const rows = bindings(), count = rows.length;
      if (!count) listExpanded = false;
      const control = count < 2 || listExpanded ? `<button class="sensor-add" data-action="sensor-connect" aria-label="${count ? "Підключити ще один датчик" : "Підключити датчик"}"><span aria-hidden="true">+</span></button>` : button(window.SvitloNativeUI.icon("chevron"),"list","sensor-chevron",`aria-label="Список датчиків" aria-expanded="${listExpanded}"`);
      const listing = listExpanded ? `<div class="sensor-binding-list">${rows.map(a=>{
        const address = [a.city,a.street].filter(Boolean).join(", "), label = a.name || address;
        return `<div class="sensor-binding-row"><button type="button" class="sensor-binding-info" data-action="sensor-details" data-address="${e(a.id)}" aria-label="${e("Графіки датчика: "+(a.name ? a.name+", " : "")+address)}"><strong>${e(label)}</strong><small>${e(reading(profile(a.id)).label)}</small></button><div class="sensor-binding-actions"><button type="button" class="sensor-icon-action" data-action="sensor-settings" data-address="${e(a.id)}" aria-label="${e("Налаштування датчика: "+label)}">${window.SvitloNativeUI.icon("settings")}</button><button type="button" class="sensor-icon-action" data-action="sensor-sharing" data-address="${e(a.id)}" aria-label="${e("Спільний доступ до датчика: "+label)}">${window.SvitloNativeUI.icon("access")}</button></div></div>`;
      }).join("")}</div>` : "";
      const title = `<strong>Датчики</strong><small>${count} із 10 · один на адресу</small>`;
      return `<section class="card outlined sensor-options"><div class="sensor-options-header">${count ? `<button class="sensor-list-toggle" data-action="sensor-list" aria-expanded="${listExpanded}">${title}</button>` : `<div class="sensor-list-title">${title}</div>`}${control}</div>${listing}</section>`;
    }

  async function execute(name,el){
    const action=name.slice(7);let p=managed();
    switch(action){
      case 'list':listExpanded=bindings().length?!listExpanded:false;ctx.render();break;
      case 'connect':connect();break;
      case 'connect-address':managedAddressId=el.dataset.address;if(scanPending){const code=scanPending;scanPending=null;confirmConnection(code);}else connect(managedAddressId);break;
      case 'check':{
        const code=window.SvitloSensorScanner.parse(document.getElementById('sensor-code')?.value||'');
        if(!code){ctx.dialog('Не вдалося підключити','<p>Код неправильний або прострочений.</p>',button('Спробувати ще','connect')+ctx.button('Скасувати','close','cancel'),'',{footerClass:'paired'});break;}
        const free=ctx.addresses().filter(a=>!profile(a.id));
        if(managedAddressId&&free.some(a=>a.id===managedAddressId))confirmConnection(code);
        else if(free.length&&bindings().length<10){scanPending=code;ctx.dialog('Обери адресу для датчика',`<div class="picker-list">${free.map(a=>button(e(a.name||[a.city,a.street].join(', ')),'connect-address','',`data-address="${e(a.id)}"`)).join('')}</div>`,ctx.button('Скасувати','close','cancel'));}
        else ctx.dialog('Потрібна вільна адреса','<p>До наявних адрес уже підключено датчики. Спочатку додай іншу адресу.</p>',ctx.button('Зрозуміло','close','center'));
        break;
      }
      case 'confirm':{
        if(!pendingBinding||bindingError(pendingBinding.addressId))break;const b=pendingBinding;
        await live.sensor('connect_qr',{requestId:b.requestId,qr:b.qr,profileId:b.addressId});pendingBinding=null;
        await live.sync('manual');await live.refreshSensors();ctx.close();ctx.render();
        ctx.dialog('Очікую перший сигнал','<p>Датчик підключено. До підтвердження стан залишається невідомим.</p>',ctx.button('Зрозуміло','close'));break;
      }
      case 'details':hourContext=null;if(el?.dataset.address)managedAddressId=el.dataset.address;hubViewport=null;await details();break;
      case 'overview':await details();break;
      case 'settings':if(el?.dataset.address){managedAddressId=el.dataset.address;hourContext=null;}p=managed();if(p){const r=await live.sensor('notice_get',{sensorId:p.sensorId,bindingEpoch:p.bindingEpoch});noticePrefs.set(key(p),r.enabled===true);}settings();break;
      case 'sharing':if(el?.dataset.address){managedAddressId=el.dataset.address;hourContext=null;}sharing();break;
      case 'help':case 'day':help();break;
      case 'view-day':if(p&&hubDays().some(d=>d.date===el.dataset.date))changeHubDay(el.dataset.date);break;
      case 'summary-source':if(p&&member(p)&&['plan','actual'].includes(el.dataset.source)){p.actualSummary=el.dataset.source==='actual';save();ctx.render();settings();}break;
      case 'hour':hourDetails(el);break;
      case 'hour-overview':if(el.dataset.address===ctx.address().id&&el.dataset.date===ctx.date()){managedAddressId=el.dataset.address;hourContext={addressId:managedAddressId,date:el.dataset.date};profile().overviewDate=el.dataset.date;hubViewport=null;await details();}break;
      case 'invite':if(owner(p))await invitation();break;
      case 'transfer': case 'transfer-confirm': break; // Explicitly deferred by the user.
      case 'members':if(owner(p))await members();break;
      case 'revoke':if(owner(p)){await call('member_revoke',{sensorId:p.sensorId,bindingEpoch:p.bindingEpoch,membershipId:el.dataset.member});await members();}break;
      case 'copy-code':await navigator.clipboard.writeText(document.getElementById('sensor-share-code').value);ctx.toast('Код скопійовано');break;
      case 'leave':if(member(p)&&!owner(p)){await call('leave',{sensorId:p.sensorId,bindingEpoch:p.bindingEpoch,membershipId:p.membershipId});await live.refreshSensors();ctx.close();ctx.render();}break;
      case 'disconnect':if(owner(p))ctx.dialog('Від’єднати для всіх?','<p>Усі учасники втратять доступ до цієї точки. Інші адреси залишаться.</p>',ctx.button('Скасувати','close','cancel')+button('Від’єднати','disconnect-confirm'),'',{footerClass:'paired'});break;
      case 'disconnect-confirm':if(owner(p)){await call('disconnect',{sensorId:p.sensorId,bindingEpoch:p.bindingEpoch,confirmed:true});generation++;signals.clear();views.clear();await live.refreshSensors();ctx.close();ctx.render();}break;
    }
  }
  async function members(){const p=managed();if(!owner(p))return;const r=await live.sensor('members',{sensorId:p.sensorId,bindingEpoch:p.bindingEpoch});
    ctx.dialog('Учасники',(r.members||r.memberships||[]).map(m=>`<p>${m.role==='owner'?'Власник':'Глядач'} ${m.role==='viewer'?button('Відкликати','revoke','',`data-member="${e(m.membershipId)}"`):''}</p>`).join(''),button('До доступу','sharing'));
  }
  async function invitation(){const p=managed();if(!owner(p))return;const r=await call('invite_create',{sensorId:p.sensorId,bindingEpoch:p.bindingEpoch}),qr={version:1,kind:'viewer_invite',sensorId:p.sensorId,proof:r.invitation.inviteToken};
    ctx.dialog('Запрошення',`<p>Одноразове запрошення на 15 хв. Не містить ключа передавання вимірів.</p><canvas class="sensor-qr" id="sensor-qr" aria-label="QR для підключення датчика"></canvas><textarea class="field" id="sensor-share-code" readonly aria-label="Код датчика">${e(JSON.stringify(qr))}</textarea>`,button('Скопіювати','copy-code')+button('До доступу','sharing'));
    const canvas=document.getElementById('sensor-qr'),{default:QR}=await import('./vendor/qrcode.js');if(canvas.isConnected)await QR.toCanvas(canvas,JSON.stringify(qr),{width:256,margin:4,errorCorrectionLevel:'M'});
  }
  document.getElementById('app').addEventListener('change',async event=>{
    if(event.target.dataset.sensorLayer!=='notifications')return;const p=managed();if(!member(p))return;const input=event.target;input.disabled=true;try{const r=await live.sensor('notice_set',{sensorId:p.sensorId,bindingEpoch:p.bindingEpoch,enabled:input.checked});noticePrefs.set(key(p),r.enabled===true);input.checked=r.enabled===true;}catch(error){input.checked=noticePrefs.get(key(p))===true;ctx.toast(error.message);}finally{input.disabled=false;}
  });
  return {pruneProfiles,hasBinding,preferActual:()=>!!profile()?.actualSummary,observation,indicator,tracks,optionsHTML,messagesHTML:()=>'',examplePlan:()=>null,
    handle(name,el){if(!name.startsWith('sensor-'))return false;execute(name,el).catch(error=>ctx.toast(error.message));return true;},
    refresh(){const p=record();if(p)load(p,ctx.date());},sync(){const p=record(),date=ctx.date();if(p&&Date.now()-(fetched.get(viewKey(p,date))||0)>=60000&&!pending.has(viewKey(p,date)))load(p,date);}};
}};
