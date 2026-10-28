const svg = (body, box = "0 0 24 24") =>
  `<svg class="icon" viewBox="${box}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
const sun =
  '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>';
const moon = '<path d="M20.5 14A8.5 8.5 0 0 1 10 3.5 8.5 8.5 0 1 0 20.5 14Z"/>';
const cloud =
  '<path d="M6 17a4 4 0 1 1 .5-8A5.5 5.5 0 0 1 17 8a4.5 4.5 0 1 1 1 9Z"/>';
const rain = '<path d="m8 20-1 2m6-2-1 2m6-2-1 2"/>';
export function powerIcon(off = false, unknown = false, style = "bolt") {
  if (unknown)
    return svg(
      '<path d="M9 8a3 3 0 1 1 5 2.3C12 11.5 12 12 12 14"/><circle cx="12" cy="18" r=".9" fill="currentColor" stroke="none"/>',
    );
  if (style === "bulb")
    return svg(
      '<path d="M9 16c0-2-3-3-3-7a6 6 0 1 1 12 0c0 4-3 5-3 7Z"' +
      (off ? '' : ' fill="currentColor"') + '/><path d="M9 19h6m-5 3h4"/>' +
      (off ? '' : '<path d="M12 1v1M3.5 3.5l1 1M1 9h2m18 0h2m-3.5-4.5 1-1"/>'),
    );
  return svg(
    '<path d="m14 5-6 8h4l-2 6 6-8h-4Z"' + (off ? '' : ' fill="currentColor"') + '/>' +
      (off ? '<path d="m6.5 6 11 12"/>' : ""),
    "5 3 14 18",
  );
}
export function checkIcon() {
  return svg('<path d="m5 12 4 4L19 6"/>');
}
export function summaryIcon(on) {
  return svg(
    on ? sun : '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  );
}
export function weatherKind(code, isDay = true) {
  if (code === 0) return isDay ? "sun" : "moon";
  if (code === 1 || code === 2) return isDay ? "partly" : "partly-night";
  if (code === 3) return "cloud";
  if (code === 45 || code === 48) return "fog";
  if ([51, 53, 55, 56, 57].includes(code)) return "drizzle";
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "rain";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "snow";
  if ([95, 96, 99].includes(code)) return "storm";
  return "unknown";
}
export function weatherDescription(code) {
  return {
    sun: "Ясно",
    moon: "Ясно",
    partly: "Мінлива хмарність",
    "partly-night": "Мінлива хмарність",
    cloud: "Хмарно",
    fog: "Туман",
    drizzle: "Мряка",
    rain: "Дощ",
    snow: "Сніг",
    storm: "Гроза",
    unknown: "Погода недоступна",
  }[weatherKind(code)];
}
export function weatherIcon(code, isDay = true) {
  const kind = weatherKind(code, isDay);
  if (kind === "sun" || kind === "moon")
    return svg(kind === "sun" ? sun : moon);
  if (kind === "partly" || kind === "partly-night")
    return svg(
      '<g transform="translate(-2 -3) scale(.8)">' +
        (kind === "partly" ? sun : moon) +
        '</g><path d="M8 20a4 4 0 0 1-1-7 5 5 0 0 1 9.5-1A4 4 0 1 1 18 20Z" fill="var(--surface)"/>',
    );
  if (kind === "fog") return svg('<path d="M5 8h14M3 12h18M5 16h14M8 20h8"/>');
  if (kind === "snow")
    return svg(
      '<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9 5l3 3 3-3M9 19l3-3 3 3M5 10l4-1-1-4M19 14l-4 1 1 4M5 14l4 1-1 4M19 10l-4-1 1-4"/>',
    );
  if (kind === "storm") return svg(cloud + '<path d="m12 14-3 5h4l-2 4"/>');
  if (kind === "unknown")
    return svg(
      '<path d="M9 8a3 3 0 1 1 5 2.3C12 11.5 12 12 12 14"/><circle cx="12" cy="18" r=".8" fill="currentColor"/>',
    );
  return svg(cloud + (kind === "rain" || kind === "drizzle" ? rain : ""));
}
