// =============================================================================
// question-bank/import.js — JSON import + add-to-assessment stub
// =============================================================================
// Part of the question-bank split.
// Functions: _importJson, _validateImportItem, _buildImportPayload, _addToAssessment
// Load order: MUST load after utils.js, data.js, render.js, modal.js.
// =============================================================================

(function () {
  'use strict';

  const _internal = window.QuestionBank = window.QuestionBank || {};
  _internal._internal = _internal._internal || { state: {}, dom: {}, constants: {}, t: null };
  const I = _internal._internal;
  const t = I.t || ((key, vars, fallback) => fallback || key);
  const C = I.constants;
  const COLLECTION = () => C.COLLECTION || 'question_bank';
  const OPTION_KEYS = () => C.OPTION_KEYS || ['A', 'B', 'C', 'D'];
  const MIN_QUESTION_LEN = () => C.MIN_QUESTION_LEN || 3;

  // ── Import JSON ─────────────────────────────────────────────────────────
  async function _importJson(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;

    const repo = window.AlbEdu?.repository;
    if (!repo || !I.state.user) {
      if (window.notify && window.notify.error) {
        window.notify.error('Error', 'Sesi tidak siap. Coba muat ulang halaman.');
      }
      return;
    }

    let parsed;
    try {
      const text = await file.text();
      parsed = JSON.parse(text);
    } catch (err) {
      console.error('[QuestionBank] import parse:', err);
      if (window.notify && window.notify.error) {
        window.notify.error(
          t('qb.import_failed_title', null, 'Import Gagal'),
          t('qb.import_invalid_json', { error: (err && err.message) || 'parse error' }, 'File JSON tidak valid: ' + ((err && err.message) || 'parse error'))
        );
      }
      return;
    }

    const arr = Array.isArray(parsed)
      ? parsed
      : (parsed && Array.isArray(parsed.questions) ? parsed.questions : null);
    if (!arr) {
      if (window.notify && window.notify.error) {
        window.notify.error(
          t('qb.import_failed_title', null, 'Import Gagal'),
          t('qb.import_wrong_format', null, 'JSON harus berupa array soal atau { questions: [...] }.')
        );
      }
      return;
    }

    let imported = 0;
    let skipped = 0;
    const validPayloads = [];
    const now = new Date().toISOString();
    const owner = I.state.user.id || I.state.user.uid;

    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      const result = _validateImportItem(item);
      if (!result.valid) {
        skipped++;
        console.warn('[QuestionBank] import skip #' + (i + 1) + ':', result.reason, item);
        continue;
      }
      validPayloads.push(_buildImportPayload(result.normalized, owner, now));
    }

    if (validPayloads.length === 0) {
      if (window.notify && window.notify.warning) {
        window.notify.warning(
          t('qb.import_empty_title', null, 'Import Kosong'),
          t('qb.import_empty_msg', { count: skipped }, 'Tidak ada soal valid. ' + skipped + ' entri dilewati.')
        );
      }
      return;
    }

    try {
      for (const payload of validPayloads) {
        const newId = _internal._uuid();
        await repo.setDoc(COLLECTION(), newId, payload);
        imported++;
      }

      const msg = skipped > 0
        ? t('qb.import_success_with_skipped', { imported, skipped }, 'Berhasil import ' + imported + ' soal, ' + skipped + ' dilewati.')
        : t('qb.import_success', { imported }, 'Berhasil import ' + imported + ' soal.');
      if (window.notify && window.notify.success) {
        window.notify.success(t('qb.import_success_title', null, 'Import Berhasil'), msg);
      }
      await _internal._loadQuestions();
    } catch (err) {
      console.error('[QuestionBank] import commit:', err);
      if (window.notify && window.notify.error) {
        window.notify.error(
          t('qb.import_failed_title', null, 'Import Gagal'),
          (err && err.message) || t('qb.import_failed_msg', null, 'Terjadi kesalahan saat import.')
        );
      }
    }
  }

  function _validateImportItem(item) {
    if (!item || typeof item !== 'object') {
      return { valid: false, reason: 'Bukan objek' };
    }
    const type = _internal._normalizeType(item.type);
    if (!type) return { valid: false, reason: 'Tipe tidak valid' };

    const question = String(item.question || '').trim();
    if (question.length < MIN_QUESTION_LEN()) {
      return { valid: false, reason: 'Pertanyaan kurang dari ' + MIN_QUESTION_LEN() + ' karakter' };
    }

    const subject = String(item.subject || '').trim();
    if (!subject) return { valid: false, reason: 'Subject kosong' };

    let pilihan = null;
    let jawaban = null;
    if (type === 'PG') {
      const p = item.pilihan || item.options;
      if (!p || typeof p !== 'object' || Array.isArray(p)) {
        return { valid: false, reason: 'PG: pilihan tidak ada atau bukan objek' };
      }
      pilihan = {};
      for (const k of OPTION_KEYS()) {
        const v = p[k] != null ? p[k] : (p[k.toLowerCase()] != null ? p[k.toLowerCase()] : p[k.toUpperCase()]);
        if (!v || !String(v).trim()) {
          return { valid: false, reason: 'PG: pilihan ' + k + ' kosong' };
        }
        pilihan[k] = String(v).trim();
      }
      const jb = item.jawaban_benar || item.answer || item.jawaban;
      const jbNorm = _internal._normalizeJawaban(jb);
      if (!jbNorm) {
        return { valid: false, reason: 'PG: jawaban benar tidak valid' };
      }
      jawaban = jbNorm;
    }

    const difficulty = _internal._normalizeDifficulty(item.difficulty);
    const topic = item.topic ? String(item.topic).trim() : null;
    const tags = _internal._parseTags(item.tags);
    const media = (item.media && typeof item.media === 'object' && !Array.isArray(item.media))
      ? item.media : {};

    return {
      valid: true,
      normalized: { type, subject, topic, difficulty, question, pilihan, jawaban_benar: jawaban, tags, media },
    };
  }

  function _buildImportPayload(n, owner, ts) {
    return {
      owner_id: owner,
      subject: n.subject,
      topic: n.topic,
      difficulty: n.difficulty,
      type: n.type,
      question: n.question,
      pilihan: n.pilihan,
      jawaban_benar: n.jawaban_benar,
      media: n.media,
      tags: n.tags,
      usage_count: 0,
      created_at: ts,
      updated_at: ts,
    };
  }

  // ── Add to Assessment (stub — Phase 8) ──────────────────────────────────
  function _addToAssessment(_id) {
    if (window.notify && window.notify.info) {
      window.notify.info(
        t('qb.coming_soon_title', null, 'Segera Hadir'),
        t('qb.coming_soon_msg', null, 'Fitur tambah ke asesmen akan tersedia di versi mendatang.')
      );
    }
  }

  // ── Expose ──────────────────────────────────────────────────────────────
  Object.assign(_internal, {
    _importJson, _validateImportItem, _buildImportPayload, _addToAssessment,
  });
})();
