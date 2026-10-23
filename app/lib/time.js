export const ZONE = "Europe/Kyiv";
const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
export function parts(ms) {
  return Object.fromEntries(
    fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
  );
}
export function dayKey(ms = Date.now()) {
  const p = parts(ms);
  return `${p.year}-${p.month}-${p.day}`;
}
export function addDays(day, n) {
  return new Date(Date.parse(day + "T12:00:00Z") + n * 86400000)
    .toISOString()
    .slice(0, 10);
}
export function civil(day, minute = 0) {
  if (minute === 1440) return civil(addDays(day, 1), 0);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || minute < 0 || minute >= 1440)
    throw Error("Некоректна дата");
  const expected = `${day}T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  const utc = Date.parse(expected + ":00Z"),
    candidates = [];
  for (const offset of [120, 180]) {
    const t = utc - offset * 60000,
      p = parts(t);
    if (`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}` === expected)
      candidates.push(t);
  }
  if (candidates.length !== 1) throw Error("Неоднозначний час джерела");
  return candidates[0];
}
export function sourceTime(s) {
  if (typeof s !== "string") throw Error("Час відсутній");
  const m = s.match(/(\d{2}):(\d{2})\s+(\d{2})\.(\d{2})\.(\d{4})/);
  if (m)
    return civil(`${m[5]}-${m[4]}-${m[3]}`, Number(m[1]) * 60 + Number(m[2]));
  if (/(?:Z|[+-]\d{2}:\d{2})$/.test(s)) {
    const t = Date.parse(s);
    if (Number.isFinite(t)) return t;
  }
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/);
  if (iso) return civil(iso[1], +iso[2] * 60 + +iso[3]);
  throw Error("Невідомий час джерела");
}
export function monday(day = dayKey()) {
  const d = new Date(day + "T12:00Z").getUTCDay();
  return addDays(day, -((d + 6) % 7));
}
export function week(day = dayKey()) {
  return Array.from({ length: 7 }, (_, i) => addDays(monday(day), i));
}
export function clock(ms) {
  return new Intl.DateTimeFormat("uk-UA", {
    timeZone: ZONE,
    hour: "2-digit",
    minute: "2-digit",
  }).format(ms);
}
export function stamp(ms) {
  return new Intl.DateTimeFormat("uk-UA", {
    timeZone: ZONE,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(ms);
}
export function duration(minutes) {
  const h = Math.floor(minutes / 60),
    m = Math.round(minutes % 60);
  return (
    [h ? `${h} год` : "", m ? `${m} хв` : ""].filter(Boolean).join(" ") ||
    "0 год"
  );
}
export function fresh(t, now = Date.now()) {
  return Number.isFinite(t) && t <= now + 300000 && t >= now - 7200000;
}
