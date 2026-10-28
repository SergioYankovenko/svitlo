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
  unplanned: "позапланове відключення",
  emergency: "аварійне відключення",
};
export const tileClock = (t, date) => (dayKey(t) > date ? "24:00" : clock(t));
// Repeated civil hours share one visual tile; their real half-hour segments stay intact.
export function groupRepeatedHours(hours) {
  const tiles = [];
  for (const hour of hours) {
    const previous = tiles.at(-1);
    if (previous && dayKey(previous.start) === dayKey(hour.start) &&
        clock(previous.start) === clock(hour.start)) {
      tiles[tiles.length - 1] = { ...previous, end: hour.end,
        segments: [...previous.segments, ...hour.segments], clockChange: true };
    } else tiles.push(hour);
  }
  return tiles;
}
export function hourTile(h, date, now, range = false, iconStyle = "bolt") {
  const parts = h.segments,
    mixed = parts.some((p) => p.kind !== parts[0].kind),
    segmented = range || h.clockChange, count = parts.length;
  const outages = parts.filter((p) => isOutage(p.kind));
  const color = (k) => `var(--${k === "clear" ? "button" : k})`;
  const bg = `linear-gradient(to ${segmented ? "bottom" : "right"},${parts.map((p, i) => `${color(p.kind)} ${i * 100 / count}% ${(i + 1) * 100 / count}%`).join(",")})`;
  const label = parts
    .map(
      (p, i) => h.clockChange
        ? `${i + 1}-й сегмент, 30 хвилин: ${kindLabel[p.kind]}`
        : `${tileClock(p.start, date)}–${tileClock(p.end, date)}: ${kindLabel[p.kind]}`,
    )
    .join("; ");
  const only = outages.length === 1 ? outages[0] : null;
  const start = range && !h.clockChange && only ? only.start : h.start,
    end = range && !h.clockChange && only ? only.end : h.end;
  const icon = (k) => powerIcon(isOutage(k), k === "unknown", iconStyle);
  const iconInk = k => isOutage(k) ? "var(--outage-ink)" : "var(--ink)";
  const timeInk = k => k === "unplanned" ? "var(--unplanned-time)" : iconInk(k);
  const timeStyle = k => `color:${timeInk(k)}${k === "unplanned" ? ';--clock-time-ink:var(--unplanned-time);--clock-time-bg:transparent' : ''}`;
  let body;
  if (segmented) {
    const icons = mixed
      ? parts
          .map((p, i) =>
            h.clockChange || isOutage(p.kind) || !outages.length
              ? `<span class="tile-icon half-${i}" style="top:${(i + 0.5) * 100 / count}%;color:${iconInk(p.kind)}">${icon(p.kind)}</span>`
              : "",
          )
          .join("")
      : `<span class="tile-icon whole" style="color:${iconInk(parts[0].kind)}">${icon(parts[0].kind)}</span>`;
    body = `${icons}<span class="tile-times">${h.clockChange ? '<span class="clock-time-group">' : ""}<span class="tile-time tile-start" style="${timeStyle(parts[0].kind)}">${tileClock(start, date)}</span>${h.clockChange ? '<span class="clock-change">зміна часу</span></span>' : ""}${range ? `<span class="tile-time tile-end" style="${timeStyle(parts.at(-1).kind)}">${tileClock(end, date)}</span>` : ""}</span>`;
    if (h.clockChange && !mixed)
      body = `<span class="tile-times"><span class="clock-time-group"><span class="clock-main" style="color:${iconInk(parts[0].kind)}">${icon(parts[0].kind)}<span class="tile-time tile-start" style="${timeStyle(parts[0].kind)}">${tileClock(start, date)}</span></span><span class="clock-change">зміна часу</span></span>${range ? `<span class="tile-time tile-end" style="${timeStyle(parts[0].kind)}">${tileClock(end, date)}</span>` : ""}</span>`;
  } else {
    const content = k => `<span class="legacy-icon" style="color:${iconInk(k)}">${powerIcon(outages.length > 0, !outages.length && parts.some((p) => p.kind === "unknown"), iconStyle)}</span><span class="legacy-time" style="color:${timeInk(k)}">${clock(h.start)}</span>`;
    body = `<span class="legacy-label">${content(parts[0].kind)}</span>`;
    if (mixed)
      parts.forEach((p, i) => {
        body += `<span class="legacy-label legacy-copy" style="clip-path:inset(0 ${i ? 0 : 50}% 0 ${i ? 50 : 0}%)">${content(p.kind)}</span>`;
      });
  }
  return `<div role="img" class="hour ${iconStyle === "bulb" ? "icon-bulb" : ""} ${segmented ? "range-hour" : ""} ${h.clockChange ? "clock-shift" : ""} ${mixed ? "mixed" : ""} ${outages.length === count ? "outage" : ""} ${parts.some((p) => p.kind === "unknown") ? "unknown" : ""} ${now >= h.start && now < h.end ? "current" : ""}" style="background:${bg}" aria-label="${escapeHTML((h.clockChange ? tileClock(h.start, date) + ", зміна часу; " : "") + label + "; округлено до 30 хвилин")}"><span class="tile-content" aria-hidden="true">${body}</span></div>`;
}
// Measures actual text and font scaling instead of forcing four unreadable columns.
export function fitHours(grid) {
  if (!grid) return () => {};
  const update = () => {
    const cell = grid.querySelector(".hour");
    if (!cell) return;
    const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const time = cell.querySelector(".tile-time, .legacy-label") || cell;
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
