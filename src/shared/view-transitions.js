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

  // ── Detect halaman admin (untuk sidebar persist animation) ───────────
  // Pattern: URL mengandung /admin/ ATAU halaman ada <aside class="sidebar">
  // Pathname check duluan (O(1) string search) — lebih cepat dari querySelector.
  // querySelector cuma fallback untuk edge case (e.g. halaman admin tanpa
  // /admin/ di URL, atau dynamic route).
  function _isAdminPage() {
    var path = window.location.pathname;
    if (path.indexOf('/admin/') !== -1 || path.indexOf('/pages/admin') !== -1) {
      return true;
    }
    // Fallback: cek <aside class="sidebar"> (hanya admin pages yang punya ini)
    return !!document.querySelector('aside.sidebar');
  }

  // Set class di <html> supaya CSS selector .albedu-admin-shell ::view-transition
  // bisa target halaman admin saja.
  if (_isAdminPage()) {
    document.documentElement.classList.add('albedu-admin-shell');
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

  // ── Click interceptor (capture phase, jalan SEBELUM handler lain) ────
  // Pakai capture: true supaya kita pertama kali lihat click, sebelum
  // navigasi.js atau handler lain mungkin preventDefault.
  document.addEventListener('click', function (e) {
    // Cari anchor ancestor dari click target
    var link = e.target.closest ? e.target.closest('a[href]') : null;
    if (!link) return;

    if (!_isEligibleLink(link, e)) return;

    var href = link.getAttribute('href');

    // [FIX v0.743.0] Skip VT entirely untuk admin area.
    // Alasan:
    //   1. Slide-in animation (translateX 12px) bikin "flinch" yang
    //      distracting saat pindah halaman admin.
    //   2. Saat VT intercept click, navigasi.js click handler tidak jalan
    //      (stopImmediatePropagation) → mobile sidebar drawer tidak sempat
    //      tertutup sebelum navigation → kedip saat halaman ganti.
    //   3. User request: "pindah halaman instan kayak gak ada animasi".
    //
    // Dengan skip VT untuk admin:
    //   - Browser navigate natural (no startViewTransition call)
    //   - navigasi.js click handler jalan normal → sidebar mobile tertutup
    //     BEFORE navigation → gak ada kedip
    //   - Chrome 126+ tetap apply default MPA cross-fade (250ms) via
    //     @view-transition { navigation: auto } di tokens.css, TAPI kita
    //     override animation: none untuk .albedu-admin-shell (lihat tokens.css)
    //     → truly instant.
    var targetIsAdmin = href.indexOf('admin/') !== -1 || href.indexOf('/admin') !== -1;
    if (_isAdminPage() || targetIsAdmin) {
      // Set class di <html> supaya CSS override animation: none jalan
      // untuk MPA VT cross-fade (Chrome 126+).
      if (targetIsAdmin) {
        document.documentElement.classList.add('albedu-admin-shell');
      }
      // Return tanpa preventDefault → browser navigate natural.
      return;
    }

    // Set .albedu-admin-shell di halaman TUJUAN kalau link ke admin page.
    // Kita tidak bisa set class di halaman tujuan sebelum load — tapi
    // kita bisa set di halaman SEKARANG, dan CSS akan apply ke transition
    // root. Untuk sidebar persist, halaman tujuan juga harus set class
    // saat DOM ready — sudah di-handle di atas (_isAdminPage).
    //
    // Trick: set class di <html> sekarang, biar transition pakai
    // animation slide-in. Halaman tujuan akan re-set class saat ready.
    // ↑ NOTE: block ini sekarang dead code karena admin case sudah di-handle
    // di atas (skip VT). Tinggal untuk non-admin → non-admin navigation.

    // Intercept navigasi
    e.preventDefault();
    e.stopImmediatePropagation(); // ← cegah handler lain preventDefault ulang

    // Start view transition — callback navigate ke URL tujuan.
    // Browser akan screenshot DOM lama, load halaman baru, screenshot DOM baru,
    // lalu animasikan cross-fade antara dua screenshot.
    //
    // NOTE: navigasi.js click handler (mobile drawer closeSidebar) tidak akan
    // jalan karena stopImmediatePropagation. Tapi navigasi.js punya pagehide
    // listener yang handle cleanup saat halaman unload. Jadi sidebar mobile
    // akan tertutup via pagehide, bukan via click handler. Acceptable.
    // ↑ NOTE: di atas sudah skip VT untuk admin, jadi blok ini cuma jalan
    // untuk non-admin → non-admin navigation (yang gak punya sidebar drawer).
    try {
      var transition = document.startViewTransition(function () {
        // Set location.href — browser akan navigate dan render halaman baru.
        // Saat halaman baru selesai render (atau partial), transition jalan.
        window.location.href = link.href;
      });

      // Safety: kalau transition ready, skip page-transition overlay
      // (Phase 4 akan handle overlay — untuk sekarang biarkan)
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
