const CACHE_PREFIX = "jansee-v4-shell-";
const CACHE_NAME = `${CACHE_PREFIX}4.0.0-alpha.1-filmstrip-reveal`;
const STATIC_ASSETS = [
  "/",
  "/offline.html",
  "/manifest.webmanifest",
  "/assets/jansee-mark.svg",
  "/assets/jansee-wordmark.svg",

];
const PRIVATE_PATH_PREFIXES = [
  "/api/",
  "/health/",
  "/auth/",
  "/session/",
  "/account/",
  "/uploads/",
  "/media/",
  "/assets-private/",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(STATIC_ASSETS);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
        .map((name) => caches.delete(name)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (PRIVATE_PATH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok && (url.pathname === "/" || url.pathname === "/index.html")) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put("/", response.clone());
        }
        return response;
      } catch {
        return (await caches.match("/offline.html")) ?? Response.error();
      }
    })());
    return;
  }

  if (!["script", "style", "font", "image"].includes(request.destination)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    const refresh = fetch(request).then((response) => {
      if (response.ok && response.type === "basic") {
        void cache.put(request, response.clone());
      }
      return response;
    }).catch(() => cached ?? Response.error());
    return cached ?? refresh;
  })());
});
