// =============================================================================
// question-bank/modal.js — Create/Edit modal (form, validation, save, delete confirm)
// =============================================================================
// Part of the question-bank split.
// Functions: _ensureModal, _togglePilihan, _openModal, _closeModal,
//            _readForm, _validateForm, _onSave, _confirmDelete
// Load order: MUST load after utils.js, data.js, render.js.
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
  const PRESET_SUBJECTS = () => C.PRESET_SUBJECTS || [];
  const VALID_TYPES = () => C.VALID_TYPES || ['PG', 'esai'];
  const VALID_DIFFICULTIES = () => C.VALID_DIFFICULTIES || ['easy', 'medium', 'hard'];
  const MIN_QUESTION_LEN = () => C.MIN_QUESTION_LEN || 3;
  const HOLD_CONFIRM_MS = () => C.HOLD_CONFIRM_MS || 2000;

  // ── Ensure modal exists ─────────────────────────────────────────────────
  function _ensureModal() {
    if (I.dom.modalOverlay) return;

    const overlay = document.createElement('div');
    overlay.className = 'qb-modal-overlay';
    overlay.setAttribute('hidden', '');
    overlay.style.cssText = [
      'position:fixed','inset:0','z-index:9999','display:flex',
      'align-items:center','justify-content:center',
      'background:rgba(15,23,42,.55)','padding:20px',
      'opacity:0','transition:opacity .2s ease','pointer-events:none',
    ].join(';');

    overlay.innerHTML = `
      <div class="qb-modal" role="dialog" aria-modal="true" aria-labelledby="qb-modal-title"
           style="background:var(--albedu-surface,#fff);border-radius:14px;border:1px solid var(--albedu-border,#e2e8f0);box-shadow:0 20px 50px rgba(15,23,42,.25);width:100%;max-width:640px;max-height:90vh;display:flex;flex-direction:column;">
        <header style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:18px 22px;border-bottom:1px solid var(--albedu-border,#e2e8f0);">
          <div>
            <h2 id="qb-modal-title" style="font-size:17px;font-weight:700;margin:0;color:var(--albedu-heading,#0f172a);">Tambah Soal</h2>
            <p id="qb-modal-subtitle" style="font-size:13px;color:var(--albedu-body,#64748b);margin:4px 0 0;"></p>
          </div>
          <button id="qb-modal-close" type="button" aria-label="Tutup"
                  style="background:transparent;border:none;cursor:pointer;color:var(--albedu-body,#64748b);padding:6px;border-radius:6px;">
            <span data-albedu-icon="close"></span>
          </button>
        </header>
        <form id="qb-modal-form" style="padding:22px;overflow-y:auto;flex:1;">
          <div class="albedu-field" style="margin-bottom:14px;">
            <label style="font-size:13px;font-weight:600;color:var(--albedu-heading,#0f172a);">Tipe Soal <span style="color:var(--albedu-danger,#dc2626);">*</span></label>
            <div style="display:flex;gap:14px;margin-top:6px;flex-wrap:wrap;">
              <label style="display:inline-flex;align-items:center;gap:6px;font-size:14px;cursor:pointer;">
                <input type="radio" name="qb-type" value="PG" /> PG (Pilihan Ganda)
              </label>
              <label style="display:inline-flex;align-items:center;gap:6px;font-size:14px;cursor:pointer;">
                <input type="radio" name="qb-type" value="esai" /> Esai
              </label>
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
            <div class="albedu-field">
              <label for="qb-f-subject" style="font-size:13px;font-weight:600;color:var(--albedu-heading,#0f172a);">Mata Pelajaran <span style="color:var(--albedu-danger,#dc2626);">*</span></label>
              <input id="qb-f-subject" type="text" class="albedu-input" list="qb-subject-list" placeholder="cth: Matematika"
                     style="padding:10px 12px;border:1px solid var(--albedu-border,#e2e8f0);border-radius:10px;font-size:14px;width:100%;box-sizing:border-box;" />
              <datalist id="qb-subject-list">
                ${PRESET_SUBJECTS().map((s) => `<option value="${_internal._esc(s)}">`).join('')}
              </datalist>
            </div>
            <div class="albedu-field">
              <label for="qb-f-topic" style="font-size:13px;font-weight:600;color:var(--albedu-heading,#0f172a);">Topik</label>
              <input id="qb-f-topic" type="text" class="albedu-input" placeholder="cth: Aljabar"
                     style="padding:10px 12px;border:1px solid var(--albedu-border,#e2e8f0);border-radius:10px;font-size:14px;width:100%;box-sizing:border-box;" />
            </div>
          </div>

          <div class="albedu-field" style="margin-top:14px;">
            <label for="qb-f-difficulty" style="font-size:13px;font-weight:600;color:var(--albedu-heading,#0f172a);">Tingkat Kesulitan</label>
            <select id="qb-f-difficulty"
                    style="padding:10px 12px;border:1px solid var(--albedu-border,#e2e8f0);border-radius:10px;font-size:14px;background:var(--albedu-surface,#fff);width:100%;box-sizing:border-box;">
              <option value="">— Tidak ditentukan —</option>
              <option value="easy">${_internal._esc('Mudah')}</option>
              <option value="medium">${_internal._esc('Sedang')}</option>
              <option value="hard">${_internal._esc('Sulit')}</option>
            </select>
          </div>

          <div class="albedu-field" style="margin-top:14px;">
            <label for="qb-f-question" style="font-size:13px;font-weight:600;color:var(--albedu-heading,#0f172a);">Pertanyaan <span style="color:var(--albedu-danger,#dc2626);">*</span></label>
            <textarea id="qb-f-question" class="albedu-textarea" placeholder="Tulis pertanyaan di sini..."
                      style="min-height:90px;padding:10px 12px;border:1px solid var(--albedu-border,#e2e8f0);border-radius:10px;font-size:14px;width:100%;box-sizing:border-box;resize:vertical;font-family:inherit;"></textarea>
            <span class="albedu-field-hint" style="font-size:12px;color:#94a3b8;">Minimal ${MIN_QUESTION_LEN()} karakter.</span>
          </div>

          <div id="qb-f-pilihan-wrap" class="albedu-field" style="margin-top:14px;" hidden>
            <label style="font-size:13px;font-weight:600;color:var(--albedu-heading,#0f172a);">Pilihan Jawaban <span style="color:var(--albedu-danger,#dc2626);">*</span></label>
            <div style="display:grid;gap:8px;margin-top:6px;">
              ${OPTION_KEYS().map((k) => `
                <div style="display:flex;align-items:center;gap:8px;">
                  <label data-letter="${k}" style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:var(--albedu-primary,#2563eb);color:#fff;font-weight:700;font-size:13px;cursor:pointer;flex-shrink:0;user-select:none;position:relative;">
                    <input type="radio" name="qb-jawaban" value="${k}" style="position:absolute;opacity:0;pointer-events:none;" />
                    ${k}
                  </label>
                  <input type="text" data-pilihan="${k}" placeholder="Teks pilihan ${k}"
                         style="flex:1;padding:9px 12px;border:1px solid var(--albedu-border,#e2e8f0);border-radius:8px;font-size:14px;" />
                </div>
              `).join('')}
            </div>
            <span class="albedu-field-hint" style="font-size:12px;color:#94a3b8;">Klik huruf untuk menandai jawaban benar.</span>
          </div>

          <div class="albedu-field" style="margin-top:14px;">
            <label for="qb-f-tags" style="font-size:13px;font-weight:600;color:var(--albedu-heading,#0f172a);">Tags</label>
            <input id="qb-f-tags" type="text" class="albedu-input" placeholder="cth: aljabar, persamaan"
                   style="padding:10px 12px;border:1px solid var(--albedu-border,#e2e8f0);border-radius:10px;font-size:14px;width:100%;box-sizing:border-box;" />
            <span class="albedu-field-hint" style="font-size:12px;color:#94a3b8;">Pisahkan dengan koma.</span>
          </div>
        </form>
        <footer style="display:flex;justify-content:flex-end;gap:10px;padding:14px 22px;border-top:1px solid var(--albedu-border,#e2e8f0);">
          <button id="qb-modal-cancel" type="button" class="albedu-btn albedu-btn-secondary albedu-btn-sm">Batal</button>
          <button id="qb-modal-save" type="button" class="albedu-btn albedu-btn-primary albedu-btn-sm">
            <span data-albedu-icon="check"></span>
            <span>Simpan</span>
          </button>
        </footer>
      </div>
    `;

    document.body.appendChild(overlay);
    window.AlbEdu?.bindIcons?.(overlay);

    I.dom.modalOverlay     = overlay;
    I.dom.modalTitle       = overlay.querySelector('#qb-modal-title');
    I.dom.modalSubtitle    = overlay.querySelector('#qb-modal-subtitle');
    I.dom.modalForm        = overlay.querySelector('#qb-modal-form');
    I.dom.modalClose       = overlay.querySelector('#qb-modal-close');
    I.dom.modalCancel      = overlay.querySelector('#qb-modal-cancel');
    I.dom.modalSave        = overlay.querySelector('#qb-modal-save');
    I.dom.modalTypePG      = overlay.querySelector('input[name="qb-type"][value="PG"]');
    I.dom.modalTypeEsai    = overlay.querySelector('input[name="qb-type"][value="esai"]');
    I.dom.modalSubject     = overlay.querySelector('#qb-f-subject');
    I.dom.modalTopic       = overlay.querySelector('#qb-f-topic');
    I.dom.modalDifficulty  = overlay.querySelector('#qb-f-difficulty');
    I.dom.modalQuestion    = overlay.querySelector('#qb-f-question');
    I.dom.modalPilihanWrap = overlay.querySelector('#qb-f-pilihan-wrap');
    I.dom.modalTags        = overlay.querySelector('#qb-f-tags');

    I.dom.modalClose.addEventListener('click', _internal._closeModal);
    I.dom.modalCancel.addEventListener('click', _internal._closeModal);
    I.dom.modalSave.addEventListener('click', _internal._onSave);
    I.dom.modalOverlay.addEventListener('click', (e) => {
      if (e.target === I.dom.modalOverlay) _internal._closeModal();
    });
    I.dom.modalTypePG.addEventListener('change', () => _togglePilihan(true));
    I.dom.modalTypeEsai.addEventListener('change', () => _togglePilihan(false));

    I.dom.modalPilihanWrap.querySelectorAll('label[data-letter]').forEach((label) => {
      label.addEventListener('click', () => {
        const input = label.querySelector('input[type="radio"]');
        if (input) input.checked = true;
      });
    });
  }

  function _togglePilihan(show) {
    if (I.dom.modalPilihanWrap) I.dom.modalPilihanWrap.hidden = !show;
  }

  function _openModal(questionId) {
    _ensureModal();
    if (!I.dom.modalOverlay) return;

    I.dom.modalForm.reset();
    I.state.editingId = questionId || null;

    if (questionId) {
      const q = I.state.questions.find((x) => x.id === questionId);
      if (!q) {
        if (window.notify && window.notify.error) {
          window.notify.error(t('qb.not_found_title', null, 'Tidak Ditemukan'), t('qb.not_found_msg', null, 'Soal tidak ditemukan.'));
        }
        return;
      }
      I.dom.modalTitle.textContent = t('qb.edit_title', null, 'Edit Soal');
      I.dom.modalSubtitle.textContent =
        (q.subject || '—') + ' • ' + (q.type === 'PG' ? t('wizard.type_pg', null, 'Pilihan Ganda') : t('wizard.type_essay', null, 'Esai'));

      if (q.type === 'PG') I.dom.modalTypePG.checked = true;
      else                  I.dom.modalTypeEsai.checked = true;
      _togglePilihan(q.type === 'PG');

      I.dom.modalSubject.value    = q.subject || '';
      I.dom.modalTopic.value      = q.topic || '';
      I.dom.modalDifficulty.value = q.difficulty || '';
      I.dom.modalQuestion.value   = q.question || '';
      I.dom.modalTags.value       = q.tags.join(', ');

      if (q.type === 'PG' && q.pilihan) {
        for (const k of OPTION_KEYS()) {
          const input = I.dom.modalPilihanWrap.querySelector('input[data-pilihan="' + k + '"]');
          if (input) input.value = q.pilihan[k] || '';
        }
        if (q.jawaban_benar) {
          const radio = I.dom.modalPilihanWrap.querySelector('input[name="qb-jawaban"][value="' + q.jawaban_benar + '"]');
          if (radio) radio.checked = true;
        }
      }
    } else {
      I.dom.modalTitle.textContent = t('qb.add_title', null, 'Tambah Soal');
      I.dom.modalSubtitle.textContent = t('qb.add_subtitle', null, 'Buat soal baru untuk bank soal Anda');
      I.dom.modalTypePG.checked = true;
      _togglePilihan(true);
    }

    I.state.modalOpen = true;
    I.dom.modalOverlay.hidden = false;
    requestAnimationFrame(() => {
      I.dom.modalOverlay.style.opacity = '1';
      I.dom.modalOverlay.style.pointerEvents = 'auto';
    });
    setTimeout(() => {
      const first = I.dom.modalForm.querySelector('input, textarea, select');
      if (first) first.focus();
    }, 100);
  }

  function _closeModal() {
    if (!I.dom.modalOverlay) return;
    I.dom.modalOverlay.style.opacity = '0';
    I.dom.modalOverlay.style.pointerEvents = 'none';
    setTimeout(() => {
      I.dom.modalOverlay.hidden = true;
      I.state.modalOpen = false;
      I.state.editingId = null;
    }, 200);
  }

  function _readForm() {
    const typeEl = I.dom.modalForm.querySelector('input[name="qb-type"]:checked');
    const type = typeEl ? typeEl.value : '';
    const subject    = (I.dom.modalSubject.value || '').trim();
    const topic      = (I.dom.modalTopic.value || '').trim() || null;
    const difficulty = (I.dom.modalDifficulty.value || '') || null;
    const question   = (I.dom.modalQuestion.value || '').trim();
    const tags       = _internal._parseTags(I.dom.modalTags.value);

    let pilihan = null;
    let jawaban = null;
    if (type === 'PG') {
      pilihan = {};
      for (const k of OPTION_KEYS()) {
        const input = I.dom.modalPilihanWrap.querySelector('input[data-pilihan="' + k + '"]');
        pilihan[k] = (input && input.value || '').trim();
      }
      const jbEl = I.dom.modalForm.querySelector('input[name="qb-jawaban"]:checked');
      jawaban = jbEl ? jbEl.value : '';
    }

    return { type, subject, topic, difficulty, question, tags, pilihan, jawaban };
  }

  function _validateForm(data) {
    const errors = [];
    if (!VALID_TYPES().includes(data.type)) {
      errors.push('Tipe soal harus dipilih.');
    }
    if (!data.question || data.question.length < MIN_QUESTION_LEN()) {
      errors.push('Pertanyaan minimal ' + MIN_QUESTION_LEN() + ' karakter.');
    }
    if (!data.subject) errors.push('Mata pelajaran harus diisi.');
    if (data.difficulty && !VALID_DIFFICULTIES().includes(data.difficulty)) {
      errors.push('Tingkat kesulitan tidak valid.');
    }
    if (data.type === 'PG') {
      if (!data.pilihan) {
        errors.push('Pilihan harus diisi.');
      } else {
        for (const k of OPTION_KEYS()) {
          if (!data.pilihan[k]) errors.push('Pilihan ' + k + ' harus diisi.');
        }
      }
      if (!data.jawaban || !OPTION_KEYS().includes(data.jawaban)) {
        errors.push('Jawaban benar harus dipilih.');
      }
    }
    return errors;
  }

  async function _onSave() {
    if (!I.dom.modalSave || I.dom.modalSave.disabled) return;

    const data = _readForm();
    const errors = _validateForm(data);
    if (errors.length > 0) {
      if (window.notify && window.notify.error) {
        window.notify.error(t('wizard.validation_failed', null, 'Validasi Gagal'), errors.join('\n'));
      }
      return;
    }

    const repo = window.AlbEdu?.repository;
    if (!repo || !I.state.user) {
      if (window.notify && window.notify.error) {
        window.notify.error(t('qb.error_title', null, 'Error'), t('qb.session_not_ready', null, 'Sesi tidak siap. Coba muat ulang halaman.'));
      }
      return;
    }

    const original = I.dom.modalSave.innerHTML;
    I.dom.modalSave.disabled = true;
    I.dom.modalSave.innerHTML =
      '<span data-albedu-icon="hourglass_top"></span><span>' + t('common.saving', null, 'Menyimpan…') + '</span>';
    window.AlbEdu?.bindIcons?.(I.dom.modalSave);

    try {
      const payload = {
        owner_id: I.state.user.id || I.state.user.uid,
        subject: data.subject,
        topic: data.topic,
        difficulty: data.difficulty,
        type: data.type,
        question: data.question,
        pilihan: data.type === 'PG' ? data.pilihan : null,
        jawaban_benar: data.type === 'PG' ? data.jawaban : null,
        media: {},
        tags: data.tags,
        updated_at: new Date().toISOString(),
      };

      // [Production Hardening] Use Actly resilience for question bank writes
      const resilience = window.AlbEdu?.resilience;
      const doSave = async () => {
        if (I.state.editingId) {
          await repo.updateDoc(COLLECTION(), I.state.editingId, payload);
          return 'updated';
        } else {
          payload.created_at = new Date().toISOString();
          const newId = _internal._uuid();
          await repo.setDoc(COLLECTION(), newId, payload);
          return 'added';
        }
      };

      let saveResult;
      if (resilience) {
        const result = await resilience.write(`qb-save:${I.state.editingId || 'new'}`, doSave);
        if (!result.ok) throw result.error || new Error('Save failed');
        saveResult = result.value;
      } else {
        saveResult = await doSave();
      }

      if (saveResult === 'updated') {
        if (window.notify && window.notify.success) {
          window.notify.success(t('wizard.saved_title', null, 'Tersimpan'), t('qb.updated_msg', null, 'Soal berhasil diperbarui.'));
        }
      } else {
        if (window.notify && window.notify.success) {
          window.notify.success(t('wizard.saved_title', null, 'Tersimpan'), t('qb.added_msg', null, 'Soal baru berhasil ditambahkan.'));
        }
      }

      _internal._closeModal();
      await _internal._loadQuestions();
    } catch (err) {
      console.error('[QuestionBank] save:', err);
      if (window.notify && window.notify.error) {
        window.notify.error(t('qb.save_failed_title', null, 'Gagal Menyimpan'), (err && err.message) || t('qb.save_failed_msg', null, 'Terjadi kesalahan saat menyimpan soal.'));
      }
    } finally {
      I.dom.modalSave.disabled = false;
      I.dom.modalSave.innerHTML = original;
      window.AlbEdu?.bindIcons?.(I.dom.modalSave);
    }
  }

  // ── Delete confirm ──────────────────────────────────────────────────────
  function _confirmDelete(id) {
    const q = I.state.questions.find((x) => x.id === id);
    if (!q) return;
    const preview = _internal._truncate(q.question, 80);

    if (window.notify && typeof window.notify.holdConfirmAsync === 'function') {
      window.notify.holdConfirmAsync({
        title: t('qb.delete_title', null, 'Hapus Soal'),
        message: t('qb.delete_hold_msg', { preview }, 'Tahan tombol untuk menghapus: "' + preview + '"'),
        intent: 'danger',
        holdDuration: HOLD_CONFIRM_MS(),
        onAsyncConfirm: async () => { await _internal._doDelete(id); },
        onCancel: function () { /* noop */ },
      });
      return;
    }
    if (window.notify && typeof window.notify.confirm === 'function') {
      window.notify.confirm({
        title: t('qb.delete_title', null, 'Hapus Soal'),
        message: t('qb.delete_confirm_msg', { preview }, 'Yakin hapus soal: "' + preview + '"? Tindakan ini tidak dapat dibatalkan.'),
        intent: 'danger',
        onYes: function () { _internal._doDelete(id); },
      });
      return;
    }
    if (window.confirm(t('qb.delete_confirm_msg', { preview }, 'Hapus soal: "' + preview + '"?'))) _internal._doDelete(id);
  }

  // ── Expose ──────────────────────────────────────────────────────────────
  Object.assign(_internal, {
    _ensureModal, _togglePilihan, _openModal, _closeModal,
    _readForm, _validateForm, _onSave, _confirmDelete,
  });
})();
