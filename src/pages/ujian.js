/**
 * ujian.js — Token Validator v3.8.1
 *
 * CHANGES v3.8.1:
 *   [1] FIX: Shake + Red Flash sekarang benar-benar muncul — hapus !important di
 *       border/background yang nge-block keyframe, dan set transition:none saat shake
 *       agar CSS transition gak konflik sama CSS animation.
 *   [2] FIX: Error flash di progress bar — force reflow sebelum add class.
 *   [3] FIX: Cleanup timer dinaikkan ke 800ms agar sesuai durasi animasi baru.
 *
 * CHANGES v3.8.0:
 *   [1] .token-slot overflow:visible — ripple & shake gak ke-clip.
 *       Digit-display dikandung di .token-slot-clip (overflow:hidden) terpisah.
 *   [2] Kolom berubah warna saat digit masuk (.filled) & saat 5/5 (.all-complete).
 *   [3] Error flash di progress bar — finally block gak langsung reset saat shake jalan.
 *   [4] Ripple Pulse berjalan — box-shadow di slot yang overflow:visible.
 */

document.addEventListener('DOMContentLoaded', function () {
  const tokenInputs = document.querySelectorAll('.token-input');
  const tokenForm   = document.getElementById('tokenForm');
  const submitBtn   = document.getElementById('submitBtn');

  // ── State ──────────────────────────────────────────────────────────────────
  let attemptCount      = 0;
  let cooldownUntil     = null;
  let cooldownInterval  = null;
  let isValidating      = false;
  let shakeCleanupTimer = null;

  // ── DB readiness ───────────────────────────────────────────────────────────
  function _getFirestoreOrThrow() {
    if (window.firebaseDb) return window.firebaseDb;
    throw new Error('Database tidak tersedia. Periksa koneksi internet.');
  }

  // BUGFIX D: Generate a per-browser device ID for server-side rate limiting.
  // Stored in localStorage so it persists across sessions. This is NOT a
  // real fingerprint — it is just a stable identifier so the server can
  // apply per-device limits on top of the unbypassable per-IP limits.
  function _getDeviceId() {
    try {
      let id = localStorage.getItem('albedu_exam_device_id');
      if (!id) {
        id = 'dev_' + Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
        localStorage.setItem('albedu_exam_device_id', id);
      }
      return id;
    } catch (_) { return 'dev_unknown'; }
  }

  // Call the exam-token-attempt Edge Function for server-side rate limiting.
  // Returns { allowed, retryAfter?, attempts? } or throws on network error.
  async function _checkServerRateLimit() {
    if (!window.sb?.functions?.invoke) return { allowed: true };
    const deviceId = _getDeviceId();
    const { data, error } = await window.sb.functions.invoke('exam-token-attempt', {
      body: { deviceId },
    });
    if (error) {
      // Try to extract backend error code
      let code = null;
      if (error?.context && typeof error.context.json === 'function') {
        try { const body = await error.context.json(); code = body?.error; } catch (_) {}
      }
      if (code === 'rate_limit_exceeded') {
        return { allowed: false, retryAfter: 3600, reason: 'server' };
      }
      // Network/other error — do not block the user (fail open here,
      // the localStorage rate limit still applies as a fallback).
      return { allowed: true };
    }
    if (data?.success && data?.allowed) return { allowed: true, attempts: data.attempts };
    if (!data?.success && data?.error === 'rate_limit_exceeded') {
      return { allowed: false, retryAfter: data.retryAfter || 3600, reason: 'server' };
    }
    return { allowed: true };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DOM SETUP — Wrap each input in .token-slot + .token-slot-clip + digit-display
  // ═══════════════════════════════════════════════════════════════════════════
  const digitDisplays = [];
  const tokenSlots    = [];

  tokenInputs.forEach(function (input, idx) {
    // 1. Create slot wrapper (overflow:visible — untuk ripple & shake)
    var slot = document.createElement('div');
    slot.className = 'token-slot';
    input.parentNode.insertBefore(slot, input);
    slot.appendChild(input);

    // 2. Create clip wrapper (overflow:hidden — untuk digit animation)
    var clip = document.createElement('div');
    clip.className = 'token-slot-clip';
    slot.appendChild(clip);

    // 3. Create digit display (visual layer, dikandung di clip)
    var display = document.createElement('span');
    display.className = 'digit-display';
    display.setAttribute('aria-hidden', 'true');
    clip.appendChild(display);

    digitDisplays[idx] = display;
    tokenSlots[idx]    = slot;

    // Clean up animation class
    display.addEventListener('animationend', function () {
      display.classList.remove('animate-in');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PROGRESS GLOW — inject progress bar
  // ═══════════════════════════════════════════════════════════════════════════
  var inputsContainer = document.querySelector('.token-inputs');
  var progressTrack, progressFill;

  if (inputsContainer) {
    progressTrack = document.createElement('div');
    progressTrack.className = 'token-progress-track';

    progressFill = document.createElement('div');
    progressFill.className = 'token-progress-fill';

    progressTrack.appendChild(progressFill);
    inputsContainer.parentNode.insertBefore(progressTrack, inputsContainer.nextSibling);
  }

  /** Update progress bar + filled state on inputs + complete state */
  function updateVisualState() {
    if (!progressFill) return;
    var filled = 0;
    var total  = tokenInputs.length;

    tokenInputs.forEach(function (inp, idx) {
      var hasValue = inp.value && /^\d$/.test(inp.value);
      if (hasValue) filled++;

      // Filled state per-kolom
      if (hasValue) {
        inp.classList.add('filled');
        digitDisplays[idx].classList.add('filled');
      } else {
        inp.classList.remove('filled');
        digitDisplays[idx].classList.remove('filled');
      }
    });

    var pct = (filled / total) * 100;
    progressFill.style.width = pct + '%';

    // Glow dot
    if (filled > 0) {
      progressFill.classList.add('has-progress');
    } else {
      progressFill.classList.remove('has-progress');
    }

    // All-complete state (5/5 → hijau)
    var isComplete = (filled === total);
    progressFill.classList.toggle('complete', isComplete);

    tokenInputs.forEach(function (inp) {
      inp.classList.toggle('all-complete', isComplete);
    });
    digitDisplays.forEach(function (d) {
      d.classList.toggle('all-complete', isComplete);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ANIMATION 1 — RIPPLE PULSE pada .token-slot
  // ═══════════════════════════════════════════════════════════════════════════
  function triggerRipplePulse(idx) {
    var slot = tokenSlots[idx];
    if (!slot) return;
    slot.classList.remove('ripple-pulse');
    void slot.offsetWidth;
    slot.classList.add('ripple-pulse');

    slot.addEventListener('animationend', function handler(e) {
      if (e.animationName === 'ripplePulse') {
        slot.classList.remove('ripple-pulse');
        slot.removeEventListener('animationend', handler);
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ANIMATION 3 — SHAKE + RED FLASH saat token salah
  //   - Shake transform: di .token-slot (overflow:visible)
  //   - Red flash: di .token-input (border + background)
  //   - Digit display: merah
  //   - Progress bar: flash merah
  // ═══════════════════════════════════════════════════════════════════════════
  function triggerShakeError() {
    if (shakeCleanupTimer) {
      clearTimeout(shakeCleanupTimer);
      shakeCleanupTimer = null;
    }

    // Disable transitions dulu di semua input agar gak konflik sama animation
    tokenInputs.forEach(function (input) {
      input.style.transition = 'none';
    });

    // Shake semua slot + red flash semua input + merah semua digit
    tokenSlots.forEach(function (slot) {
      slot.classList.remove('shake-error');
      void slot.offsetWidth;
      slot.classList.add('shake-error');
    });

    tokenInputs.forEach(function (input) {
      input.classList.remove('shake-error');
      void input.offsetWidth;
      input.classList.add('shake-error');
    });

    digitDisplays.forEach(function (d) {
      d.classList.add('shake-error');
    });

    // Progress bar flash merah
    if (progressFill) {
      progressFill.classList.remove('error-flash');
      void progressFill.offsetWidth;
      progressFill.classList.add('error-flash');
    }

    // Cleanup setelah animasi selesai (shake 0.55s + red flash 0.7s = ~800ms)
    shakeCleanupTimer = setTimeout(function () {
      tokenSlots.forEach(function (slot) {
        slot.classList.remove('shake-error');
      });
      tokenInputs.forEach(function (input) {
        input.classList.remove('shake-error');
        // Restore transitions
        input.style.transition = '';
      });
      digitDisplays.forEach(function (d) {
        d.classList.remove('shake-error');
      });
      if (progressFill) {
        progressFill.classList.remove('error-flash');
      }

      // Clear semua input setelah shake
      tokenInputs.forEach(function (inp) {
        inp.value = '';
        inp.classList.remove('filled', 'all-complete');
      });
      digitDisplays.forEach(function (d) {
        d.textContent = '';
        d.classList.remove('animate-in', 'filled', 'all-complete');
      });
      updateVisualState();

      // Re-enable inputs kalau gak ada cooldown
      if (!cooldownUntil || cooldownUntil <= Date.now()) {
        tokenInputs.forEach(function (inp) { inp.disabled = false; });
        tokenInputs[0]?.focus();
      }

      shakeCleanupTimer = null;
    }, 800);
  }

  // ── Digit bounce helper ────────────────────────────────────────────────────
  function triggerDigitBounce(idx) {
    var display = digitDisplays[idx];
    var input   = tokenInputs[idx];
    if (!display || !input) return;

    display.textContent = input.value || '';
    display.classList.remove('animate-in');
    void display.offsetWidth;
    display.classList.add('animate-in');
  }

  function clearDigitDisplay(idx) {
    var display = digitDisplays[idx];
    if (!display) return;
    display.textContent = '';
    display.classList.remove('animate-in');
  }

  // ── Rate limit helpers ─────────────────────────────────────────────────────
  function loadRateLimitState() {
    const storedAttempts = localStorage.getItem('exam_token_attempts');
    const storedCooldown = localStorage.getItem('exam_token_cooldown');

    attemptCount = storedAttempts ? parseInt(storedAttempts, 10) : 0;
    const now    = Date.now();

    if (storedCooldown) {
      const cooldownTime = parseInt(storedCooldown, 10);
      if (cooldownTime > now) {
        cooldownUntil = cooldownTime;
        disableInputs(true);
        startCooldownTimer();
      } else {
        resetRateLimit();
      }
    } else {
      cooldownUntil = null;
      disableInputs(false);
    }
  }

  function saveRateLimitState() {
    localStorage.setItem('exam_token_attempts', attemptCount.toString());
    if (cooldownUntil && cooldownUntil > Date.now()) {
      localStorage.setItem('exam_token_cooldown', cooldownUntil.toString());
    } else {
      localStorage.removeItem('exam_token_cooldown');
    }
  }

  function resetRateLimit() {
    attemptCount  = 0;
    cooldownUntil = null;
    localStorage.removeItem('exam_token_attempts');
    localStorage.removeItem('exam_token_cooldown');

    if (cooldownInterval) {
      clearInterval(cooldownInterval);
      cooldownInterval = null;
    }

    removeCountdownDisplay();
    disableInputs(false);
    tokenInputs.forEach(i => i.value = '');
    digitDisplays.forEach(d => { d.textContent = ''; d.classList.remove('animate-in', 'filled', 'all-complete'); });
    tokenInputs.forEach(i => i.classList.remove('filled', 'all-complete'));
    updateVisualState();
    tokenInputs[0]?.focus();
  }

  function startCooldownTimer() {
    removeCountdownDisplay();

    const countdownDiv       = document.createElement('div');
    countdownDiv.className   = 'countdown-timer';
    countdownDiv.id          = 'cooldownTimer';
    countdownDiv.innerHTML   = `<i class="material-symbols-outlined">hourglass_top</i> <span id="cooldownSeconds">60</span> detik tersisa`;
    tokenForm.parentNode.insertBefore(countdownDiv, tokenForm.nextSibling);

    if (cooldownInterval) clearInterval(cooldownInterval);
    cooldownInterval = setInterval(() => {
      if (!cooldownUntil) { clearInterval(cooldownInterval); cooldownInterval = null; return; }

      const remaining = Math.ceil((cooldownUntil - Date.now()) / 1000);
      const span      = document.getElementById('cooldownSeconds');
      if (span) span.textContent = Math.max(0, remaining);

      if (remaining <= 0) {
        clearInterval(cooldownInterval);
        cooldownInterval = null;
        resetRateLimit();
        _notify('success', 'Cooldown Selesai', 'Silakan coba masukkan token kembali.');
      }
    }, 1000);
  }

  function removeCountdownDisplay() {
    document.getElementById('cooldownTimer')?.remove();
  }

  function disableInputs(disabled) {
    tokenInputs.forEach(function (inp, idx) {
      inp.disabled = disabled;
      if (disabled) {
        tokenSlots[idx].classList.add('disabled');
      } else {
        tokenSlots[idx].classList.remove('disabled');
      }
    });
    if (submitBtn) submitBtn.disabled = disabled;
  }

  function isRateLimited() {
    loadRateLimitState();
    if (cooldownUntil && cooldownUntil > Date.now()) {
      const remaining = Math.ceil((cooldownUntil - Date.now()) / 1000);
      _notify('warning', 'Terlalu Banyak Percobaan', `Tunggu ${remaining} detik sebelum mencoba lagi.`);
      return true;
    }
    return false;
  }

  function recordFailedAttempt() {
    attemptCount++;
    saveRateLimitState();

    // ── TRIGGER SHAKE + RED FLASH ──
    triggerShakeError();

    if (attemptCount >= 3) {
      cooldownUntil = Date.now() + 60_000;
      saveRateLimitState();
      disableInputs(true);
      startCooldownTimer();
      _notify('error', 'Batas Percobaan Terlampaui', 'Anda 3 kali gagal. Tunggu 1 menit.');
      return false;
    }

    const sisa = 3 - attemptCount;
    _notify('warning', 'Token Salah', `Token tidak valid. Sisa percobaan: ${sisa} kali.`);
    return true;
  }

  function resetAttemptsOnSuccess() {
    attemptCount  = 0;
    cooldownUntil = null;
    saveRateLimitState();
    if (cooldownInterval) { clearInterval(cooldownInterval); cooldownInterval = null; }
    removeCountdownDisplay();
    disableInputs(false);
  }

  // ── Input handling ─────────────────────────────────────────────────────────
  tokenInputs.forEach((input, idx) => {
    input.addEventListener('input', function () {
      if (this.value.length > 1) return;

      const val = this.value;
      if (val && !/^\d$/.test(val)) { this.value = ''; clearDigitDisplay(idx); updateVisualState(); return; }

      if (val && /^\d$/.test(val)) {
        triggerDigitBounce(idx);
        triggerRipplePulse(idx);
      } else {
        clearDigitDisplay(idx);
      }

      updateVisualState();

      if (this.value.length === 1 && idx < tokenInputs.length - 1) {
        tokenInputs[idx + 1].focus();
      }
      checkAutoSubmit();
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Backspace' && this.value === '' && idx > 0) {
        tokenInputs[idx - 1].focus();
        tokenInputs[idx - 1].value = '';
        clearDigitDisplay(idx - 1);
        updateVisualState();
        e.preventDefault();
      }
      if (e.key === 'ArrowLeft'  && idx > 0)                       tokenInputs[idx - 1].focus();
      if (e.key === 'ArrowRight' && idx < tokenInputs.length - 1)  tokenInputs[idx + 1].focus();
    });

    input.addEventListener('paste', function (e) {
      e.preventDefault();
      const pasted = (e.clipboardData || window.clipboardData).getData('text');
      const digits = pasted.replace(/\D/g, '').slice(0, tokenInputs.length);
      if (!digits) return;

      digits.split('').forEach((d, i) => {
        const targetIdx = idx + i;
        const target    = tokenInputs[targetIdx];
        if (target) {
          target.value = d;
          setTimeout(function () {
            triggerDigitBounce(targetIdx);
            triggerRipplePulse(targetIdx);
            updateVisualState();
          }, i * 70);
        }
      });

      setTimeout(updateVisualState, digits.length * 70 + 10);

      const nextIdx = Math.min(idx + digits.length, tokenInputs.length - 1);
      tokenInputs[nextIdx].focus();
      checkAutoSubmit();
    });

    input.addEventListener('focus', function () { this.select(); });
  });

  function checkAutoSubmit() {
    const token = getTokenString();
    if (token.length === tokenInputs.length && /^\d+$/.test(token)) {
      // BUGFIX: skip if a validation is already in flight. Previously, a
      // fast paste + keystroke could fire performTokenValidation twice
      // before isValidating propagated, causing duplicate fetches and
      // double rate-limit consumption.
      if (isValidating) return;
      performTokenValidation(token);
    }
  }

  // ── Submit ─────────────────────────────────────────────────────────────────
  tokenForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!validateEntryPoint()) return;
    const token = getTokenString();
    if (token.length !== 5) {
      _notify('warning', 'Token Tidak Lengkap', 'Token harus 5 digit angka.');
      return;
    }
    performTokenValidation(token);
  });

  function validateEntryPoint() {
    if (isValidating) {
      _notify('warning', 'Proses Berjalan', 'Tunggu sebentar, validasi sedang diproses.');
      return false;
    }
    if (isRateLimited()) return false;
    return true;
  }

  // ── Core: validate token ───────────────────────────────────────────────────
  async function performTokenValidation(token) {
    isValidating     = true;
    submitBtn.innerHTML = '<i class="material-symbols-outlined ms-spin">progress_activity</i> Memproses...';
    submitBtn.disabled  = true;
    tokenInputs.forEach(i => i.disabled = true);

    try {
      // BUGFIX D: Server-side rate limit check (unbypassable).
      // This runs BEFORE the Firestore lookup. If the server says
      // rate-limited, we block immediately and start a cooldown.
      const serverCheck = await _checkServerRateLimit();
      if (!serverCheck.allowed) {
        const retrySec = serverCheck.retryAfter || 3600;
        cooldownUntil = Date.now() + (retrySec * 1000);
        saveRateLimitState();
        disableInputs(true);
        startCooldownTimer();
        _notify('error', 'Batas Percobaan Terlampaui',
          'Server telah memblokir percobaan Anda karena terlalu banyak gagal. Tunggu ' +
          Math.ceil(retrySec / 60) + ' menit sebelum mencoba lagi.');
        isValidating = false;
        submitBtn.innerHTML = '<i class="material-symbols-outlined">arrow_forward</i> Masuk Ujian';
        submitBtn.disabled = false;
        return;
      }

      if (!window.__firebaseReady) {
        await new Promise((resolve, reject) => {
          if (window.__firebaseReady) { resolve(); return; }
          const timer = setTimeout(() => reject(new Error('Koneksi timeout')), 12_000);
          document.addEventListener('firebase-ready', () => { clearTimeout(timer); resolve(); }, { once: true });
          document.addEventListener('firebase-error', () => { clearTimeout(timer); reject(new Error('Koneksi gagal')); }, { once: true });
        });
      }

      const db      = _getFirestoreOrThrow();
      // FIX BUG-02: Peserta HARUS fetch dari view 'ujian_peserta' yang tidak expose p_q (kunci jawaban).
      // Sebelumnya fetch dari 'ujian' langsung — peserta bisa baca kunci jawaban dari sessionStorage.
      const examCollection = (window.Auth?.userRole === 'admin') ? 'ujian' : 'ujian_peserta';
      const docSnap = await db.collection(examCollection).doc(token).get();

      if (!docSnap.exists) {
        recordFailedAttempt();
        return;
      }

      const ujianData = docSnap.data();

      const accessResult = _checkAccess(ujianData.access_control);
      if (!accessResult.open) {
        recordFailedAttempt();
        _notify('warning', 'Ujian Tidak Dapat Diakses', accessResult.reason);
        return;
      }

      const currentUser = _getCurrentUser();
      const userKey     = currentUser ? (currentUser.uid || currentUser.email || 'anon') : 'anon';
      const submitKey   = `exam_submitted_${token}_${userKey}`;

      // FIX BUG-11: Double-submit guard — cek server-side (Firestore) SEBELUM localStorage.
      // localStorage bisa dimanipulasi peserta via DevTools. Cek ViolationStore dulu.
      if (token && window.Security?.ViolationStore) {
        try {
          const isSubmitted = await Security.ViolationStore.isSubmitted(token, userKey);
          if (isSubmitted) {
            _notify('error', 'Sudah Dikumpulkan', 'Anda sudah mengumpulkan ujian ini. Tidak dapat mengerjakan ulang.');
            return;
          }
        } catch (_) {
          // ViolationStore check gagal — fallback ke localStorage
        }
      }
      // Fallback: cek localStorage (bisa dimanipulasi, tapi lebih baik daripada tidak ada check)
      if (localStorage.getItem(submitKey) === 'true') {
        _notify('error', 'Sudah Dikumpulkan', 'Anda sudah mengumpulkan ujian ini. Tidak dapat mengerjakan ulang.');
        return;
      }

      // ── SUCCESS ──
      resetAttemptsOnSuccess();

      sessionStorage.setItem('exam_token',    token);
      sessionStorage.setItem('exam_user_key', userKey);
      sessionStorage.setItem('exam_data', JSON.stringify({ id: token, ...ujianData }));

      const ujianInfo = window.ExamRecordCompat?.getMeta(ujianData) || ujianData?.ujian || {};
      _notify('success', 'Token Diterima', `Menyiapkan ujian "${ujianInfo.judul || token}"...`);

      setTimeout(() => {
        window.location.href = `kerjakan-ujian.html?token=${encodeURIComponent(token)}`;
      }, 900);

    } catch (err) {
      _notify('error', 'Gagal Memvalidasi', err.message || 'Terjadi kesalahan.');
    } finally {
      isValidating        = false;
      submitBtn.innerHTML = '<i class="material-symbols-outlined">arrow_forward</i> Masuk Ujian';
      submitBtn.disabled  = false;

      // Kalau shake animation lagi jalan, JANGAN clear inputs dulu
      // Shake cleanup yang handle reset setelah animasi selesai
      var shakeInProgress = !!shakeCleanupTimer;

      if (!shakeInProgress) {
        tokenInputs.forEach(function (i) { i.value = ''; });
        digitDisplays.forEach(function (d) { d.textContent = ''; d.classList.remove('animate-in', 'filled', 'all-complete'); });
        tokenInputs.forEach(function (i) { i.classList.remove('filled', 'all-complete'); });
        updateVisualState();

        if (!cooldownUntil || cooldownUntil <= Date.now()) {
          tokenInputs.forEach(function (i) { i.disabled = false; });
          tokenInputs[0]?.focus();
        } else {
          tokenInputs.forEach(function (i) { i.disabled = true; });
        }
      }
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function getTokenString() {
    return Array.from(tokenInputs).map(i => i.value).join('');
  }

  function _toDate(value) {
    if (!value) return null;
    if (value instanceof Date) return value;
    if (typeof value.toDate === 'function') return value.toDate();
    if (value.seconds != null) return new Date(value.seconds * 1000);
    const parsed = new Date(value);
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  function _checkAccess(ac) {
    if (!ac) return { open: false, reason: 'Ujian belum dikonfigurasi.' };
    const now = new Date();

    if (ac.mode === 'manual' || ac.override) {
      if (ac.manual_status === 'open') {
        if (ac.end) {
          const end = _toDate(ac.end);
          if (end && now > end) return { open: false, reason: 'Waktu ujian sudah habis.' };
        }
        return { open: true };
      } else {
        if (ac.remaining_time != null && ac.remaining_time > 0) {
          // BUG-17 fix: remaining_time sekarang dalam detik
          const remMin = Math.ceil(ac.remaining_time / 60);
          return { open: false, reason: `Ujian sedang dijeda. Sisa waktu: ${remMin} menit.` };
        }
        return { open: false, reason: 'Ujian belum dibuka oleh guru.' };
      }
    }

    if (ac.mode === 'scheduled' && ac.scheduled?.active) {
      const start  = _toDate(ac.scheduled.start);
      const endSch = _toDate(ac.scheduled.end);
      if (!start || !endSch) return { open: false, reason: 'Jadwal ujian tidak valid.' };
      if (now < start) return { open: false, reason: `Ujian dijadwalkan mulai ${_fmt(start)}.` };
      if (now > endSch) return { open: false, reason: `Ujian sudah berakhir pada ${_fmt(endSch)}.` };
      return { open: true };
    }

    return { open: false, reason: 'Ujian belum dibuka. Hubungi guru.' };
  }

  function _fmt(d) {
    return d.toLocaleString('id-ID', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
  }

  function _getCurrentUser() {
    return window.Auth?.currentUser ?? window.firebaseAuth?.currentUser ?? null;
  }

  function _notify(type, title, message) {
    const qn = window.QNotify || window.show;
    if (qn?.notify && typeof qn.notify[type] === 'function') {
      qn.notify[type](title, message, 4500);
    } else if (type === 'error') {
      alert(`${title}\n${message}`);
    }
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────────
  if (tokenInputs.length) setTimeout(() => tokenInputs[0].focus(), 100);
  loadRateLimitState();
  updateVisualState();
});

// ── Global export ──────────────────────────────────────────────────────────
window.setExamSubmitLock = function (token, userKey) {
  if (!token || !userKey) return;
  try {
    localStorage.setItem(`exam_submitted_${token}_${userKey}`, 'true');
  } catch (_) {}
};
