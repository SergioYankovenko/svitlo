import { dayKey } from "../app/lib/time.js";
export const REGISTRY_URL =
  "https://www.cherkasyoblenergo.com/perelik-gpv?lang=uk";
export const REGISTRY_INTERVAL = 14 * 86400000;
export const normAddress = (s) =>
  String(s || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’ʼ]/g, "'")
    .replace(/\s+/g, " ")
    .replace(/^(місто|м\.)\s*/, "м.")
    .replace(/^(село|с\.)\s*/, "с.")
    .replace(/^(вулиця|вул\.)\s*/, "вул.")
    .replace(/^(провулок|пров\.)\s*/, "пров.")
    .replace(/\s*\.\s*/g, ".")
    .trim();
const safePDF = (url) => {
  try {
    const u = new URL(url);
    return (
      u.origin === "https://www.cherkasyoblenergo.com" &&
      /^\/cherkasyoblenergo\/uploads\/pages\/files\/[a-f0-9-]+\.pdf$/.test(
        u.pathname,
      ) &&
      !u.search
    );
  } catch {
    return false;
  }
};
export function registryMatch(version, address, now = Date.now()) {
  if (
    !version ||
    version.validFrom > dayKey(now) ||
    version.validUntil < dayKey(now)
  )
    return { queue: null, status: "unavailable" };
  const city = normAddress(address.city),
    street = normAddress(address.street),
    house = normAddress(address.house).replace(/\s/g, "");
  if (!city || !street || !house)
    return { queue: null, status: "incomplete_address" };
  const matches = (version.rules || []).filter(
    (r) =>
      normAddress(r.city) === city &&
      (r.scope === "settlement_all" || normAddress(r.street) === street) &&
      (!r.houses?.length ||
        r.houses
          .map((x) => normAddress(x).replace(/\s/g, ""))
          .includes(house)) &&
      !r.excluded?.map(normAddress).includes(house),
  );
  const queues = [...new Set(matches.map((r) => r.queue))];
  if (queues.length !== 1)
    return { queue: null, status: queues.length ? "ambiguous" : "not_found" };
  const match = matches.sort(
    (a, b) =>
      ({ house: 3, street_all: 2, settlement_all: 1 })[b.scope] -
      { house: 3, street_all: 2, settlement_all: 1 }[a.scope],
  )[0];
  // Any different-queue mention of this city AND street in an unsupported clause blocks a broad fallback.
  if (
    (version.mentions || []).some(
      (m) =>
        m.queue !== match.queue &&
        normAddress(m.text).includes(city) &&
        (match.scope === "settlement_all" ||
          normAddress(m.text).includes(street.replace(/^вул\./, ""))),
    )
  )
    return { queue: null, status: "ambiguous" };
  return {
    queue: match.queue,
    status: "matched",
    source: "official_registry",
    scope: match.scope,
    url: match.url,
    page: match.page,
    version: version.id,
    validUntil: version.validUntil,
    checkedAt: version.checkedAt,
  };
}
// Conservative importer: complete named street lists and explicit "Села:" lists only.
// Partial streets, ranges, businesses and unsupported clauses never become broad rules.
export function rulesFromPages(pages, queue, url) {
  const rules = [];
  for (let page = 0; page < pages.length; page++) {
    const lines = pages[page]
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      if (
        /^м\.[\p{L}’ʼ' -]+$/u.test(lines[i]) &&
        /^вул\s*[:.]/i.test(lines[i + 1] || "")
      ) {
        const city = lines[i];
        let copy = lines[++i].replace(/^вул\s*[:.]\s*/i, "");
        while (
          i + 1 < lines.length &&
          !/^(?:пров\.|ТОВ|ПрАТ|ПАТ|ФОП|ПОСП|[мс]\.|Назва|Сторінка|Графік)/i.test(
            lines[i + 1],
          )
        )
          copy += " " + lines[++i];
        for (const token of copy.split(/,(?![^()]*\))/)) {
          const street = token.trim().replace(/[.;]+$/, "");
          if (
            !street ||
            /[\d():]|част|від | до |район|ТП|ТОВ|філі/i.test(street) ||
            !/^[\p{L}’ʼ'. -]+$/u.test(street)
          )
            continue;
          rules.push({
            city,
            street: "вул." + street,
            scope: "street_all",
            queue,
            url,
            page: page + 1,
            evidence: city + "; вул. " + street,
          });
        }
      }
      if (/Села\s*:/i.test(lines[i])) {
        let copy = lines[i].slice(lines[i].indexOf(":") + 1);
        while (
          i + 1 < lines.length &&
          !/^(?:Сторінка|Назва|Графік)/i.test(lines[i + 1]) &&
          !/\.$/.test(copy)
        )
          copy += " " + lines[++i];
        for (const token of copy.split(",")) {
          const city = token.trim().replace(/[.;]+$/, "");
          if (
            /^с\.[\p{L}’ʼ'. -]+$/u.test(city) &&
            !/част|вул|район|ТП|ТОВ/i.test(city)
          )
            rules.push({
              city,
              scope: "settlement_all",
              queue,
              url,
              page: page + 1,
              evidence: "Села: " + city,
            });
        }
      }
    }
  }
  return rules;
}
export async function syncRegistry({
  db,
  fetcher = fetch,
  pdfPages,
  now = Date.now(),
}) {
  const old = await db.registry(),
    state = await db.registryState();
  if (state.nextCheckAt > now) return { status: "not_due" };
  try {
    const page = await fetcher(REGISTRY_URL, {
      signal: AbortSignal.timeout(20000),
      redirect: "error",
    });
    if (!page.ok) throw Error("registry_http");
    const html = await page.text();
    if (html.length > 2000000) throw Error("registry_format");
    const links = [
      ...new Set(
        [
          ...html.matchAll(
            /(?:https?:[^"<>\s]+)?\/cherkasyoblenergo\/uploads\/pages\/files\/[a-f0-9-]+\.pdf/g,
          ),
        ].map((m) => new URL(m[0], REGISTRY_URL).href),
      ),
    ];
    if (links.length !== 12 || links.some((u) => !safePDF(u)))
      throw Error("registry_links");
    const documents = [],
      rules = [],
      mentions = [];
    let validFrom, validUntil;
    for (let index = 0; index < links.length; index++) {
      const url = links[index],
        r = await fetcher(url, {
          signal: AbortSignal.timeout(20000),
          redirect: "error",
        });
      if (!r.ok) throw Error("registry_pdf");
      if (Number(r.headers.get("content-length")) > 2000000)
        throw Error("registry_size");
      const reader = r.body.getReader();
      let size = 0;
      const chunks = [];
      while (true) {
        const x = await reader.read();
        if (x.done) break;
        size += x.value.length;
        if (size > 2000000) {
          await reader.cancel();
          throw Error("registry_size");
        }
        chunks.push(x.value);
      }
      const bytes = new Uint8Array(size);
      let cursor = 0;
      for (const c of chunks) {
        bytes.set(c, cursor);
        cursor += c.length;
      }
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
      const cached = old?.documents?.find((d) => d.hash === hash),
        pages = cached?.pages || (await pdfPages(bytes));
      const text = pages.join("\n"),
        header = text
          .slice(0, 1400)
          .match(/([1-6])\s*черга[.,]?\s*(ІІ|II|І|I)\s*підчерга/);
      if (!header) throw Error("registry_header");
      const queue = header[1] + "." + (header[2].length === 2 ? "2" : "1");
      const period = text.match(
        /з\s*0?1\s*жовтня\s*(20\d{2})\s*р\.?\s*по\s*0?1\s*квітня\s*(20\d{2})/i,
      );
      if (!period) throw Error("registry_period");
      const from = period[1] + "-10-01",
        until = period[2] + "-04-01";
      if (validFrom && (from !== validFrom || until !== validUntil))
        throw Error("registry_period_conflict");
      validFrom = from;
      validUntil = until;
      documents.push({ url, hash, queue, pages });
      rules.push(...rulesFromPages(pages, queue, url));
      for (const text of pages) mentions.push({ queue, text });
    }
    if (
      new Set(documents.map((d) => d.queue)).size !== 12 ||
      !rules.length ||
      validFrom > dayKey(now) ||
      validUntil < dayKey(now)
    )
      throw Error("registry_validation");
    if (old?.rules?.length && rules.length < old.rules.length * 0.8)
      throw Error("registry_unexpected_removals");
    const id = documents.map((d) => d.hash.slice(0, 12)).join("-");
    const version = {
      id,
      validFrom,
      validUntil,
      checkedAt: now,
      documents,
      rules,
      mentions,
    };
    await db.activateRegistry(version);
    const nearExpiry = Date.parse(validUntil + "T00:00Z") - now < 21 * 86400000;
    await db.saveRegistryState({
      nextCheckAt: now + (nearExpiry ? 86400000 : REGISTRY_INTERVAL),
      lastSuccessAt: now,
      failures: 0,
    });
    return {
      status: old?.id === id ? "unchanged" : "updated",
      version: id,
      rules: rules.length,
    };
  } catch {
    const failures = (state.failures || 0) + 1;
    await db.saveRegistryState({
      ...state,
      lastAttemptAt: now,
      failures,
      nextCheckAt:
        now + Math.min(86400000, 3600000 * 2 ** Math.min(failures - 1, 5)),
      error: "registry_update_failed",
    });
    return { status: "failed_retained" };
  }
}
