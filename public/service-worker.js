// service-worker.js — AlbEdu PWA service worker (stale-while-revalidate + network-first)

const CACHE_VERSION = 'albedu-v0.831.0';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const PAGE_CACHE = `${CACHE_VERSION}-pages`;
const MAX_CACHE_ENTRIES = 100;

// Compute the base path so the service worker works on subfolder deploys
// (e.g. GitHub Pages /albedu/, Vercel preview deployments). The SW is
// always served from `<base>/public/service-worker.js`, so we strip the
// trailing `/public/service-worker.js` from its own pathname.
const BASE_PATH = (() => {
  const swPath = self.location.pathname;
  const marker = '/public/service-worker.js';
  if (swPath.endsWith(marker)) {
    return swPath.slice(0, -marker.length) || '';
  }
  // Fallback: assume root.
  return '';
})();

const base = (p) => (p.startsWith('/') ? `${BASE_PATH}${p}` : `${BASE_PATH}/${p}`);

// Navigation fallback page (offline) — a small HTML stub served from the
// page cache so users get a graceful message instead of a browser default.
const OFFLINE_FALLBACK = base('/pages/offline.html');

const PRECACHE_URLS = [
  // F5-04 fix: trimmed from 63 to 10 entries. The previous precache list
  // included every page + every shared JS + every CSS + every font — totalling
  // ~400KB precached on first install. For a 500-student flash crowd, that's
  // 31,500 origin hits in the first post-deploy minute — a self-inflicted
  // DDoS. The SW should only precache the offline fallback + critical shell
  // assets that are needed for the offline page to render. Everything else
  // is cached on-demand via the runtime cache (STATIC_PATTERNS below).
  base('/'),
  base('/index.html'),
  base('/pages/offline.html'),
  OFFLINE_FALLBACK,

  // Critical shell CSS (needed for offline page to look right)
  base('/styles/tokens.css'),
  base('/styles/albedu-components.css'),

  // Critical shell JS (icons used by offline page)
  base('/src/shared/icons/icons.js'),

  // Logo + favicon (offline page branding)
  base('/public/images/logo.svg'),
  base('/public/images/favicon/favicon-96x96.png'),
];

const STATIC_PATTERNS = [
  /\.css$/,
  /\.js$/,
  /\.woff2?$/,
  /\.ttf$/,
  /fonts\.googleapis\.com/,
  /fonts\.gstatic\.com/,
  /cdn\.jsdelivr\.net/,
  /\/public\/images\//,
  /\/public\/QNotify\//,
];

const NETWORK_PATTERNS = [
  /\/functions\/v1\//,
  /\/rest\/v1\//,
  /supabase\.co/,
  // C3-02 fix: the worker.dev pattern previously caught /img/{sha256}
  // (served by the CF Worker) and routed it through networkFirst — defeating
  // the edge cache for SW-equipped browsers. We now exclude /img/ paths
  // from the network-first route so they fall through to STATIC_PATTERNS
  // (which uses staleWhileRevalidate). The /img/ assets are SHA-256
  // addressed and immutable, so cache-first is correct.
];

// C3-02 fix: /img/ paths are always cacheable (SHA-256 addressed, immutable).
const IMMUTABLE_IMG_PATTERN = /albyte-inc\.workers\.dev\/img\//;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      return cache.addAll(PRECACHE_URLS).catch((err) => {
        console.warn('[SW] Precache partial failure:', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => !key.startsWith(CACHE_VERSION))
          .map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isCDN = STATIC_PATTERNS.some((p) => p.test(req.url));

  if (!isSameOrigin && !isCDN) return;

  // Navigation requests: network-first with offline fallback page.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const cache = caches.open(PAGE_CACHE);
          cache.then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(async () => {
          const cache = await caches.open(PAGE_CACHE);
          const cached = await cache.match(req);
          if (cached) return cached;
          const fallback = await cache.match(OFFLINE_FALLBACK);
          if (fallback) return fallback;
          return new Response('Offline', { status: 503, statusText: 'Offline' });
        })
    );
    return;
  }

  if (NETWORK_PATTERNS.some((p) => p.test(req.url))) {
    event.respondWith(networkFirst(req));
    return;
  }

  // C3-02 fix: /img/{sha256} assets are immutable (SHA-256 addressed).
  // Use cache-first (with background revalidate) for maximum cache hit rate.
  // Previously these fell through to the generic STATIC_PATTERNS check below
  // OR got caught by the now-removed worker.dev NETWORK_PATTERN.
  if (IMMUTABLE_IMG_PATTERN.test(req.url)) {
    event.respondWith(cacheFirst(req));
    return;
  }

  if (STATIC_PATTERNS.some((p) => p.test(req.url)) || isSameOrigin) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  event.respondWith(
    fetch(req).catch(() => caches.match(req))
  );
});

// C3-02 fix: cache-first strategy for immutable assets (SHA-256 addressed images).
async function cacheFirst(req) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(req);
  if (cached) {
    // Background revalidate (no await — fire-and-forget).
    fetch(req).then((res) => {
      if (res && res.status === 200) {
        cache.put(req, res.clone());
      }
    }).catch(() => {});
    return cached;
  }
  try {
    const res = await fetch(req);
    if (res && res.status === 200 && res.type === 'basic') {
      cache.put(req, res.clone());
      evictIfNeeded(cache);
    }
    return res;
  } catch (err) {
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(req);

  const fetchPromise = fetch(req)
    .then((res) => {
      if (res && res.status === 200 && res.type === 'basic') {
        cache.put(req, res.clone());
        evictIfNeeded(cache);
      }
      return res;
    })
    .catch(() => null);

  return cached || fetchPromise || new Response('Offline', { status: 503 });
}

async function networkFirst(req) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const res = await fetch(req);
    if (res && res.status === 200) {
      cache.put(req, res.clone());
    }
    return res;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw err;
  }
}

async function evictIfNeeded(cache) {
  const keys = await cache.keys();
  if (keys.length > MAX_CACHE_ENTRIES) {
    const toDelete = keys.slice(0, 20);
    await Promise.all(toDelete.map((key) => cache.delete(key)));
  }
}

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
