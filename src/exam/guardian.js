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
      ctrl && e.shiftKey && key === 'i',  // Chrome DevTools
      ctrl && e.shiftKey && key === 'j',  // Chrome Console
      ctrl && e.shiftKey && key === 'c',  // Chrome Inspect Element
      ctrl && key === 'u',               // View Source
    ];

    if (devCombos.some(Boolean)) {
      e.preventDefault();
      _triggerViolation('Shortcut keyboard ini tidak diizinkan saat asesmen.');
    }
  }

  // --- 8. Window blur detection -> VIOLATION (debounced) --------------
  // Catches Alt+Tab, clicking another app, etc. that visibilitychange
  // might miss (especially on multi-monitor setups where the tab stays
  // "visible" but the user is clearly not looking at it).
  //
  // DOUBLE-TRIGGER FIX v0.854.0: When a peserta switches tabs, the browser
  // fires BOTH `visibilitychange` (hidden) AND `window.blur`. Without
  // cross-coordination, both debounce timers mature (~800ms + ~1000ms)
  // producing TWO violations for ONE user action. Now:
  //   1. `_focusLossJustFired` flag — set when EITHER timer fires, cleared
  //      on `window.focus` / visibility=visible. Prevents the second timer
  //      from firing for the same focus-loss event.
  //   2. `_handleWindowBlur` checks if a visibility violation is pending
  //      and skips starting its own timer (visibility fires faster at 800ms).
  //   3. `_handleVisibilityChange` (hidden) cancels any pending blur timer.
  let _blurTimer = null;
  let _focusLossJustFired = false;
  const FOCUS_LOSS_GRACE_MS = 1500; // grace window after a focus-loss violation
  const BLUR_DEBOUNCE_MS = 1000; // 1s — brief focus losses (autocomplete) don't trigger

  function _handleWindowBlur() {
    if (!_isActive) return;
    // If visibility already fired OR is pending, skip — same user action
    if (_focusLossJustFired) return;
    if (_visibilityTimer) {
      // Visibility debounce is pending (will fire at 800ms before our 1000ms) —
      // don't start a competing blur timer.
      return;
    }
    _blurTimer = setTimeout(() => {
      _blurTimer = null;
      if (_focusLossJustFired) return; // visibility fired while we were waiting
      _focusLossJustFired = true;
      _triggerViolation('Anda meninggalkan jendela asesmen!');
      setTimeout(() => { _focusLossJustFired = false; }, FOCUS_LOSS_GRACE_MS);
    }, BLUR_DEBOUNCE_MS);
  }

  function _handleWindowFocus() {
    if (_blurTimer) {
      clearTimeout(_blurTimer);
      _blurTimer = null;
    }
    // Clear the "just fired" flag on focus return — allows the NEXT focus
    // loss (a separate user action) to be detected.
    _focusLossJustFired = false;
  }

  // --- 9. DevTools size detection (passive) ---------------------------
  // Detects when DevTools is opened by checking if the window's outer
  // dimensions are significantly smaller than the inner dimensions
  // (DevTools takes up space). Also detects very small windows
  // (potential screen sharing or split-screen cheating).
  let _devToolsCheckInterval = null;
  const DEVTOOLS_THRESHOLD = 160; // px difference threshold
  let _lastInnerWidth = window.innerWidth;
  let _lastInnerHeight = window.innerHeight;

  function _checkDevTools() {
    if (!_isActive) return;
    const wDiff = window.outerWidth - window.innerWidth;
    const hDiff = window.outerHeight - window.innerHeight;

    // DevTools open (side panel or bottom panel)
    if (wDiff > DEVTOOLS_THRESHOLD || hDiff > DEVTOOLS_THRESHOLD) {
      _triggerViolation('Developer Tools terdeteksi! Tutup segera.');
      return;
    }

    // Window resized very small (potential cheating — screen share, split)
    if (window.innerWidth < 400 || window.innerHeight < 300) {
      _triggerViolation('Ukuran jendela terlalu kecil. Perbesar jendela browser.');
      return;
    }

    // Detect orientation change / resize that might indicate screen splitting
    const resizeDelta = Math.abs(window.innerWidth - _lastInnerWidth) +
                        Math.abs(window.innerHeight - _lastInnerHeight);
    if (resizeDelta > 200) {
      // Large resize — could be splitting screen to cheat
      // Don't trigger violation (too many false positives), just log
      console.warn('[ExamGuardian] Large window resize detected:', resizeDelta + 'px');
    }
    _lastInnerWidth = window.innerWidth;
    _lastInnerHeight = window.innerHeight;
  }

  // --- 10. PrintScreen block (silent) --------------------------------
  function _handleKeyUp(e) {
    // PrintScreen key
    if (e.key === 'PrintScreen') {
      // Clear clipboard to prevent screenshot paste
      try {
        navigator.clipboard?.writeText?.('');
      } catch (_) {}
      _triggerViolation('PrintScreen tidak diizinkan saat asesmen!');
    }
  }

  // --- 11. Drag and drop block ---------------------------------------
  function _blockDragStart(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  function _blockDrop(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  // --- Pindah tab / minimize -> violation (DEBOUNCED) ----------------------
  // BUGFIX B: Previously ANY visibilityState=hidden fired a violation --
  // including OS notifications, screen lock, autofill dropdowns, and
  // multi-monitor focus loss. Now we require the page to be hidden for
  // at least 800ms before counting it as a violation. Brief focus losses
  // (notifications, etc.) cancel the timer and do not penalize the user.
  //
  // DOUBLE-TRIGGER FIX v0.854.0: visibilitychange and window.blur both
  // fire on tab switch. We cancel the blur timer when visibility goes
  // hidden, and set _focusLossJustFired so the blur timer (if it already
  // started) won't fire its own violation.
  let _visibilityTimer = null;
  const VISIBILITY_DEBOUNCE_MS = 800;

  function _handleVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      // Cancel any pending blur violation — visibility will handle this event
      if (_blurTimer) {
        clearTimeout(_blurTimer);
        _blurTimer = null;
      }
      // Start debounce timer -- only fire violation if page stays hidden
      _visibilityTimer = setTimeout(() => {
        _visibilityTimer = null;
        if (_focusLossJustFired) return; // blur already fired (shouldn't happen, but defensive)
        _focusLossJustFired = true;
        _triggerViolation('Kamu berpindah tab atau meninggalkan halaman asesmen!');
        setTimeout(() => { _focusLossJustFired = false; }, FOCUS_LOSS_GRACE_MS);
      }, VISIBILITY_DEBOUNCE_MS);
    } else {
      // Page became visible again -- cancel the pending violation
      if (_visibilityTimer) {
        clearTimeout(_visibilityTimer);
        _visibilityTimer = null;
      }
      // Clear the "just fired" flag — next focus loss is a new event
      _focusLossJustFired = false;
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
    document.addEventListener('keyup',            _handleKeyUp,            { capture: true });
    document.addEventListener('visibilitychange', _handleVisibilityChange);
    window.addEventListener('blur',               _handleWindowBlur);
    window.addEventListener('focus',              _handleWindowFocus);
    document.addEventListener('dragstart',        _blockDragStart,         { capture: true });
    document.addEventListener('drop',             _blockDrop,              { capture: true });
    document.addEventListener('dragover',         _blockDrop,              { capture: true });

    // DevTools size detection — check every 2s
    _devToolsCheckInterval = setInterval(_checkDevTools, 2000);
  }

  // --- deactivate -----------------------------------------------------------
  // Fix (Agent 4): DON'T reset _warningCount on deactivate() — only reset on
  // activate(). deactivate() is called by AntiCheat.pause() (during submit
  // dialog). If submit fails + _resumeSecurity() calls activate(), the old
  // code erased all accumulated violations → peserta got a fresh slate.
  function deactivate() {
    _isActive = false;
    // NOTE: _warningCount intentionally NOT reset here — see comment above.
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
    document.removeEventListener('keyup',            _handleKeyUp,            { capture: true });
    document.removeEventListener('visibilitychange', _handleVisibilityChange);
    window.removeEventListener('blur',               _handleWindowBlur);
    window.removeEventListener('focus',              _handleWindowFocus);
    document.removeEventListener('dragstart',        _blockDragStart,         { capture: true });
    document.removeEventListener('drop',             _blockDrop,              { capture: true });
    document.removeEventListener('dragover',         _blockDrop,              { capture: true });

    if (_devToolsCheckInterval) {
      clearInterval(_devToolsCheckInterval);
      _devToolsCheckInterval = null;
    }
    if (_blurTimer) {
      clearTimeout(_blurTimer);
      _blurTimer = null;
    }
  }

  // --- Public API -----------------------------------------------------------
  function onViolation(cb)     { _onViolationCallback    = cb; }
  function onMaxViolation(cb)  { _onMaxViolationCallback = cb; }
  function getWarningCount()   { return _warningCount; }
  function resetWarningCount() { _warningCount = 0; }

  return { activate, deactivate, onViolation, onMaxViolation, getWarningCount, resetWarningCount };
})();