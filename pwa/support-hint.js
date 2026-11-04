"use strict";
//221: a passive teaching spotlight. Decoration never locks the underlying app.
window.SvitloSupportHint = {
  create({app, page, root}) {
    let target = null, frame = 0, description = null, anchorGap = 12;
    function hide(restoreFocus = false) {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      const returnTo = restoreFocus && root.contains(document.activeElement) ? target : null;
      if (target?.getAttribute("aria-describedby") === "support-hint-copy") {
        if (description === null) target.removeAttribute("aria-describedby");
        else target.setAttribute("aria-describedby", description);
      }
      target = null;
      root.hidden = true;
      root.replaceChildren();
      returnTo?.focus({preventScroll: true});
    }
    function layout() {
      frame = 0;
      if (!target?.isConnected || root.hidden) return hide();
      const tr = target.getBoundingClientRect(), pr = page.getBoundingClientRect(), rr = root.getBoundingClientRect();
      //223: keep the conversation pinned while the dimmed page scrolls underneath.
      const targetVisible = tr.top >= pr.top - 1 && tr.bottom <= pr.bottom + 1 && tr.width > 0 && tr.height > 0;
      const ring = root.querySelector(".support-highlight"), panel = root.querySelector(".support-hint");
      ring.hidden = !targetVisible;
      root.querySelector(".support-shade").hidden = targetVisible;
      Object.assign(ring.style, {
        left: tr.left - rr.left - 2 + "px", top: tr.top - rr.top - 2 + "px",
        width: tr.width + 4 + "px", height: tr.height + 4 + "px",
        borderRadius: (parseFloat(getComputedStyle(target).borderTopLeftRadius) || 0) + 2 + "px",
      });
      panel.style.top = Math.max(pr.top - rr.top + 8, pr.bottom - rr.top - panel.offsetHeight - anchorGap) + "px";
      const figure = panel.querySelector(".support-figure"), bubble = panel.querySelector(".support-bubble");
      const fr = figure.getBoundingClientRect(), br = bubble.getBoundingClientRect();
      panel.style.setProperty("--support-tail-top", Math.max(14, Math.min(br.height - 14, fr.top + fr.height * .32 - br.top)) + "px");
      const diameter = fr.width * 1.7, left = fr.left - rr.left - (diameter - fr.width) / 2;
      const top = fr.top - rr.top - (diameter - fr.height) / 2;
      const clearBelow = (targetVisible ? tr.top - 6 : pr.bottom) - rr.top;
      Object.assign(root.querySelector(".support-blur").style, {
        left: left + "px", top: top + "px", width: diameter + "px", height: diameter + "px",
        clipPath: `inset(0 0 ${Math.max(0, top + diameter - clearBelow)}px 0)`,
      });
    }
    function sync() {
      if (target && !frame) frame = requestAnimationFrame(layout);
    }
    function show(button, {text, preview = false}) {
      hide();
      target = button;
      description = button.getAttribute("aria-describedby");
      anchorGap = Math.max(12, page.getBoundingClientRect().bottom - button.getBoundingClientRect().top + 12);
      const shade = document.createElement("div"), blur = document.createElement("div");
      shade.className = "support-shade";
      blur.className = "support-blur";
      shade.setAttribute("aria-hidden", "true");
      blur.setAttribute("aria-hidden", "true");
      const ring = document.createElement("div");
      ring.className = "support-highlight";
      ring.setAttribute("aria-hidden", "true");
      const panel = document.createElement("aside");
      panel.className = "support-hint";
      panel.dataset.preview = String(preview);
      panel.setAttribute("role", "region");
      panel.setAttribute("aria-label", "Підтримка Світла");
      panel.innerHTML = '<div class="support-bubble"><p id="support-hint-copy"></p><button class="action" data-action="support-dismiss">Зрозуміло</button></div><div class="support-figure" aria-hidden="true"><img src="assets/support-bowl-point-down-left-v2.webp" width="152" height="152" alt=""></div>';
      panel.querySelector("p").textContent = text;
      button.setAttribute("aria-describedby", "support-hint-copy");
      root.replaceChildren(shade, ring, blur, panel);
      root.hidden = false;
      layout();
    }
    function retarget(button) {
      if (root.hidden || !button) return hide();
      if (target?.getAttribute("aria-describedby") === "support-hint-copy") {
        if (description === null) target.removeAttribute("aria-describedby");
        else target.setAttribute("aria-describedby", description);
      }
      target = button;
      description = button.getAttribute("aria-describedby");
      target.setAttribute("aria-describedby", "support-hint-copy");
      layout();
    }
    page.addEventListener("scroll", sync, {passive: true});
    window.addEventListener("resize", sync);
    window.visualViewport?.addEventListener("resize", sync);
    return {show, hide, sync, retarget, visible: () => !root.hidden};
  },
};
