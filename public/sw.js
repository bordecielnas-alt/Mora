// Service worker : garde l'interface en cache pour qu'elle s'ouvre comme une app.
// Les données (/api) passent toujours par le réseau.
const CACHE = "mora-v14";
const SHELL = ["/styles.css", "/themes.css", "/app.js", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || url.pathname.startsWith("/api/") || e.request.method !== "GET") return;
  // réseau d'abord, cache si hors ligne
  // (une page de connexion, obtenue par redirection, n'est jamais mise en cache à la place de l'app)
  e.respondWith(fetch(e.request).then((r) => { if (r.ok && !r.redirected) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return r; })
    .catch(() => caches.match(e.request)));
});
