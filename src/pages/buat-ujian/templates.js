// =============================================================================
// templates.js — Question templates for Buat Ujian v2
// Schema-accurate: pilihan is {A,B,C,D} object, jawaban_benar is letter.
// Loaded as a classic <script defer> — exposes window.TemplatePicker.
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

  // ── Question templates (schema-accurate) ──
  // Each template knows its sectionType so the picker can route it to the
  // correct section. create() returns a fresh question object matching the
  // verified examData schema (state.js addQuestion).
  const TEMPLATES = [
    {
      id: 'pg-4',
      name: 'PG Standar (4 Opsi)',
      desc: 'Pilihan ganda A/B/C/D dengan jawaban benar',
      icon: 'format_list_bulleted',
      sectionType: 'PG',
      create() {
        return {
          idq: 0,
          pertanyaan: '',
          pilihan: { A: '', B: '', C: '', D: '' },
          jawaban_benar: '',
          media: { video: { enabled: false, src: null }, gambar: [] },
        };
      },
    },
    {
      id: 'esai',
      name: 'Esai',
      desc: 'Soal uraian tanpa opsi jawaban',
      icon: 'edit_note',
      sectionType: 'esai',
      create() {
        return {
          idq: 0,
          pertanyaan: '',
          media: { video: { enabled: false, src: null }, gambar: [] },
        };
      },
    },
  ];

  // ── TemplatePicker — modal picker ──
  // Wired to the "Dari Template" button in Card 2. Opens an overlay,
  // lets user pick a template, then routes to SoalEditorModal with the
  // template's create() result pre-filled as the draft.
  const TemplatePicker = {
    init() {
      this._overlay = document.getElementById('question-template-overlay');
      this._body = document.getElementById('question-template-body');
      this._close = document.getElementById('question-template-close');

      if (!this._overlay) {
        console.warn('[TemplatePicker] overlay element missing — page not on buat-ujian?');
        return;
      }

      this._close.addEventListener('click', () => this.close());
      this._overlay.addEventListener('click', (e) => {
        if (e.target === this._overlay) this.close();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !this._overlay.hidden) this.close();
      });
    },

    open() {
      if (!this._overlay) return;
      this._body.innerHTML = `
        <div class="albedu-template-grid">
          ${TEMPLATES.map((t) => `
            <button class="albedu-template-card" data-id="${t.id}" type="button">
              <div class="albedu-template-icon"><span data-albedu-icon="${t.icon}"></span></div>
              <div class="albedu-template-info">
                <div class="albedu-template-name">${t.name}</div>
                <div class="albedu-template-desc">${t.desc}</div>
              </div>
              <span class="albedu-template-arrow" data-albedu-icon="arrow_forward"></span>
            </button>
          `).join('')}
        </div>
        <p class="albedu-template-hint">Template akan menambah soal ke bagian dengan tipe yang cocok. Jika belum ada, bagian baru akan dibuatkan otomatis.</p>
      `;

      this._body.querySelectorAll('.albedu-template-card').forEach((card) => {
        card.addEventListener('click', () => {
          const tpl = TEMPLATES.find((t) => t.id === card.dataset.id);
          if (!tpl) return;
          this._applyTemplate(tpl);
        });
      });

      this._overlay.hidden = false;
      requestAnimationFrame(() => this._overlay.classList.add('albedu-modal-visible'));
    },

    close() {
      if (!this._overlay) return;
      this._overlay.classList.remove('albedu-modal-visible');
      setTimeout(() => { this._overlay.hidden = true; }, 250);
    },

    _applyTemplate(tpl) {
      const state = window.CreateAssessment.getState();
      let targetSection = state.examData.sections.findIndex((s) => s.type_question === tpl.sectionType);

      if (targetSection === -1) {
        // No matching section — create one if possible
        if (state.examData.sections.length < 2) {
          const sec = window.CreateAssessment.addSection();
          if (sec) {
            window.CreateAssessment.updateSection(state.examData.sections.length - 1, { type_question: tpl.sectionType });
            targetSection = state.examData.sections.length - 1;
          }
        } else {
          window.notify?.error(
            t('wizard.cannot_use_template', null, 'Tidak bisa'),
            t('wizard.cannot_use_template_msg', { type: tpl.sectionType }, `Tidak ada bagian dengan tipe ${tpl.sectionType}. Ubah tipe bagian existing.`)
          );
          return;
        }
      }

      if (targetSection === -1) {
        window.notify?.error(t('wizard.title_failed', null, 'Gagal'), t('wizard.no_section_for_template', null, 'Tidak ada bagian yang bisa dipakai untuk template ini'));
        return;
      }

      // Open editor modal, then pre-fill draft with template
      window.SoalEditorModal.open({
        mode: 'new',
        sectionIndex: targetSection,
        questionType: tpl.sectionType,
      });

      setTimeout(() => {
        if (!window.SoalEditorModal._draft) return;
        const fresh = tpl.create();
        // Preserve any idq assigned by open()
        fresh.idq = window.SoalEditorModal._draft.idq || 0;
        window.SoalEditorModal._draft = fresh;
        window.SoalEditorModal._renderForm();
      }, 60);

      this.close();
    },
  };

  window.TemplatePicker = TemplatePicker;
  // Also expose TEMPLATES for debugging / external use
  window.BU_TEMPLATES = TEMPLATES;
})();
