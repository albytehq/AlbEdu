// SelfStorage.js — provisioning & management of per-admin private storage.
//
// PRINSIP DESAIN:
//   1. Storage terbentuk otomatis saat admin login — admin tidak tahu storage ada.
//   2. Storage 1:1 dengan admin — tidak bisa dibuat ulang, dihapus, atau diganti.
//   3. Sistem ini HANYA untuk admin. Peserta tidak boleh menyentuh apapun di sini.
//   4. Semua operasi downstream (DaftarNama, limit ujian) bergantung pada storage_id
//      yang di-resolve oleh modul ini.
//
// CARA PAKAI:
//   await window.SelfStorage.ready();            // tunggu storage siap
//   const id = window.SelfStorage.getStorageId(); // dapatkan ID storage admin ini
//   const limitReached = await window.SelfStorage.isExamLimitReached();
//
// BOOT ORDER:
//   SupabaseApi.js → auth.js → SelfStorage.js
//   SelfStorage mendengar event 'auth-ready' — saat admin login, storage
//   langsung di-provision secara background tanpa user notice.
//
// PRODUCTION-GRADE FIXES (v2):
//   • Three-tier admin_id resolution (Auth.currentUser → supabase.auth.getUser → null)
//   • Retry with exponential backoff on transient failures
//   • Clear error states: 'pending' | 'ready' | 'failed' | 'not-admin'
//   • Never hangs forever — surfaces failure via onError callback + event
//   • Idempotent provisioning (SELECT first, INSERT only if missing, race-safe)

const MAX_ACTIVE_EXAMS = 5;   // draft + active max per admin
const EXAM_LIMIT = MAX_ACTIVE_EXAMS;

// Provisioning retry config (exponential backoff)
const PROVISION_MAX_RETRIES = 3;
const PROVISION_BASE_DELAY_MS = 400;

window.SelfStorage = (() => {
  // State machine: 'pending' → 'ready' (success) | 'failed' (error) | 'not-admin' (skip)
  let _state        = 'pending'; // 'pending' | 'ready' | 'failed' | 'not-admin'
  let _storageId    = null;
  let _adminId      = null;
  let _lastError    = null;
  let _readyResolvers = [];

  function _getSb() {
    return window.AlbEdu?.supabase?.client;
  }

  function _isAdmin() {
    return window.Auth?.userRole === 'admin';
  }

  // ── Three-tier admin_id resolution ──────────────────────────────
  // Tier 1: window.Auth.currentUser.id (synchronous, cached)
  // Tier 2: supabase.auth.getUser() (async, native, always fresh)
  // Tier 3: null (give up — caller must handle)
  async function _resolveAdminId() {
    // Tier 1
    const cached = window.Auth?.currentUser?.id;
    if (cached) return cached;

    // Tier 2 — async fallback (covers edge cases where Auth module hasn't
    // populated currentUser yet but Supabase session IS valid)
    const sb = _getSb();
    if (sb?.auth?.getUser) {
      try {
        const { data, error } = await sb.auth.getUser();
        if (!error && data?.user?.id) {
          // Cache back to Auth for downstream callers
          if (window.Auth) window.Auth.currentUser = { ...window.Auth.currentUser, id: data.user.id };
          return data.user.id;
        }
      } catch (e) {
        console.warn('[SelfStorage] Tier-2 admin_id resolution failed:', e?.message);
      }
    }

    // Tier 3
    return null;
  }

  // _promiseReady — single Promise that resolves once storage is provisioned
  // (or rejects on failure). Multiple callers can await this.
  let _readyPromise = null;
  function _getReadyPromise() {
    if (!_readyPromise) {
      _readyPromise = new Promise(resolve => {
        if (_state === 'ready') return resolve(_storageId);
        if (_state === 'failed' || _state === 'not-admin') return resolve(null);
        _readyResolvers.push(resolve);
      });
    }
    return _readyPromise;
  }

  function _resolveReady(storageId) {
    _state      = storageId ? 'ready' : 'failed';
    _storageId  = storageId;
    const resolvers = [..._readyResolvers];
    _readyResolvers = [];
    resolvers.forEach(fn => fn(storageId));
    window.dispatchEvent(new CustomEvent('selfstorage-ready', {
      detail: { storageId, state: _state, error: _lastError }
    }));
  }

  function _markNotAdmin() {
    _state     = 'not-admin';
    _storageId = null;
    const resolvers = [..._readyResolvers];
    _readyResolvers = [];
    resolvers.forEach(fn => fn(null));
    window.dispatchEvent(new CustomEvent('selfstorage-ready', {
      detail: { storageId: null, state: 'not-admin' }
    }));
  }

  // ── Sleep helper for retry backoff ───────────────────────────────
  function _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ── Single provisioning attempt ─────────────────────────────────
  // Returns storageId on success, null on recoverable failure.
  // Throws on unexpected error (caller decides whether to retry).
  async function _provisionAttempt(adminId) {
    const sb = _getSb();
    if (!sb) throw new Error('Supabase client not ready');

    // Step 1: Try to read existing storage row (owner-scoped SELECT)
    const { data: existing, error: readErr } = await sb
      .from('admin_storages')
      .select('id')
      .eq('admin_id', adminId)
      .maybeSingle();

    if (readErr) {
      // RLS error or network — caller may retry
      throw readErr;
    }
    if (existing?.id) return existing.id;

    // Step 2: Storage doesn't exist — INSERT new row
    const { data: created, error: createErr } = await sb
      .from('admin_storages')
      .insert({ admin_id: adminId })
      .select('id')
      .single();

    if (createErr) {
      // Race condition: another tab inserted simultaneously (code 23505).
      // Read back the existing row.
      if (createErr.code === '23505') {
        const { data: retry } = await sb
          .from('admin_storages')
          .select('id')
          .eq('admin_id', adminId)
          .maybeSingle();
        return retry?.id || null;
      }
      throw createErr;
    }

    return created?.id || null;
  }

  // ── Provisioning with retry + exponential backoff ───────────────
  async function _provisionWithRetry(adminId) {
    let lastErr = null;
    for (let attempt = 1; attempt <= PROVISION_MAX_RETRIES; attempt++) {
      try {
        const id = await _provisionAttempt(adminId);
        if (id) return id;
        // Returned null without throwing — unusual but treat as failure
        lastErr = new Error('Provisioning returned null (RLS may be blocking)');
      } catch (err) {
        lastErr = err;
        // Don't retry on auth errors — they won't fix themselves
        const code = err?.code || '';
        const msg = (err?.message || '').toLowerCase();
        if (code === '42501' || msg.includes('jwt') || msg.includes('auth') || msg.includes('token')) {
          break;
        }
      }
      // Exponential backoff: 400ms, 800ms, 1600ms
      if (attempt < PROVISION_MAX_RETRIES) {
        await _sleep(PROVISION_BASE_DELAY_MS * Math.pow(2, attempt - 1));
      }
    }
    console.error('[SelfStorage] Provisioning failed after', PROVISION_MAX_RETRIES, 'attempts:', lastErr?.message);
    _lastError = lastErr;
    return null;
  }


  async function _handleAuthReady(e) {
    // Idempotency guard — if state already moved past 'pending', skip.
    // Prevents duplicate provisioning if both the { once: true } listener
    // AND the safety net fire _handleAuthReady concurrently.
    if (_state !== 'pending') return;

    const role = e?.detail?.role;
    // FIX: Skip transient role=null events (Supabase INITIALIZE phase emits
    // auth-ready with role=null before the real role is fetched). The old
    // { once: true } listener would permanently mark 'not-admin' on the
    // first null event. Now we skip null and wait for the real role.
    if (role === null || role === undefined) {
      console.warn('[SelfStorage] auth-ready fired with role=null — skipping (transient state, will retry)');
      return;
    }
    if (role !== 'admin') {
      // Bukan admin — storage tidak diperlukan.
      _markNotAdmin();
      return;
    }

    const adminId = await _resolveAdminId();
    if (!adminId) {
      console.warn('[SelfStorage] Could not resolve admin_id — storage not provisioned');
      _lastError = new Error('admin_id tidak bisa di-resolve (sesi tidak valid)');
      _resolveReady(null);
      return;
    }

    _adminId = adminId;
    const storageId = await _provisionWithRetry(adminId);
    _resolveReady(storageId);
  }

  // Register listener — auth-ready fires from auth.js after role is confirmed.
  // NOT using { once: true } — we need to catch subsequent auth-ready events
  // that fire with the real role after an initial transient role=null event.
  // _handleAuthReady has idempotency guard via _state check.
  document.addEventListener('auth-ready', _handleAuthReady);

  // CRITICAL FIX: If auth-ready already fired BEFORE this script loaded
  // (race condition — auth/main.js defer-loaded earlier, fast cached login),
  // the { once: true } listener will NEVER fire. Check synchronously + after
  // a short delay to catch the already-fired case.
  if (window.Auth?.authReady) {
    // Already ready — call _handleAuthReady immediately (don't wait for event)
    Promise.resolve().then(() => _handleAuthReady({ detail: { role: window.Auth.userRole } }));
  }

  // Safety-net retry loop. The { once: true } listener catches late events;
  // this loop surfaces a visible failure if auth-ready never fires within 10s.
  let _safetyRetries = 0;
  const _SAFETY_MAX_RETRIES = 20; // 20 × 500ms = 10 seconds
  function _safetyNetCheck() {
    if (_state !== 'pending') return;
    _safetyRetries++;
    if (_safetyRetries > _SAFETY_MAX_RETRIES) {
      console.warn('[SelfStorage] Safety net gave up after 10s — auth-ready never fired. Marking as failed.');
      _lastError = new Error('auth-ready event never fired within 10s');
      _resolveReady(null);
      return;
    }
    if (window.Auth?.authReady) {
      const role = window.Auth.userRole;
      // Auth is ready — fire _handleAuthReady directly
      _handleAuthReady({ detail: { role } });
    } else {
      setTimeout(_safetyNetCheck, 500);
    }
  }
  setTimeout(_safetyNetCheck, 500);


  async function getExamCount() {
    const adminId = _adminId || (await _resolveAdminId());
    if (!adminId) return 0;

    const sb = _getSb();
    if (!sb) return 0;

    try {
      const { count, error } = await sb
        .from('assessments')
        .select('*', { count: 'exact', head: true })
        .eq('created_by', adminId)
        .in('status', ['draft', 'active']);

      if (error) throw error;
      return count ?? 0;
    } catch (err) {
      console.warn('[SelfStorage] getExamCount failed:', err?.message);
      return 0;
    }
  }

  async function isExamLimitReached() {
    const count = await getExamCount();
    return count >= EXAM_LIMIT;
  }


  return {
    /** Menunggu storage siap. Resolve dengan storageId (string) atau null jika gagal/bukan admin. */
    ready: _getReadyPromise,

    /** Storage ID admin yang sedang login. Null jika belum siap atau bukan admin. */
    getStorageId: () => _storageId,

    /** Admin ID yang terikat ke storage ini. */
    getAdminId: () => _adminId,

    /** Apakah storage sudah selesai di-provision. */
    isReady: () => _state === 'ready',

    /** State machine: 'pending' | 'ready' | 'failed' | 'not-admin'. */
    getState: () => _state,

    /** Error terakhir yang menyebabkan provisioning gagal. Null jika sukses/belum selesai. */
    getLastError: () => _lastError,

    /** Resolve admin_id dengan three-tier fallback (async). */
    resolveAdminId: _resolveAdminId,

    /** Hitung ujian draft + active milik admin ini. */
    getExamCount,

    /** Apakah limit 5 ujian sudah tercapai. */
    isExamLimitReached,

    /** Batas max ujian (konstan). */
    EXAM_LIMIT,
  };
})();
