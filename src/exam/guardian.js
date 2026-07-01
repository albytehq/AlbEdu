/**
 * ExamGuardian.js
 * Sistem anti-kecurangan.
 *
 * Filosofi:
 *   - Copy/paste/select/klik kanan/long-press -> DISABLE SILENT (tidak ada warning)
 *   - Violation HANYA dari: dev tools shortcuts + pindah tab/minimize
 *
 * Anti-copy berlapis:
 *   1. CSS user-select: none (tidak bisa select teks)
 *   2. selectstart event block (drag-select mati)
 *   3. copy/cut/paste event block capture=true (shortcut mati)
 *   4. document.execCommand override (execCommand copy mati)
 *   5. navigator.clipboard override (async API mati)
 *   6. contextmenu block silent (klik kanan + long-press mati, NO violation)
 *   7. touchstart/touchend long-press neutralize (mobile long-press mati)
 */

const ExamGuardian = (() => {
  let _isActive = false;
  let _warningCount = 0;
  const MAX_WARNINGS = 4;
  let _onViolationCallback = null;
  let _onMaxViolationCallback = null;

  // --- 1. CSS inject: user-select none -------------------------------------
  let _styleEl = null;

  function _injectCSS() {
    if (_styleEl) return;
    _styleEl = document.createElement('style');
    _styleEl.id = 'exam-guardian-css';
    _styleEl.textContent = `
      body.exam-active, body.exam-active * {
        -webkit-user-select: none !important;
        -moz-user-select:    none !important;
        -ms-user-select:     none !important;
        user-select:         none !important;
        -webkit-user-drag:   none !important;
        -webkit-touch-callout: none !important; /* iOS long-press callout */
      }
    `;
    document.head.appendChild(_styleEl);
  }

  function _removeCSS() {
    _styleEl?.remove();
    _styleEl = null;
    document.body.classList.remove('exam-active');
  }

  // --- 2. selectstart block -------------------------------------------------
  function _blockSelectStart(e) {
    e.preventDefault();
  }

  // --- 3. copy/cut/paste block (silent) -------------------------------------
  function _silentBlock(e) {
    e.preventDefault();
    e.stopImmediatePropagation(); // matikan semua listener lain
    try { e.clipboardData?.setData('text/plain', ''); } catch (_) {}
  }

  // --- 4. execCommand override ---------------------------------------------
  function _overrideExecCommand() {
    const orig = document.execCommand.bind(document);
    document._examExecOrig = orig;
    document.execCommand = (cmd, ...args) => {
      if (['copy', 'cut', 'paste'].includes(String(cmd).toLowerCase())) return false;
      return orig(cmd, ...args);
    };
  }

  function _restoreExecCommand() {
    if (document._examExecOrig) {
      document.execCommand = document._examExecOrig;
      delete document._examExecOrig;
    }
  }

  // --- 5. navigator.clipboard override -------------------------------------
  let _clipboardOrig = null;
  function _overrideClipboardAPI() {
    if (!navigator.clipboard) return;
    _clipboardOrig = {
      readText:  navigator.clipboard.readText?.bind(navigator.clipboard),
      writeText: navigator.clipboard.writeText?.bind(navigator.clipboard),
      read:      navigator.clipboard.read?.bind(navigator.clipboard),
      write:     navigator.clipboard.write?.bind(navigator.clipboard),
    };
    const blocked = () => Promise.reject(new DOMException('Blocked by exam', 'NotAllowedError'));
    navigator.clipboard.readText  = blocked;
    navigator.clipboard.writeText = blocked;
    navigator.clipboard.read      = blocked;
    navigator.clipboard.write     = blocked;
  }

  function _restoreClipboardAPI() {
    if (!navigator.clipboard || !_clipboardOrig) return;
    Object.keys(_clipboardOrig).forEach(k => {
      if (_clipboardOrig[k]) navigator.clipboard[k] = _clipboardOrig[k];
    });
    _clipboardOrig = null;
  }

  // --- 6. Context menu block SILENT (klik kanan + mobile long-press) --------
  // TIDAK trigger violation -- hanya preventDefault
  function _blockContextMenu(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  // --- 7. Mobile long-press neutralize -------------------------------------
  // iOS/Android: long-press -> selection callout. Blok dengan touch cancel.
  let _touchTimer = null;

  function _onTouchStart(e) {
    // Jika sudah lebih dari 300ms tanpa touchend/touchmove -> long press
    _touchTimer = setTimeout(() => {
      // Paksa selection clear
      window.getSelection()?.removeAllRanges();
    }, 300);
  }

  function _onTouchEndOrMove() {
    clearTimeout(_touchTimer);
    _touchTimer = null;
  }

  // --- Dev tools keyboard block -> VIOLATION --------------------------------
  function _blockKeyboard(e) {
    const key  = e.key?.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;

    // Clipboard shortcuts -> silent block ONLY, no violation
    const isClipboard =
      (ctrl && ['c', 'x', 'v', 'a'].includes(key)) ||
      (ctrl && e.shiftKey && key === 'c');

    if (isClipboard) {
      e.preventDefault();
      e.stopPropagation();
      // Juga clear selection kalau ada
      window.getSelection()?.removeAllRanges();
      return;
    }

    // BUGFIX I: ctrl+S (save page) and ctrl+P (print) are common user
    // actions, not dev-tools shortcuts. Previously they triggered a
    // cheating violation -- users pressing them instinctively got
    // penalized unfairly. Now they are silently blocked (like ctrl+C)
    // without counting as a violation.
    const silentBlockCombos = [
      ctrl && key === 's',
      ctrl && key === 'p',
    ];

    if (silentBlockCombos.some(Boolean)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // Dev tools shortcuts -> violation (these are genuinely suspicious)
    const devCombos = [
      key === 'f12',
      key === 'f11',
      ctrl && e.shiftKey && key === 'i',
      ctrl && e.shiftKey && key === 'j',
      ctrl && key === 'u',
    ];

    if (devCombos.some(Boolean)) {
      e.preventDefault();
      _triggerViolation('Shortcut keyboard ini tidak diizinkan saat ujian.');
    }
  }

  // --- Pindah tab / minimize -> violation (DEBOUNCED) ----------------------
  // BUGFIX B: Previously ANY visibilityState=hidden fired a violation --
  // including OS notifications, screen lock, autofill dropdowns, and
  // multi-monitor focus loss. Now we require the page to be hidden for
  // at least 800ms before counting it as a violation. Brief focus losses
  // (notifications, etc.) cancel the timer and do not penalize the user.
  let _visibilityTimer = null;
  const VISIBILITY_DEBOUNCE_MS = 800;

  function _handleVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      // Start debounce timer -- only fire violation if page stays hidden
      _visibilityTimer = setTimeout(() => {
        _visibilityTimer = null;
        _triggerViolation('Kamu berpindah tab atau meninggalkan halaman ujian!');
      }, VISIBILITY_DEBOUNCE_MS);
    } else {
      // Page became visible again -- cancel the pending violation
      if (_visibilityTimer) {
        clearTimeout(_visibilityTimer);
        _visibilityTimer = null;
      }
    }
  }

  // --- Trigger violation ----------------------------------------------------
  function _triggerViolation(pesan) {
    if (!_isActive) return;
    _warningCount++;

    _onViolationCallback?.({ pesan, ke: _warningCount, maks: MAX_WARNINGS, isFinal: _warningCount >= MAX_WARNINGS });

    if (_warningCount >= MAX_WARNINGS) {
      _isActive = false;
      _onMaxViolationCallback?.();
    }
  }

  // --- activate -------------------------------------------------------------
  function activate() {
    if (_isActive) return;
    _isActive     = true;
    _warningCount = 0;

    _injectCSS();
    document.body.classList.add('exam-active');

    // Disable copy/paste/select -- semua silent
    document.addEventListener('selectstart',   _blockSelectStart,  { capture: true, passive: false });
    document.addEventListener('copy',          _silentBlock,       { capture: true, passive: false });
    document.addEventListener('cut',           _silentBlock,       { capture: true, passive: false });
    document.addEventListener('paste',         _silentBlock,       { capture: true, passive: false });
    document.addEventListener('contextmenu',   _blockContextMenu,  { capture: true, passive: false });
    document.addEventListener('touchstart',    _onTouchStart,      { capture: true, passive: true  });
    document.addEventListener('touchend',      _onTouchEndOrMove,  { capture: true, passive: true  });
    document.addEventListener('touchmove',     _onTouchEndOrMove,  { capture: true, passive: true  });

    _overrideExecCommand();
    _overrideClipboardAPI();

    // Violation triggers
    document.addEventListener('keydown',          _blockKeyboard,          { capture: true });
    document.addEventListener('visibilitychange', _handleVisibilityChange);
  }

  // --- deactivate -----------------------------------------------------------
  // FIX BUG-10: Reset warningCount saat deactivate agar state bersih
  // untuk sesi ujian berikutnya. Sebelumnya warningCount persist
  // dan bisa trigger false max-violation jika ExamGuardian di-reuse.
  function deactivate() {
    _isActive = false;
    _warningCount = 0;
    clearTimeout(_touchTimer);

    _removeCSS();

    document.removeEventListener('selectstart',   _blockSelectStart,  { capture: true });
    document.removeEventListener('copy',          _silentBlock,       { capture: true });
    document.removeEventListener('cut',           _silentBlock,       { capture: true });
    document.removeEventListener('paste',         _silentBlock,       { capture: true });
    document.removeEventListener('contextmenu',   _blockContextMenu,  { capture: true });
    document.removeEventListener('touchstart',    _onTouchStart,      { capture: true, passive: true });
    document.removeEventListener('touchend',      _onTouchEndOrMove,  { capture: true, passive: true });
    document.removeEventListener('touchmove',     _onTouchEndOrMove,  { capture: true, passive: true });

    _restoreExecCommand();
    _restoreClipboardAPI();

    document.removeEventListener('keydown',          _blockKeyboard,          { capture: true });
    document.removeEventListener('visibilitychange', _handleVisibilityChange);
  }

  // --- Public API -----------------------------------------------------------
  function onViolation(cb)     { _onViolationCallback    = cb; }
  function onMaxViolation(cb)  { _onMaxViolationCallback = cb; }
  function getWarningCount()   { return _warningCount; }
  function resetWarningCount() { _warningCount = 0; }

  return { activate, deactivate, onViolation, onMaxViolation, getWarningCount, resetWarningCount };
})();