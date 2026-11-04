"use strict";
// Geometry transcribed from the current Android 1.6.0 / 25 Canvas and vector resources.
// Provenance and limits: qa/native-style-sources.json and NATIVE-FIDELITY.md.
(() => {
  const rays = (
    radius,
    end,
    cx = 0,
    cy = 0,
    angles = [0, 45, 90, 135, 180, 225, 270, 315],
  ) =>
    angles
      .map((a) => {
        const r = (a * Math.PI) / 180;
        return `<path d="M${cx + Math.cos(r) * radius} ${cy + Math.sin(r) * radius}L${cx + Math.cos(r) * end} ${cy + Math.sin(r) * end}"/>`;
      })
      .join("");
  const svg = (body, box, stroke, cls = "") =>
    `<svg class="glyph native-glyph ${cls}" viewBox="${box}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
  function icon(name, cls = "") {
    if (name === "access")
      return svg('<circle cx="10" cy="6" r="4"/><path d="M10 22H5a3 3 0 0 1-3-3 7 7 0 0 1 7-7h3a7 7 0 0 1 2.5.5"/><circle cx="18" cy="18" r="5" fill="currentColor" stroke="none"/><path d="M18 15.5v5M15.5 18h5" stroke="var(--bg)"/>',"0 0 24 24",1.8,cls);
    if (name === "moon")
      return svg(
        '<path d="M20.5 14A8.5 8.5 0 0 1 10 3.5A8.5 8.5 0 1 0 20.5 14Z"/>',
        "0 0 24 24",
        1.8,
        cls,
      );
    if (name === "sun" && cls.includes("large-symbol"))
      return svg(
        '<circle cx="12" cy="12" r="4"/>' + rays(6, 9, 12, 12),
        "0 0 24 24",
        1.5,
        cls,
      );
    if (name === "sun")
      return svg(
        '<circle cx="14" cy="14" r="4"/>' + rays(7, 9, 14, 14),
        "0 0 28 28",
        1.6,
        "summary-glyph " + cls,
      );
    if (name === "clock")
      return svg(
        '<circle cx="14" cy="14" r="8"/><path d="M14 14V10M14 14L17 16"/>',
        "0 0 28 28",
        1.6,
        "summary-glyph " + cls,
      );
    if (name === "share")
      return svg(
        '<path d="M3 21C3 12 7 7 14 7L14 3L22 11L14 19L14 14C8 14 5 17 3 21Z"/>',
        "0 0 24 24",
        1.4,
        "share-glyph " + cls,
      );
    if (name === "bell" || name === "bell-off")
      return svg(
        '<path d="M5 21L8 17V12C8 4 20 4 20 12V17L23 21Z"/><path d="M17 23A3 3 0 0 1 11 23M14 3V5"/>' +
          (name === "bell-off" ? '<path d="M3 3L25 25"/>' : ""),
        "0 0 28 28",
        2,
        "bell-glyph " + cls,
      );
    if (name === "chevron")
      return svg('<path d="M8 12L16 20L24 12"/>', "0 0 32 32", 2.5, cls);
    if (name === "edit")
      return svg(
        '<path d="M14 5L19 10M4 16L3 21L8 20L21 7L17 3Z"/>',
        "0 0 24 24",
        1.8,
        cls,
      );
    if (name === "house")
      return svg(
        '<path d="M3 10.5L12 3L21 10.5M5 9V21H19V9M9 21V14H15V21"/>',
        "0 0 24 24",
        1.8,
        cls,
      );
    if (name === "sensor")
      return svg(
        '<path d="M8 3V8M16 3V8M6 8H18V13A6 6 0 0 1 6 13ZM12 19V22"/>',
        "0 0 24 24",
        1.8,
        cls,
      );
    if (name === "settings")
      return svg('<path d="M4 7H9M15 7H20M4 17H13M19 17H20"/><circle cx="12" cy="7" r="3"/><circle cx="16" cy="17" r="3"/>', "0 0 24 24", 1.8, cls);
    if (name === "users")
      return svg('<circle cx="9" cy="8" r="3"/><path d="M3 21V18A6 6 0 0 1 15 18V21M17 5A3 3 0 0 1 17 11M18 15A5 5 0 0 1 21 19V21"/>', "0 0 24 24", 2.5, cls);
    return "";
  }
  function power(off = false, unknown = false, bulbs = false) {
    if (unknown)
      return '<span class="glyph power-glyph" aria-hidden="true">?</span>';
    const shape = bulbs
      ? `<circle cx="0" cy="-1" r="4" fill="${off ? "none" : "currentColor"}" stroke="${off ? "currentColor" : "none"}"/><path d="M-2 4H2M-1.5 6H1.5"/>${off ? "" : rays(6, 7.5, 0, -1, [-150, -90, -30, 30, 150])}`
      : `<path d="M2 -7L-4 1H0L-2 7L4 -1H0Z" fill="${off ? "none" : "currentColor"}" stroke="${off ? "currentColor" : "none"}"/>${off ? '<path d="M-5.5 -6L5.5 6"/>' : ""}`;
    return svg(shape, "-7 -7 14 14", 1.3, "power-glyph " + (off ? "off" : ""));
  }
  const measure = document.createElement("canvas").getContext("2d");
  function matching(buttons, maximum, minimum, wholeLabel = true) {
    const fits = (size) =>
      buttons.every((button) => {
        const cs = getComputedStyle(button),
          dot = button.querySelector(".options-dot"),
          extra = dot
            ? dot.getBoundingClientRect().width +
              (parseFloat(cs.columnGap) || 0)
            : 0,
          room =
            button.clientWidth -
            parseFloat(cs.paddingLeft) -
            parseFloat(cs.paddingRight) -
            extra;
        measure.font = `400 ${size}px "Svitlo Roboto"`;
        const labels = wholeLabel
          ? [button.textContent.trim()]
          : button.textContent.trim().split(/\s+/);
        return labels.every(
          (label) => Math.ceil(measure.measureText(label).width) <= room,
        );
      });
    let size = maximum;
    if (!fits(size)) {
      let low = minimum,
        high = Math.floor(maximum);
      while (low < high) {
        const mid = Math.floor((low + high + 1) / 2);
        if (fits(mid)) low = mid;
        else high = mid - 1;
      }
      size = low;
    }
    buttons.forEach((button) => (button.style.fontSize = size + "px"));
  }
  // Shared pane geometry: use the actual content width for every pane, before measuring motion.
  function fitLegend(legend) {
    const app = legend.closest(".phone");
    if (!app || !legend.clientWidth) return;
    const scale =
      parseFloat(getComputedStyle(app).getPropertyValue("--scale")) || 1;
    const maximum = 14 * scale,
      minimum = Math.max(11, Math.ceil(11 * Math.min(scale, 1.25)));
    const labels = [...legend.querySelectorAll(".legend-item")];
    const gap = parseFloat(getComputedStyle(legend).columnGap) || 16;
    function apply(size) {
      legend.style.fontSize = size + "px";
      legend.style.setProperty("--legend-side", (20 * size) / 14 + "px");
      return labels.reduce(
        (sum, label) => sum + label.getBoundingClientRect().width,
        gap * Math.max(0, labels.length - 1),
      );
    }
    let size = maximum;
    while (apply(size) > legend.clientWidth + 0.5 && size > minimum)
      size = Math.max(minimum, size - 0.5);
    apply(size);
  }
  function fitGrids(scope = document) {
    const app = document.getElementById("app");
    if (!app) return;
    const scale =
      parseFloat(getComputedStyle(app).getPropertyValue("--scale")) || 1;
    measure.font = `500 ${Math.min(14 * scale, 24)}px "Svitlo Roboto"`;
    const minimum =
      measure.measureText("24:00").width + 14 * Math.min(scale, 2) + 14;
    scope.querySelectorAll(".hour-grid").forEach((grid) => {
      const gap = parseFloat(getComputedStyle(grid).columnGap) || 6;
      const available = grid.clientWidth - 6,
        preferred = app.clientWidth >= 600 ? 6 : 4;
      let columns = preferred;
      while (
        columns > 2 &&
        (available - gap * (columns - 1)) / columns < minimum
      )
        columns--;
      grid.style.gridTemplateColumns = `repeat(${columns},minmax(0,1fr))`;
    });
  }
  function fitSummary() {
    const app = document.getElementById("app");
    if (!app) return;
    const scale =
      parseFloat(getComputedStyle(app).getPropertyValue("--scale")) || 1;
    app.querySelectorAll(".summary-grid").forEach((group) => {
      const cards = [...group.querySelectorAll(".summary-card")];
      if (!cards.length) return;
      group.style.setProperty(
        "--summary-padding",
        Math.max(10, Math.min(16, app.clientWidth / 26)) + "px",
      );
      group.style.setProperty(
        "--summary-icon-size",
        Math.min(28, 20 * Math.sqrt(scale)) + "px",
      );
      const fit = (variable, selector, max, min) => {
        const nodes = [...group.querySelectorAll(selector)];
        let size = max;
        const fits = () =>
          nodes.every((n) => n.scrollWidth <= n.clientWidth + 1);
        group.style.setProperty(variable, size + "px");
        while (!fits() && size > min) {
          size = Math.max(min, size - 0.5);
          group.style.setProperty(variable, size + "px");
        }
      };
      fit("--summary-heading-size", ".summary-heading", 13 * scale, 11);
      fit("--summary-value-size", ".summary-value", 44 * scale, 18);
      group.style.setProperty(
        "--summary-caption-size",
        Math.min(12 * scale, 15) + "px",
      );
    });
  }
  function fitSingle(node, max, min) {
    if (!node) return;
    let size = max;
    node.style.fontSize = size + "px";
    while (node.scrollWidth > node.clientWidth + 0.5 && size > min) {
      size = Math.max(min, size - 0.5);
      node.style.fontSize = size + "px";
    }
  }
  function fit() {
    const app = document.getElementById("app");
    if (!app) return;
    const scale =
      parseFloat(getComputedStyle(app).getPropertyValue("--scale")) || 1;
    const nav = [...app.querySelectorAll(".bottom-nav button")].filter(
      (x) => x.offsetParent !== null,
    );
    if (nav.length) matching(nav, 15 * scale, 12);
    app.querySelectorAll(".actions:not(.one)").forEach((row) => {
      const buttons = [...row.querySelectorAll(".action")];
      if (!buttons.length) return;
      const schedule = row.closest(".schedule-card");
      matching(
        buttons,
        (schedule ? 15 : 14) * scale,
        schedule ? 12 : 10,
        !schedule,
      );
    });
    app.querySelectorAll(".legend").forEach(fitLegend);
    fitGrids(app);
    fitSummary();
    fitSingle(
      app.querySelector(".home-header .app-title"),
      22 * Math.min(scale, 1.4),
      16,
    );
    fitSingle(app.querySelector(".queue-line"), 12 * Math.min(scale, 1.3), 10);
    fitSingle(
      app.querySelector(".compact-address .address-primary"),
      21 * Math.min(scale, 1.35),
      16,
    );
    const status = app.querySelector(".header-status");
    if (status) {
      let size = 13 * scale;
      const label = status.querySelector(".header-status-label");
      status.style.fontSize = size + "px";
      while (
        label &&
        (label.clientHeight > size * 1.35 * 2 + 1 ||
          label.scrollWidth > label.clientWidth + 1 ||
          status.scrollWidth > status.clientWidth + 1) &&
        size > 11
      ) {
        size -= 0.5;
        status.style.fontSize = size + "px";
      }
    }
    fitSingle(
      app.querySelector(".weather-city"),
      17 * scale,
      12 * Math.min(scale, 1.25),
    );
  }
  window.SvitloNativeUI = { icon, power, fit, fitLegend, fitGrids, fitSummary };
  document.fonts?.ready.then(fit);
  document.fonts?.addEventListener("loadingdone", fit);
  window.addEventListener("resize", () => requestAnimationFrame(fit));
})();
