// =============================================================================
// soal-card.js — Card 2: sections + questions list
// =============================================================================
// Renders sections (max 2) and their questions (min 3, max 50 per section).
// Each question is a compact row; click → opens SoalEditorModal.
// Changing a section's type_question clears its questions (schema rule).
// Loaded as classic <script defer>. Exposes window.SoalCard.
// =============================================================================

(function () {
  'use strict';

  // v2.0.0: i18n helper — falls back to Indonesian if i18n not loaded
  const t = (key, vars, fallback) => {
    if (window.i18n && typeof window.i18n.t === 'function') {
      const v = window.i18n.t(key, vars);
      return v !== undefined ? v : fallback;
    }
    return fallback;
  };

  const SoalCard = {
    init() {
      this._list = document.getElementById('sections-list');
      this._empty = document.getElementById('soal-empty');
      this._sectionCount = document.getElementById('section-count');
      this._questionCount = document.getElementById('question-count');
      this._btnAddSection = document.getElementById('btn-add-section');
      this._btnEmptyAddSection = document.getElementById('btn-empty-add-section');
      this._btnTemplate = document.getElementById('btn-template');

      if (!this._list) {
        console.warn('[SoalCard] required elements missing');
        return;
      }

      this._btnAddSection.addEventListener('click', () => this._addSection());
      this._btnEmptyAddSection.addEventListener('click', () => this._addSection());
      this._btnTemplate.addEventListener('click', () => window.TemplatePicker?.open());

      window.CreateAssessment.subscribe((state) => this._render(state));
    },

    _addSection() {
      const sec = window.CreateAssessment.addSection();
      if (!sec) {
        window.notify?.warning(
          t('wizard.max_sections_reached', null, 'Batas tercapai'),
          t('wizard.max_sections_msg', null, 'Maksimal 2 bagian'),
          2000
        );
        return;
      }
      window.notify?.info(
        t('wizard.section_added', null, 'Bagian baru'),
        t('wizard.section_added_msg', null, 'Pilih tipe soal untuk bagian ini'),
        3000
      );
    },

    _render(state) {
      const sections = state.examData.sections || [];
      this._sectionCount.textContent = sections.length;
      this._questionCount.textContent = sections.reduce((sum, s) => sum + s.questions.length, 0);

      // Disable "Tambah Bagian" button if at max
      this._btnAddSection.disabled = sections.length >= 2;

      if (sections.length === 0) {
        this._empty.hidden = false;
        this._list.hidden = true;
        return;
      }

      this._empty.hidden = true;
      this._list.hidden = false;

      this._list.innerHTML = sections.map((sec, sIdx) => `
        <div class="albedu-section-block" data-section-index="${sIdx}">
          <header class="albedu-section-header">
            <div class="albedu-section-info">
              <h3 class="albedu-section-name">Bagian ${sIdx + 1}</h3>
              <span class="albedu-section-meta">${sec.questions.length} soal • ${sec.type_question === 'PG' ? 'Pilihan Ganda' : sec.type_question === 'esai' ? 'Esai' : 'pilih tipe'}</span>
            </div>
            <div class="albedu-section-actions">
              <select class="albedu-section-type" data-index="${sIdx}" ${sec.questions.length > 0 ? 'disabled' : ''}>
                <option value="">— Pilih tipe —</option>
                <option value="PG" ${sec.type_question === 'PG' ? 'selected' : ''}>Pilihan Ganda</option>
                <option value="esai" ${sec.type_question === 'esai' ? 'selected' : ''}>Esai</option>
              </select>
              <button class="albedu-btn albedu-btn-ghost albedu-btn-sm albedu-btn-add-question" data-index="${sIdx}" type="button" ${!sec.type_question ? 'disabled' : ''}>
                <i class="material-symbols-outlined">add</i> Soal
              </button>
              ${sections.length > 1 ? `<button class="albedu-btn albedu-btn-ghost albedu-btn-sm albedu-btn-delete-section" data-index="${sIdx}" type="button" aria-label="Hapus bagian"><i class="material-symbols-outlined">delete</i></button>` : ''}
            </div>
          </header>
          <div class="albedu-section-questions" data-section-index="${sIdx}">
            ${sec.questions.length === 0
              ? `<div class="albedu-questions-empty"><p>Belum ada soal. Klik "Soal" untuk menambah.</p></div>`
              : sec.questions.map((q, qIdx) => `
                <div class="albedu-question-row" data-section="${sIdx}" data-question="${qIdx}" tabindex="0" role="button">
                  <span class="albedu-question-num">${qIdx + 1}</span>
                  <span class="albedu-question-type albedu-q-type-${sec.type_question === 'PG' ? 'PG' : 'esai'}">${sec.type_question === 'PG' ? 'PG' : 'Esai'}</span>
                  <span class="albedu-question-text">${this._esc((q.pertanyaan || '').replace(/<[^>]*>/g, '').slice(0, 80)) || 'Soal kosong'}</span>
                  <span class="albedu-question-score">${q.skor || 0}p</span>
                  <div class="albedu-question-actions">
                    <button class="albedu-btn albedu-btn-ghost albedu-btn-sm albedu-btn-edit-question" data-section="${sIdx}" data-question="${qIdx}" type="button" aria-label="Edit soal"><i class="material-symbols-outlined">edit</i></button>
                    <button class="albedu-btn albedu-btn-ghost albedu-btn-sm albedu-btn-delete-question" data-section="${sIdx}" data-question="${qIdx}" type="button" aria-label="Hapus soal"><i class="material-symbols-outlined">delete</i></button>
                  </div>
                </div>
              `).join('')
            }
          </div>
        </div>
      `).join('');

      // Wire section-type select
      this._list.querySelectorAll('.albedu-section-type').forEach((sel) => {
        sel.addEventListener('change', (e) => {
          const idx = parseInt(e.target.dataset.index, 10);
          window.CreateAssessment.updateSection(idx, { type_question: e.target.value });
        });
      });

      // Wire add-question buttons
      this._list.querySelectorAll('.albedu-btn-add-question').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const sIdx = parseInt(btn.dataset.index, 10);
          const sec = window.CreateAssessment.getState().examData.sections[sIdx];
          if (!sec || !sec.type_question) return;
          window.SoalEditorModal.open({ mode: 'new', sectionIndex: sIdx, questionType: sec.type_question });
        });
      });

      // Wire delete-section buttons
      this._list.querySelectorAll('.albedu-btn-delete-section').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const idx = parseInt(btn.dataset.index, 10);
          this._deleteSection(idx);
        });
      });

      // Wire question-row click → open editor
      this._list.querySelectorAll('.albedu-question-row').forEach((row) => {
        row.addEventListener('click', (e) => {
          if (e.target.closest('.albedu-btn-delete-question')) return;
          if (e.target.closest('.albedu-btn-edit-question')) return;
          const sIdx = parseInt(row.dataset.section, 10);
          const qIdx = parseInt(row.dataset.question, 10);
          window.SoalEditorModal.open({ mode: 'edit', sectionIndex: sIdx, questionIndex: qIdx });
        });
        row.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          row.click();
        });
      });

      // Wire edit-question buttons (separate from row click to avoid double-trigger)
      this._list.querySelectorAll('.albedu-btn-edit-question').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const sIdx = parseInt(btn.dataset.section, 10);
          const qIdx = parseInt(btn.dataset.question, 10);
          window.SoalEditorModal.open({ mode: 'edit', sectionIndex: sIdx, questionIndex: qIdx });
        });
      });

      // Wire delete-question buttons
      this._list.querySelectorAll('.albedu-btn-delete-question').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const sIdx = parseInt(btn.dataset.section, 10);
          const qIdx = parseInt(btn.dataset.question, 10);
          this._deleteQuestion(sIdx, qIdx);
        });
      });
    },

    _deleteSection(sIdx) {
      if (!window.notify?.confirm) {
        if (!confirm(t('wizard.delete_section_confirm', { n: sIdx + 1 }, `Hapus Bagian ${sIdx + 1} beserta semua soal?`))) return;
        window.CreateAssessment.removeSection(sIdx);
        return;
      }
      window.notify.confirm({
        title: t('wizard.delete_section_title', null, 'Hapus Bagian'),
        message: t('wizard.delete_section_msg', { n: sIdx + 1 }, `Yakin hapus Bagian ${sIdx + 1}? Semua soal di dalamnya akan dihapus.`),
        intent: 'danger',
        onYes: () => window.CreateAssessment.removeSection(sIdx),
      });
    },

    _deleteQuestion(sIdx, qIdx) {
      if (!window.notify?.confirm) {
        if (!confirm(t('wizard.delete_question_confirm', { n: qIdx + 1 }, `Hapus soal #${qIdx + 1}?`))) return;
        window.CreateAssessment.removeQuestion(sIdx, qIdx);
        return;
      }
      window.notify.confirm({
        title: t('wizard.delete_question_title', null, 'Hapus Soal'),
        message: t('wizard.delete_question_msg', { n: qIdx + 1 }, `Yakin hapus soal #${qIdx + 1}?`),
        intent: 'danger',
        onYes: () => window.CreateAssessment.removeQuestion(sIdx, qIdx),
      });
    },

    _esc(str) {
      return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },
  };

  window.SoalCard = SoalCard;
})();
