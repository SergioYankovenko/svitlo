"use strict";
// UI226/UI227–234: source-independent renderer and bounded, local time viewport.
window.SvitloSensorOverview = (() => {
  const esc = text => String(text).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  let DAY = 1440, dayStart=null;
  function configure(length,start){DAY=[1380,1440,1500].includes(+length)?+length:1440;dayStart=Number.isFinite(Date.parse(start))?Date.parse(start):null;}
  const MIN_SPAN = 60;
  let chartSequence = 0, cleanup = null;
  const time = minute => {
    if(dayStart!==null){if(minute===DAY)return '24:00';return new Intl.DateTimeFormat('uk-UA',{timeZone:'Europe/Kyiv',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(dayStart+Math.round(minute)*60000);}
    const m = Math.round(minute);
    return `${String(Math.floor(m / 60)).padStart(2,"0")}:${String(m % 60).padStart(2,"0")}`;
  };
  function viewport(start = 0, span = DAY) {
    span = Math.max(MIN_SPAN, Math.min(DAY, Number.isFinite(span) ? span : DAY));
    start = Math.max(0, Math.min(DAY - span, Number.isFinite(start) ? start : 0));
    return {start, end:start + span};
  }
  function zoom(range, factor, anchor = .5) {
    anchor = Math.max(0, Math.min(1, anchor));
    const span = range.end - range.start;
    const next = Math.max(MIN_SPAN, Math.min(DAY, span / Math.max(.01, factor)));
    return viewport(range.start + span * anchor - next * anchor, next);
  }
  const pan = (range, minutes) => viewport(range.start + minutes, range.end - range.start);
  function chart({title, kind, data, note = ""}) {
    const rows = data?.segments || [], known = rows.some(row => row.state !== "unknown"), id = `sensor-gap-${++chartSequence}`;
    const description = rows.filter(row => row.state !== "unknown").map(row => `${time(row.start)}–${time(row.end)}: ${row.state === "on" ? "світло є" : "світла немає"}`).join("; ");
    const gaps = rows.filter(row => row.state === "unknown").map(row => `<rect x="${row.start}" y="0" width="${row.end-row.start}" height="80" fill="url(#${id})"/>`).join("");
    const lines = rows.map((row,index) => {
      if (row.state === "unknown") return "";
      const y = row.state === "on" ? 14 : 66, previous = rows[index-1];
      const join = previous && previous.state !== "unknown" && previous.end === row.start && previous.state !== row.state
        ? `M${row.start} ${previous.state === "on" ? 14 : 66}V${y}` : "";
      return `<path class="sensor-series ${kind} ${row.state}" d="${join}M${row.start} ${y}H${row.end}" vector-effect="non-scaling-stroke"/>`;
    }).join("");
    const origin = kind === "prediction" ? "Орієнтовний прогноз датчика, не офіційний графік. " : "Підтверджені виміри датчика. ";
    // An unavailable series has a reason, not a squeezed plot behind that reason.
    if (!known && note) return `<figure class="sensor-chart sensor-chart-empty" data-series="${kind}" aria-label="${esc(origin+title)}"><figcaption><strong>${esc(title)}</strong><span>${kind === "prediction" ? "Орієнтовно" : "Виміряно"}</span></figcaption><p class="sensor-chart-note" role="status">${esc(note)}</p></figure>`;
    return `<figure class="sensor-chart" data-series="${kind}"><figcaption><strong>${esc(title)}</strong><span>${kind === "prediction" ? "Орієнтовно" : "Виміряно"}</span></figcaption><div class="sensor-chart-area"><div class="sensor-y-axis" aria-hidden="true"><span>Є</span><span>Немає</span></div><div class="sensor-chart-viewport" tabindex="0" role="group" aria-label="${esc("Часова шкала: " + title)}" aria-describedby="sensor-zoom-help"><svg viewBox="0 0 1440 80" preserveAspectRatio="none" role="img" aria-label="${esc(origin + title + ". " + (known ? description + ". На штрихованих ділянках немає даних." : note || "Немає даних"))}"><defs><pattern id="${id}" width="24" height="12" patternUnits="userSpaceOnUse"><path d="M-12 12L12 0M12 12L36 0" class="sensor-gap-stroke"/></pattern></defs><path class="sensor-chart-grid" d="M0 14H1440M0 66H1440M480 0V80M960 0V80"/>${gaps}${lines}</svg></div><div class="sensor-x-axis" aria-hidden="true"><span>00</span><span>08</span><span>16</span><span>24</span></div></div>${note ? `<p class="sensor-chart-note" role="status">${esc(note)}</p>` : ""}</figure>`;
  }
  function dispose() { cleanup?.(); cleanup = null; }
  function capture(root) {
    if (!root) return null;
    const pill = root.querySelector(".sensor-day-pill"), pane = root.querySelector(".sensor-day-pane");
    // Rapid input selects the newest day immediately instead of queuing old slides.
    return {pill:pill?.getBoundingClientRect(),pane:root.dataset.dayTransition === "true" ? null : pane?.cloneNode(true)};
  }
  function mount(root, {viewport:initial, motion, onViewport = () => {}, onDay = () => {}} = {}) {
    dispose();
    if (!root) return;
    DAY=[1380,1440,1500].includes(+root.dataset.dayLength)?+root.dataset.dayLength:1440;
    dayStart=Number.isFinite(Date.parse(root.dataset.dayStart))?Date.parse(root.dataset.dayStart):null;
    const abort = new AbortController(), pointers = new Map();
    const reduced = matchMedia("(prefers-reduced-motion: reduce)"), animations = new Set();
    const nav = root.querySelector(".sensor-day-nav"), selected = nav?.querySelector('[aria-pressed="true"]');
    const stage = root.querySelector(".sensor-day-stage"), pane = stage?.querySelector(".sensor-day-pane");
    const pill = document.createElement("span"); pill.className = "sensor-day-pill"; pill.ariaHidden = "true";
    nav?.prepend(pill);
    let outgoing = null, hostSize = null;
    function settle() {
      animations.forEach(animation => animation.cancel()); animations.clear();
      outgoing?.remove(); outgoing = null; root.dataset.dayTransition = "false";
    }
    function animate(node, frames) {
      const animation = node.animate(frames, window.SvitloMotionUI.timing);
      animations.add(animation);
      animation.finished.then(()=>{animations.delete(animation);if (!animations.size) settle();}).catch(()=>{});
    }
    function placePill() {
      if (!selected || !nav) return;
      const box = selected.getBoundingClientRect(), container = nav.getBoundingClientRect();
      Object.assign(pill.style,{left:box.left-container.left+"px",top:box.top-container.top+"px",width:box.width+"px",height:box.height+"px"});
    }
    let range = viewport(initial?.start, initial ? initial.end-initial.start : DAY), gesture = null, suppressClick = false;
    const plots = [...root.querySelectorAll(".sensor-chart-viewport")];
    const helper = document.createElement("span");
    helper.id = "sensor-zoom-help"; helper.className = "sensor-sr-only";
    helper.textContent = "Свайп на повній шкалі або днях перемикає день. Два пальці змінюють масштаб. Перетягни збільшену шкалу. Клавіші +/− змінюють масштаб, стрілки пересувають час, Home показує всю добу.";
    root.append(helper);
    function draw() {
      const span = range.end-range.start;
      root.dataset.zoomed = String(span < DAY);
      for (const plot of plots) {
        plot.querySelector("svg").setAttribute("viewBox",`${range.start} 0 ${span} 80`);
        const width = plot.clientWidth, font = parseFloat(getComputedStyle(plot.nextElementSibling).fontSize);
        const divisions = span < DAY ? (width < font*13 ? 1 : 2) : (width < font*8 ? 1 : width < font*17 ? 2 : 3);
        const ticks = Array.from({length:divisions+1},(_,i)=>range.start+span*i/divisions);
        plot.nextElementSibling.innerHTML = ticks.map(m=>`<span>${span === DAY && m % 60 === 0 ? time(m).slice(0,2) : time(m)}</span>`).join("");
        plot.querySelector(".sensor-chart-grid").setAttribute("d",`M${range.start} 14H${range.end}M${range.start} 66H${range.end}`+ticks.slice(1,-1).map(m=>`M${m} 0V80`).join(""));
        plot.dataset.start = String(range.start); plot.dataset.end = String(range.end);
        plot.setAttribute("aria-label",`Часова шкала: ${plot.closest("figure").querySelector("strong").textContent}, ${time(range.start)}–${time(range.end)}`);
      }
    }
    function update(next) { range = next; draw(); onViewport({...range}); }
    // One owner arbitrates day swipe, plot pan and pinch. A pinch cannot become a day swipe on release.
    const listenRoot = (name,fn,options={}) => root.addEventListener(name,fn,{...options,signal:abort.signal});
    listenRoot("pointerdown",event => {
      if (event.button > 0) return;
      const plot = event.target.closest(".sensor-chart-viewport"), nav = event.target.closest(".sensor-day-nav");
      if (!plot && !nav && (event.target.closest("button,input,.dialog-head,.dialog-footer") || !event.target.closest(".dialog-body"))) return;
      if (gesture && gesture.plot !== plot) return;
      if (!pointers.size) suppressClick = false;
      pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
      if (!nav) root.setPointerCapture(event.pointerId);
      if (pointers.size === 1) gesture = {plot,x:event.clientX,y:event.clientY,range:{...range},mode:plot && range.end-range.start < DAY ? "pan" : "day",dragged:false};
      else if (plot && pointers.size === 2) {
        const [a,b] = [...pointers.values()], rect = plot.getBoundingClientRect();
        gesture = {plot,range:{...range},distance:Math.max(1,Math.hypot(b.x-a.x,b.y-a.y)),anchor:range.start+((a.x+b.x)/2-rect.left)/rect.width*(range.end-range.start),mode:"pinch",dragged:true};
      } else if (gesture) gesture.mode = "cancel";
    });
    listenRoot("pointermove",event => {
      if (!pointers.has(event.pointerId) || !gesture) return;
      pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
      const g = gesture;
      if (g.mode === "pinch" && pointers.size >= 2) {
        const [a,b] = [...pointers.values()], rect = g.plot.getBoundingClientRect();
        const span = Math.max(MIN_SPAN,Math.min(DAY,(g.range.end-g.range.start)*g.distance/Math.max(1,Math.hypot(b.x-a.x,b.y-a.y))));
        update(viewport(g.anchor-((a.x+b.x)/2-rect.left)/rect.width*span,span));
      } else if (["pan","day"].includes(g.mode)) {
        const dx=event.clientX-g.x,dy=event.clientY-g.y;
        if (Math.hypot(dx,dy)>8) {g.dragged=true;root.setPointerCapture(event.pointerId);}
        if (Math.abs(dy)>12 && Math.abs(dy)*1.4>Math.abs(dx)) g.mode="cancel";
        else if (g.mode === "pan" && Math.abs(dx)>8 && Math.abs(dx)>Math.abs(dy)*1.4)
          update(pan(g.range,-dx/g.plot.clientWidth*(g.range.end-g.range.start)));
      }
    });
    const end = event => {
      // A touch starts with implicit capture on a day button. Moving capture to
      // this root emits a bubbling lostpointercapture for that child, not a cancel.
      if (event.type === "lostpointercapture" && event.target !== root) return;
      if (!pointers.delete(event.pointerId) || !gesture) return;
      const g=gesture,dx=event.clientX-g.x,dy=event.clientY-g.y;
      suppressClick = suppressClick || g.dragged;
      if (pointers.size) {g.mode="cancel";return;}
      gesture=null;
      if (event.type === "pointerup" && g.mode === "day" && Math.abs(dx)>=48 && Math.abs(dx)>Math.abs(dy)*1.6) onDay(dx<0?1:-1);
    };
    for (const name of ["pointerup","pointercancel","lostpointercapture"]) listenRoot(name,end);
    listenRoot("click",event => {if(suppressClick){suppressClick=false;event.preventDefault();event.stopImmediatePropagation();}},{capture:true});
    for (const plot of plots) {
      const listen = (event, fn, options = {}) => plot.addEventListener(event,fn,{...options,signal:abort.signal});
      listen("wheel",event=>{
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          const rect = plot.getBoundingClientRect();
          update(zoom(range,Math.exp(-event.deltaY*.005),(event.clientX-rect.left)/rect.width));
        } else if (range.end-range.start < DAY && Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
          event.preventDefault(); update(pan(range,event.deltaX/plot.clientWidth*(range.end-range.start)));
        }
      },{passive:false});
      listen("keydown",event=>{
        if (event.target !== plot) return;
        let next;
        if (["+","="].includes(event.key)) next = zoom(range,2);
        if (["-","−"].includes(event.key)) next = zoom(range,.5);
        if (event.key === "ArrowRight") next = pan(range,(range.end-range.start)/4);
        if (event.key === "ArrowLeft") next = pan(range,-(range.end-range.start)/4);
        if (event.key === "Home") next = viewport();
        if (next) { event.preventDefault(); update(next); }
      });
    }
    const resize = () => {
      const host = root.parentElement.getBoundingClientRect();
      if (hostSize && (Math.abs(hostSize.width-host.width)>.5 || Math.abs(hostSize.height-host.height)>.5)) settle();
      hostSize = {width:host.width,height:host.height};
      root.dataset.short = String(host.height < 470);
      root.dataset.wide = String(host.width >= 500);
      draw();
      placePill();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(root.parentElement); plots.forEach(plot=>observer.observe(plot));
    resize();
    if (motion && !reduced.matches) {
      const box = pill.getBoundingClientRect();
      if (motion.pill) animate(pill,[{transform:`translateX(${motion.pill.left-box.left}px)`},{transform:"translateX(0)"}]);
      if (motion.pane && pane) {
        outgoing = motion.pane; outgoing.classList.add("sensor-day-outgoing"); outgoing.inert = true; outgoing.ariaHidden = "true";
        stage.append(outgoing); root.dataset.dayTransition = "true";
        animate(outgoing,[{transform:"translateX(0)"},{transform:`translateX(${-motion.direction*100}%)`}]);
        animate(pane,[{transform:`translateX(${motion.direction*100}%)`},{transform:"translateX(0)"}]);
      }
    }
    const reduceChanged = () => {if (reduced.matches) settle();};
    reduced.addEventListener("change",reduceChanged);
    cleanup = () => {settle();abort.abort();observer.disconnect();reduced.removeEventListener("change",reduceChanged);pointers.clear();gesture=null;};
  }
  return {chart,mount,capture,dispose,viewport,zoom,pan,configure};
})();
