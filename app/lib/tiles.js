import { clock, dayKey } from "./time.js";
import { isOutage } from "./schedule.js";
import { powerIcon } from "./icons.js";
export const escapeHTML = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const kindLabel = {
  clear: "відключень не заплановано",
  unknown: "немає точних даних",
  hourly: "погодинне відключення",
  planned: "планові роботи",
  emergency: "аварійне відключення",
};
export const tileClock = (t, date) => (dayKey(t) > date ? "24:00" : clock(t));
export function hourTile(h, date, now, range = false, iconStyle = "bolt") {
  const parts = h.segments,
    mixed = parts[0].kind !== parts[1].kind;
  const outages = parts.filter((p) => isOutage(p.kind));
  const color = (k) => `var(--${k === "clear" ? "button" : k})`;
  const bg = `linear-gradient(to ${range ? "bottom" : "right"},${parts.map((p, i) => `${color(p.kind)} ${i * 50}% ${(i + 1) * 50}%`).join(",")})`;
  const label = parts
    .map(
      (p) =>
        `${tileClock(p.start, date)}–${tileClock(p.end, date)}: ${kindLabel[p.kind]}`,
    )
    .join("; ");
  const only = outages.length === 1 ? outages[0] : null;
  const start = range && only ? only.start : h.start,
    end = range && only ? only.end : h.end;
  const icon = (k) => powerIcon(isOutage(k), k === "unknown", iconStyle);
  let body;
  if (range) {
    const icons = mixed
      ? parts
          .map((p, i) =>
            isOutage(p.kind) || !outages.length
              ? `<span class="tile-icon half-${i}" style="color:${isOutage(p.kind) ? "var(--outage-ink)" : "var(--ink)"}">${icon(p.kind)}</span>`
              : "",
          )
          .join("")
      : `<span class="tile-icon whole">${icon(parts[0].kind)}</span>`;
    body = `${icons}<span class="tile-times"><span class="tile-time tile-start" style="color:${isOutage(parts[0].kind) ? "var(--outage-ink)" : "var(--ink)"}">${tileClock(start, date)}</span><span class="tile-time tile-end" style="color:${isOutage(parts[1].kind) ? "var(--outage-ink)" : "var(--ink)"}">${tileClock(end, date)}</span></span>`;
  } else {
    const content = `<span>${powerIcon(outages.length > 0, !outages.length && parts.some((p) => p.kind === "unknown"), iconStyle)}</span><span>${clock(h.start)}</span>`;
    body = `<span class="legacy-label">${content}</span>`;
    if (mixed)
      parts.forEach((p, i) => {
        if (isOutage(p.kind))
          body += `<span class="legacy-label legacy-copy" style="clip-path:inset(0 ${i ? 0 : 50}% 0 ${i ? 50 : 0}%)">${content}</span>`;
      });
  }
  return `<div role="img" class="hour ${iconStyle === "bulb" ? "icon-bulb" : ""} ${range ? "range-hour" : ""} ${mixed ? "mixed" : ""} ${outages.length === 2 ? "outage" : ""} ${parts.some((p) => p.kind === "unknown") ? "unknown" : ""} ${now >= h.start && now < h.end ? "current" : ""}" style="background:${bg}" aria-label="${escapeHTML(label + "; округлено до 30 хвилин")}"><span class="tile-content" aria-hidden="true">${body}</span></div>`;
}
// Measures actual text and font scaling instead of forcing four unreadable columns.
export function fitHours(grid) {
  if (!grid) return () => {};
  const update = () => {
    const cell = grid.querySelector(".hour");
    if (!cell) return;
    const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const time = cell.querySelector(".tile-time") || cell;
    const ctx = document.createElement("canvas").getContext("2d");
    const textStyle = getComputedStyle(time);
    ctx.font = `${textStyle.fontWeight} ${textStyle.fontSize} ${textStyle.fontFamily}`;
    const minimum =
      ctx.measureText("24:00").width + cell.querySelector(".icon").getBoundingClientRect().width + 14;
    const width = grid.clientWidth,
      max = width > 650 ? 6 : root >= 23 ? 3 : 4;
    let count = max;
    while (count > 1 && (width - (count - 1) * 6) / count < minimum) count--;
    grid.style.gridTemplateColumns = `repeat(${count},minmax(0,1fr))`;
  };
  const observer = new ResizeObserver(update);
  observer.observe(grid);
  update();
  return () => observer.disconnect();
}
