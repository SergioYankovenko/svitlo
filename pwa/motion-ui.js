"use strict";
window.SvitloMotionUI = (() => {
  const timing = Object.freeze({duration:220,easing:"cubic-bezier(.2,.7,.2,1)"});
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  function nav(root) {
    const pill = document.createElement("span");
    pill.className = "nav-pill";
    pill.ariaHidden = "true";
    root.prepend(pill);
    let animation = null,
      last = null;
    function sync(animate = true) {
      const selected = root.querySelector('[aria-current="page"]');
      if (!selected || !root.offsetWidth || !selected.offsetWidth) {
        last = null;
        animation?.cancel();
        return;
      }
      const n = root.getBoundingClientRect(),
        r = selected.getBoundingClientRect();
      const target = {
        left: r.left - n.left,
        top: r.top - n.top,
        width: r.width,
        height: r.height,
      };
      const current = last ? pill.getBoundingClientRect() : null;
      animation?.cancel();
      Object.assign(pill.style, {
        top: target.top + "px",
        width: target.width + "px",
        height: target.height + "px",
        borderRadius: getComputedStyle(selected).borderRadius,
        transform: `translateX(${target.left}px)`,
      });
      if (animate && last && !reduced.matches && current) {
        animation = pill.animate(
          [
            {
              transform: `translateX(${current.left - n.left}px)`,
              width: current.width + "px",
            },
            {
              transform: `translateX(${target.left}px)`,
              width: target.width + "px",
            },
          ],
          timing,
        );
      }
      last = target;
    }
    new ResizeObserver(() => sync(false)).observe(root);
    document.fonts?.ready.then(() => sync(false));
    reduced.addEventListener("change", () => sync(false));
    window.addEventListener("pageshow", () => sync(false));
    return { sync };
  }
  function pager(ctx) {
    let root = null,
      current = null,
      neighbor = null,
      drag = null,
      animation = null,
      seq = 0,
      pendingDate = null,
      offset = 0,
      suppressSensorClickUntil = 0;
    let indicator = null,
      indicatorAnimation = null,
      week = null;
    const datePlus = (key, delta) => {
      const d = window.SvitloClock.date(key);
      d.setUTCDate(d.getUTCDate() + delta);
      return window.SvitloClock.key(d);
    };
    const allowed = (date) => ctx.allowed?.(date) !== false;
    function indicatorX(date) {
      if (!week) return 0;
      const buttons = [...week.querySelectorAll("[data-date]")],
        selected = buttons.find((x) => x.dataset.date === date);
      if (selected) return selected.offsetLeft + selected.offsetWidth / 2 - 12;
      const first = buttons[0],
        last = buttons.at(-1);
      if (!first || !last) return 0;
      return date < first.dataset.date ? -12 : week.clientWidth;
    }
    function underline(x, animate = false) {
      if (!indicator || !week) return;
      const from =
        indicator.getBoundingClientRect().left -
        week.getBoundingClientRect().left;
      indicatorAnimation?.cancel();
      indicator.style.left = "0px";
      indicator.style.transform = `translateX(${x}px)`;
      if (animate && !reduced.matches)
        indicatorAnimation = indicator.animate(
          [
            { transform: `translateX(${from}px)` },
            { transform: `translateX(${x}px)` },
          ],
          timing,
        );
    }
    function cancel(reset = true) {
      seq++;
      animation?.forEach((a) => a.cancel());
      animation = null;
      neighbor?.remove();
      neighbor = null;
      drag = null;
      pendingDate = null;
      offset = 0;
      if (current) current.style.transform = "";
      if (root) {
        root.style.height = "";
        root.classList.remove("is-moving");
      }
      if (reset) underline(indicatorX(ctx.date()));
    }
    function legends(pane) {
      if (pane) window.SvitloNativeUI?.fitGrids(pane);
      const legend = pane?.querySelector(".legend");
      if (!legend) return;
      window.SvitloNativeUI?.fitLegend(legend);
    }
    function mount() {
      cancel(false);
      root = document.getElementById("day-pager");
      current = root?.querySelector(".day-pane");
      week = document.querySelector(".week");
      const placeholder = week?.querySelector(".day-indicator");
      if (placeholder) {
        if (indicator) placeholder.replaceWith(indicator);
        else indicator = placeholder;
        underline(indicatorX(ctx.date()));
      }
      legends(current);
      window.SvitloMascot?.readyPane?.(current || document);
    }
    function adjacent(date) {
      if (neighbor?.dataset.date === date) return;
      neighbor?.remove();
      neighbor = document.createElement("div");
      neighbor.className = "day-pane day-neighbor";
      neighbor.dataset.date = date;
      neighbor.ariaHidden = "true";
      neighbor.inert = true;
      neighbor.innerHTML = ctx.content(date);
      root.append(neighbor);
      legends(current);
      legends(neighbor);
      window.SvitloMascot?.readyPane?.(neighbor);
      root.style.height = current.scrollHeight + "px";
    }
    function place(dx, direction) {
      const width = root.clientWidth;
      current.style.transform = `translateX(${dx}px)`;
      if (neighbor)
        neighbor.style.transform = `translateX(${dx + direction * width}px)`;
      const a = indicatorX(ctx.date()),
        b = indicatorX(datePlus(ctx.date(), direction));
      underline(a + (b - a) * Math.min(1, Math.abs(dx) / width));
    }
    function go(date, fromDrag = false) {
      if (!root || !current || !allowed(date) || ctx.blocked()) return;
      if (date === ctx.date()) {
        cancel();
        return;
      }
      if (reduced.matches) {
        cancel();
        ctx.commit(date);
        return;
      }
      const direction = date > ctx.date() ? 1 : -1,
        width = root.clientWidth;
      const start = fromDrag
        ? offset
        : current.getBoundingClientRect().left -
          root.getBoundingClientRect().left;
      seq++;
      const token = seq;
      animation?.forEach((a) => a.cancel());
      adjacent(date);
      pendingDate = date;
      root.classList.add("is-moving");
      place(start, direction);
      underline(indicatorX(date), true);
      animation = [
        current.animate(
          [
            { transform: `translateX(${start}px)` },
            { transform: `translateX(${-direction * width}px)` },
          ],
          {
            ...timing,
            fill: "forwards",
          },
        ),
        neighbor.animate(
          [
            { transform: `translateX(${start + direction * width}px)` },
            { transform: "translateX(0px)" },
          ],
          {
            ...timing,
            fill: "forwards",
          },
        ),
        root.animate(
          [
            { height: root.getBoundingClientRect().height + "px" },
            { height: neighbor.scrollHeight + "px" },
          ],
          {
            ...timing,
            fill: "forwards",
          },
        ),
      ];
      Promise.all(animation.map((a) => a.finished)).then(
        () => {
          if (token === seq && allowed(date)) ctx.commit(date);
          else if (token === seq) cancel();
        },
        () => {},
      );
    }
    function down(e) {
      if (
        !root ||
        !root.contains(e.target) ||
        (e.target.closest("button,a,input") && !e.target.closest(".sensor-tile-details")) ||
        ctx.blocked() ||
        (e.pointerType === "mouse" && e.button !== 0)
      )
        return;
      suppressSensorClickUntil = 0;
      cancel();
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, started: false };
    }
    function move(e) {
      if (!drag || drag.id !== e.pointerId || !root) return;
      const dx = e.clientX - drag.x,
        dy = e.clientY - drag.y;
      if (!drag.started) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
          drag = null;
          return;
        }
        if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
        drag.started = true;
        root.setPointerCapture(e.pointerId);
        root.classList.add("is-moving");
      }
      const direction = dx < 0 ? 1 : -1,
        date = datePlus(ctx.date(), direction);
      if (!allowed(date)) {
        offset = 0;
        neighbor?.remove();
        neighbor = null;
        place(0, direction);
        return;
      }
      adjacent(date);
      offset = Math.max(-root.clientWidth, Math.min(root.clientWidth, dx));
      place(offset, direction);
    }
    function up(e, cancelled = false) {
      if (!drag || drag.id !== e.pointerId) return;
      const started = drag.started;
      drag = null;
      if (!started) return;
      suppressSensorClickUntil = performance.now() + 350;
      if (
        !cancelled &&
        Math.abs(offset) >= Math.min(65, root.clientWidth * 0.2)
      ) {
        go(datePlus(ctx.date(), offset < 0 ? 1 : -1), true);
        return;
      }
      if (!neighbor) {
        cancel();
        return;
      }
      const token = ++seq,
        direction = offset < 0 ? 1 : -1,
        width = root.clientWidth;
      if (reduced.matches) {
        cancel();
        return;
      }
      underline(indicatorX(ctx.date()), true);
      animation = [
        current.animate(
          [
            { transform: `translateX(${offset}px)` },
            { transform: "translateX(0px)" },
          ],
          { duration: 180, easing: "ease-out" },
        ),
        neighbor.animate(
          [
            { transform: `translateX(${offset + direction * width}px)` },
            { transform: `translateX(${direction * width}px)` },
          ],
          { duration: 180, easing: "ease-out" },
        ),
      ];
      Promise.all(animation.map((a) => a.finished)).then(
        () => {
          if (token === seq) cancel();
        },
        () => {},
      );
    }
    const app = document.getElementById("app");
    app.addEventListener("click", (e) => {
      if (e.detail && e.target.closest(".sensor-tile-details") &&
          performance.now() < suppressSensorClickUntil) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true);
    app.addEventListener("pointerdown", down);
    app.addEventListener("pointermove", move);
    app.addEventListener("pointerup", up);
    app.addEventListener("pointercancel", () => {
      if (drag) up({ pointerId: drag.id }, true);
    });
    app.addEventListener("keydown", (e) => {
      if (e.target !== root || ctx.blocked()) return;
      if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault();
        go(
          datePlus(pendingDate || ctx.date(), e.key === "ArrowRight" ? 1 : -1),
        );
      }
    });
    function settlePending() {
      const date = pendingDate;
      cancel();
      if (date && allowed(date)) ctx.commit(date);
    }
    reduced.addEventListener("change", settlePending);
    window.addEventListener("resize", settlePending);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) settlePending();
    });
    document.fonts?.ready.then(() => {
      legends(current);
      legends(neighbor);
    });
    return { mount, go, cancel };
  }

  return { nav, pager, timing };
})();
