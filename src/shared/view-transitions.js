// view-transitions.js — wrap internal-link navigations with
// document.startViewTransition() for a cross-fade. Progressive enhancement:
// browsers without the API get plain navigation.
//
// Admin pages opt out entirely (truly instant nav). On non-admin→admin clicks
// we also skip VT and let the browser navigate naturally.

(function () {
  'use strict';

  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  // Feature detection. typeof check handles the case where the property
  // exists but is undefined (for example, after Object.defineProperty).
  if (typeof document.startViewTransition !== 'function') {
    return;
  }

  if (window.__albeduViewTransitionsInit) return;
  window.__albeduViewTransitionsInit = true;

  function _isAdminPage() {
    var path = window.location.pathname;
    if (path.indexOf('/admin/') !== -1 || path.indexOf('/pages/admin') !== -1) {
      return true;
    }
    return !!document.querySelector('aside.sidebar');
  }

  // Admin: inject `@view-transition { navigation: none }` to override the
  // global `auto` from tokens.css, then bail. Without this override Chrome
  // 126+ still snapshots (overhead + brief freeze) even when animation:none.
  if (_isAdminPage()) {
    try {
      var noVtStyle = document.createElement('style');
      noVtStyle.id = 'albedu-admin-no-vt';
      noVtStyle.textContent = '@view-transition { navigation: none; }';
      document.head.appendChild(noVtStyle);
    } catch (_) { /* noop */ }

    if (!window.AlbEdu) window.AlbEdu = {};
    window.AlbEdu.viewTransitionsReady = true;
    return;
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
      } catch (_) {
        return false;
      }
    }

    var target = link.getAttribute('target');
    if (target === '_blank' || target === '_top' || target === '_parent') {
      return false;
    }

    if (link.hasAttribute('download')) return false;

    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return false;
    if (e.defaultPrevented) return false;
    if (e.button !== 0) return false;

    return true;
  }

  // Capture-phase click interceptor (non-admin pages only). Entering admin
  // is intentionally non-animated — let the browser navigate naturally.
  document.addEventListener('click', function (e) {
    var link = e.target.closest ? e.target.closest('a[href]') : null;
    if (!link) return;

    if (!_isEligibleLink(link, e)) return;

    var href = link.getAttribute('href');

    var targetIsAdmin = href.indexOf('admin/') !== -1 || href.indexOf('/admin') !== -1;
    if (targetIsAdmin) {
      return;
    }

    e.preventDefault();
    e.stopImmediatePropagation();

    try {
      var transition = document.startViewTransition(function () {
        window.location.href = link.href;
      });

      if (transition && transition.finished) {
        transition.finished.catch(function (_) {
          // Transition aborted (for example, user clicked another link) — no-op.
        });
      }
    } catch (err) {
      // Fallback: if startViewTransition throws, navigate the normal way.
      window.location.href = link.href;
    }
  }, true); // capture phase

  // Back/forward: @view-transition { navigation: auto } handles this in
  // Chrome 126+. Chrome 111-125 + Safari/Firefox rely on bfcache. No need
  // for a manual popstate handler.

  if (!window.AlbEdu) window.AlbEdu = {};
  window.AlbEdu.viewTransitionsReady = true;
})();
