// Offline support: always try the network first (so updates show right away),
// fall back to the last saved copy when there's no signal.
const CACHE = 'ticket-radar-v3';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'icon.svg', 'css/app.css',
  'vendor/leaflet.css', 'vendor/leaflet.js', 'vendor/leaflet-heat.js', 'vendor/supabase.js',
  'js/config.js', 'js/app.js', 'js/util.js', 'js/store.js', 'js/cloud.js', 'js/native.js', 'js/mapview.js', 'js/engine.js',
  'js/ui.js', 'js/voice.js', 'js/pages-main.js', 'js/pages-community.js', 'js/pages-plan.js', 'js/pages-learn.js', 'js/pages-you.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;   // Supabase, maps, fonts: straight to the network
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    } catch {
      return (await caches.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? caches.match('index.html') : Response.error());
    }
  })());
});
