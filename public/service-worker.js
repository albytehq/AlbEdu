// service-worker.js — AlbEdu PWA service worker (stale-while-revalidate + network-first)

const CACHE_VERSION = 'albedu-v0.818.0';
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
  // Landing + auth
  base('/'),
  base('/index.html'),
  base('/pages/login.html'),
  base('/pages/register-admin.html'),
  base('/pages/register-success.html'),
  base('/pages/forgot-password.html'),
  base('/pages/reset-password.html'),
  base('/pages/privacy-policy.html'),
  base('/404.html'),
  OFFLINE_FALLBACK,

  // Admin
  base('/pages/admin/index.html'),
  base('/pages/admin/profile.html'),
  base('/pages/admin/create-assessment.html'),
  base('/pages/admin/active-assessments.html'),
  base('/pages/admin/monitoring.html'),
  base('/pages/admin/results-analytics.html'),
  base('/pages/admin/daftar-nama.html'),

  // Assessment
  base('/pages/assessment/index.html'),
  base('/pages/assessment/take.html'),
  base('/pages/assessment/blocked.html'),
  base('/pages/assessment/submitted.html'),

  // CSS
  base('/styles/tokens.css'),
  base('/styles/albedu-v1.css'),
  base('/styles/loading.css'),
  base('/styles/navigasi.css'),
  base('/styles/admin-panel.css'),
  base('/styles/notification-panel.css'),
  base('/styles/profile.css'),

  base('/public/QNotify/ui/notify.css'),
  base('/public/QNotify/ui/dialog.css'),
  base('/public/QNotify/ui/label.css'),
  base('/public/QNotify/ui/Readnote.css'),

  // JS — shared head + icons
  base('/src/shared/head/critical-css.js'),
  base('/src/shared/head/fonts.js'),
  base('/src/shared/icons/icons.js'),

  // JS — shared core
  base('/src/shared/boot.js'),
  base('/src/shared/qnotify-loader.js'),
  base('/src/shared/error-boundary.js'),
  base('/src/shared/race-condition.js'),
  base('/src/shared/observability.js'),
  base('/src/shared/resilience.js'),
  base('/src/shared/view-transitions.js'),
  base('/src/shared/link-prefetch.js'),
  base('/src/shared/page-transition-overlay.js'),

  // JS — platform + auth + utils + security + theme
  base('/src/platform/supabase-client.js'),
  base('/src/platform/repository.js'),
  base('/src/auth/main.js'),
  base('/src/auth/security.js'),
  base('/src/auth/errors.js'),
  base('/src/auth/user-helpers.js'),
  base('/src/auth/byteward.js'),
  base('/src/utils/ui.js'),
  base('/src/utils/navigasi.js'),
  base('/src/utils/admin-notification-center.js'),
  base('/src/utils/self-storage.js'),
  base('/src/security/sanitize.js'),
  base('/src/theme-system/index.js'),

  // Fonts
  base('/public/fonts/plus-jakarta-sans-latin.woff2'),
  base('/public/fonts/plus-jakarta-sans-latin-ext.woff2'),
  base('/public/fonts/jetbrains-mono-latin.woff2'),

  // Images
  base('/public/images/logo.svg'),
  base('/public/images/favicon/favicon.ico'),
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
  /albyte-inc\.workers\.dev/,
];

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

  if (STATIC_PATTERNS.some((p) => p.test(req.url)) || isSameOrigin) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  event.respondWith(
    fetch(req).catch(() => caches.match(req))
  );
});

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
