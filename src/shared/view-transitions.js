// =============================================================================
// view-transitions.js — AlbEdu Shared Layer · Phase 2: Cross-Page Transitions
// =============================================================================
// Responsibility:
//   Intercept clicks pada internal <a href> links dan wrap navigation dengan
//   document.startViewTransition() untuk cross-fade halus antar halaman.
//
//   Progressive enhancement:
//   - Browser DENGAN View Transitions API (Chrome 111+, Edge 111+, Safari 18+):
//     Cross-fade 180ms + admin sidebar persist + content slide-in.
//   - Browser TANPA support (Firefox, Safari < 18):
//     Navigasi biasa, no animation, no break.
//
// Architecture:
//   1. Detect feature: 'startViewTransition' in document
//   2. Capture-phase click listener on document (intercept SEBELUM navigasi.js)
//   3. Cek apakah link internal (same-origin, no target=_blank, no modifier keys)
//   4. Set .albedu-admin-shell class di <html> kalau halaman admin (untuk
//      sidebar persist animation)
//   5. document.startViewTransition(() => navigate) — browser handle sisanya
//
// Safety:
//   - Skip: external links (http://, https://, mailto:, tel:)
//   - Skip: anchor links (#)
//   - Skip: javascript: URLs
//   - Skip: target=_blank / target=_top
//   - Skip: modifier keys (Ctrl/Cmd/Shift/Alt — new tab / download)
//   - Skip: download attribute
//   - Skip: <button> elements (otomatis — VT cuma intercept <a href>)
//   - Skip: kalau click di-cancel (e.defaultPrevented) oleh handler lain
//
// Load strategy:
//   File ini di-inject oleh critical-css.js via <script defer>.
//   Akan jalan setelah HTML parse selesai, sebelum window.load.
// =============================================================================

(function () {
  'use strict';

  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  // ── Feature detection ────────────────────────────────────────────────
  // Kalau browser gak support, skip entirely — navigasi biasa.
  // Pakai typeof check (lebih robust dari 'in' — handle case dimana
  // property ada tapi value undefined, e.g. setelah Object.defineProperty).
  if (typeof document.startViewTransition !== 'function') {
    return;
  }

  // Guard: jangan double-init kalau file ke-load 2x (defensive)
  if (window.__albeduViewTransitionsInit) return;
  window.__albeduViewTransitionsInit = true;

  // ── Detect halaman admin ─────────────────────────────────────────────
  // Pattern: URL mengandung /admin/ ATAU halaman ada <aside class="sidebar">
  function _isAdminPage() {
    var path = window.location.pathname;
    if (path.indexOf('/admin/') !== -1 || path.indexOf('/pages/admin') !== -1) {
      return true;
    }
    return !!document.querySelector('aside.sidebar');
  }

  // ── [v0.745.0] ADMIN AREA: ZERO page transition ──────────────────────
  // User request: "hapus page transition sepenuhnya, wajib instant, di
  // area albedu creates". Untuk achieve truly instant:
  //
  //   1. Inject `@view-transition { navigation: none }` — override global
  //      `@view-transition { navigation: auto }` dari tokens.css. Ini
  //      disable Chrome 126+ MPA VT cross-fade untuk admin pages. Tanpa
  //      ini, browser tetap bikin VT snapshot (overhead + brief freeze)
  //      walau animation: none.
  //   2. Skip click interceptor entirely — gak ada startViewTransition
  //      call, gak ada .albedu-admin-shell class, gak ada handler.
  //   3. Mark viewTransitionsReady = true supaya page-transition-overlay.js
  //      juga skip (overlay gak muncul).
  //   4. Return early — sisa file gak dieksekusi untuk admin.
  //
  // Result: admin→admin navigation = pure browser natural navigation.
  // No VT, no overlay, no snapshot, no animation. Truly instant.
  if (_isAdminPage()) {
    try {
      var noVtStyle = document.createElement('style');
      noVtStyle.id = 'albedu-admin-no-vt';
      noVtStyle.textContent = '@view-transition { navigation: none; }';
      document.head.appendChild(noVtStyle);
    } catch (_) { /* noop */ }

    if (!window.AlbEdu) window.AlbEdu = {};
    window.AlbEdu.viewTransitionsReady = true;
    return; // ← admin: stop here, no VT setup
  }

  // ── Cek apakah link eligible untuk view transition ───────────────────
  function _isEligibleLink(link, e) {
    // Hanya <a> element
    if (!link || link.tagName !== 'A') return false;

    var href = link.getAttribute('href');
    if (!href) return false;

    // Skip anchor links (#...)
    if (href.charAt(0) === '#') return false;

    // Skip javascript: / data: / mailto: / tel:
    if (/^(javascript|data|mailto|tel|blob):/i.test(href)) return false;

    // Skip absolute URLs ke domain lain
    if (/^https?:\/\//i.test(href)) {
      // Cek same-origin
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

    // Skip modifier keys (new tab, new window, download via keyboard)
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return false;

    // Skip kalau click sudah di-cancel oleh handler lain (e.g. preventDefault)
    if (e.defaultPrevented) return false;

    // Skip button-type clicks (form submit)
    if (e.button !== 0) return false;

    return true;
  }

  // ── Click interceptor (capture phase) — NON-ADMIN only ──────────────
  // Admin pages return early di atas, jadi handler ini cuma jalan di
  // non-admin pages. Untuk non-admin → admin click, skip VT (natural nav).
  document.addEventListener('click', function (e) {
    var link = e.target.closest ? e.target.closest('a[href]') : null;
    if (!link) return;

    if (!_isEligibleLink(link, e)) return;

    var href = link.getAttribute('href');

    // [v0.745.0] Non-admin → admin click: skip VT, natural navigation.
    // Admin area has ZERO page transition (lihat early-return di atas).
    // Entering admin should be instant too.
    var targetIsAdmin = href.indexOf('admin/') !== -1 || href.indexOf('/admin') !== -1;
    if (targetIsAdmin) {
      return; // natural navigation, no VT
    }

    // Non-admin → non-admin: intercept with startViewTransition
    e.preventDefault();
    e.stopImmediatePropagation();

    try {
      var transition = document.startViewTransition(function () {
        window.location.href = link.href;
      });

      if (transition && transition.finished) {
        transition.finished.catch(function (_) {
          // Transition abort (misal user klik link lain) — no-op
        });
      }
    } catch (err) {
      // Fallback: kalau startViewTransition throw, navigate biasa
      window.location.href = link.href;
    }
  }, true); // ← capture phase

  // ── Browser back/forward ─────────────────────────────────────────────
  // View Transitions API dengan @view-transition { navigation: auto }
  // sudah handle back/forward otomatis di browser yang support (Chrome 126+).
  // Browser yang support startViewTransition TAPI belum support @view-transition
  // (Chrome 111-125) juga sudah handle back/forward via bfcache — tidak perlu
  // intercept manual popstate. Biarkan browser default behavior.
  //
  // (Sebelumnya ada popstate handler kosong — dead code, sudah dihapus.)

  // ── Mark siap untuk debugging ────────────────────────────────────────
  if (!window.AlbEdu) window.AlbEdu = {};
  window.AlbEdu.viewTransitionsReady = true;
})();
