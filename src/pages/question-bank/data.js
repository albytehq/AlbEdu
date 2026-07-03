// =============================================================================
// question-bank/data.js — Data load, normalize, filter, delete, export
// =============================================================================
// Part of the question-bank split.
// Functions: _loadQuestions, _normalizeRow, _rebuildFilters, _applyFilters,
//            _doDelete, _exportJson
// Load order: MUST load after utils.js, before question-bank.js.
// =============================================================================

(function () {
  'use strict';

  const _internal = window.QuestionBank = window.QuestionBank || {};
  _internal._internal = _internal._internal || { state: {}, dom: {}, constants: {}, t: null };
  const I = _internal._internal;
  const t = I.t || ((key, vars, fallback) => fallback || key);
  const COLLECTION = () => I.constants.COLLECTION || 'question_bank';
  const PRESET_SUBJECTS = () => I.constants.PRESET_SUBJECTS || [];

  // ── Load questions ──────────────────────────────────────────────────────
  async function _loadQuestions() {
    const repo = window.AlbEdu?.repository;
    if (!repo || !I.state.user) return;

    if (I.dom.grid) I.dom.grid.setAttribute('aria-busy', 'true');
    try {
      const snap = await repo.getDocs(COLLECTION(), {
        eq: { owner_id: I.state.user.id || I.state.user.uid },
        order: { column: 'created_at', ascending: false },
      });

      I.state.questions = (snap.docs || []).map((d) => {
        const data = d.data() || {};
        return _normalizeRow(d.id, data);
      });

      _internal._rebuildFilters();
      _internal._applyFilters();
    } catch (err) {
      console.error('[QuestionBank] load:', err);
      window.notify && window.notify.error
        ? window.notify.error(t('qb.load_failed_title', null, 'Gagal Memuat'), (err && err.message) || t('qb.load_failed_msg', null, 'Tidak dapat memuat bank soal.'))
        : console.warn('[QuestionBank] notify unavailable');
      I.state.questions = [];
      _internal._applyFilters();
    } finally {
      if (I.dom.grid) I.dom.grid.setAttribute('aria-busy', 'false');
    }
  }

  function _normalizeRow(id, data) {
    const type = data.type === 'PG' ? 'PG' : 'esai';
    const pilihan = type === 'PG' ? _internal._normalizePilihan(data.pilihan) : null;
    const jawaban = type === 'PG' ? _internal._normalizeJawaban(data.jawaban_benar) : null;
    return {
      id,
      owner_id: data.owner_id || data.ownerId || null,
      subject: data.subject || '',
      topic: data.topic || null,
      difficulty: _internal._normalizeDifficulty(data.difficulty) || null,
      type,
      question: data.question || '',
      pilihan,
      jawaban_benar: jawaban,
      media: (data.media && typeof data.media === 'object' && !Array.isArray(data.media))
        ? data.media : {},
      tags: Array.isArray(data.tags) ? data.tags.filter(Boolean) : [],
      usage_count: Number(data.usage_count) || 0,
      last_used_at: data.last_used_at || data.lastUsedAt || null,
      created_at: data.created_at || data.createdAt || null,
      updated_at: data.updated_at || data.updatedAt || null,
    };
  }

  function _rebuildFilters() {
    const subjectSet = new Set();
    for (const q of I.state.questions) {
      if (q.subject) subjectSet.add(q.subject);
    }
    I.state.subjects = [...subjectSet].sort((a, b) => a.localeCompare(b));

    if (I.dom.filterSubject) {
      const currentValue = I.dom.filterSubject.value;
      const firstOpt = I.dom.filterSubject.querySelector('option:first-child');
      const merged = [...new Set([...PRESET_SUBJECTS(), ...I.state.subjects])];
      I.dom.filterSubject.innerHTML = '';
      if (firstOpt) I.dom.filterSubject.appendChild(firstOpt);
      for (const s of merged) {
        const opt = document.createElement('option');
        opt.value = s;
        opt.textContent = s;
        I.dom.filterSubject.appendChild(opt);
      }
      I.dom.filterSubject.value = currentValue;
    }

    const tagSet = new Set();
    for (const q of I.state.questions) {
      for (const t of q.tags) {
        if (t) tagSet.add(String(t));
      }
    }
    I.state.tags = [...tagSet].sort((a, b) => a.localeCompare(b));

    if (I.dom.filterTags) {
      let dl = document.getElementById('qb-filter-tags-list');
      if (!dl) {
        dl = document.createElement('datalist');
        dl.id = 'qb-filter-tags-list';
        I.dom.filterTags.setAttribute('list', dl.id);
        document.body.appendChild(dl);
      }
      dl.innerHTML = I.state.tags.map((t) => `<option value="${_internal._esc(t)}">`).join('');
    }
  }

  function _applyFilters() {
    const search = I.state.search.trim().toLowerCase();
    const subject = I.state.filterSubject;
    const difficulty = I.state.filterDifficulty;
    const tags = I.state.filterTags;

    I.state.filtered = I.state.questions.filter((q) => {
      if (subject && q.subject !== subject) return false;
      if (difficulty && q.difficulty !== difficulty) return false;
      if (tags.length > 0) {
        const qTags = q.tags.map((t) => String(t).toLowerCase());
        const hasAny = tags.some((t) => qTags.includes(t));
        if (!hasAny) return false;
      }
      if (search) {
        const haystack = [q.question || '', q.subject || '', q.topic || '', q.tags.join(' ')].join(' ').toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });

    _internal._render();
  }

  // ── Delete ──────────────────────────────────────────────────────────────
  async function _doDelete(id) {
    const repo = window.AlbEdu?.repository;
    if (!repo) return;
    try {
      await repo.deleteDoc(COLLECTION(), id);
      if (window.notify && window.notify.success) {
        window.notify.success(t('qb.deleted_title', null, 'Terhapus'), t('qb.deleted_msg', null, 'Soal berhasil dihapus.'));
      }
      await _loadQuestions();
    } catch (err) {
      console.error('[QuestionBank] delete:', err);
      if (window.notify && window.notify.error) {
        window.notify.error(t('qb.delete_failed_title', null, 'Gagal Hapus'), (err && err.message) || t('qb.delete_failed_msg', null, 'Tidak dapat menghapus soal.'));
      }
    }
  }

  // ── Export JSON ─────────────────────────────────────────────────────────
  async function _exportJson() {
    const repo = window.AlbEdu?.repository;
    if (!repo || !I.state.user) {
      if (window.notify && window.notify.error) {
        window.notify.error('Error', 'Sesi tidak siap. Coba muat ulang halaman.');
      }
      return;
    }

    try {
      const snap = await repo.getDocs(COLLECTION(), {
        eq: { owner_id: I.state.user.id || I.state.user.uid },
        order: { column: 'created_at', ascending: false },
      });

      const arr = (snap.docs || []).map((d) => {
        const data = d.data() || {};
        const type = data.type === 'PG' ? 'PG' : 'esai';
        const pilihan = type === 'PG' ? _internal._normalizePilihan(data.pilihan) : null;
        const jawaban = type === 'PG' ? _internal._normalizeJawaban(data.jawaban_benar) : null;
        return {
          type,
          subject: data.subject || null,
          topic: data.topic || null,
          difficulty: _internal._normalizeDifficulty(data.difficulty) || null,
          question: data.question || null,
          pilihan,
          jawaban_benar: jawaban,
          media: (data.media && typeof data.media === 'object' && !Array.isArray(data.media)) ? data.media : {},
          tags: Array.isArray(data.tags) ? data.tags : [],
          usage_count: Number(data.usage_count) || 0,
          created_at: data.created_at || data.createdAt || null,
          updated_at: data.updated_at || data.updatedAt || null,
        };
      });

      if (arr.length === 0) {
        if (window.notify && window.notify.warning) {
          window.notify.warning('Export Kosong', 'Belum ada soal untuk diexport.');
        }
        return;
      }

      const json = JSON.stringify(arr, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const date = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = 'albedu-question-bank-export-' + date + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      if (window.notify && window.notify.success) {
        window.notify.success(t('qb.export_success_title', null, 'Export Berhasil'), t('qb.export_success_msg', { count: arr.length }, arr.length + ' soal berhasil diexport.'));
      }
    } catch (err) {
      console.error('[QuestionBank] export:', err);
      if (window.notify && window.notify.error) {
        window.notify.error(t('qb.export_failed_title', null, 'Export Gagal'), (err && err.message) || t('qb.export_failed_msg', null, 'Terjadi kesalahan saat export.'));
      }
    }
  }

  // ── Expose ──────────────────────────────────────────────────────────────
  Object.assign(_internal, {
    _loadQuestions, _normalizeRow, _rebuildFilters, _applyFilters,
    _doDelete, _exportJson,
  });
})();
