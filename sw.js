// Offline support. Network-first so players always get the latest version
// when online; when offline, the last version seen is served from the cache.
// Network requests revalidate with the server ('no-cache') instead of using
// the browser's HTTP cache, which GitHub Pages lets keep files for 10 minutes;
// unchanged files come back as a cheap 304.
// Bump CACHE when the SHELL list changes.
const CACHE = 'stone-clash-v5';
const SHELL = [
  './',
  'index.html',
  'style.css',
  'game.js',
  'online.js',
  'bot.js',
  'main.js',
  'vendor/peerjs.min.js',
  'vendor/qrcode.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/favicon-32.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL.map(url => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;

  // A navigation Request can't be re-created with options, so fetch its URL.
  const fresh = request.mode === 'navigate'
    ? fetch(request.url, { cache: 'no-cache', credentials: 'same-origin' })
    : fetch(request, { cache: 'no-cache' });

  event.respondWith(
    fresh
      .then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request, { ignoreSearch: true });
        if (cached) return cached;
        if (request.mode === 'navigate') return (await caches.match('index.html')) || Response.error();
        return Response.error();
      })
  );
});
