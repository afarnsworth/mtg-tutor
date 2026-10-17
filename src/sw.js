// Service worker. scripts/postbuild.ts fills in BUILD and PRECACHE and writes
// the result to dist/sw.js; any change to the app shell changes BUILD, which
// is what makes browsers install a new worker.
//
// Card data is cached by the app itself (src/data.ts), so it is available
// offline even when the first visit wasn't controlled by this worker.

const BUILD = '__BUILD__';
const PRECACHE = /*__PRECACHE__*/ [];

const SHELL_CACHE = `mtg-shell-${BUILD}`;
const SHELL_URLS = new Set(PRECACHE.map((path) => new URL(path, self.registration.scope).href));
const IMAGE_CACHE = 'mtg-images';
const IMAGE_ORIGIN = 'https://cards.scryfall.io';
// "large" images average ~135 KB, so this is roughly 70 MB.
const IMAGE_LIMIT = 500;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith('mtg-shell-') && key !== SHELL_CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === IMAGE_ORIGIN) {
    event.respondWith(cardImage(request));
  } else if (url.origin === self.location.origin) {
    if (request.mode === 'navigate') {
      event.respondWith(fromShell(new URL('index.html', self.registration.scope).href, request));
    } else if (SHELL_URLS.has(url.href)) {
      event.respondWith(fromShell(url.href, request));
    }
    // Everything else (version.json, data files) goes straight to the network.
  }
});

async function fromShell(key, request) {
  const cached = await caches.match(key, { cacheName: SHELL_CACHE });
  return cached ?? fetch(request);
}

async function cardImage(request) {
  const cache = await caches.open(IMAGE_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  // Only cache CORS responses: opaque ones count ~7 MB each against storage quota in Chrome.
  if (response.ok && response.type === 'cors') {
    await cache.put(request, response.clone());
    trimImages(cache);
  }
  return response;
}

let trimming = false;
async function trimImages(cache) {
  if (trimming) return;
  trimming = true;
  try {
    // keys() is in insertion order, so this evicts the oldest images first.
    const keys = await cache.keys();
    for (const key of keys.slice(0, Math.max(0, keys.length - IMAGE_LIMIT))) await cache.delete(key);
  } finally {
    trimming = false;
  }
}
