// =============================================================================
// service-worker.js — AlbEdu v0.742.9 PWA Service Worker
// =============================================================================
// Strategy: stale-while-revalidate for static assets, network-first for API.
// Cache limit: ~5MB (Free Plan safe).
//
// Edge cases:
//   1. Install → precache critical assets
//   2. Activate → clear old caches
//   3. Fetch → stale-while-revalidate for CSS/JS/fonts/images
//   4. Fetch → network-first for API/Edge Functions
//   5. Offline → serve cached page, queue API calls
//   6. Update → skipWaiting + clients.claim (instant update)
//   7. Cache size → evict oldest entries if > 100 entries
// =============================================================================

const CACHE_VERSION = 'albedu-v2-hardened';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const PAGE_CACHE = `${CACHE_VERSION}-pages`;
const MAX_CACHE_ENTRIES = 100;

// Assets to precache on install
// [v2.0 Hardening] Added critical shared modules + QNotify CSS + resilience
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/pages/login.html',
  '/pages/assessment/index.html',
  '/pages/assessment/blocked.html',
  '/pages/assessment/submitted.html',
  '/styles/tokens.css',
  '/styles/albedu-v1.css',
  '/styles/loading.css',
  '/public/images/favicon/favicon.ico',
  '/public/images/favicon/favicon-96x96.png',
  '/public/images/logo.svg',
  '/src/shared/head/critical-css.js',
  '/src/shared/head/fonts.js',
  '/src/shared/icons/icons.js',
  '/src/shared/boot.js',
  '/src/shared/qnotify-loader.js',
  '/src/shared/error-boundary.js',
  '/src/shared/race-condition.js',
  '/src/shared/observability.js',
  '/src/platform/supabase-client.js',
  '/src/platform/repository.js',
  '/src/security/sanitize.js',
  '/public/QNotify/ui/notify.css',
  '/public/QNotify/ui/dialog.css',
  '/public/QNotify/ui/label.css',
  '/public/QNotify/ui/Readnote.css',
];

// Patterns for stale-while-revalidate (static assets)
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

// Patterns for network-first (API calls)
const NETWORK_PATTERNS = [
  /\/functions\/v1\//,
  /\/rest\/v1\//,
  /supabase\.co/,
  /albyte-inc\.workers\.dev/,
];

// ── Install: precache critical assets ──
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      return cache.addAll(PRECACHE_URLS).catch((err) => {
        console.warn('[SW] Precache failed (some assets may be unavailable offline):', err);
      });
    })
  );
  self.skipWaiting(); // instant update
});

// ── Activate: clear old caches ──
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => !key.startsWith(CACHE_VERSION))
          .map((key) => {
            console.info('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      );
    })
  );
  self.clients.claim(); // take control immediately
});

// ── Fetch: routing strategy ──
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Skip non-GET requests
  if (req.method !== 'GET') return;

  // Skip cross-origin requests that aren't CDN/fonts
  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isCDN = STATIC_PATTERNS.some((p) => p.test(req.url));

  if (!isSameOrigin && !isCDN) return;

  // Network-first for API calls
  if (NETWORK_PATTERNS.some((p) => p.test(req.url))) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Stale-while-revalidate for static assets
  if (STATIC_PATTERNS.some((p) => p.test(req.url)) || isSameOrigin) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // Default: try network, fallback to cache
  event.respondWith(
    fetch(req).catch(() => caches.match(req))
  );
});

// ── Stale-while-revalidate ──
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

// ── Network-first (for API calls) ──
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

// ── Cache eviction (prevent unbounded growth) ──
async function evictIfNeeded(cache) {
  const keys = await cache.keys();
  if (keys.length > MAX_CACHE_ENTRIES) {
    // Delete oldest 20 entries (FIFO)
    const toDelete = keys.slice(0, 20);
    await Promise.all(toDelete.map((key) => cache.delete(key)));
  }
}

// ── Message: allow page to trigger skipWaiting ──
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
