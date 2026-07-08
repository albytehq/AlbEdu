// link-prefetch.js — prefetch destination pages before the user clicks them.
// Three modes (hybrid):
//   1. Viewport prefetch: when a link enters the viewport (200px margin),
//      inject <link rel="prefetch">. Capped at 10 per page; skipped when
//      navigator.connection.saveData is on.
//   2. Hover/focus prefetch: 100ms after hover or immediately on focus.
//      Intent-driven, no cap.
//   3. Touchstart prefetch (mobile): exploit the 300ms touchstart→click gap.
//
// Skips external/anchor/javascript links, target=_blank, download attribute.
// Dedup via Set so each URL is only prefetched once.

(function () {
  'use strict';

  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  if (window.__albeduLinkPrefetchInit) return;
  window.__albeduLinkPrefetchInit = true;

  var VIEWPORT_ROOT_MARGIN = '200px';
  var VIEWPORT_MAX_PREFETCH = 10;
  var HOVER_DELAY_MS = 100;
  var DEDUP_SET = new Set();
  var viewportPrefetchCount = 0;

  // Skip viewport prefetch when the user has data saver on. Hover/focus still
  // fire — they're explicit intent.
  function _isDataSaver() {
    if (navigator.connection && navigator.connection.saveData) return true;
    return false;
  }

  function _isEligibleLink(link) {
    if (!link || link.tagName !== 'A') return false;

    var href = link.getAttribute('href');
    if (!href) return false;

    if (href.charAt(0) === '#') return false;
    if (/^(javascript|data|mailto|tel|blob):/i.test(href)) return false;

    // Skip absolute cross-origin URLs.
    if (/^https?:\/\//i.test(href)) {
      try {
        var url = new URL(link.href, window.location.href);
        if (url.origin !== window.location.origin) return false;
      } catch (_) {
        return false;
      }
    }

    var target = link.getAttribute('target');
    if (target === '_blank' || target === '_top' || target === '_parent') {
      return false;
    }

    if (link.hasAttribute('download')) return false;

    return true;
  }

  function _prefetch(link, source) {
    if (!link || !link.href) return;

    // Skip current page — already in memory.
    try {
      var linkUrl = new URL(link.href, window.location.href);
      var currentUrl = window.location;
      if (linkUrl.pathname === currentUrl.pathname && linkUrl.search === currentUrl.search) {
        return;
      }
    } catch (_) { /* malformed URL — skip safety check, allow prefetch */ }

    if (DEDUP_SET.has(link.href)) return;
    DEDUP_SET.add(link.href);

    var prefetchLink = document.createElement('link');
    prefetchLink.rel = 'prefetch';
    prefetchLink.href = link.href;
    prefetchLink.as = 'document';
    // crossorigin anonymous so it can be cached cross-origin if needed.
    prefetchLink.setAttribute('crossorigin', 'anonymous');

    // On failure, remove from dedup so a later attempt can retry.
    prefetchLink.onerror = function () {
      DEDUP_SET.delete(link.href);
      if (prefetchLink.parentNode) prefetchLink.parentNode.removeChild(prefetchLink);
    };

    document.head.appendChild(prefetchLink);

    // Dev-only debug log. Enable with:
    //   localStorage.setItem('albedu-prefetch-debug', '1')
    try {
      if (window.console && console.debug && localStorage.getItem('albedu-prefetch-debug') === '1') {
        console.debug('[prefetch:' + source + ']', link.href);
      }
    } catch (_) { /* localStorage might throw in private mode */ }
  }

  // Mode 1: Viewport prefetch (skipped if data saver is on).
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
          io.unobserve(link);
        }
      }
    }, {
      rootMargin: VIEWPORT_ROOT_MARGIN,
      threshold: 0.01,
    });

    var links = document.querySelectorAll('a[href]');
    for (var j = 0; j < links.length; j++) {
      if (_isEligibleLink(links[j])) {
        io.observe(links[j]);
      }
    }

    // Re-observe dynamically added links.
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

    // Explicit cleanup on pagehide — browsers auto-clean on navigation,
    // but this avoids any leak edge cases.
    window.addEventListener('pagehide', function () {
      try { if (io) io.disconnect(); } catch (_) {}
      try { if (mo) mo.disconnect(); } catch (_) {}
    }, { once: true });
  }

  // Mode 2: Hover/focus prefetch. 100ms hover delay avoids triggering on
  // mouse-flying-past-navbar; focus is instant (keyboard = high intent).
  function _setupHoverPrefetch() {
    var hoverTimer = null;

    document.addEventListener('mouseover', function (e) {
      var link = e.target.closest ? e.target.closest('a[href]') : null;
      if (!link || !_isEligibleLink(link)) return;

      if (hoverTimer) clearTimeout(hoverTimer);
      hoverTimer = setTimeout(function () {
        _prefetch(link, 'hover');
      }, HOVER_DELAY_MS);
    }, true);

    document.addEventListener('mouseout', function () {
      if (hoverTimer) {
        clearTimeout(hoverTimer);
        hoverTimer = null;
      }
    }, true);

    document.addEventListener('focusin', function (e) {
      var link = e.target.closest ? e.target.closest('a[href]') : null;
      if (!link || !_isEligibleLink(link)) return;
      _prefetch(link, 'focus');
    }, true);
  }

  // Mode 3: Touchstart prefetch (mobile).
  function _setupTouchPrefetch() {
    document.addEventListener('touchstart', function (e) {
      var link = e.target.closest ? e.target.closest('a[href]') : null;
      if (!link || !_isEligibleLink(link)) return;
      _prefetch(link, 'touch');
    }, { passive: true, capture: true });
  }

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
