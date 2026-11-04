"use strict";
window.SvitloGuideTour = {
  //189: six authored poses preserve the asymmetric body; never mirror/rotate it.
  poses: [
    {id:"up-left",tip:[.164,.28],ray:[-1,-.95]},
    {id:"up-right",tip:[.8,.27],ray:[1,-1.05]},
    {id:"down-left",tip:[.166,.67],ray:[-1,.95]},
    {id:"down-right",tip:[.81,.70],ray:[1,1.05]},
    {id:"up",tip:[.28,.215],ray:[-.05,-1]},
    {id:"down",tip:[.717,.65],ray:[.02,1]},
  ],
  pointing(target, panel, width, height) {
    const clamp = (n,a,b) => Math.max(a,Math.min(b,n));
    const corners = [target.left,(target.left+target.right)/2,target.right]
      .flatMap(x=>[target.top,(target.top+target.bottom)/2,target.bottom].map(y=>({x,y})));
    let best = null;
    for (const side of ["right","left"]) for (const pose of this.poses) for (const shift of pose.id === "up" ? [0,12] : [0]) {
      // Up pose has transparent right padding: a small translation can align its fingertip
      // with an edge button while retaining a wide, readable conversation.
      const x = (side === "right" ? panel.right-width : panel.left) + shift;
      const localX = (pose.tip[0]*1.35-.175)*width, localY = (pose.tip[1]*1.35-.1)*width;
      const ray = {x:pose.ray[0],y:pose.ray[1]}, maximum = Math.max(0,panel.height-height);
      const offsets = [0,maximum/2,maximum,...corners.map(p=>clamp(p.y-ray.y/ray.x*(p.x-x-localX)-localY-panel.top,0,maximum))];
      for (const offset of offsets) {
        const tip = {x:x+localX,y:panel.top+offset+localY};
        let enter=0,leave=Infinity;
        for (const axis of ["x","y"]) {
          const low=axis==="x"?target.left:target.top, high=axis==="x"?target.right:target.bottom;
          const a=(low-tip[axis])/ray[axis], b=(high-tip[axis])/ray[axis];
          enter=Math.max(enter,Math.min(a,b));leave=Math.min(leave,Math.max(a,b));
        }
        const hits=leave>=enter;
        const angle=hits?0:Math.min(...corners.map(p=>{
          const dx=p.x-tip.x,dy=p.y-tip.y;
          return Math.acos(clamp((dx*ray.x+dy*ray.y)/Math.hypot(dx,dy)/Math.hypot(ray.x,ray.y),-1,1))*180/Math.PI;
        }));
        const distance=Math.hypot(tip.x-(target.left+target.right)/2,tip.y-(target.top+target.bottom)/2);
        const score=angle*100+(side==="left"?.5:0)+shift*.001+distance*.0001+(maximum-offset)*.0001;
        if(!best||score<best.score)best={side,pose:pose.id,shift,offset,tip,ray,hits,angle,score};
      }
    }
    return best;
  },
  create(ctx) {
    const app = document.getElementById("app"),
      root = document.getElementById("tour-root"),
      page = document.getElementById("page-scroll"),
      nav = app.querySelector(".bottom-nav");
    const base = [
      {
        id: "address",
        tab: "home",
        target: ".address-trigger",
        title: "Твоя адреса",

        text: (s) => say("address", s),
      },
      {
        id: "add",
        tab: "home",
        target: ".address-add",
        title: "Додай ще одну адресу",

        text: () => "Натисни «+», щоб додати ще одну адресу.",
      },
      {
        id: "week",
        tab: "home",
        target: ".schedule-core",
        title: "Твій графік",

        text: (s) => say("graph", s),
      },
      {
        id: "summary",
        tab: "home",
        target: ".summary-grid",
        title: "Підсумки дня",

        text: (s) => say("summary", s),
      },
      {
        id: "share",
        tab: "home",
        target: '[data-action="share"]',
        title: "Поділись графіком",

        text: (s) => say("shareCopy", s),
      },
      {
        id: "messages",
        tab: "messages",
        target: '[data-tab="messages"]',
        title: "Повідомлення",

        text: (s) =>
          s.target === "pwa"
            ? "Тут знайдеш повідомлення про зміни твого графіка."
            : "Тут знайдеш повідомлення про зміни графіка й нові версії «Світла».",
      },
      {
        id: "options",
        tab: "options",
        target: '[data-tab="options"]',
        title: "Усе під тебе",

        text: (s) =>
          (s.target === "pwa"
            ? "В «Опціях» змінюй вигляд і налаштовуй сповіщення застосунку."
            : "В «Опціях» змінюй вигляд і нагадування та знаходь віджети.") +
          (s.preferencesStatus === "pending"
            ? " Крапка означає незавершені налаштування."
            : ""),
      },
    ];
    let frame = 0,
      signature = "",
      previousFocus = null,
      hint = false,
      docked = false,
      dockHeight = 0;
    const visible = () => !root.hidden;
    const say = (id, state) =>
      window.SvitloPolicy.text(id, state, app.clientWidth);
    const steps = (state) =>
      window.SvitloPolicy.tourIds({
        count: state.addresses.length,
        graph: ctx.hasGraph?.() === true,
        summary: ctx.hasSummary?.() === true,
        share: ctx.canShare?.() === true,
      }).map((id) => base.find((s) => s.id === id));
    function hide() {
      page.style.removeProperty("max-height");
      page.style.removeProperty("flex");
      page.removeAttribute("tabindex");
      page.removeAttribute("aria-label");
      nav.style.removeProperty("margin-top");
      docked = false;
      root.hidden = true;
      root.replaceChildren();
      delete root.dataset.mode;
      app.classList.remove("tour-active");
      app.classList.remove("tour-graph-step");
      window.SvitloMascot?.tourPose(null);
      signature = "";
      page.inert = false;
      nav.inert = false;
      hint = false;
    }
    function lock() {
      if (!app.classList.contains("tour-active")) ctx.cancelMotion?.();
      app.classList.add("tour-active");
      root.dataset.mode = "active";
      page.inert = true;
      nav.inert = true;
    }
    function suspend() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      hide();
    }
    function completeHint() {
      const state = ctx.getState();
      if (hint) {
        state.addressHint = "seen";
        ctx.save();
        suspend();
        ctx.collapseAddresses();
        app.querySelector(".address-trigger")?.focus({ preventScroll: true });
      }
    }
    function finish(status) {
      const state = ctx.getState();
      state.guideTour = {
        ...state.guideTour,
        status: status === "skipped" ? "deferred" : status,
      };
      ctx.save();
      suspend();
      if (status === "completed") {
        ctx.go("home");
        app.querySelector(".address-trigger")?.focus({ preventScroll: true });
      } else
        (previousFocus?.isConnected
          ? previousFocus
          : nav.querySelector('[aria-current="page"]')
        )?.focus({ preventScroll: true });
      previousFocus = null;
    }
    function layout() {
      frame = 0;
      const state = ctx.getState();
      if (ctx.blocked()) {
        hide();
        return;
      }
      const offer = ["awaiting", "offered"].includes(state.guideTour?.status);
      if (offer && ctx.hasGraph?.() && ctx.getTab() === "home") {
        state.guideTour.status = "offered";
        if (signature !== "offer") {
          hide();
          signature = "offer";
          root.dataset.stepId = "offer";
          root.dataset.mode = "offer";
          root.innerHTML = `<aside class="tour-offer" role="region" aria-labelledby="tour-offer-title"><div class="tour-offer-bubble"><p id="tour-offer-title">Давай я покажу, що тут де знаходиться?</p><div class="tour-actions"><button class="action tour-skip" data-action="tour-defer">Потім</button><button class="action tour-next" data-action="tour-accept">Давай</button></div></div><img src="assets/tour-invite-v2.webp" width="116" height="140" alt="" aria-hidden="true"></aside>`;
          root.hidden = false;
          page.inert = false;
          nav.inert = false;
          ctx.save();
        }
        // The invitation is passive. Only accepting it starts a modal spotlight.
        root.querySelector(".tour-offer").style.bottom =
          Math.max(8, root.getBoundingClientRect().bottom - nav.getBoundingClientRect().top + 8) + "px";
        return;
      }
      const main = state.guideTour?.status === "active";
      const wantHint =
        !main &&
        state.addressHint === "pending" &&
        state.addresses.length > 1 &&
        ctx.getTab() === "home";
      if (!main && !wantHint) {
        hide();
        return;
      }
      let list = steps(state);
      if (!list.length) {
        hide();
        return;
      }
      if (
        main &&
        state.addresses.length === 1 &&
        state.guideTour.stepId === "address"
      )
        state.guideTour.stepId = "add";
      let index = main
        ? list.findIndex((s) => s.id === state.guideTour.stepId)
        : 0;
      if (index < 0) {
        const order = base.findIndex((s) => s.id === state.guideTour.stepId);
        index = list.findIndex((s) => base.indexOf(s) > order);
        if (index < 0) index = list.length - 1;
      }
      if (main) {
        state.guideTour.stepId = list[index].id;
        state.guideTour.step = index;
      }
      const hintStep = Math.min(1, Number(state.addressHintStep) || 0);
      const step = wantHint
        ? hintStep === 0
          ? {
              id: "address-hint-list",
              tab: "home",
              target: ".address-list-rows",
              title: "Адреси тепер тут",

              text: () =>
                "Замість «+» з’явилась стрілка зі списком адрес. Обирай адресу, а через олівець змінюй назву чи видаляй її.",
            }
          : {
              id: "address-hint-add",
              tab: "home",
              target: ".address-list-add",
              title: "Додай ще одну адресу",

              text: () =>
                "Натисни «Додати адресу» внизу списку, щоб додати наступну.",
            }
        : list[index];
      if (ctx.getTab() !== step.tab) {
        ctx.go(step.tab);
        return;
      }
      if (wantHint && !app.querySelector(".address-list-add")) {
        ctx.expandAddresses();
        return;
      }
      app.classList.toggle("tour-graph-step", step.id === "week");
      const target = app.querySelector(step.target);
      if (!target) {
        if (main && index < list.length - 1) {
          state.guideTour.stepId = list[index + 1].id;
          state.guideTour.step = index + 1;
          ctx.save();
          sync();
        } else if (main) finish("completed");
        return;
      }
      lock();
      page.style.removeProperty("max-height");
      page.style.removeProperty("flex");
      page.removeAttribute("tabindex");
      page.removeAttribute("aria-label");
      nav.style.removeProperty("margin-top");
      const key = [step.id, state.target, state.addresses.length, state.preferencesStatus, state.font].join(":");
      const changedStep = signature !== key || root.hidden;
      if (changedStep) {
        if (root.hidden) previousFocus = document.activeElement;
        signature = key;
        root.hidden = false;
        hint = wantHint;
        root.dataset.stepId = step.id;
        root.innerHTML = `<div class="tour-highlight" aria-hidden="true"></div><section class="tour-dialog" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-progress tour-copy"><div class="tour-bubble"><div class="tour-body"><p id="tour-progress">${hint ? `Підказка ${hintStep + 1} із 2` : `Крок ${index + 1} із ${list.length}`}</p><h2 id="tour-title">${step.title}</h2><p id="tour-copy">${ctx.esc(step.text(state))}</p></div><div class="tour-actions">${hint ? "" : '<button class="action tour-skip" data-action="tour-skip">Пропустити</button>'}<button class="action tour-next" data-action="${hint ? "tour-hint-done" : "tour-next"}">${hint ? (hintStep === 0 ? "Далі" : "Зрозуміло") : index === list.length - 1 ? "Зрозуміло" : "Далі"}</button></div></div><div class="tour-figure" aria-hidden="true"><img class="tour-mascot" src="assets/tour-neutral.webp" width="112" height="124" alt=""></div></section>`;
      }
      const rr = root.getBoundingClientRect(), panel = root.querySelector(".tour-dialog");
      const maximum = Math.max(130, Math.min(330, rr.height - nav.offsetHeight - 100));
      panel.style.setProperty("--tour-max-height", maximum + "px");
      const height = panel.getBoundingClientRect().height;
      docked = page.contains(target) && target.offsetHeight + height + nav.offsetHeight + 32 > app.clientHeight;
      if (docked) {
        dockHeight = height;
        page.style.maxHeight = Math.max(60, app.clientHeight - nav.offsetHeight - height - 32) + "px";
        page.style.flex = "0 1 auto";
        nav.style.marginTop = "auto";
      }
      if (page.contains(target)) {
        const r = target.getBoundingClientRect(), pr = page.getBoundingClientRect();
        if (changedStep || r.top < pr.top + 8 || (!docked && r.bottom > pr.bottom - 8)) {
          target.scrollIntoView({block:"start", behavior:"instant"});
          page.scrollTop = Math.max(0, page.scrollTop - 8);
        }
      }
      // A short target near the end of scroll content may not reach the top.
      // Reserve a separate conversation area if neither free side fits it.
      if (page.contains(target) && !docked) {
        const r = target.getBoundingClientRect(), navTop = nav.getBoundingClientRect().top;
        if (navTop - r.bottom - 20 < height && r.top - rr.top - 20 < height) {
          docked = true;
          page.style.maxHeight = Math.max(60, app.clientHeight - nav.offsetHeight - height - 32) + "px";
          page.style.flex = "0 1 auto";
          nav.style.marginTop = "auto";
          target.scrollIntoView({block:"start",behavior:"instant"});
          page.scrollTop = Math.max(0,page.scrollTop-8);
        }
      }
      let tr = target.getBoundingClientRect();
      if (page.contains(target)) {
        const pr = page.getBoundingClientRect(), top = Math.max(tr.top, pr.top + 4), bottom = Math.min(tr.bottom, pr.bottom - 4);
        tr = {left:tr.left, right:tr.right, top, bottom, width:tr.width, height:Math.max(0,bottom-top)};
      }
      if (!tr.width || !tr.height) { hide(); return; }
      const gap = Math.max(0, Math.min(4,tr.left-rr.left,rr.right-tr.right,tr.top-rr.top,rr.bottom-tr.bottom));
      const top = tr.top - rr.top - gap, bottom = tr.bottom - rr.top + gap;
      const ring = root.querySelector(".tour-highlight"), radius = parseFloat(getComputedStyle(target).borderTopLeftRadius)||0;
      Object.assign(ring.style,{left:tr.left-rr.left-gap+"px",top:top+"px",width:tr.width+gap*2+"px",height:tr.height+gap*2+"px",borderRadius:radius+gap+"px"});
      const navTop = nav.getBoundingClientRect().top - rr.top;
      const below = navTop - bottom - 20, above = top - 20;
      panel.style.top = Math.max(8, Math.min(rr.height-height-8,
        docked ? navTop-height-12 : below >= height ? bottom+12 : above >= height ? top-height-12 : navTop-height-12)) + "px";
      const body = panel.querySelector(".tour-body");
      body.tabIndex = body.scrollHeight > body.clientHeight + 1 ? 0 : -1;
      if (body.tabIndex === 0) body.setAttribute("aria-label","Пояснення кроку");
      else body.removeAttribute("aria-label");
      const figure=panel.querySelector(".tour-figure"),pb=panel.getBoundingClientRect();
      const aim=window.SvitloGuideTour.pointing(tr,pb,figure.offsetWidth,figure.offsetHeight);
      panel.dataset.figureSide=aim.side;
      figure.style.left=aim.shift+"px";
      panel.style.setProperty("--tour-figure-offset",aim.offset+"px");
      panel.style.setProperty("--tour-tail-top",Math.max(16,Math.min(pb.height-16,aim.offset+figure.offsetWidth*.45))+"px");
      if(panel.dataset.pointPose!==aim.pose){
        panel.dataset.pointPose=aim.pose;
        window.SvitloMascot?.tourPose("assets/tour-point-"+aim.pose+"-v3.webp",true);
      }
      if (!root.contains(document.activeElement)) root.querySelector(".tour-next")?.focus({preventScroll:true});
    }
    function sync() {
      if (!frame) frame = requestAnimationFrame(layout);
    }
    function handle(action) {
      if (!visible()) return;
      if (action === "tour-accept") {
        const state = ctx.getState();
        state.guideTour = {
          ...state.guideTour,
          status: "active",
          step: 0,
          stepId: steps(state)[0]?.id,
        };
        ctx.save();
        suspend();
        root.hidden = false;
        lock();
        sync();
        return;
      }
      if (action === "tour-defer") {
        finish("deferred");
        return;
      }
      if (action === "tour-hint-done") {
        const state = ctx.getState();
        if ((state.addressHintStep || 0) === 0) {
          state.addressHintStep = 1;
          ctx.save();
          sync();
        } else completeHint();
        return;
      }
      if (action === "tour-skip") {
        finish("skipped");
        return;
      }
      if (action === "tour-next") {
        const state = ctx.getState(),
          list = steps(state);
        if (
          state.guideTour.stepId &&
          state.guideTour.stepId !== root.dataset.stepId
        )
          return;
        let index = list.findIndex((s) => s.id === state.guideTour.stepId);
        if (index < 0) index = state.guideTour.step || 0;
        if (index >= list.length - 1) {
          finish("completed");
          return;
        }
        state.guideTour = {
          ...state.guideTour,
          step: index + 1,
          stepId: list[index + 1].id,
          version: 2,
        };
        ctx.save();
        sync();
      }
    }
    document.addEventListener("keydown", (event) => {
      if (!visible()) return;
      if (signature === "offer") {
        if (event.key === "Escape" && root.contains(document.activeElement)) {
          event.preventDefault();
          finish("deferred");
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        if (hint) completeHint();
        else finish("skipped");
      }
      if (event.key === "Tab") {
        const controls = [
          ...root.querySelectorAll('button,.tour-body[tabindex="0"]'),
        ];

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
    //186: decoration is transparent, but an active tour is a real input lock.
    // Inert alone does not stop touch/wheel scroll; never punch a hole at the ring.
    const active = () => visible() && root.dataset.mode === "active";
    for (const type of ["wheel", "touchmove"]) app.addEventListener(type, event => {
      if (active() && !root.querySelector(".tour-body")?.contains(event.target)) event.preventDefault();
    }, {capture:true,passive:false});
    for (const type of ["click", "pointerdown", "keydown"]) app.addEventListener(type, event => {
      if (active() && !root.contains(event.target)) {
        event.preventDefault(); event.stopImmediatePropagation();
      }
    }, true);
    window.addEventListener("resize", sync);
    window.visualViewport?.addEventListener("resize", sync);
    page.addEventListener(
      "scroll",
      () => {
        if (visible()) sync();
      },
      { passive: true },
    );
    window.addEventListener("pageshow", sync);
    return {
      sync,
      handle,
      visible,
      isOffer: () => visible() && signature === "offer",
      suspend,
    };
  },
};
