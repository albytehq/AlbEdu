// =============================================================================
// soal-editor-modal.js — Modal editor for single question
// =============================================================================
// Schema-accurate:
//   - pilihan is OBJECT {A,B,C,D}, NOT array
//   - jawaban_benar is letter 'A'/'B'/'C'/'D', NOT index
//   - media { video: {enabled, src}, gambar: [] } — gambar not editable here
//     in v2.2.0 (placeholder for future image upload integration)
// Loaded as classic <script defer>. Exposes window.SoalEditorModal.
// =============================================================================

(function () {
  'use strict';

  const SoalEditorModal = {
    init() {
      this._overlay = document.getElementById('question-modal-overlay');
      this._title = document.getElementById('question-modal-title');
      this._subtitle = document.getElementById('question-modal-subtitle');
      this._body = document.getElementById('question-modal-body');
      this._closeBtn = document.getElementById('question-modal-close');
      this._cancelBtn = document.getElementById('question-modal-cancel');
      this._saveBtn = document.getElementById('question-modal-save');

      if (!this._overlay) {
        console.warn('[SoalEditorModal] overlay element missing');
        return;
      }

      this._closeBtn.addEventListener('click', () => this.close());
      this._cancelBtn.addEventListener('click', () => this.close());
      this._overlay.addEventListener('click', (e) => {
        if (e.target === this._overlay) this.close();
      });
      this._saveBtn.addEventListener('click', () => this._save());
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !this._overlay.hidden) this.close();
      });

      this._mode = null;
      this._sectionIndex = null;
      this._questionIndex = null;
      this._draft = null;
    },

    open({ mode, sectionIndex, questionIndex, questionType }) {
      this._mode = mode;
      this._sectionIndex = sectionIndex;
      this._questionIndex = questionIndex;

      if (mode === 'edit') {
        const state = window.CreateAssessment.getState();
        const sec = state.examData.sections[sectionIndex];
        if (!sec || !sec.questions[questionIndex]) {
          window.notify?.error('Gagal', 'Soal tidak ditemukan');
          return;
        }
        this._draft = JSON.parse(JSON.stringify(sec.questions[questionIndex]));
        this._title.textContent = `Edit Soal #${questionIndex + 1}`;
        this._subtitle.textContent = `Bagian ${sectionIndex + 1}`;
      } else {
        // new question
        const media = { video: { enabled: false, src: null }, gambar: [] };
        this._draft = questionType === 'PG'
          ? { idq: 0, pertanyaan: '', pilihan: { A: '', B: '', C: '', D: '' }, jawaban_benar: '', media: JSON.parse(JSON.stringify(media)) }
          : { idq: 0, pertanyaan: '', media: JSON.parse(JSON.stringify(media)) };
        this._title.textContent = 'Tambah Soal';
        this._subtitle.textContent = `Bagian ${sectionIndex + 1} • ${questionType === 'PG' ? 'Pilihan Ganda' : 'Esai'}`;
      }

      this._renderForm();
      this._overlay.hidden = false;
      requestAnimationFrame(() => this._overlay.classList.add('albedu-modal-visible'));
      setTimeout(() => {
        const firstInput = this._body.querySelector('textarea, input, select');
        if (firstInput) firstInput.focus();
      }, 100);
    },

    close() {
      this._overlay.classList.remove('albedu-modal-visible');
      setTimeout(() => {
        this._overlay.hidden = true;
        this._body.innerHTML = '';
        this._draft = null;
      }, 250);
    },

    _renderForm() {
      if (!this._draft) return;
      const isPG = !!this._draft.pilihan;
      this._body.innerHTML = `
        <div class="albedu-soal-editor">
          <div class="albedu-soal-editor-section">
            <label class="albedu-soal-editor-label" for="q-pertanyaan">Pertanyaan <span class="albedu-required">*</span></label>
            <textarea id="q-pertanyaan" class="albedu-soal-textarea" placeholder="Tulis pertanyaan...">${this._esc(this._draft.pertanyaan || '')}</textarea>
            <span class="albedu-field-hint">Mendukung HTML sederhana. Min. 3 karakter setelah tag di-strip.</span>
          </div>

          ${isPG ? `
            <div class="albedu-soal-editor-section">
              <label class="albedu-soal-editor-label">Opsi Jawaban <span class="albedu-required">*</span></label>
              <p class="albedu-field-hint" style="margin-bottom:8px;">Klik radio untuk menandai jawaban benar</p>
              <div class="albedu-soal-options">
                ${['A', 'B', 'C', 'D'].map((letter) => `
                  <div class="albedu-soal-option ${this._draft.jawaban_benar === letter ? 'albedu-option-correct' : ''}" data-letter="${letter}">
                    <input type="radio" name="jawaban-benar" value="${letter}" ${this._draft.jawaban_benar === letter ? 'checked' : ''} aria-label="Jawaban benar: ${letter}">
                    <span class="albedu-soal-option-letter">${letter}</span>
                    <input type="text" class="albedu-soal-option-input" data-letter="${letter}" value="${this._esc(this._draft.pilihan[letter] || '')}" placeholder="Opsi ${letter}">
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}

          <div class="albedu-soal-editor-section">
            <label class="albedu-soal-editor-label">Media (opsional)</label>
            <label class="albedu-toggle albedu-toggle-sm">
              <input type="checkbox" id="q-video-enabled" ${this._draft.media?.video?.enabled ? 'checked' : ''}>
              <span class="albedu-toggle-track"></span>
              <span class="albedu-toggle-label">Sertakan video YouTube</span>
            </label>
            <div id="q-video-url-field" ${!this._draft.media?.video?.enabled ? 'hidden' : ''}>
              <input type="url" id="q-video-url" class="albedu-field-input" value="${this._esc(this._draft.media?.video?.src || '')}" placeholder="https://youtube.com/watch?v=...">
              <span class="albedu-field-hint">URL harus diawali http:// atau https://</span>
            </div>
          </div>
        </div>
      `;

      // Wire pertanyaan
      document.getElementById('q-pertanyaan').addEventListener('input', (e) => {
        this._draft.pertanyaan = e.target.value;
      });

      // Wire options (PG only)
      if (isPG) {
        this._body.querySelectorAll('input[name="jawaban-benar"]').forEach((radio) => {
          radio.addEventListener('change', (e) => {
            this._draft.jawaban_benar = e.target.value;
            // Re-render to update .albedu-option-correct highlight
            this._renderForm();
          });
        });
        this._body.querySelectorAll('.albedu-soal-option-input').forEach((input) => {
          input.addEventListener('input', (e) => {
            this._draft.pilihan[e.target.dataset.letter] = e.target.value;
          });
        });
      }

      // Wire video toggle + url
      const videoEnabled = document.getElementById('q-video-enabled');
      const videoUrlField = document.getElementById('q-video-url-field');
      const videoUrl = document.getElementById('q-video-url');
      videoEnabled.addEventListener('change', (e) => {
        this._draft.media.video.enabled = e.target.checked;
        videoUrlField.hidden = !e.target.checked;
      });
      videoUrl.addEventListener('input', (e) => {
        this._draft.media.video.src = e.target.value;
      });
    },

    _save() {
      if (!this._draft) return;

      // Validate pertanyaan (HTML-stripped min 3 chars)
      const cleanQ = (this._draft.pertanyaan || '').replace(/<[^>]*>/g, '').trim();
      if (cleanQ.length < 3) {
        window.notify?.error('Validasi gagal', 'Pertanyaan minimal 3 karakter');
        return;
      }

      // PG-specific validation
      if (this._draft.pilihan) {
        if (!this._draft.jawaban_benar) {
          window.notify?.error('Validasi gagal', 'Pilih jawaban benar');
          return;
        }
        const missing = ['A', 'B', 'C', 'D'].find((k) => !this._draft.pilihan[k]?.trim());
        if (missing) {
          window.notify?.error('Validasi gagal', `Opsi ${missing} harus diisi`);
          return;
        }
      }

      // Validate video URL if enabled
      if (this._draft.media?.video?.enabled) {
        const src = this._draft.media.video.src?.trim() || '';
        if (src && !/^https?:\/\//i.test(src)) {
          window.notify?.error('Validasi gagal', 'URL video harus diawali http:// atau https://');
          return;
        }
      }

      if (this._mode === 'new') {
        // Add the question first to get the correct idq, then overwrite with draft values
        const type = this._draft.pilihan ? 'PG' : 'esai';
        const added = window.CreateAssessment.addQuestion(this._sectionIndex, type);
        if (!added) {
          window.notify?.error('Gagal', 'Tidak bisa menambah soal (limit tercapai?)');
          return;
        }
        const qIdx = window.CreateAssessment.getState().examData.sections[this._sectionIndex].questions.length - 1;
        // Preserve assigned idq, take everything else from draft
        const newIdq = added.idq;
        const draftCopy = { ...this._draft, idq: newIdq };
        window.CreateAssessment.updateQuestion(this._sectionIndex, qIdx, draftCopy);
      } else {
        window.CreateAssessment.updateQuestion(this._sectionIndex, this._questionIndex, this._draft);
      }

      window.notify?.success('Tersimpan', `Soal ${this._mode === 'new' ? 'ditambahkan' : 'diperbarui'}`, 2000);
      this.close();
    },

    _esc(str) {
      return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },
  };

  window.SoalEditorModal = SoalEditorModal;
})();
