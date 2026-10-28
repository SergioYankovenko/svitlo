const svg = (body, box = "0 0 24 24") =>
  `<svg class="icon" viewBox="${box}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
const sun =
  '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>';
const moon = '<path d="M20.5 14A8.5 8.5 0 0 1 10 3.5 8.5 8.5 0 1 0 20.5 14Z"/>';
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
export function shareIcon() {
  // Same outline and stroke as Android's ic_share_outline.xml.
  return svg('<path d="M3 21C3 12 7 7 14 7V3l8 8-8 8v-5c-6 0-9 3-11 7Z" stroke-width="1.4"/>');
}
export function summaryIcon(on) {
  return svg(
    on ? sun : '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  );
}
// Appearance choices keep their existing monochrome theme symbols.
export const themeIcon = light => svg(light ? sun : moon);
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
// Filled, emoji-like weather artwork. Inline paths stay identical across mobile
// fonts and work offline; no external assets, masks, filters or duplicate IDs.
const weatherSun = `<g fill="#F6B62D">${Array.from({length:8},(_,i)=>`<path d="M16 1 13.8 6.6h4.4Z" transform="rotate(${i*45} 16 16)"/>`).join('')}<circle cx="16" cy="16" r="7" fill="#FFD65A"/></g>`;
const weatherMoon = '<path d="M23.8 24.9A12 12 0 0 1 12 4.1a12 12 0 1 0 11.8 20.8Z" fill="#FFD65A"/>';
const weatherCloud = '<path d="M8 25.5a5.8 5.8 0 1 1 .4-11.6 8.4 8.4 0 0 1 16.2 1.9 4.9 4.9 0 0 1 .5 9.7Z" fill="#E5EEF1"/><path d="M2.5 21.9c1.1 1.1 2.8 1.5 4.5 1.1 1.6 1.8 4.6 2 6.5.4 2.1 1.4 5 1.4 7-.1 3.1 1.4 6.6.5 8.8-1.2a4.9 4.9 0 0 1-4.2 3.4H8a5.8 5.8 0 0 1-5.5-3.6Z" fill="#B7CDD5"/>';
const weatherDrops = heavy => `<g fill="#68BCE8">${[8,16,24].map(x=>`<path d="M${x} ${heavy?24:25}${heavy?'c-1 1.4-2 2.5-2 3.6a2 2 0 0 0 4 0c0-1.1-1-2.2-2-3.6':'c-.75 1.1-1.5 1.9-1.5 2.7a1.5 1.5 0 0 0 3 0c0-.8-.75-1.6-1.5-2.7'}Z"/>`).join('')}</g>`;
const coloredWeather = body => `<svg class="icon weather-art" viewBox="0 0 32 32" fill="none" stroke="none" aria-hidden="true" focusable="false">${body}</svg>`;
export function weatherIcon(code, isDay = true) {
  const kind = weatherKind(code, isDay);
  if (kind === "sun") return coloredWeather(weatherSun);
  if (kind === "moon") return coloredWeather(weatherMoon);
  if (kind === "partly" || kind === "partly-night")
    // Android uses the same sun-behind-cloud symbol for WMO 1/2 day and night.
    return coloredWeather(`<g transform="translate(-2 -3) scale(.72)">${weatherSun}</g>${weatherCloud}`);
  if (kind === "cloud") return coloredWeather(weatherCloud);
  if (kind === "fog") return coloredWeather(`<g transform="translate(0 -3)">${weatherCloud}</g><path d="M4 24h24M2 28h17m4 0h7" stroke="#A6BEC8" stroke-width="2" stroke-linecap="round"/>`);
  if (kind === "drizzle" || kind === "rain")
    return coloredWeather(`<g transform="translate(0 -4)">${weatherCloud}</g>${weatherDrops(kind === 'rain')}`);
  if (kind === "snow") return coloredWeather(`<g transform="translate(0 -4)">${weatherCloud}</g><g stroke="#81C9EB" stroke-width="1.3" stroke-linecap="round">${[8,16,24].map(x=>`<path d="M${x} 25v5m-2.2-3.8 4.4 2.6m-4.4 0 4.4-2.6"/>`).join('')}</g>`);
  if (kind === "storm") return coloredWeather(`<g transform="translate(0 -4)">${weatherCloud}</g><path d="m16 21-5 6h4l-1 5 8-8h-5l3-3Z" fill="#FFD65A"/>`);
  return svg('<path d="M9 8a3 3 0 1 1 5 2.3C12 11.5 12 12 12 14"/><circle cx="12" cy="18" r=".8" fill="currentColor"/>');
}
