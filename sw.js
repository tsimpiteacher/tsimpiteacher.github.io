/* Service worker αρχικής σελίδας: offline για το ίδιο το κέλυφος. Δεν αγγίζει τις εφαρμογές /efimeries/ και /gr/. */
const CACHE = 'suite-hub-v6';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png', './icon-maskable.png', './apple-touch-icon.png', './logo.webp'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' }))))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k.startsWith('suite-hub-')).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const base = new URL('./', self.registration.scope).pathname;           // π.χ. "/"
  const rel = url.pathname.slice(base.length);                              // π.χ. "efimeries/"
  const own = rel === '' || SHELL.indexOf('./' + rel) !== -1;
  if (!own) return;                                                          // άλλες εφαρμογές: κανονικά από το δίκτυο
  e.respondWith(
    fetch(req, { cache: 'no-cache' }).then((res) => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
  );
});
