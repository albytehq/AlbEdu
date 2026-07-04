// =============================================================================
// page-transition-overlay.js — AlbEdu Shared Layer · Phase 4: Loading Fallback
// =============================================================================
// Responsibility:
//   Tampilkan loading overlay saat navigation lambat atau saat browser
//   tidak support View Transitions API (Phase 2 fallback).
//
// Strategy:
//   1. Saat user klik internal link, start timer 500ms
//   2. Kalau halaman baru belum load dalam 500ms → tampilkan overlay
//   3. Kalau halaman baru load < 500ms → overlay tidak muncul (instant)
//   4. Saat pageshow event fire → hide overlay
//
// Co-existence dengan Phase 2 (View Transitions):
//   - Browser DENGAN VT: VT handle animasi (cross-fade 180ms). Overlay
//     TIDAK muncul (timer di-clear saat VT start). Fallback only.
//   - Browser TANPA VT (Firefox/Safari lama): Overlay muncul kalau
//     navigation > 500ms. Cegah "dead click" perception.
//
// Co-existence dengan Phase 3 (Prefetch):
//   - Prefetch membuat navigation biasanya < 500ms → overlay jarang muncul
//   - Tapi kalau network lambat / first visit (no cache), overlay jadi
//     loading indicator yang useful
//
// Architecture:
//   - Auto-inject <div class="page-transition"> kalau belum ada di DOM
//   - Pakai existing CSS di loading.css (no new CSS needed)
//   - 500ms threshold — researched sweet spot (Linear, GitHub pakai 200-500ms)
//   - Auto-hide di pageshow event (handle bfcache restore juga)
//   - Safety timeout 8 detik — kalau halaman belum load, hide overlay
//     (avoid stuck overlay jika pageshow tidak fire)
//
// Safety:
//   - Skip external links, anchor links, modifier keys (sama kayak VT)
//   - Tidak preventDefault — biarkan browser navigate natural
//   - Tidak interfere dengan VT (Phase 2) — clear timer saat VT start
//
// Load strategy:
//   File ini di-inject oleh critical-css.js via <script defer>.
// =============================================================================

(function () {
  'use strict';

  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  // Guard: jangan double-init
  if (window.__albeduOverlayInit) return;
  window.__albeduOverlayInit = true;

  // ── Config ───────────────────────────────────────────────────────────
  var OVERLAY_DELAY_MS = 500;       // tunggu 500ms sebelum overlay muncul
  var OVERLAY_TIMEOUT_MS = 8000;    // safety: hide setelah 8 detik max
  var FADE_OUT_MS = 200;            // CSS transition duration (match loading.css)

  var overlayEl = null;
  var showTimer = null;
  var safetyTimer = null;

  // ── Inject overlay div kalau belum ada di DOM ────────────────────────
  // 7 admin pages sudah punya div ini. 20 halaman lain belum — auto-inject
  // supaya konsisten di semua halaman.
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

  // ── Tampilkan overlay ────────────────────────────────────────────────
  function _showOverlay() {
    var el = _ensureOverlay();
    if (!el) return;
    el.classList.add('visible');
    el.classList.remove('hidden', 'gone');
    el.setAttribute('aria-hidden', 'false');
  }

  // ── Sembunyikan overlay ──────────────────────────────────────────────
  function _hideOverlay() {
    if (!overlayEl) return;
    overlayEl.classList.remove('visible');
    overlayEl.classList.add('hidden');
    overlayEl.setAttribute('aria-hidden', 'true');
    // Set display:none setelah transition selesai (cleanup DOM)
    setTimeout(function () {
      if (overlayEl && !overlayEl.classList.contains('visible')) {
        overlayEl.classList.add('gone');
      }
    }, FADE_OUT_MS + 50);
  }

  // ── Clear semua timer ────────────────────────────────────────────────
  function _clearTimers() {
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
    if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
  }

  // ── Cek apakah link eligible (sama kayak VT logic) ───────────────────
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

  // ── Click handler — start timer ──────────────────────────────────────
  // Pakai BUBBLE phase (bukan capture) supaya jalan SETELAH VT (Phase 2).
  // VT pakai capture + stopImmediatePropagation. Kalau overlay juga capture,
  // dia tidak akan jalan karena stopImmediatePropagation block handler lain.
  //
  // Dengan bubble phase + cek e.defaultPrevented:
  //   - Kalau VT handle: e.defaultPrevented = true → overlay skip (VT handle)
  //   - Kalau VT tidak support: e.defaultPrevented = false → overlay start timer
  //
  // Flow:
  //   1. User klik link
  //   2. VT handler (capture) jalan duluan:
  //      - Kalau VT support: preventDefault + startViewTransition → e.defaultPrevented=true
  //      - Kalau VT tidak support: VT handler skip (tidak preventDefault)
  //   3. Overlay handler (bubble) jalan:
  //      - Cek e.defaultPrevented → kalau true, skip (VT handle)
  //      - Kalau false, start overlay timer 500ms
  //   4. Setelah 500ms, kalau halaman belum unload → overlay muncul
  //   5. pageshow event fire di halaman baru → overlay hide
  document.addEventListener('click', function (e) {
    var link = e.target.closest ? e.target.closest('a[href]') : null;
    if (!_isEligibleLink(link, e)) return;

    // Skip kalau VT sudah handle (preventDefault + startViewTransition)
    if (e.defaultPrevented) return;

    // Skip kalau VT akan handle (Phase 2 aktif + API support)
    // Defensive: kalau VT handler tidak jalan (e.g. race condition), tetap skip
    // Pakai typeof check (lebih robust dari 'in')
    if (typeof document.startViewTransition === 'function' && window.AlbEdu?.viewTransitionsReady) {
      return;
    }

    // Browser tidak support VT, atau VT tidak ready — start overlay timer
    _clearTimers();
    showTimer = setTimeout(function () {
      _showOverlay();
    }, OVERLAY_DELAY_MS);

    // Safety: kalau pageshow tidak fire dalam 8 detik, hide overlay
    safetyTimer = setTimeout(function () {
      _hideOverlay();
      _clearTimers();
    }, OVERLAY_TIMEOUT_MS);
  }, false); // ← bubble phase (bukan capture)

  // ── Listen VT start event — cancel overlay timer ─────────────────────
  // Kalau VT jalan, overlay tidak perlu muncul (VT handle animasi).
  // Cukup dengarkan 'viewtransitionstart' — cancel timer.
  // 'viewtransitionend' tidak perlu didengarkan karena overlay memang tidak
  // muncul saat VT aktif (timer sudah di-cancel di start).
  if (typeof document.startViewTransition === 'function') {
    document.addEventListener('viewtransitionstart', function () {
      _clearTimers();
    });
  }

  // ── pageshow — hide overlay saat halaman ready ───────────────────────
  // Handle 2 case:
  //   1. Halaman baru selesai load (normal navigation)
  //   2. bfcache restore (browser back/forward)
  window.addEventListener('pageshow', function () {
    _clearTimers();
    _hideOverlay();
  });

  // ── pagehide — cleanup (defensive) ───────────────────────────────────
  window.addEventListener('pagehide', function () {
    _clearTimers();
  }, { once: true });

  // ── Mark ready ───────────────────────────────────────────────────────
  if (!window.AlbEdu) window.AlbEdu = {};
  window.AlbEdu.overlayReady = true;
})();
