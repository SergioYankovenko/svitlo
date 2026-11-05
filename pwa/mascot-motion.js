"use strict";
//218: Registered4-key search /4-key finite settle and empty reaction. Stable anchors, bounded decode cache.
(() => {
  const prepared = new Map();
  const submitFallback =
    "data:image/webp;base64,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";
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  //207/211: four registered keys, 6800ms cycle including240ms fades. Final reaction holds the same prop.
  const searchHolds = [1800,1500,1600,1900];
  const closeHolds = [480,600,650,1000];
  let closing = null, previousScene = null, previousRequest = null;
  function searchFrameDuration(frame) { return searchHolds[frame]; }
  function prepare(src) {
    if (!prepared.has(src)) {
      if (/mascot-(?:submit|search|empty)-sheet/.test(src))
        for (const key of prepared.keys())
          if (/mascot-(?:submit|search|empty)-sheet/.test(key) && key !== src)
            prepared.delete(key);
      const image = new Image();
      image.decoding = "async";
      image.src = src;
      const ready = image
        .decode()
        .then(() => image)
        .catch((error) => {
          prepared.delete(src);
          throw error;
        });
      prepared.set(src, ready);
    }
    for (const key of prepared.keys())
      if (prepared.size > 6 && key !== src) prepared.delete(key);
    return prepared.get(src);
  }
  function track(selector, className) {
    let current = null,
      incoming = null,
      animation = null,
      desired = "",
      layout = "",
      generation = 0;
    const source = (node) =>
      node?.dataset?.mascotSource || node?.getAttribute("src");
    function nodeFor(image, spec) {
      if (spec.frame === undefined) {
        const node = image.cloneNode();
        node.className = className;
        node.alt = "";
        node.setAttribute("aria-hidden", "true");
        return node;
      }
      const node = document.createElement("span");
      node.className = className + " mascot-sprite";
      node.setAttribute("aria-hidden", "true");
      node.dataset.mascotSource = spec.src;
      node.dataset.spriteFrame = String(spec.frame);
      const canvas = document.createElement("span");
      canvas.className = "mascot-canvas";
      const img = image.cloneNode();
      img.className = "sprite-sheet";
      img.alt = "";
      img.draggable = false;
      img.style.height = (spec.rows || 2) * 100 + "%";
      img.style.left = -(spec.frame % 4) * 100 + "%";
      img.style.top = -Math.floor(spec.frame / 4) * 100 + "%";
      canvas.append(img);
      node.append(canvas);
      return node;
    }
    function stop() {
      animation?.cancel();
      animation = null;
      incoming?.remove();
      incoming = null;
    }
    function promote(token, node) {
      if (token !== generation || incoming !== node) return;
      const old = current;
      current = node;
      incoming = null;
      const oldAnimation = animation;
      animation = null;
      current.classList.remove("mascot-next");
      current.dataset.mascotPhase = "stable";
      old?.remove();
      oldAnimation?.cancel();
    }
    function sync(override) {
      const slot = document.querySelector(selector);
      if (!slot) {
        generation++;
        stop();
        desired = "";
        // Retain one small ready pose for instant re-entry; release detached atlas nodes.
        if (current?.classList.contains("mascot-sprite")) current = null;
        return;
      }
      const nextLayout = slot.closest(".fullbody-pending") ? "full" : "normal";
      if (layout && nextLayout !== layout) {
        generation++;
        stop();
        current = slot;
        desired = "";
      }
      layout = nextLayout;
      const spec = override || {
          src: slot.getAttribute("src") || source(slot),
        },
        key = spec.src + ":" + (spec.frame ?? "pose");
      if (!current) {
        current = slot;
        current.dataset.mascotSource = source(slot);
      }
      if (slot !== current) {
        // UI248: keep decoded pixels, but adopt the new scene's layout immediately.
        // A retained image otherwise brings its old width/height and inline grid area.
        for (const node of [current,incoming].filter(Boolean)) {
          const sprite = node.classList.contains("mascot-sprite");
          node.className = slot.className;
          node.classList.toggle("mascot-sprite",sprite);
          node.classList.toggle("mascot-next",node === incoming);
          node.style.cssText = slot.style.cssText;
          for (const name of ["width","height"]) {
            const value = slot.getAttribute(name);
            if (value === null) node.removeAttribute(name); else node.setAttribute(name,value);
          }
        }
        slot.replaceWith(current);
        if (incoming) current.after(incoming);
      }
      if (desired === key) return;
      desired = key;
      const token = ++generation;
      stop();
      if (
        spec.frame === undefined &&
        source(current) === spec.src &&
        !current.classList.contains("mascot-sprite") &&
        current.complete &&
        current.naturalWidth > 0
      ) {
        prepare(spec.src).catch(() => {});
        return;
      }
      current.dataset.mascotPhase = "preparing";
      prepare(spec.src)
        .then((image) => {
          if (token !== generation || !current?.parentElement) return;
          if (spec.frame === undefined && source(current) === spec.src &&
              current.tagName === "IMG" && current.complete && current.naturalWidth > 0) {
            current.dataset.mascotPhase = "stable";
            return;
          }
          const next = nodeFor(image, spec);
          for (const name of ["width","height"]) {
            const value = current.getAttribute(name);
            if (value === null) next.removeAttribute(name); else next.setAttribute(name,value);
          }
          next.classList.add("mascot-next");
          incoming = next;
          current.after(next);
          if (current.closest(".fullbody-pending")) {
            next.style.gridArea = "portrait";
            current.style.gridArea = "portrait";
          }
          if (
            (spec.frame !== undefined &&
              !current.classList.contains("mascot-sprite")) ||
            reduced.matches ||
            document.hidden ||
            typeof next.animate !== "function"
          ) {
            next.dataset.mascotMotion = reduced.matches ? "reduced" : "instant";
            promote(token, next);
            return;
          }
          const duration =
            spec.frame === undefined ? 240 : (spec.fadeMs ?? 160);
          next.dataset.mascotMotion = "crossfade";
          animation = next.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration,
            easing: "linear",
            fill: "forwards",
          });
          animation.finished.then(
            () => promote(token, next),
            () => promote(token, next),
          );
        })
        .catch(() => {
          if (token === generation && current)
            current.dataset.mascotPhase = "stable";
        });
    }
    function settle() {
      if (incoming) promote(generation, incoming);
    }
    return { sync, prepare, settle, reset() { generation++; stop(); current = null; desired = ""; layout = ""; } };
  }
  const large = track(
    ".onboard-greeting .onboard-mascot:not(.mascot-next)",
    "onboard-mascot",
  );
  const compact = track(
    ".lookup-portrait .lookup-mascot:not(.mascot-next)",
    "lookup-mascot",
  );
  const tour = track(".tour-mascot:not(.mascot-next)", "tour-mascot");
  let timer = null,
    requestKey = null,
    index = 0,
    scene = null,
    tourSource = null;
  function clear() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }
  function sync() {
    readyPane(document);
    const request = document.querySelector(".lookup-state[data-lookup-phase]");
    const pendingLookup = !!document.querySelector(".lookup-pending");
    const phase = request?.dataset.lookupPhase;
    const fullbody = !!document.querySelector(".fullbody-pending");
    const requested = ["searching","slow"].includes(phase) || (phase === "pending" && fullbody)
      ? "search" : phase === "empty" ? "empty" : null;
    const hasPortrait = !!document.querySelector(".onboard-mascot,.lookup-mascot");
    const terminal = phase === "error" || (!request && !pendingLookup);
    if (requested || pendingLookup || !hasPortrait || (request && closing && request.dataset.lookupRequest !== closing.request)) closing = null;
    if (!requested && previousScene === "search" && terminal && hasPortrait && !reduced.matches)
      closing = {request:previousRequest};
    previousScene = requested;
    if (requested) previousRequest = request.dataset.lookupRequest;
    scene = closing ? "closing" : requested;
    const key = scene ? scene + ":" + (closing?.request ?? request?.dataset.lookupRequest) : null;
    if (key !== requestKey) { clear(); index=0; requestKey=key; }
    if (reduced.matches) { closing=null; scene=requested; clear(); index=scene === "empty" ? 3 : 0; }
    let spec=null;
    if (scene) {
      const src=scene === "closing"
        ? fullbody ? "assets/mascot-finish-full-v2.webp" : "assets/mascot-finish-compact-v2.webp"
        : scene === "search" ? fullbody ? "assets/mascot-search-full-v2.webp" : "assets/mascot-search-compact-v2.webp"
        : fullbody ? "assets/mascot-finish-full-v2.webp" : "assets/mascot-finish-compact-v2.webp";
      spec={src,frame:index,rows:1,fadeMs:240};
      if(scene === "search") prepare(fullbody ? "assets/mascot-finish-full-v2.webp" : "assets/mascot-finish-compact-v2.webp").catch(()=>{});
    }
    if (!spec && phase === "error") spec = {src:"assets/mascot-catalog-settled-compact-v2.webp"};
    // LIVE-23: the editor keeps its approved thoughtful guide; lookup feedback has its own compact portrait.
    large.sync(document.querySelector('.additional-address-edit') ? {src:'assets/onboarding-guide-house.webp'} : spec); compact.sync(spec);
    tour.sync(tourSource ? {src:tourSource} : null);
    for (const selector of [".onboard-greeting", ".lookup-portrait"]) {
      const host=document.querySelector(selector);
      if(host) { if(scene) host.dataset.lookupMood=scene+"-"+index; else delete host.dataset.lookupMood; }
    }
    if (!scene || reduced.matches || document.hidden) { clear(); return; }
    if ((scene === "search" || index<3) && timer === null) {
      const expected=key;
      const id=setTimeout(()=>{
        if(timer !== id || requestKey !== expected) return;
        timer=null;
        index=scene === "search" ? (index+1)%4 : index+1;
        sync();
      },scene === "search" ? searchFrameDuration(index) : closeHolds[index]);
      timer=id;
    }
  }
  reduced.addEventListener("change", () => {
    large.settle();
    compact.settle();
    tour.settle();
    sync();
  });
  document.addEventListener("visibilitychange", sync);
  window.addEventListener("pagehide", () => {
    clear();
    large.settle();
    compact.settle();
    tour.settle();
  });
  window.addEventListener("pageshow", sync);
  prepare("assets/onboarding-guide-peeking-extended-v1.webp").catch(() => {});
  prepare("assets/schedule-unpublished.webp").catch(() => {});
  prepare("assets/mascot-technician.webp").catch(() => {});
  prepare("assets/tour-neutral.webp").catch(() => {});
  prepare("assets/tour-invite-v2.webp").catch(() => {});
  function frameEmpty(root) {
    for (const portrait of root.querySelectorAll(".schedule-empty-portrait")) {
      const scene = portrait.closest(".schedule-empty"),
        speech = scene.querySelector(".schedule-empty-speech");
      const width = scene.clientWidth,
        scale =
          parseFloat(
            getComputedStyle(document.getElementById("app")).getPropertyValue(
              "--scale",
            ),
          ) || 1;
      // Adapt to actual speech and available block width; never inflate a card just to fit legs.
      const full = width >= 300 && scale <= 1.25 && speech.scrollHeight <= 220;
      portrait.classList.toggle("portrait-full", full);
    }
  }
  function readyPane(root) {
    const images = [...root.querySelectorAll("img[data-ready-src]")];
    frameEmpty(root);
    return Promise.all(
      images.map((node) => {
        const src = node.dataset.readySrc;
        if (node.dataset.ready === "true") return Promise.resolve();
        return prepare(src).then(
          () => {
            if (node.isConnected && node.dataset.readySrc === src) {
              node.src = src;
              node.dataset.ready = "true";
              frameEmpty(root);
            }
          },
          () => {
            node.dataset.ready = "fallback";
          },
        );
      }),
    );
  }
  window.addEventListener("resize", () => frameEmpty(document));
  window.SvitloMascot = {
    sync,
    prepare,
    readyPane,
    submitFallback,
    warmEntry() {
      return large
        .prepare("assets/mascot-search-compact-v2.webp")
        .catch(() => null);
    },
    warmSubmit() {
      return Promise.all([
        prepare("assets/onboarding-guide-ready-extended-v1.webp"),
        prepare("assets/mascot-search-full-v2.webp"),
        prepare("assets/tour-neutral.webp"),
        prepare("assets/tour-point-up-left-v3.webp"),
      ]).catch(() => null);
    },
    tourPose(src, immediate = false) {
      tourSource = src;
      if (immediate) {
        // UI249: an entering step must never display the preceding pointing pose.
        const slot = document.querySelector(".tour-mascot");
        if (slot) { slot.setAttribute("src",src); slot.dataset.mascotSource = src; }
        tour.reset();
      }
      tour.sync(src ? { src } : null);
    },
  };
})();
