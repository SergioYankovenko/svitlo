import { civil, sourceTime, dayKey, addDays } from "./time.js";
import { OUTAGE_TYPES_VERSION } from "./outage-types.js";
export const ORIGIN = "https://www.cherkasyoblenergo.com";
export const QUEUES = Array.from({ length: 6 }, (_, i) => [
  `${i + 1}.1`,
  `${i + 1}.2`,
]).flat();
export function plain(html) {
  return String(html)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/?(?:p|div|br|tr|li|h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#160;|\u00a0/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .split("\n")
    .map((x) => x.replace(/[\t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}
export function rows(value) {
  const r = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.values(value)
      : null;
  if (!r || r.some((x) => !x || typeof x !== "object" || Array.isArray(x)))
    throw Error("Некоректна відповідь джерела");
  return r;
}
export function article(root) {
  const d = root?.data;
  if (
    !root?.success ||
    !d ||
    !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,199}$/.test(d.slug) ||
    typeof d.content !== "string"
  )
    throw Error("Некоректна публікація");
  return {
    id: String(d.id),
    title: plain(d.title),
    body: plain(d.content),
    publishedAt: sourceTime(d.publishedAt),
    url: `${ORIGIN}/media/${d.slug}`,
  };
}
const months =
  "січня лютого березня квітня травня червня липня серпня вересня жовтня листопада грудня".split(
    " ",
  );
export function dates(text, published) {
  const result = [];
  for (const m of text.matchAll(/(?<!\d)(\d{1,2})[.](\d{1,2})[.](20\d{2})/g))
    result.push(`${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`);
  for (const m of text.matchAll(
    new RegExp(
      `(?<!\\d)(\\d{1,2})\\s+(${months.join("|")})(?:\\s+(20\\d{2}))?`,
      "gi",
    ),
  )) {
    const year = +dayKey(published).slice(0, 4),
      mon = months.indexOf(m[2].toLowerCase()) + 1;
    const options = (m[3] ? [+m[3]] : [year - 1, year, year + 1])
      .map(
        (y) => `${y}-${String(mon).padStart(2, "0")}-${m[1].padStart(2, "0")}`,
      )
      .sort(
        (a, b) =>
          Math.abs(Date.parse(a) - published) -
          Math.abs(Date.parse(b) - published),
      );
    result.push(options[0]);
  }
  return [...new Set(result)];
}
export function parsePlan(a, checkedAt) {
  if (
    !/гпв|погодинн[а-яіїєґ]*\s+відключ/i.test(a.title) ||
    /гоп|обмеженн.*потужност/i.test(a.title)
  )
    return [];
  const ds = dates(a.title, a.publishedAt),
    fallback = ds.length ? ds : dates(a.body, a.publishedAt);
  if (fallback.length !== 1) return [];
  const date = fallback[0],
    rowRe =
      /^\s*(?:(?:під)?черг[а-яіїєґ]*\s*)?([1-6])\s*\.\s*([12])\s*[:–—-]?\s*(.*?)\s*$/i;
  const lines = [];
  for (const line of a.body.split("\n")) {
    if (
      /^[,;]?\s*\d{1,2}\s*:/.test(line) &&
      lines.length &&
      rowRe.test(lines.at(-1))
    )
      lines[lines.length - 1] += ", " + line;
    else lines.push(line);
  }
  const matches = lines.map((x) => x.match(rowRe)).filter(Boolean),
    found = new Map();
  for (const m of matches) {
    const q = m[1] + "." + m[2];
    found.set(q, [...(found.get(q) || []), m[3]]);
  }
  const partial =
    /^(оновлено|оновлення|змінено|уточнено|коригування|зміни до)/i.test(
      a.title,
    );
  // Unsupported prose never becomes a clear day. Explicit per-queue cancellation is supported.
  return (partial ? [...found.keys()] : QUEUES).map((queue) => {
    const list = found.get(queue) || [],
      text = list[0] || "",
      cancellation =
        /^(?:скасовано|без відключень|не застосовуються)[.!]?$/i.test(text);
    let uncertain = list.length !== 1 || (!partial && found.size !== 12),
      events = [];
    if (!cancellation) {
      const re =
          /(?<!\d)(\d{1,2}):\s*(\d{2})\s*[-–—−]\s*(\d{1,2}):\s*(\d{2})(?!\d)/g,
        spans = [...text.matchAll(re)];
      if (!spans.length || !/^[\s,;.!]*$/.test(text.replace(re, "")))
        uncertain = true;
      try {
        for (const m of spans) {
          const [h, s, H, S] = m.slice(1).map(Number);
          if (h > 23 || s > 59 || H > 24 || S > 59 || (H === 24 && S))
            throw Error();
          const start = civil(date, h * 60 + s),
            end = civil(date, H * 60 + S);
          if (end <= start) throw Error();
          events.push({ start, end, category: "hourly" });
        }
        events.sort((a, b) => a.start - b.start);
        if (events.some((x, i) => i && x.start < events[i - 1].end))
          throw Error();
      } catch {
        uncertain = true;
      }
    }
    if (uncertain) events = [];
    return {
      date,
      queue,
      events,
      uncertain,
      publishedAt: a.publishedAt,
      checkedAt,
      url: a.url,
      revision: JSON.stringify([uncertain, events]),
    };
  });
}
export function parseOutages(root, category, checkedAt) {
  if (!root || root.error || root.ERROR || !("DISCONNECTIONS" in root))
    throw Error("Немає переліку відключень");
  const events = rows(root.DISCONNECTIONS)
    .filter(
      (x) => !/скасован|відмін|cancelled|canceled/i.test(x.STATE_CHAR || ""),
    )
    .map((x) => {
      const start = sourceTime(x.DATE_START),
        raw = plain(x.DATE_TIME || x.DATE_STOP || ""),
        match = raw.match(/\d{2}:\d{2}\s+\d{2}\.\d{2}\.\d{4}/),
        end = match ? sourceTime(match[0]) : null;
      if (end !== null && end <= start) throw Error("Некоректний інтервал");
      return { start, end, category, plannedEnd: /план/i.test(raw),
        ...(category === "planned" ? {
          unplanned: typeof x.DISCONN_TYPE === "string" && /позаплан/i.test(x.DISCONN_TYPE),
        } : {}),
      };
    });
  const info = root.DISCONN_QUEUQ
    ? rows(root.DISCONN_QUEUQ)
        .map((x) => x.QUEUE_INFO || "")
        .filter((s) => /погодин/i.test(s))
    : [];
  const queues = [
    ...new Set(
      info.flatMap((s) =>
        [...s.matchAll(/([1-6])\s*черга\s*([12])\s*підчерга/gi)].map(
          (m) => m[1] + "." + m[2],
        ),
      ),
    ),
  ];
  return {
    events,
    ...(category === "planned" ? { outageTypesVersion: OUTAGE_TYPES_VERSION } : {}),
    queue: queues.length === 1 ? queues[0] : null,
    checkedAt,
    sourceAt: root.DATETIME ? sourceTime(root.DATETIME) : null,
  };
}
export function parseEmergency(a) {
  const text = a.title + "\n" + a.body;
  if (!/графік[а-яіїєґ]*\s+аварійн[а-яіїєґ]*\s+відключ/i.test(a.title))
    return null;
  const ended = /скасован|відмінено|припинено|не застосовуються/i.test(a.title);
  if (!ended && !/застосован|введен|запроваджен/i.test(a.title)) return null;
  if (
    !ended &&
    /можлив|можуть|у разі|навчан|тренуван|не\s+(?:застосован|введен)/i.test(
      text,
    )
  )
    return null;
  const ds = dates(a.body, a.publishedAt),
    time = a.body.match(/(?:з|із|о)\s*(\d{1,2}):(\d{2})/i);
  let effectiveAt = a.publishedAt;
  try {
    if (ds.length === 1 && time)
      effectiveAt = civil(ds[0], +time[1] * 60 + +time[2]);
  } catch {
    return null;
  }
  const scope = [
    ...new Set(
      [...text.matchAll(/(?:підчерг[а-яіїєґ]*\s*)([1-6]\.[12])/gi)].map(
        (m) => m[1],
      ),
    ),
  ];
  if (
    !/по області|по Черкаській області|у Черкаській області|на території.*област/i.test(
      text,
    ) &&
    !scope.length
  )
    return null;
  let validity = "unknown";
  if (
    /(?:продовжують діяти|діють).*графік[а-яіїєґ]* погодинн|погодинн[а-яіїєґ]*.*(?:продовжує діяти|продовжують діяти)/i.test(
      text,
    )
  )
    validity = "active";
  if (
    /погодинн[а-яіїєґ]*.*(?:не діють|не діє|призупин|не застосов)|(?:призупинено|не діють).*погодинн/i.test(
      text,
    )
  )
    validity = "suspended";
  let until = null;
  const end = a.body.match(/до\s+(\d{1,2}):(\d{2})/i);
  if (end && ds.length === 1) {
    try {
      until = civil(ds[0], +end[1] * 60 + +end[2]);
      if (until <= effectiveAt) until = null;
    } catch {}
  }
  return {
    id: a.id,
    publishedAt: a.publishedAt,
    effectiveAt,
    until,
    ended,
    validity,
    queues: scope,
    url: a.url,
  };
}
export function mergeHistory(old, next, now) {
  const byId = new Map();
  for (const x of [...old, ...next])
    if (
      x.updatedAt >= now - 7 * 86400000 &&
      x.updatedAt <= now + 300000 &&
      (!byId.has(x.id) || x.updatedAt > byId.get(x.id).updatedAt)
    )
      byId.set(x.id, x);
  return [...byId.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 150);
}
