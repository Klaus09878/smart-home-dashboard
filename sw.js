// Service Worker für den Smart Home Hub.
// Strategie: Network-first für alles Eigene (damit Deployments sofort ankommen),
// Cache als Offline-Fallback. API-Aufrufe (ThingSpeak, Open-Meteo, CDNs) gehen
// immer direkt ans Netz und werden nicht gecacht.
const CACHE_NAME = 'smarthub-v14';
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
