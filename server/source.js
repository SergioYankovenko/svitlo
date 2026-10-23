import {
  article,
  parsePlan,
  parseEmergency,
  parseOutages,
  rows,
  plain,
  ORIGIN,
} from "../app/lib/parsers.js";
import { dayKey, addDays } from "../app/lib/time.js";
const CABINET = "https://cabinet.cherkasyoblenergo.com/api_new/disconn.php";
export async function jsonFetch(url, fetcher = fetch, limit = 8_000_000) {
  const r = await fetcher(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(20000),
    redirect: "error",
  });
  if (!r.ok) throw Error("Джерело HTTP " + r.status);
  const reader = r.body.getReader();
  let size = 0,
    chunks = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw Error("Завелика відповідь");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let i = 0;
  for (const c of chunks) {
    all.set(c, i);
    i += c.length;
  }
  return JSON.parse(new TextDecoder().decode(all));
}
const norm = (s) =>
  plain(s)
    .toLowerCase()
    .replace(/[’ʼ]/g, "'")
    .replace(/^(місто|м\.)\s*/, "м ")
    .replace(/^(село|с\.)\s*/, "с ")
    .replace(/^(вулиця|вул\.)\s*/, "вул ")
    .replace(/^(провулок|пров\.)\s*/, "пров ")
    .replace(/\s+/g, " ")
    .trim();
export function matchesAddress(html, a) {
  const sections = [
    ...String(html).matchAll(/<strong\b[^>]*>(.*?)<\/strong>/gis),
  ];
  if (!sections.length || html.slice(0, sections[0].index).trim())
    throw Error("Невідомий формат адреси");
  let found = false;
  for (let i = 0; i < sections.length; i++) {
    const m = sections[i],
      body = html.slice(
        m.index + m[0].length,
        sections[i + 1]?.index ?? html.length,
      );
    if (norm(m[1]) !== norm(a.city)) continue;
    for (const line of body
      .split(/<br\s*\/?>/i)
      .map(norm)
      .filter(Boolean)) {
      const prefix = norm(a.street) + " ";
      if (!line.startsWith(prefix)) continue;
      const hs = line
        .slice(prefix.length)
        .split(",")
        .map((x) => x.replace(/\s/g, ""));
      if (
        hs.some(
          (x) =>
            !/^\d+[\p{L}]?(?:[/-][\d\p{L}]+)?$/u.test(x) || /^\d+-\d+$/.test(x),
        )
      )
        throw Error("Неоднозначний перелік будинків");
      if (hs.includes(norm(a.house).replace(/\s/g, ""))) found = true;
    }
  }
  return found;
}
export class Source {
  constructor(fetcher = fetch) {
    this.fetcher = fetcher;
    this.publicCache = null;
    this.pending = null;
    this.dictionaries = new Map();
  }
  request(params) {
    return jsonFetch(CABINET + "?" + new URLSearchParams(params), this.fetcher);
  }
  async dictionary(kind, args = {}) {
    const ops = {
      department: { op: "department_list" },
      city: { op: "city_list", dept_id: args.parent },
      street: { op: "street_list", city_id: args.parent, search_name: "" },
      house: { op: "house_list", street_id: args.parent, search_name: "" },
    };
    if (
      !ops[kind] ||
      (kind !== "department" && !/^[\w-]{1,100}$/.test(args.parent || ""))
    )
      throw Error("Оберіть адресу");
    const key = JSON.stringify(ops[kind]),
      cached = this.dictionaries.get(key);
    if (cached && cached.at > Date.now() - 3600000) return cached.value;
    const list = rows(await this.request(ops[kind])).map((x) => {
      const id = String(kind === "house" ? x.HOUSE : x.ID),
        name = String(kind === "house" ? x.HOUSE : x.NAME);
      if (id === "undefined" || name === "undefined")
        throw Error("Некоректний довідник");
      return { id, name };
    });
    if (this.dictionaries.size > 300) this.dictionaries.clear();
    this.dictionaries.set(key, { at: Date.now(), value: list });
    return list;
  }
  async resolve(input) {
    const a = {};
    for (const k of ["department", "cityId", "streetId", "house"]) {
      if (typeof input[k] !== "string" || input[k].length > 120 || !input[k])
        throw Error("Оберіть повну адресу");
      a[k] = input[k];
    }
    const depts = await this.dictionary("department");
    if (!depts.some((x) => x.id === a.department))
      throw Error("Невідома філія");
    const cities = await this.dictionary("city", { parent: a.department }),
      city = cities.find((x) => x.id === a.cityId);
    if (!city) throw Error("Невідомий населений пункт");
    const streets = await this.dictionary("street", { parent: a.cityId }),
      street = streets.find((x) => x.id === a.streetId);
    if (!street) throw Error("Невідома вулиця");
    const houses = await this.dictionary("house", { parent: a.streetId });
    if (!houses.some((x) => x.id === a.house)) throw Error("Невідомий будинок");
    Object.assign(a, {
      city: city.name,
      street: street.name,
      label: `${city.name}, ${street.name}, ${a.house}`,
    });
    const accounts = rows(
      await this.request({
        op: "ls_list_by_addr",
        street_id: a.streetId,
        house: a.house,
      }),
    ).map((x) => ({ account: String(x.LS), address: x.ADDRESS }));
    if (
      accounts.some(
        (x) => !/^\d{11}$/.test(x.account) || typeof x.address !== "string",
      )
    )
      throw Error("Некоректні дані адреси");
    const unique = [...new Set(accounts.map((x) => x.account))];
    if (unique.length === 1) a.account = unique[0];
    // Ambiguous/missing accounts use the exact dictionary address; personal names never leave the source adapter.
    return a;
  }
  async feed(now = Date.now(), previous = {}) {
    if (this.publicCache && this.publicCache.checkedAt > now - 3600000)
      return this.publicCache;
    if (previous.checkedAt > now - 3600000 && Array.isArray(previous.plans))
      return (this.publicCache = previous);
    if (this.pending) return this.pending;
    this.pending = this.loadFeed(now, previous)
      .then((v) => ((this.publicCache = v), v))
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
  async loadFeed(now, previous) {
    const items = [];
    for (let page = 0; page < 4; page++) {
      const r = await jsonFetch(
        `${ORIGIN}/api/v1/posts/category/news?lang=uk&page=${page}&size=10`,
        this.fetcher,
      );
      if (!r.success || !Array.isArray(r.data?.content))
        throw Error("Невідомий формат новин");
      items.push(...r.data.content);
    }
    const candidates = items
        .filter((x) =>
          /гпв|погодинн.*відключ|аварійн.*відключ/i.test(x.title || ""),
        )
        .slice(0, 24),
      plans = new Map(
        (previous.plans || [])
          .filter((p) => p.date >= addDays(dayKey(now), -7))
          .map((p) => [p.date + "/" + p.queue, p]),
      ),
      emergencies = new Map((previous.emergencies || []).map((x) => [x.id, x])),
      messages = [];
    for (let offset = 0; offset < candidates.length; offset += 4) {
      const batch = await Promise.all(
        candidates.slice(offset, offset + 4).map(async (item) => {
          if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,199}$/.test(item.slug))
            throw Error("Некоректне джерело");
          return article(
            await jsonFetch(
              `${ORIGIN}/api/v1/posts/${item.slug}?lang=uk`,
              this.fetcher,
            ),
          );
        }),
      );
      for (const a of batch) {
        if (a.publishedAt > now + 300000) continue;
        for (const p of parsePlan(a, now)) {
          const key = p.date + "/" + p.queue,
            old = plans.get(key);
          if (!old || p.publishedAt >= old.publishedAt) {
            plans.set(key, p);
            const changed = old && old.revision !== p.revision;
            messages.push({
              id: `plan:${key}:${p.revision}`,
              date: p.date,
              queue: p.queue,
              title: `${changed || /оновлен/i.test(a.title) ? "Оновлено" : "Опубліковано"} графік на ${p.date}`,
              updatedAt:
                changed && p.publishedAt <= old.publishedAt
                  ? now
                  : p.publishedAt,
              url: p.url,
              kind: "schedule",
            });
          }
        }
        const e = parseEmergency(a);
        if (e) emergencies.set(e.id, e);
      }
    }
    return {
      plans: [...plans.values()],
      emergencies: [...emergencies.values()].filter(
        (e) => e.publishedAt > now - 7 * 86400000,
      ),
      checkedAt: now,
      messages,
    };
  }
  async address(a, now = Date.now(), previous = {}) {
    const format = (d) => d.split("-").reverse().join("."),
      base = {
        n_date: format(addDays(dayKey(now), -7)),
        k_date: format(addDays(dayKey(now), 1)),
      };
    const categories = { ...previous.categories },
      failures = [];
    await Promise.all(
      ["planned", "emergency", "hourly"].map(async (category, selector) => {
        try {
          const root = await this.request({
            ...base,
            disconn_selector: String(selector),
            ...(a.account
              ? { op: "disconn_by_ls", abon_ls: a.account }
              : { op: "disconn_by_dept", dept_id: a.department }),
          });
          if (!a.account) {
            parseOutages(root, category, now);
            root.DISCONNECTIONS = rows(root.DISCONNECTIONS).filter((x) => {
              if (typeof x.ADDRESS !== "string") throw Error("Немає адреси");
              return matchesAddress(x.ADDRESS, a);
            });
            root.DISCONN_QUEUQ = [];
          }
          const next = parseOutages(root, category, now);
          // Retain already elapsed intervals if upstream omits them on a later request.
          const historical = (
            previous.categories?.[category]?.events || []
          ).filter(
            (e) => e.end && e.end <= now && e.start >= now - 7 * 86400000,
          );
          next.events = [
            ...new Map(
              [...historical, ...next.events].map((e) => [
                `${e.start}/${e.end}`,
                e,
              ]),
            ).values(),
          ];
          categories[category] = next;
        } catch {
          failures.push(category);
        }
      }),
    );
    return {
      categories,
      failures,
      queue: categories.hourly?.queue || null,
      checkedAt: now,
    };
  }
  async weather(city) {
    const name = city
      .replace(/^(м\.|с\.|смт\.?|с-ще|місто|село|селище)\s*/i, "")
      .trim();
    let location;
    if (name.toLowerCase() === "христинівка" && /^(м\.|місто)/i.test(city))
      location = { latitude: 48.81282, longitude: 29.96885 };
    if (name.toLowerCase() === "христинівка" && /^(с\.|село)/i.test(city))
      location = { latitude: 48.84958, longitude: 29.96641 };
    if (!location) {
      for (const query of [...new Set([name, latin(name)])]) {
        const geo = await jsonFetch(
          "https://geocoding-api.open-meteo.com/v1/search?" +
            new URLSearchParams({
              name: query,
              count: "100",
              language: "uk",
              format: "json",
            }),
          this.fetcher,
        );
        const exact = (geo.results || []).filter(
          (x) =>
            x.country_code === "UA" &&
            /Cherkasy|Черкаськ/i.test(x.admin1 || "") &&
            latin(x.name) === latin(name),
        );
        const unique = [
          ...new Map(
            exact.map((x) => [`${x.latitude},${x.longitude}`, x]),
          ).values(),
        ];
        if (unique.length === 1) {
          location = unique[0];
          break;
        }
      }
    }
    if (!location)
      throw Error("Не вдалося однозначно визначити населений пункт");
    const forecast = await jsonFetch(
      "https://api.open-meteo.com/v1/forecast?" +
        new URLSearchParams({
          latitude: String(location.latitude),
          longitude: String(location.longitude),
          current: "temperature_2m,weather_code,is_day",
          hourly: "temperature_2m,weather_code,is_day",
          forecast_days: "2",
          timezone: "UTC",
          timeformat: "unixtime",
        }),
      this.fetcher,
    );
    if (!Number.isFinite(forecast.current?.temperature_2m))
      throw Error("Немає погоди");
    return {
      city,
      checkedAt: Date.now(),
      temperature: forecast.current.temperature_2m,
      code: forecast.current.weather_code,
      isDay: forecast.current.is_day === 1,
      hours: forecast.hourly.time
        .map((t, i) => ({
          time: t * 1000,
          temp: forecast.hourly.temperature_2m[i],
          code: forecast.hourly.weather_code[i],
          isDay: forecast.hourly.is_day[i] === 1,
        }))
        .filter((x) => x.time >= Date.now() - 3600000)
        .slice(0, 24),
    };
  }
}
export function latin(text) {
  const letters = {
      а: "a",
      б: "b",
      в: "v",
      г: "h",
      ґ: "g",
      д: "d",
      е: "e",
      ж: "zh",
      з: "z",
      и: "y",
      і: "i",
      к: "k",
      л: "l",
      м: "m",
      н: "n",
      о: "o",
      п: "p",
      р: "r",
      с: "s",
      т: "t",
      у: "u",
      ф: "f",
      х: "kh",
      ц: "ts",
      ч: "ch",
      ш: "sh",
      щ: "shch",
      ь: "",
    },
    special = {
      є: ["ye", "ie"],
      ї: ["yi", "i"],
      й: ["y", "i"],
      ю: ["yu", "iu"],
      я: ["ya", "ia"],
    };
  const n = text.toLowerCase().replace(/[’'ʼ]/g, "");
  return [...n]
    .map(
      (c, i) =>
        special[c]?.[!i || /[ -]/.test(n[i - 1]) ? 0 : 1] ??
        (c === "г" && n[i - 1] === "з" ? "gh" : (letters[c] ?? c)),
    )
    .join("");
}
