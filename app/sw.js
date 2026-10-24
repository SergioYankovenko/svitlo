const CACHE = "svitlo-pwa-fb029d7d95e0",
  ROOT = new URL("./", self.location.href);
// Build writes the complete hashed app-shell list here, including the bundled client library.
const SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./main.js",
  "./api.js",
  "./config.js",
  "./lib/time.js",
  "./lib/icons.js",
  "./lib/pickers.js",
  "./lib/parsers.js",
  "./lib/schedule.js",
  "./lib/tiles.js",
  "./lib/layout.js",
  "./lib/navigation.js",
  "./lib/day-transition.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon.svg",
  "./vendor/supabase.js",
];
self.addEventListener("install", (event) =>
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL.map((p) => new Request(new URL(p, ROOT), { cache: "reload" })))),
  ),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("svitlo-pwa-") && k !== CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  ),
);
self.addEventListener("fetch", (event) => {
  const r = event.request,
    u = new URL(r.url);
  if (
    r.method !== "GET" ||
    u.origin !== ROOT.origin ||
    !u.pathname.startsWith(ROOT.pathname)
  )
    return;
  if (r.mode === "navigate") {
    event.respondWith(
      fetch(r).catch(() => caches.match(ROOT.href + "index.html")),
    );
    return;
  }
  if (SHELL.some((p) => new URL(p, ROOT).href === u.href))
    event.respondWith(caches.match(r).then((cached) => cached || fetch(r)));
});
async function recordPush(stage, error = "") {
  try {
    const cache = await caches.open(CACHE);
    await cache.put(
      new URL("push-receipt.json", ROOT).href,
      Response.json({ at: Date.now(), stage, error }),
    );
  } catch {
    /* Local diagnostics must not prevent notification delivery. */
  }
}
self.addEventListener("push", (event) =>
  event.waitUntil(
    (async () => {
      await recordPush("received");
      let p = {};
      try {
        p = event.data?.json() || {};
      } catch {}
      try {
        await self.registration.showNotification(
          String(p.title || "Світло").slice(0, 160),
          {
            body: String(p.body || "З’явилося оновлення графіка.").slice(
              0,
              300,
            ),
            icon: new URL("icons/icon-192.png", ROOT).href,
            badge: new URL("icons/icon-192.png", ROOT).href,
            tag: String(p.tag || "svitlo").slice(0, 160),
            data: {
              date: /^\d{4}-\d{2}-\d{2}$/.test(p.date) ? p.date : null,
              profile: /^[0-9a-f-]{36}$/.test(p.profile) ? p.profile : null,
            },
          },
        );
        await recordPush("created");
      } catch (error) {
        await recordPush("failed", String(error.name));
        throw error;
      }
    })(),
  ),
);
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const url = new URL(ROOT),
        d = event.notification.data || {};
      if (d.date) url.searchParams.set("date", d.date);
      if (d.profile) url.searchParams.set("profile", d.profile);
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const existing = windows.find(
        (c) =>
          new URL(c.url).origin === ROOT.origin &&
          new URL(c.url).pathname.startsWith(ROOT.pathname),
      );
      if (existing) {
        await existing.navigate(url.href);
        await existing.focus();
      } else await self.clients.openWindow(url.href);
    })(),
  );
});
