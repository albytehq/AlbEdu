// =============================================================================
// SelfStorage.js — AlbEdu Self Storage v1.0.0
// =============================================================================
//
// Satu tanggung jawab: provisioning & manajemen private storage per admin.
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
// =============================================================================

const MAX_ACTIVE_EXAMS = 5;   // draft + active max per admin
const EXAM_LIMIT = MAX_ACTIVE_EXAMS;

window.SelfStorage = (() => {
  let _storageId   = null;
  let _adminId     = null;
  let _ready       = false;
  let _readyResolvers = [];

  // ── Helpers ───────────────────────────────────────────────────────────────

  function _getSb() {
    return window.sb;
  }

  function _isAdmin() {
    return window.Auth?.userRole === 'admin';
  }

  function _getCurrentUserId() {
    return window.Auth?.currentUser?.uid || null;
  }

  // _promiseReady — single Promise that resolves once storage is provisioned.
  // Multiple callers can await this; all resolve together.
  let _readyPromise = null;
  function _getReadyPromise() {
    if (!_readyPromise) {
      _readyPromise = new Promise(resolve => {
        if (_ready) return resolve(_storageId);
        _readyResolvers.push(resolve);
      });
    }
    return _readyPromise;
  }

  function _resolveReady(storageId) {
    _ready     = true;
    _storageId = storageId;
    const resolvers = [..._readyResolvers];
    _readyResolvers = [];
    resolvers.forEach(fn => fn(storageId));
    window.dispatchEvent(new CustomEvent('selfstorage-ready', { detail: { storageId } }));
  }

  // ── Provisioning ──────────────────────────────────────────────────────────

  async function _provision(adminId) {
    const sb = _getSb();
    if (!sb) {
      console.warn('[SelfStorage] Supabase not ready — provision skipped');
      return null;
    }

    try {
      // Coba baca storage yang sudah ada dulu — upsert mahal kalau row sudah ada.
      const { data: existing, error: readErr } = await sb
        .from('admin_storages')
        .select('id')
        .eq('admin_id', adminId)
        .maybeSingle();

      if (readErr) throw readErr;

      if (existing?.id) return existing.id;

      // Storage belum ada — buat baru.
      const { data: created, error: createErr } = await sb
        .from('admin_storages')
        .insert({ admin_id: adminId })
        .select('id')
        .single();

      if (createErr) {
        // Conflict: race condition, another tab created it simultaneously.
        // Just read back the existing row.
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
    } catch (err) {
      console.error('[SelfStorage] Provision failed:', err?.message);
      return null;
    }
  }

  // ── Boot: listen for auth-ready ───────────────────────────────────────────

  async function _handleAuthReady(e) {
    const role = e?.detail?.role;
    if (role !== 'admin') {
      // Bukan admin — storage tidak diperlukan. Mark ready anyway so callers don't hang.
      _ready     = true;
      _storageId = null;
      _readyResolvers.forEach(fn => fn(null));
      _readyResolvers = [];
      return;
    }

    const adminId = _getCurrentUserId();
    if (!adminId) return;

    _adminId = adminId;
    const storageId = await _provision(adminId);
    _resolveReady(storageId);
  }

  // Register listener — auth-ready fires from auth.js after role is confirmed.
  document.addEventListener('auth-ready', _handleAuthReady, { once: true });

  // BUGFIX K: Replaced the single 800ms setTimeout with a retry loop.
  // The old approach would miss auth-ready if it fired later than 800ms
  // (slow network, cold start) AND Auth.authReady was still false at
  // the 800ms mark. The { once: true } event listener still catches
  // late events, but this retry provides a visible warning if
  // provisioning never happens -- instead of silently hanging.
  let _safetyRetries = 0;
  const _SAFETY_MAX_RETRIES = 20; // 20 x 500ms = 10 seconds
  function _safetyNetCheck() {
    if (_ready) return;
    _safetyRetries++;
    if (_safetyRetries > _SAFETY_MAX_RETRIES) {
      console.warn('[SelfStorage] Safety net gave up after 10s -- auth-ready never fired. Storage will not be provisioned.');
      _resolveReady(null); // resolve with null so callers do not hang forever
      return;
    }
    if (window.Auth?.authReady) {
      const role = window.Auth.userRole;
      if (role === 'admin') {
        _handleAuthReady({ detail: { role: 'admin' } });
      } else {
        _handleAuthReady({ detail: { role } });
      }
    } else {
      setTimeout(_safetyNetCheck, 500);
    }
  }
  setTimeout(_safetyNetCheck, 500);

  // ── Exam limit ────────────────────────────────────────────────────────────

  async function getExamCount() {
    const adminId = _adminId || _getCurrentUserId();
    if (!adminId) return 0;

    const sb = _getSb();
    if (!sb) return 0;

    try {
      // v1.0.0: 'ujian' table was renamed to 'assessments' (snake_case schema).
      // Filter on `created_by` (was `createdBy`) and status in {draft, active}
      // — 'expired' was removed; archived assessments live in `archived` status now
      // and don't count against the active limit.
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

  // ── Public API ────────────────────────────────────────────────────────────

  return {
    /** Menunggu storage siap. Resolve dengan storageId (string) atau null jika bukan admin. */
    ready: _getReadyPromise,

    /** Storage ID admin yang sedang login. Null jika belum siap atau bukan admin. */
    getStorageId: () => _storageId,

    /** Admin ID yang terikat ke storage ini. */
    getAdminId: () => _adminId,

    /** Apakah storage sudah selesai di-provision. */
    isReady: () => _ready,

    /** Hitung ujian draft + active milik admin ini. */
    getExamCount,

    /** Apakah limit 5 ujian sudah tercapai. */
    isExamLimitReached,

    /** Batas max ujian (konstan). */
    EXAM_LIMIT,
  };
})();
