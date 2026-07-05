// =============================================================================
// link-prefetch.js — AlbEdu Shared Layer · Phase 3: Predictive Prefetch
// =============================================================================
// Responsibility:
//   Prefetch halaman tujuan SEBELUM user klik, supaya saat klik terjadi
//   halaman sudah ada di browser cache → instant load.
//
// Strategy (2 mode, hybrid):
//
//   1. VIEWPORT PREFETCH (background, low priority)
//      Saat link masuk viewport (200px margin), prefetch halaman tujuan.
//      Cost: bandwidth. Benefit: kalau user klik, instant.
//      Limit: max 10 prefetch per halaman (cegah waste).
//
//   2. HOVER/FOCUS PREFETCH (high priority, intent-based)
//      Saat user hover atau focus link (mouse mendekati 100ms), prefetch.
//      Lebih akurat karena user menunjukkan intent.
//      Limit: tidak ada (user-driven, pasti dibutuhkan).
//
//   3. TOUCHSTART PREFETCH (mobile)
//      Saat user touch link (sebelum click event fire), prefetch.
//      Mobile punya 300ms delay antara touchstart → click — manfaatkan.
//
// Architecture:
//   - Pure <link rel="prefetch"> injection — zero dependency
//   - IntersectionObserver untuk viewport detection
//   - Dedup via Set supaya tidak prefetch link yang sama 2x
//   - respect prefers-reduced-data (skip viewport prefetch kalau user
//     pakai data saver / cellular)
//
// Co-existence dengan Phase 2 (View Transitions):
//   Prefetch TIDAK interferes dengan VT. Prefetch cuma fetch HTML ke cache.
//   VT tetap handle animasi cross-fade. Kombinasi: instant + animated.
//
// Safety:
//   - Skip external links (http://, https:// cross-origin)
//   - Skip anchor links (#)
//   - Skip javascript:, mailto:, tel:
//   - Skip target=_blank
//   - Skip download attribute
//   - Skip kalau link sudah di-prefetch (dedup)
//   - Skip kalau user prefers-reduced-data
//
// Load strategy:
//   File ini di-inject oleh critical-css.js via <script defer>.
// =============================================================================

(function () {
  'use strict';

  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  // ── Guard: jangan double-init ────────────────────────────────────────
  if (window.__albeduLinkPrefetchInit) return;
  window.__albeduLinkPrefetchInit = true;

  // ── Config ───────────────────────────────────────────────────────────
  var VIEWPORT_ROOT_MARGIN = '200px';      // prefetch saat link 200px dari viewport
  var VIEWPORT_MAX_PREFETCH = 10;          // max 10 link di-prefetch per halaman
  var HOVER_DELAY_MS = 100;                // tunggu 100ms sebelum prefetch on hover
  var DEDUP_SET = new Set();               // track URL yang sudah di-prefetch
  var viewportPrefetchCount = 0;

  // ── Cek apakah user pakai data saver / reduced data ──────────────────
  // Kalau ya, skip viewport prefetch (hemat bandwidth). Hover/focus tetap jalan
  // karena user-driven (intent-based, pasti dibutuhkan).
  function _isDataSaver() {
    if (navigator.connection && navigator.connection.saveData) return true;
    return false;
  }

  // ── Cek apakah link eligible untuk prefetch ──────────────────────────
  function _isEligibleLink(link) {
    if (!link || link.tagName !== 'A') return false;

    var href = link.getAttribute('href');
    if (!href) return false;

    // Skip anchor links
    if (href.charAt(0) === '#') return false;

    // Skip javascript:, mailto:, tel:, data:
    if (/^(javascript|data|mailto|tel|blob):/i.test(href)) return false;

    // Skip absolute URLs cross-origin
    if (/^https?:\/\//i.test(href)) {
      try {
        var url = new URL(link.href, window.location.href);
        if (url.origin !== window.location.origin) return false;
      } catch (_) {
        return false;
      }
    }

    // Skip target=_blank / _top / _parent
    var target = link.getAttribute('target');
    if (target === '_blank' || target === '_top' || target === '_parent') {
      return false;
    }

    // Skip download attribute
    if (link.hasAttribute('download')) return false;

    return true;
  }

  // ── Prefetch link (inject <link rel="prefetch">) ─────────────────────
  function _prefetch(link, source) {
    if (!link || !link.href) return;

    // Skip current page — sudah ada di memory, waste request
    // Compare pathname + search (ignore hash fragment)
    try {
      var linkUrl = new URL(link.href, window.location.href);
      var currentUrl = window.location;
      if (linkUrl.pathname === currentUrl.pathname && linkUrl.search === currentUrl.search) {
        return;
      }
    } catch (_) { /* malformed URL — skip safety check, allow prefetch */ }

    // Dedup — jangan prefetch URL yang sama 2x
    if (DEDUP_SET.has(link.href)) return;
    DEDUP_SET.add(link.href);

    // Inject <link rel="prefetch">
    var prefetchLink = document.createElement('link');
    prefetchLink.rel = 'prefetch';
    prefetchLink.href = link.href;
    prefetchLink.as = 'document';
    // crossorigin anonymous supaya bisa di-cache cross-origin (jika perlu)
    prefetchLink.setAttribute('crossorigin', 'anonymous');

    // Error handler — remove dari dedup kalau gagal (supaya bisa retry nanti)
    prefetchLink.onerror = function () {
      DEDUP_SET.delete(link.href);
      if (prefetchLink.parentNode) prefetchLink.parentNode.removeChild(prefetchLink);
    };

    document.head.appendChild(prefetchLink);

    // Debug log — only when explicitly enabled via localStorage flag.
    // Production: silent (no console noise).
    // Dev: enable with `localStorage.setItem('albedu-prefetch-debug', '1')`
    try {
      if (window.console && console.debug && localStorage.getItem('albedu-prefetch-debug') === '1') {
        console.debug('[prefetch:' + source + ']', link.href);
      }
    } catch (_) { /* localStorage might throw in private mode */ }
  }

  // ── Mode 1: Viewport prefetch (IntersectionObserver) ─────────────────
  // Skip kalau data saver aktif — viewport prefetch bisa waste bandwidth.
  function _setupViewportPrefetch() {
    if (_isDataSaver()) return;
    if (!('IntersectionObserver' in window)) return;

    var io = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) {
          var link = entries[i].target;
          if (viewportPrefetchCount < VIEWPORT_MAX_PREFETCH && _isEligibleLink(link)) {
            _prefetch(link, 'viewport');
            viewportPrefetchCount++;
          }
          // Unobserve setelah first intersect (one-shot per link)
          io.unobserve(link);
        }
      }
    }, {
      rootMargin: VIEWPORT_ROOT_MARGIN,
      threshold: 0.01,
    });

    // Observe semua eligible links
    var links = document.querySelectorAll('a[href]');
    for (var j = 0; j < links.length; j++) {
      if (_isEligibleLink(links[j])) {
        io.observe(links[j]);
      }
    }

    // Re-observe link baru yang ditambahkan dynamically (MutationObserver)
    var mo = null;
    if ('MutationObserver' in window) {
      mo = new MutationObserver(function (mutations) {
        for (var k = 0; k < mutations.length; k++) {
          var added = mutations[k].addedNodes;
          for (var m = 0; m < added.length; m++) {
            var node = added[m];
            if (node.nodeType !== 1) continue;
            if (node.tagName === 'A' && _isEligibleLink(node)) {
              io.observe(node);
            }
            if (node.querySelectorAll) {
              var innerLinks = node.querySelectorAll('a[href]');
              for (var n = 0; n < innerLinks.length; n++) {
                if (_isEligibleLink(innerLinks[n])) {
                  io.observe(innerLinks[n]);
                }
              }
            }
          }
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }

    // Cleanup observers saat page hide — defensive against memory leaks
    // (browser auto-cleanup saat navigation, tapi explicit lebih aman)
    window.addEventListener('pagehide', function () {
      try { if (io) io.disconnect(); } catch (_) {}
      try { if (mo) mo.disconnect(); } catch (_) {}
    }, { once: true });
  }

  // ── Mode 2: Hover/Focus prefetch (intent-based) ──────────────────────
  // User hover atau focus link = intent tinggi. Prefetch immediately.
  // Dedup via DEDUP_SET mencegah unlimited prefetch URL yang sama.
  // Tidak ada global cap — hover/focus adalah user-driven, pasti dibutuhkan.
  function _setupHoverPrefetch() {
    var hoverTimer = null;

    document.addEventListener('mouseover', function (e) {
      var link = e.target.closest ? e.target.closest('a[href]') : null;
      if (!link || !_isEligibleLink(link)) return;

      // Delay 100ms supaya tidak prefetch saat user mouse-melewati link
      // tanpa intent klik (mouse moving fast across navbar)
      if (hoverTimer) clearTimeout(hoverTimer);
      hoverTimer = setTimeout(function () {
        _prefetch(link, 'hover');
      }, HOVER_DELAY_MS);
    }, true);

    // Clear timer kalau mouse leave — cegah prefetch kalau user cuma lewat
    document.addEventListener('mouseout', function () {
      if (hoverTimer) {
        clearTimeout(hoverTimer);
        hoverTimer = null;
      }
    }, true);

    // Focus prefetch (keyboard navigation) — instant, no delay
    // User yang pakai Tab key = intent tinggi, langsung prefetch
    document.addEventListener('focusin', function (e) {
      var link = e.target.closest ? e.target.closest('a[href]') : null;
      if (!link || !_isEligibleLink(link)) return;
      _prefetch(link, 'focus');
    }, true);
  }

  // ── Mode 3: Touchstart prefetch (mobile) ─────────────────────────────
  // Mobile punya 300ms delay antara touchstart → click. Manfaatkan untuk
  // prefetch selama delay itu. Saat click fire, halaman sudah ada di cache.
  function _setupTouchPrefetch() {
    document.addEventListener('touchstart', function (e) {
      var link = e.target.closest ? e.target.closest('a[href]') : null;
      if (!link || !_isEligibleLink(link)) return;
      _prefetch(link, 'touch');
    }, { passive: true, capture: true });
  }

  // ── Init (setelah DOM ready) ──────────────────────────────────────────
  function _init() {
    _setupViewportPrefetch();
    _setupHoverPrefetch();
    _setupTouchPrefetch();

    if (!window.AlbEdu) window.AlbEdu = {};
    window.AlbEdu.linkPrefetchReady = true;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }
})();
