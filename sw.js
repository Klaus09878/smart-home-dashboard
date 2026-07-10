// Service Worker für den Smart Home Hub.
// Strategie: Network-first für alles Eigene (damit Deployments sofort ankommen),
// Cache als Offline-Fallback. API-Aufrufe (ThingSpeak, Open-Meteo, CDNs) gehen
// immer direkt ans Netz und werden nicht gecacht.
const CACHE_NAME = 'smarthub-v16';
const APP_SHELL = [
  './',
  './gpx.html',
  './tailwind.css',
  './shared.js',
  './settings-sync.js',
  './app.js',
  './gpx.js',
  './lib/core.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  // Vendor-Bibliotheken lokal gepinnt (offline-fähig, siehe vendor/)
  './vendor/chart.umd.js',
  './vendor/hammer.min.js',
  './vendor/chartjs-plugin-zoom.min.js',
  './vendor/lucide.min.js',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css'
];

self.addEventListener('install', event => {
  // Kein automatisches skipWaiting: der neue SW wartet, bis der Nutzer im
  // „Neue Version"-Toast auf „Neu laden" tippt (postMessage 'skipWaiting').
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
  );
});

self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

// Web-Push: Serverseitige Warnungen (functions/_notify.js) als System-Notification.
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data && event.data.text() }; }
  const title = data.title || 'Smart Home Hub';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: data.tag || title,
    data: { url: data.url || './' }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const c of clients) {
        if ('focus' in c) { c.focus(); if (c.navigate && target !== './') c.navigate(target); return; }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // API-Aufrufe immer live, nie cachen

  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(event.request, { ignoreSearch: event.request.mode === 'navigate' })
          .then(match => match || (event.request.mode === 'navigate' ? caches.match('./') : Promise.reject(new Error('offline'))))
      )
  );
});
