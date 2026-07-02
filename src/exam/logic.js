/**
 * ExamLogic.js -- v0.3.0 (Production Hardened)
 * OTAK utama sistem ujian. Multi-page aware.
 * ATURAN KERAS: TIDAK BOLEH ada manipulasi DOM di file ini.
 *
 * Struktur pages dari JSON:
 *   pages1 -> identitas (bukan soal)
 *   pages2 -> soal bagian pertama
 *   pages3 -> soal bagian kedua (opsional)
 *
 * Key jawaban unik: `${pageKey}__${idq}` -- tidak collision antar bagian.
 *
 * CHANGES v4.1.0:
 *   - Violation state pindah ke Security.ViolationStore (Firestore-backed)
 *     Peserta tidak bisa manipulasi state via DevTools lagi.
 *   - Hapus semua console.log (production build)
 *   - submitUjian: double-submit guard via Firestore check, bukan localStorage
 */

const ExamLogic = (() => {

  // --- State ---------------------------------------------------------------
  let _state = {
    isReady:          false,
    phase:            'loading',
    ujianData:        null,
    identitas:        { nama: '', kelas: '' },
    soalPages:        [],
    shuffledPages:    {},
    activePageIdx:    0,
    jawaban:          {},
    violations:       0,
    forceReshuffle:   false,
    _lastSeed:        0,
    startTime:        null,
    endTime:          null,
    durasi_menit:     90,
    timerInterval:    null,
    _cbTimer:         [],
    _cbPhase:         [],
    _cbPageChange:    [],
    _cbReshuffle:     [],
  };

  const TIMER_TICK_MS = 1_000;

  // --- Helpers -------------------------------------------------------------
  function _parseDurasi(str) {
    const m = String(str || '').match(/(\d+)/);
    return m ? parseInt(m[1], 10) : 90;
  }

  function _toDate(value) {
    if (!value) return null;
    if (value instanceof Date) return value;
    if (typeof value.toDate === 'function') return value.toDate();
    if (value.seconds != null) return new Date(value.seconds * 1000);
    const parsed = new Date(value);
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  function _jawabanKey(pageKey, idq) {
    return `${pageKey}__${idq}`;
  }

  function _emit(list, ...args) {
    list.forEach(cb => cb(...args));
  }

  function _setPhase(phase) {
    _state.phase = phase;
    _emit(_state._cbPhase, phase);
  }

  // --- Seed-based PRNG (mulberry32) ----------------------------------------
  // Reproducible tapi unik per user+timestamp.
  function _mulberry32(seed) {
    return function() {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // BUGFIX O: Per-session nonce mixed into the shuffle seed.
  // Previously _makeSeed used only Date.now() + nama -- two users
  // starting in the same millisecond with same-length names would get
  // the same shuffle. The nonce is generated once per session and
  // stored in sessionStorage so it survives page refreshes.
  let _sessionNonce = null;
  function _getSessionNonce() {
    if (_sessionNonce !== null) return _sessionNonce;
    try {
      const stored = sessionStorage.getItem('albedu_exam_nonce');
      if (stored) { _sessionNonce = parseInt(stored, 10); return _sessionNonce; }
    } catch (_) {}
    _sessionNonce = Math.floor(Math.random() * 0xFFFFFFFF) >>> 0;
    try { sessionStorage.setItem('albedu_exam_nonce', String(_sessionNonce)); } catch (_) {}
    return _sessionNonce;
  }

  function _makeSeed(nama) {
    let base = (Date.now() ^ _getSessionNonce()) >>> 0;
    for (let i = 0; i < nama.length; i++) base ^= (nama.charCodeAt(i) * (i + 1));
    if (base === _state._lastSeed) base ^= 0xDEADBEEF;
    return base >>> 0;
  }

  function _shuffleFisherYates(arr, rng) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function _generateShuffledPages(nama) {
    const seed = _makeSeed(nama);
    _state._lastSeed = seed;
    const rng = _mulberry32(seed);
    const result = {};

    // Shuffle urutan soal saja — pilihan A/B/C/D tidak disentuh sama sekali
    _state.soalPages.forEach(({ pageKey, questions }) => {
      result[pageKey] = _shuffleFisherYates(questions.map(q => q), rng);
    });

    _state.shuffledPages = result;
  }

  function shuffleStats() {
    const pages = _state.soalPages.map(({ pageKey, questions }) => {
      const shuffled = _state.shuffledPages[pageKey] || [];
      const moved = shuffled.filter((q, i) => questions[i]?.idq !== q.idq).length;
      return { pageKey, total: questions.length, posisiDiubah: moved };
    });
    // eslint-disable-next-line no-console
    console.table(pages); // diagnostics only — call dari DevTools, bukan auto
    return pages;
  }

  function _parseSoalPages(PQ) {
    const pages = [];
    const keys  = Object.keys(PQ)
      .filter(k => k !== 'pages1' && PQ[k]?.questions?.length)
      .sort();
    keys.forEach((pageKey, i) => {
      const page = PQ[pageKey];
      pages.push({
        pageKey,
        label:        `Bagian ${i + 1}`,
        typeQuestion: page.type_question || 'PG',
        questions:    page.questions,
      });
    });
    return pages;
  }

  // --- Public: init --------------------------------------------------------
  function init(ujianData) {
    const ujianInfo = window.ExamRecordCompat?.getMeta(ujianData) || ujianData?.ujian || {};
    _state.ujianData      = ujianData;
    _state.soalPages      = _parseSoalPages(ujianData?.PQ || {});
    _state.durasi_menit   = _parseDurasi(ujianInfo.time);
    _state.jawaban        = {};
    _state.shuffledPages  = {};
    _state.activePageIdx  = 0;
    _state.violations     = 0;
    _state.forceReshuffle = false;
    _state._lastSeed      = 0;
    _state.isReady        = true;
    _setPhase('identity');
  }

  // --- Public: mulai ujian -------------------------------------------------
  function startUjian(identitas) {
    if (!_state.isReady) throw new Error('ExamLogic belum diinisialisasi.');
    _state.identitas     = { ...identitas };
    _state.startTime     = Date.now();
    // WHY: JANGAN reset _state.jawaban di sini.
    // init() sudah set jawaban={} untuk fresh start.
    // resetUjian() juga sudah clear jawaban sebelum kembali ke phase identity.
    // Kalau kita reset di sini, restoreFromDraft() yang sebelumnya memuat
    // jawaban peserta dari localStorage jadi sia-sia — semua jawaban terhapus
    // setiap kali peserta re-enter setelah tutup browser. Bug kritis.
    _state.activePageIdx = 0;

    const wasForced = _state.forceReshuffle;

    if (wasForced || Object.keys(_state.shuffledPages).length === 0) {
      _state.forceReshuffle = false;
      // v2.0.0: identity bisa dari _display_name (mode manual/daftar) atau .nama (legacy)
      const displayName = identitas._display_name || identitas.nama || '';
      _generateShuffledPages(displayName);
    }

    _setPhase('exam');
    _startTimer();

    if (wasForced) _emit(_state._cbReshuffle);

    // WHY: controller di kerjakan-ujian.html destruktur return value:
    //   const { reshuffled } = ExamLogic.startUjian(identitas);
    // Sebelumnya fungsi ini void (tidak return apapun = undefined),
    // sehingga destruktur crash: "Cannot destructure property 'reshuffled' of undefined".
    return { reshuffled: wasForced };
  }

  // --- Public: navigate pages ----------------------------------------------
  function goToPage(idx) {
    if (idx < 0 || idx >= _state.soalPages.length) return;
    _state.activePageIdx = idx;
    _emit(_state._cbPageChange, idx);
  }

  // --- Auto-save ke localStorage -------------------------------------------
  // Jawaban hanya hidup di _state.jawaban (in-memory). Kalau HP mati atau
  // browser crash, seluruh progress hilang. Auto-save mencegah ini.
  //
  // Key format: exam_draft_${token}_${userKey}
  // Dihapus otomatis setelah submitUjian() berhasil.
  //
  // Kenapa localStorage dan bukan sessionStorage?
  // sessionStorage mati kalau tab ditutup. localStorage survive reboot HP.
  // Kenapa tidak Firestore? Terlalu berat untuk setiap keystroke jawaban.
  // localStorage cukup — scope-nya sudah unik per token+user.

  function _draftKey() {
    const token   = (typeof ExamData !== 'undefined') ? ExamData.getActiveToken() : null;
    const userKey = (typeof ExamData !== 'undefined') ? ExamData.getUserKey()    : 'anon';
    if (!token || !userKey) return null;
    return `exam_draft_${token}_${userKey}`;
  }

  // S4 fix: debounced draft save. Old code wrote localStorage on every jawab()
  // call — for a 40-question exam with rapid clicking, that was 40+ sync writes
  // per exam, each serializing the entire jawaban object. Now we debounce to
  // 500ms after the last answer — same persistence guarantee, ~40x less I/O.
  let _draftSaveTimer = null;
  const DRAFT_SAVE_DEBOUNCE_MS = 500;

  function _saveDraftImmediate() {
    const key = _draftKey();
    if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify({
        jawaban:   _state.jawaban,
        identitas: _state.identitas,
        savedAt:   Date.now(),
      }));
    } catch (_) {
      // localStorage bisa penuh di HP low-end — gagal silent, tidak crash ujian
    }
  }

  function _saveDraft() {
    if (_draftSaveTimer) clearTimeout(_draftSaveTimer);
    _draftSaveTimer = setTimeout(() => {
      _saveDraftImmediate();
      _draftSaveTimer = null;
    }, DRAFT_SAVE_DEBOUNCE_MS);
  }

  // S4: flush pending draft save immediately (called on submit / page unload)
  function _flushDraft() {
    if (_draftSaveTimer) {
      clearTimeout(_draftSaveTimer);
      _draftSaveTimer = null;
    }
    _saveDraftImmediate();
  }

  function _clearDraft() {
    const key = _draftKey();
    if (!key) return;
    try { localStorage.removeItem(key); } catch (_) {}
  }

  // Coba restore jawaban dari draft tersimpan.
  // Return: { restored: bool, count: number, identitas: object|null }
  function restoreFromDraft() {
    const key = _draftKey();
    if (!key) return { restored: false, count: 0, identitas: null };
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return { restored: false, count: 0, identitas: null };

      const draft = JSON.parse(raw);
      if (!draft?.jawaban) return { restored: false, count: 0, identitas: null };

      // Tolak draft yang lebih dari 12 jam — mungkin sisa ujian kemarin
      const age = Date.now() - (draft.savedAt || 0);
      if (age > 12 * 60 * 60 * 1000) {
        _clearDraft();
        return { restored: false, count: 0, identitas: null };
      }

      _state.jawaban = { ...draft.jawaban };
      const count = Object.values(draft.jawaban).filter(Boolean).length;
      return { restored: count > 0, count, identitas: draft.identitas || null };
    } catch (_) {
      return { restored: false, count: 0, identitas: null };
    }
  }

  // --- Public: jawab soal --------------------------------------------------
  function jawab(pageKey, idq, pilihan) {
    _state.jawaban[_jawabanKey(pageKey, idq)] = pilihan;
    // Auto-save setiap jawaban berubah — debounce tidak perlu, localStorage sync sangat cepat
    _saveDraft();
  }

  function getJawaban(pageKey, idq) {
    return _state.jawaban[_jawabanKey(pageKey, idq)] || null;
  }

  // --- Public: submit ujian ------------------------------------------------
  // Gunakan Security.ViolationStore (Firestore-backed) bukan localStorage.
  // Lebih aman: peserta tidak bisa delete/edit entry di Firestore tanpa auth.
  async function submitUjian() {
    if (_state.phase === 'result') return; // idempotent guard

    _stopTimer();
    _state.endTime = Date.now();

    // S4: flush any pending debounced draft save before marking submitted.
    // Without this, the last answer (clicked <500ms before submit) would be lost.
    _flushDraft();

    const token   = (typeof ExamData !== 'undefined') ? ExamData.getActiveToken() : null;
    const userKey = (typeof ExamData !== 'undefined') ? ExamData.getUserKey()    : 'anon';

    if (token && userKey && window.Security?.ViolationStore) {
      await Security.ViolationStore.markSubmitted(token, userKey);
    }

    // Draft tidak dibutuhkan lagi setelah submit berhasil — bersihkan
    _clearDraft();

    _setPhase('result');
  }

  // --- Public: reset (setelah max violation) --------------------------------
  async function resetUjian() {
    _stopTimer();
    _state.jawaban        = {};
    _state.activePageIdx  = 0;
    _state.startTime      = null;
    _state.endTime        = null;
    _state.forceReshuffle = true;
    // BUGFIX: Reset violation counter so the new exam session starts fresh.
    // Without this, _state.violations persisted across resets - the very first
    // violation in the new session would return isMaxed=true (counter was
    // already at 4 from the previous session), showing "Peringatan ke-5 dari 4"
    // and only leaving 3 effective warnings before the next forced reset.
    // ExamGuardian.deactivate() already resets its own warningCount; this
    // syncs the ExamLogic side.
    _state.violations     = 0;

    const token   = (typeof ExamData !== 'undefined') ? ExamData.getActiveToken() : null;
    const userKey = (typeof ExamData !== 'undefined') ? ExamData.getUserKey()    : 'anon';

    if (token && userKey && window.Security?.ViolationStore) {
      await Security.ViolationStore.markViolation(token, userKey, _state.violations);
    }

    // Reset juga draft — jawaban lama tidak relevan setelah reshuffle
    _clearDraft();

    _setPhase('identity');
  }

  // --- Public: catat pelanggaran -------------------------------------------
  // BUGFIX J: ExamLogic and ExamGuardian both track violation counts.
  // To prevent divergence, ExamLogic defers to ExamGuardian as the
  // source of truth when available. If ExamGuardian reports a different
  // count (e.g. after a reset in one but not the other), we use the max.
  function addViolation() {
    _state.violations++;
    // Cross-check with ExamGuardian
    if (typeof window.ExamGuardian !== 'undefined' && typeof window.ExamGuardian.getWarningCount === 'function') {
      const guardianCount = window.ExamGuardian.getWarningCount();
      if (guardianCount > _state.violations) {
        _state.violations = guardianCount;
      }
    }
    return {
      violations: _state.violations,
      isMaxed:    _state.violations >= 4,
    };
  }

  function getViolations() { return _state.violations; }
  function isForceReshuffle() { return _state.forceReshuffle; }

  // --- Public: hitung hasil ------------------------------------------------
  function getHasil() {
    const nilaiMaks = _state.ujianData?.ujian?.global_skor || 100;
    let totalSoal = 0, benar = 0, salah = 0, kosong = 0;
    const detailPerBagian = [];

    _state.soalPages.forEach(({ pageKey, label, questions }) => {
      totalSoal += questions.length;

      // WHY shuffledPages: detailPerBagian ditampilkan ke peserta saat review hasil.
      // Urutan harus sama dengan yang mereka kerjakan (shuffled), bukan urutan asli JSON.
      // Nilai tetap dihitung dari semua soal — urutan tidak mempengaruhi scoring.
      const orderedQuestions = _state.shuffledPages[pageKey] || questions;

      const detail = orderedQuestions.map(q => {
        const jw = getJawaban(pageKey, q.idq);
        let status;
        if (!jw)                         { kosong++; status = 'kosong'; }
        else if (jw === q.jawaban_benar) { benar++;  status = 'benar';  }
        else                             { salah++;  status = 'salah';  }
        return { idq: q.idq, pertanyaan: q.pertanyaan, jawabanPeserta: jw, jawabanBenar: q.jawaban_benar, status };
      });
      detailPerBagian.push({ label, detail });
    });

    const nilaiPerSoal = totalSoal > 0 ? nilaiMaks / totalSoal : 0;
    const nilai        = Math.round(benar * nilaiPerSoal);
    const durasiDetik  = _state.endTime
      ? Math.floor((_state.endTime - _state.startTime) / 1000) : 0;

    return {
      identitas: { ..._state.identitas },
      totalSoal, benar, salah, tidakDijawab: kosong,
      nilai, nilaiMaksimal: nilaiMaks,
      durasiDetik, detailPerBagian,
    };
  }

  // --- Timer ---------------------------------------------------------------
  function _startTimer() {
    _stopTimer();

    const ac = _state.ujianData?.access_control;

    // WHY dua sumber end-time:
    // manual mode  → ac.end ditulis oleh exam-admin-controller saat startManualExam/resumeExam
    // scheduled mode → ac.scheduled.end ditulis wizard, ac.end TIDAK diisi sampai admin start
    // Kalau hanya baca ac.end, scheduled exam selalu fallback ke timer lokal → peserta bisa
    // manipulasi waktu. Resolve dari sumber yang benar sesuai mode.
    const endRaw = (ac?.mode === 'scheduled')
      ? (ac?.end ?? ac?.scheduled?.end)   // prefer ac.end jika admin sudah start, fallback ke scheduled.end
      : ac?.end;
    const end = _toDate(endRaw);

    if (end && !isNaN(end.getTime())) {
      // Mode real-time: countdown dari server end-time
      function _tick() {
        const sisa = Math.max(0, Math.floor((end - new Date()) / 1000));
        _emit(_state._cbTimer, sisa);
        if (sisa <= 0) { _stopTimer(); if (_state.phase === 'exam') submitUjian(); }
      }
      _tick();
      _state.timerInterval = setInterval(_tick, TIMER_TICK_MS);
    } else {
      // Mode lokal: countdown dari durasi_menit
      let sisa = _state.durasi_menit * 60;
      _emit(_state._cbTimer, sisa);
      _state.timerInterval = setInterval(() => {
        sisa--;
        _emit(_state._cbTimer, sisa);
        if (sisa <= 0) { _stopTimer(); submitUjian(); }
      }, TIMER_TICK_MS);
    }
  }

  function _stopTimer() {
    if (_state.timerInterval) {
      clearInterval(_state.timerInterval);
      _state.timerInterval = null;
    }
  }

  // --- Callbacks -----------------------------------------------------------
  function onTimerTick(cb)   { _state._cbTimer.push(cb); }
  function onPhaseChange(cb) { _state._cbPhase.push(cb); }
  function onPageChange(cb)  { _state._cbPageChange.push(cb); }
  function onReshuffle(cb)   { _state._cbReshuffle.push(cb); }

  // --- Getters -------------------------------------------------------------
  function getState() {
    return {
      phase:         _state.phase,
      activePageIdx: _state.activePageIdx,
      identitas:     { ..._state.identitas },
      durasi_menit:  _state.durasi_menit,
      jawaban:       { ..._state.jawaban },
    };
  }

  function getSoalPages()       { return _state.soalPages; }
  function getActivePage()      { return _state.soalPages[_state.activePageIdx] || null; }
  function getUjianInfo()       {
    const meta = window.ExamRecordCompat?.getMeta(_state.ujianData) || _state.ujianData?.ujian || null;
    // v2.0.0: enrich meta dengan identity_mode + identity_config dari top-level (untuk view ujian_peserta yang stripped p_q)
    if (meta && _state.ujianData) {
      if (!meta.identity_mode && _state.ujianData.identity_mode) {
        meta.identity_mode = _state.ujianData.identity_mode;
      }
      if (!meta.identity_config && _state.ujianData.identity_config) {
        meta.identity_config = _state.ujianData.identity_config;
      }
    }
    return meta;
  }
  function getIdentitasConfig() {
    // v2.0.0: prioritas baca dari top-level identity_mode + identity_config
    // (untuk exam baru yang sudah migrate + yang di-fetch via view ujian_peserta tanpa p_q)
    const ud = _state.ujianData || {};
    if (ud.identity_mode) {
      const cfg = ud.identity_config || {};
      if (ud.identity_mode === 'manual') {
        return {
          mode: 'manual',
          identity_mode: 'manual',
          fields: Array.isArray(cfg.fields) && cfg.fields.length > 0
            ? cfg.fields
            : null,
        };
      }
      if (ud.identity_mode === 'daftar') {
        return {
          mode: 'daftar',
          identity_mode: 'daftar',
          daftar_id:    cfg.daftar_id    || null,
          daftar_tipe:  cfg.daftar_tipe  || null,
          daftar_label: cfg.daftar_label || null,
          tabs:         Array.isArray(cfg.tabs) ? cfg.tabs : [],
        };
      }
    }
    // Fallback: legacy path via PQ.pages1.identitas (untuk exam yang masih punya p_q)
    return ud?.PQ?.pages1?.identitas || ud?.p_q?.pages1?.identitas || {};
  }

  function getProgress() {
    let total = 0, dijawab = 0;
    _state.soalPages.forEach(({ pageKey, questions }) => {
      questions.forEach(q => {
        total++;
        if (getJawaban(pageKey, q.idq)) dijawab++;
      });
    });
    return {
      total,
      dijawab,
      persentase: total > 0 ? Math.round(dijawab / total * 100) : 0,
    };
  }

  function getPageProgress(pageKey) {
    const page = _state.soalPages.find(p => p.pageKey === pageKey);
    if (!page) return { total: 0, dijawab: 0 };
    let dijawab = 0;
    page.questions.forEach(q => { if (getJawaban(pageKey, q.idq)) dijawab++; });
    return { total: page.questions.length, dijawab };
  }

  function getShuffledPage(pageKey) {
    const page = _state.soalPages.find(p => p.pageKey === pageKey);
    return _state.shuffledPages[pageKey] || page?.questions || [];
  }

  function isAccessOpen() {
    const ac = _state.ujianData?.access_control;
    if (!ac) return false;
    if (ac.override) return true;
    if (ac.mode === 'manual') return ac.manual_status === 'open';
    if (ac.mode === 'scheduled' && ac.scheduled?.active) {
      const now   = Date.now();
      const start = _toDate(ac.scheduled.start)?.getTime() ?? 0;
      const end   = _toDate(ac.scheduled.end)?.getTime()   ?? Infinity;
      return now >= start && now <= end;
    }
    return false;
  }

  // --- Public API ----------------------------------------------------------
  return {
    init, startUjian, goToPage,
    jawab, getJawaban, submitUjian, resetUjian, getHasil,
    addViolation, getViolations, isForceReshuffle,
    getShuffledPage, shuffleStats, restoreFromDraft,
    onTimerTick, onPhaseChange, onPageChange, onReshuffle,
    getState, getSoalPages, getActivePage,
    getUjianInfo, getIdentitasConfig,
    getProgress, getPageProgress, isAccessOpen,
    flushDraft: _flushDraft, // S4: expose for beforeunload handler
  };
})();