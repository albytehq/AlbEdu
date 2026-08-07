// page-transition-overlay.js — loading overlay for slow navigations and for
// browsers without View Transitions API support.
//
// Strategy: on internal-link click, start a 500ms timer. If the new page
// hasn't loaded by then, show the overlay. Hide on pageshow.
//
// View Transitions (when supported) handles the animation, so this overlay
// is a fallback. Safety timeout at 8s avoids a stuck overlay if pageshow
// never fires.

(function () {
  'use strict';

  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  if (window.__albeduOverlayInit) return;
  window.__albeduOverlayInit = true;

  // Admin pages: skip entirely. User requested truly instant admin nav —
  // no overlay, no timer, no listeners. View Transitions also opts out
  // (see view-transitions.js), so admin→admin is pure browser navigation.
  function _isAdminPage() {
    var path = window.location.pathname;
    if (path.indexOf('/admin/') !== -1 || path.indexOf('/pages/admin') !== -1) {
      return true;
    }
    return !!document.querySelector('aside.sidebar');
  }
  if (_isAdminPage()) {
    if (!window.AlbEdu) window.AlbEdu = {};
    window.AlbEdu.overlayReady = true;
    return;
  }

  var OVERLAY_DELAY_MS = 500;
  var OVERLAY_TIMEOUT_MS = 8000;
  var FADE_OUT_MS = 200; // matches loading.css transition

  var overlayEl = null;
  var showTimer = null;
  var safetyTimer = null;

  function _ensureOverlay() {
    if (overlayEl) return overlayEl;
    overlayEl = document.querySelector('.page-transition');
    if (!overlayEl) {
      overlayEl = document.createElement('div');
      overlayEl.className = 'page-transition';
      overlayEl.setAttribute('aria-hidden', 'true');
      document.body.appendChild(overlayEl);
    }
    return overlayEl;
  }

  function _showOverlay() {
    var el = _ensureOverlay();
    if (!el) return;
    el.classList.add('visible');
    el.classList.remove('hidden', 'gone');
    el.setAttribute('aria-hidden', 'false');
  }

  function _hideOverlay() {
    if (!overlayEl) return;
    overlayEl.classList.remove('visible');
    overlayEl.classList.add('hidden');
    overlayEl.setAttribute('aria-hidden', 'true');
    // Set display:none after the transition finishes (cleanup DOM).
    setTimeout(function () {
      if (overlayEl && !overlayEl.classList.contains('visible')) {
        overlayEl.classList.add('gone');
      }
    }, FADE_OUT_MS + 50);
  }

  function _clearTimers() {
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
    if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
  }

  function _isEligibleLink(link, e) {
    if (!link || link.tagName !== 'A') return false;
    var href = link.getAttribute('href');
    if (!href) return false;
    if (href.charAt(0) === '#') return false;
    if (/^(javascript|data|mailto|tel|blob):/i.test(href)) return false;
    if (/^https?:\/\//i.test(href)) {
      try {
        var url = new URL(link.href, window.location.href);
        if (url.origin !== window.location.origin) return false;
      } catch (_) { return false; }
    }
    var target = link.getAttribute('target');
    if (target === '_blank' || target === '_top' || target === '_parent') return false;
    if (link.hasAttribute('download')) return false;
    if (e && (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey)) return false;
    if (e && e.defaultPrevented) return false;
    if (e && e.button !== 0) return false;
    return true;
  }

  // Bubble-phase click listener so it runs AFTER view-transitions.js
  // (which uses capture + stopImmediatePropagation). If VT handles the
  // click, e.defaultPrevented is true and we skip the overlay timer.
  document.addEventListener('click', function (e) {
    var link = e.target.closest ? e.target.closest('a[href]') : null;
    if (!_isEligibleLink(link, e)) return;

    if (e.defaultPrevented) return;

    // VT will handle this — skip overlay.
    if (typeof document.startViewTransition === 'function' && window.AlbEdu?.viewTransitionsReady) {
      return;
    }

    _clearTimers();
    showTimer = setTimeout(function () {
      _showOverlay();
    }, OVERLAY_DELAY_MS);

    safetyTimer = setTimeout(function () {
      _hideOverlay();
      _clearTimers();
    }, OVERLAY_TIMEOUT_MS);
  }, false); // bubble phase

  // If VT starts, cancel the overlay timer — VT handles the animation.
  if (typeof document.startViewTransition === 'function') {
    document.addEventListener('viewtransitionstart', function () {
      _clearTimers();
    });
  }

  // Hide overlay when the new page is ready. Handles both fresh navigations
  // and bfcache restore (browser back/forward).
  window.addEventListener('pageshow', function () {
    _clearTimers();
    _hideOverlay();
  });

  window.addEventListener('pagehide', function () {
    _clearTimers();
  }, { once: true });

  if (!window.AlbEdu) window.AlbEdu = {};
  window.AlbEdu.overlayReady = true;
})();
