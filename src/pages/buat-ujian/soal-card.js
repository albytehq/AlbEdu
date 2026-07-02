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

  const SoalCard = {
    init() {
      this._list = document.getElementById('bu-sections-list');
      this._empty = document.getElementById('bu-soal-empty');
      this._sectionCount = document.getElementById('bu-section-count');
      this._questionCount = document.getElementById('bu-question-count');
      this._btnAddSection = document.getElementById('bu-btn-add-section');
      this._btnEmptyAddSection = document.getElementById('bu-btn-empty-add-section');
      this._btnTemplate = document.getElementById('bu-btn-template');

      if (!this._list) {
        console.warn('[SoalCard] required elements missing');
        return;
      }

      this._btnAddSection.addEventListener('click', () => this._addSection());
      this._btnEmptyAddSection.addEventListener('click', () => this._addSection());
      this._btnTemplate.addEventListener('click', () => window.TemplatePicker?.open());

      window.BuatUjian.subscribe((state) => this._render(state));
    },

    _addSection() {
      const sec = window.BuatUjian.addSection();
      if (!sec) {
        window.notify?.warning('Batas tercapai', 'Maksimal 2 bagian', 2000);
        return;
      }
      window.notify?.info('Bagian baru', 'Pilih tipe soal untuk bagian ini', 3000);
    },

    _render(state) {
      const sections = state.sections || [];
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
        <div class="bu-section-block" data-section-index="${sIdx}">
          <header class="bu-section-header">
            <div class="bu-section-info">
              <h3 class="bu-section-name">Bagian ${sIdx + 1}</h3>
              <span class="bu-section-meta">${sec.questions.length} soal • ${sec.type_question === 'PG' ? 'Pilihan Ganda' : sec.type_question === 'esai' ? 'Esai' : 'pilih tipe'}</span>
            </div>
            <div class="bu-section-actions">
              <select class="bu-section-type" data-index="${sIdx}" ${sec.questions.length > 0 ? 'disabled' : ''}>
                <option value="">— Pilih tipe —</option>
                <option value="PG" ${sec.type_question === 'PG' ? 'selected' : ''}>Pilihan Ganda</option>
                <option value="esai" ${sec.type_question === 'esai' ? 'selected' : ''}>Esai</option>
              </select>
              <button class="bu-btn bu-btn-ghost bu-btn-sm bu-btn-add-question" data-index="${sIdx}" type="button" ${!sec.type_question ? 'disabled' : ''}>
                <i class="material-symbols-outlined">add</i> Soal
              </button>
              ${sections.length > 1 ? `<button class="bu-btn bu-btn-ghost bu-btn-sm bu-btn-delete-section" data-index="${sIdx}" type="button" aria-label="Hapus bagian"><i class="material-symbols-outlined">delete</i></button>` : ''}
            </div>
          </header>
          <div class="bu-section-questions" data-section-index="${sIdx}">
            ${sec.questions.length === 0
              ? `<div class="bu-questions-empty"><p>Belum ada soal. Klik "Soal" untuk menambah.</p></div>`
              : sec.questions.map((q, qIdx) => `
                <div class="bu-question-row" data-section="${sIdx}" data-question="${qIdx}" tabindex="0" role="button">
                  <span class="bu-question-num">${qIdx + 1}</span>
                  <span class="bu-question-type bu-q-type-${sec.type_question === 'PG' ? 'PG' : 'esai'}">${sec.type_question === 'PG' ? 'PG' : 'Esai'}</span>
                  <span class="bu-question-text">${this._esc((q.pertanyaan || '').replace(/<[^>]*>/g, '').slice(0, 80)) || 'Soal kosong'}</span>
                  <span class="bu-question-score">${q.skor || 0}p</span>
                  <div class="bu-question-actions">
                    <button class="bu-btn bu-btn-ghost bu-btn-sm bu-btn-edit-question" data-section="${sIdx}" data-question="${qIdx}" type="button" aria-label="Edit soal"><i class="material-symbols-outlined">edit</i></button>
                    <button class="bu-btn bu-btn-ghost bu-btn-sm bu-btn-delete-question" data-section="${sIdx}" data-question="${qIdx}" type="button" aria-label="Hapus soal"><i class="material-symbols-outlined">delete</i></button>
                  </div>
                </div>
              `).join('')
            }
          </div>
        </div>
      `).join('');

      // Wire section-type select
      this._list.querySelectorAll('.bu-section-type').forEach((sel) => {
        sel.addEventListener('change', (e) => {
          const idx = parseInt(e.target.dataset.index, 10);
          window.BuatUjian.updateSection(idx, { type_question: e.target.value });
        });
      });

      // Wire add-question buttons
      this._list.querySelectorAll('.bu-btn-add-question').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const sIdx = parseInt(btn.dataset.index, 10);
          const sec = window.BuatUjian.getState().sections[sIdx];
          if (!sec || !sec.type_question) return;
          window.SoalEditorModal.open({ mode: 'new', sectionIndex: sIdx, questionType: sec.type_question });
        });
      });

      // Wire delete-section buttons
      this._list.querySelectorAll('.bu-btn-delete-section').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const idx = parseInt(btn.dataset.index, 10);
          this._deleteSection(idx);
        });
      });

      // Wire question-row click → open editor
      this._list.querySelectorAll('.bu-question-row').forEach((row) => {
        row.addEventListener('click', (e) => {
          if (e.target.closest('.bu-btn-delete-question')) return;
          if (e.target.closest('.bu-btn-edit-question')) return;
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
      this._list.querySelectorAll('.bu-btn-edit-question').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const sIdx = parseInt(btn.dataset.section, 10);
          const qIdx = parseInt(btn.dataset.question, 10);
          window.SoalEditorModal.open({ mode: 'edit', sectionIndex: sIdx, questionIndex: qIdx });
        });
      });

      // Wire delete-question buttons
      this._list.querySelectorAll('.bu-btn-delete-question').forEach((btn) => {
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
        if (!confirm(`Hapus Bagian ${sIdx + 1} beserta semua soal?`)) return;
        window.BuatUjian.removeSection(sIdx);
        return;
      }
      window.notify.confirm({
        title: 'Hapus Bagian',
        message: `Yakin hapus Bagian ${sIdx + 1}? Semua soal di dalamnya akan dihapus.`,
        intent: 'danger',
        onYes: () => window.BuatUjian.removeSection(sIdx),
      });
    },

    _deleteQuestion(sIdx, qIdx) {
      if (!window.notify?.confirm) {
        if (!confirm(`Hapus soal #${qIdx + 1}?`)) return;
        window.BuatUjian.removeQuestion(sIdx, qIdx);
        return;
      }
      window.notify.confirm({
        title: 'Hapus Soal',
        message: `Yakin hapus soal #${qIdx + 1}?`,
        intent: 'danger',
        onYes: () => window.BuatUjian.removeQuestion(sIdx, qIdx),
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
