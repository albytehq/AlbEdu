/**
 * ExamData.js -- v4.0 PRODUCTION (v2.0.0 identity system)
 *
 * SUMBER DATA (prioritas):
 *   1. sessionStorage 'exam_data' -- ditulis oleh ujian/ujian.js setelah token valid
 *   2. Firestore langsung via ?token= di URL (fallback jika sessionStorage kosong)
 *
 * DATA PESERTA (v2.0.0):
 *   - Mode 'daftar': query tabel 'daftar_nama' WHERE id = daftarId
 *     → parse tabs JSONB → return anggota:[string]
 *   - Mode 'manual': peserta isi sendiri via IdentityFormRenderer (tidak butuh fetch)
 *
 * MIGRATION v4.0 (v2.0.0 identity system):
 *   - Hapus getPesertaDariKelas (sistem kelas lama via Firestore collection + JSON lokal)
 *   - Hapus _fetchLocalKelas + _cache.kelas (assets/Data/kls*.json dihapus)
 *   - Tambah getPesertaDariDaftar(daftarId, tabName)
 *
 * SECURITY PATCH v3.2:
 *   - Tambah _getExamCollection(): peserta fetch dari view 'ujian_peserta' (tanpa p_q),
 *     admin fetch dari tabel 'ujian' langsung (termasuk kunci jawaban).
 *   - sessionStorage tidak menyimpan p_q untuk peserta — data yang di-cache
 *     juga bebas kunci jawaban karena berasal dari view yang sudah strip p_q.
 *
 * TIDAK ADA MOCKDATA -- ini production.
 */

const ExamData = (() => {

  /* --- Cache ------------------------------------------------------------ */
  const _cache = {
    ujian: null,
    daftar: {},  // v2.0.0: cache daftar_nama by daftarId
  };

  /* --- Helpers ---------------------------------------------------------- */
  function _getTokenFromURL() {
    try {
      return new URLSearchParams(window.location.search).get('token') || null;
    } catch (_) { return null; }
  }

  // SECURITY: peserta fetch ujian dari VIEW 'ujian_peserta' yang tidak expose p_q.
  // Admin fetch dari tabel 'ujian' penuh (butuh p_q untuk buat/edit soal).
  //
  // WHY dicek tiap call (bukan cached sekali):
  //   Auth state bisa berubah (logout/login ulang). Cek fresh tiap call
  //   memastikan tidak ada window di mana peserta dapat akses tabel penuh.
  function _getExamCollection() {
    return window.Auth?.userRole === 'admin' ? 'ujian' : 'ujian_peserta';
  }

  function _getFirestore() {
    return window.firebaseDb || null; // null = tidak tersedia, bukan throw -- biar caller yg handle
  }

  function _normalizeExamRecord(data) {
    if (window.ExamRecordCompat?.normalize) {
      return window.ExamRecordCompat.normalize(data);
    }

    if (!data || typeof data !== 'object') return data;

    const toSnake = (key) => String(key).replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
    const snakeObject = (value) => {
      if (!value || typeof value !== 'object') return value;
      if (Array.isArray(value)) return value.map(snakeObject);
      return Object.entries(value).reduce((out, [key, child]) => {
        out[toSnake(key)] = snakeObject(child);
        return out;
      }, {});
    };

    const normalized = { ...data };
    normalized.ujian = snakeObject(data.ujian || {});
    if (!normalized.access_control && data.accessControl) {
      normalized.access_control = snakeObject(data.accessControl);
    }

    ['judul', 'mata_pelajaran', 'kelas'].forEach((field) => {
      const camel = field.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());
      const value = normalized.ujian[field]
        ?? normalized.ujian[camel]
        ?? normalized[field]
        ?? normalized[camel];
      if (value !== undefined && value !== null) {
        normalized.ujian[field] = value;
        normalized[field] = value;
      }
    });

    // Hoist p_q / pQ → PQ so the Firestore-era runtime key is always present.
    // This path runs only when window.ExamRecordCompat is not yet installed
    // (i.e. SupabaseApi.js hasn't loaded yet). Mirrors the same hoist in
    // SupabaseApi._normalizeExamRecord so both paths are consistent.
    if (!normalized.PQ) {
      normalized.PQ = normalized.pQ ?? normalized.p_q ?? null;
    }

    return normalized;
  }

  function _isValidExamData(data) {
    // Accept all three casings: PQ (Firestore-era), pQ (Supabase shim output),
    // p_q (raw snake_case).  SupabaseApi._normalizeExamRecord hoists these to PQ
    // at read time, but cached sessionStorage payloads from before that fix may
    // still carry pQ or p_q.
    return !!(data && data.ujian && (data.PQ || data.pQ || data.p_q));
  }

  /* --- v2.0.0 — Fetch daftar_nama by ID (replaces _fetchLocalKelas) ----- */
  async function _fetchDaftarNama(daftarId) {
    if (!daftarId) throw new Error('daftarId tidak boleh kosong.');

    if (_cache.daftar[daftarId]) return _cache.daftar[daftarId];

    const db = _getFirestore();
    if (!db) {
      throw new Error('Database tidak tersedia. Pastikan koneksi internet aktif.');
    }

    // v2.0.0: 'daftar_nama' is now a Supabase table (was Firestore collection).
    // SupabaseApi.js shim exposes it via db.collection('daftar_nama').doc(id).get()
    let data = null;
    try {
      const doc = await db.collection('daftar_nama').doc(daftarId).get();
      if (doc.exists) data = doc.data();
    } catch (e) {
      // Fall through to direct Supabase client below
    }

    // Fallback: direct Supabase client (if SupabaseApi shim not available)
    if (!data && window.sb) {
      try {
        const { data: rows, error } = await window.sb
          .from('daftar_nama')
          .select('*')
          .eq('id', daftarId)
          .maybeSingle();
        if (!error && rows) data = rows;
      } catch (e) {
        // silent
      }
    }

    if (!data) {
      throw new Error('Daftar nama dengan ID ' + daftarId + ' tidak ditemukan. Hubungi admin.');
    }

    _cache.daftar[daftarId] = data;
    return data;
  }

  /* --- Public: ambil data ujian ----------------------------------------- */
  // FIX BUG-13: Clear cache jika role berubah (admin → peserta) untuk mencegah
  // data ujian lengkap (dengan kunci jawaban) leak ke sesi peserta.
  let _lastRole = null;
  async function getUjianData() {
    const currentRole = window.Auth?.userRole || null;
    if (_cache.ujian && _lastRole !== null && _lastRole !== currentRole) {
      // Role changed — invalidate cache to prevent data leakage
      _cache.ujian = null;
    }
    _lastRole = currentRole;
    if (_cache.ujian) return _cache.ujian;

    /* 1 -- sessionStorage cache (cepat, tapi bukan source of truth) */
    let cached = null;
    const raw = sessionStorage.getItem('exam_data');
    if (raw) {
      try {
        const parsed = _normalizeExamRecord(JSON.parse(raw));
        if (_isValidExamData(parsed)) cached = parsed;
      } catch (e) {
      }
    }

    /* 2 -- Refresh from Firestore/Supabase when possible so admin edits win */
    const token = _getTokenFromURL() || cached?.id || sessionStorage.getItem('exam_token');
    const db    = _getFirestore();

    if (token && db) {
      try {
        const doc = await db.collection(_getExamCollection()).doc(token).get();
        if (doc.exists) {
          const fresh = _normalizeExamRecord({ id: token, ...doc.data() });
          if (_isValidExamData(fresh)) {
            try { sessionStorage.setItem('exam_data', JSON.stringify(fresh)); } catch (_) {}
            _cache.ujian = fresh;
            return fresh;
          }
        }
      } catch (_) {
        // Jika refresh gagal (mis. koneksi drop), cache valid tetap boleh dipakai.
      }
    }

    if (cached) {
      _cache.ujian = cached;
      return cached;
    }

    /* 3 -- Firestore langsung via token URL jika cache kosong */
    if (!token) {
      throw new Error(
        'Token tidak ditemukan. Kembali ke halaman token dan masukkan token ujian.'
      );
    }

    if (!db) throw new Error('Database tidak tersedia. Pastikan koneksi internet aktif.');

    const doc = await db.collection(_getExamCollection()).doc(token).get();

    if (!doc.exists) {
      throw new Error('Ujian dengan token "' + token + '" tidak ditemukan di database.');
    }

    const data = _normalizeExamRecord({ id: token, ...doc.data() });

    if (!_isValidExamData(data)) {
      throw new Error(
        'Struktur data ujian tidak valid. Hubungi administrator.'
      );
    }

    /* Simpan ke sessionStorage untuk request berikutnya */
    try { sessionStorage.setItem('exam_data', JSON.stringify(data)); } catch (_) {}

    _cache.ujian = data;
    return data;
  }

  /* --- v2.0.0 — Public: ambil daftar nama peserta dari daftar_nama ----- */
  /*                                                                         */
  /* Flow:                                                                   */
  /*   1. Fetch daftar_nama by daftarId (cached per daftarId)                 */
  /*   2. Parse tabs JSONB                                                   */
  /*   3. Find tab by nama_tab === tabName                                   */
  /*   4. Return anggota:[string]                                            */
  /*                                                                         */
  async function getPesertaDariDaftar(daftarId, tabName) {
    if (!daftarId) throw new Error('daftarId tidak boleh kosong.');
    if (!tabName)  throw new Error('tabName tidak boleh kosong.');

    const daftar = await _fetchDaftarNama(daftarId);
    const tabs   = Array.isArray(daftar.tabs) ? daftar.tabs : [];
    const tab    = tabs.find(t => (t.nama_tab || '') === tabName);

    if (!tab) {
      throw new Error('Tab "' + tabName + '" tidak ditemukan di daftar ini.');
    }

    const anggota = Array.isArray(tab.anggota) ? tab.anggota : [];
    if (anggota.length === 0) {
      throw new Error('Tab "' + tabName + '" kosong. Hubungi admin.');
    }

    return anggota.slice(); // return copy
  }

  /* --- v2.0.0 — Public: ambil list tab dari daftar_nama ------------------ */
  /*                                                                         */
  /* Return: [{ nama_tab: '7A', anggota_count: 30 }, ...]                    */
  /*                                                                         */
  async function getTabsDariDaftar(daftarId) {
    const daftar = await _fetchDaftarNama(daftarId);
    const tabs   = Array.isArray(daftar.tabs) ? daftar.tabs : [];
    return tabs.map(t => ({
      nama_tab:      t.nama_tab || '',
      anggota_count: Array.isArray(t.anggota) ? t.anggota.length : 0,
    }));
  }

  /* --- Public utils ----------------------------------------------------- */
  function getActiveToken() {
    return sessionStorage.getItem('exam_token') || _getTokenFromURL() || null;
  }

  function getUserKey() {
    return sessionStorage.getItem('exam_user_key') || 'anon';
  }

  /* --- Public API ------------------------------------------------------- */
  return {
    getUjianData,
    // v2.0.0: getPesertaDariKelas removed (sistem kelas lama dihapus)
    getPesertaDariDaftar,
    getTabsDariDaftar,
    getActiveToken,
    getUserKey,
  };
})();