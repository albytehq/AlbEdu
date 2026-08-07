// soal-editor-modal.js — modal editor for a single question.
//
// v0.821.0: Phase 2 — image upload UI added. Admins can now attach images
// to questions via drag-and-drop. Magic Compress™ v2 compresses client-side,
// uploads to BackBlaze B2 via asset-upload Edge Function.
//
// Schema reminders:
//   - `pilihan` is an OBJECT {A,B,C,D}, not an array
//   - `jawaban_benar` is the letter 'A'/'B'/'C'/'D', not an index
//   - `media.gambar` is an array of { url, hash } objects

(function () {
  'use strict';

  const t = (key, vars, fallback) => fallback;

  const MAX_IMAGES_PER_QUESTION = 5;
  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB pre-compression
  const ACCEPTED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/avif'];

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
      this._uploading = false;
    },

    open({ mode, sectionIndex, questionIndex, questionType }) {
      this._mode = mode;
      this._sectionIndex = sectionIndex;
      this._questionIndex = questionIndex;

      if (mode === 'edit') {
        const state = window.CreateAssessment.getState();
        const sec = state.examData.sections[sectionIndex];
        if (!sec || !sec.questions[questionIndex]) {
          window.notify?.error(t('wizard.title_failed', null, 'Gagal'), t('wizard.question_not_found', null, 'Soal tidak ditemukan'));
          return;
        }
        this._draft = JSON.parse(JSON.stringify(sec.questions[questionIndex]));
        this._title.textContent = t('wizard.edit_question', { n: questionIndex + 1 }, `Edit Soal #${questionIndex + 1}`);
        this._subtitle.textContent = t('wizard.section_label', { n: sectionIndex + 1 }, `Bagian ${sectionIndex + 1}`);
      } else {
        const media = { video: { enabled: false, src: null }, gambar: [] };
        this._draft = questionType === 'PG'
          ? { idq: 0, pertanyaan: '', pilihan: { A: '', B: '', C: '', D: '' }, jawaban_benar: '', media: JSON.parse(JSON.stringify(media)) }
          : { idq: 0, pertanyaan: '', media: JSON.parse(JSON.stringify(media)) };
        this._title.textContent = t('wizard.add_question_title', null, 'Tambah Soal');
        this._subtitle.textContent = t('wizard.section_with_type', { n: sectionIndex + 1, type: questionType === 'PG' ? t('wizard.type_pg', null, 'Pilihan Ganda') : t('wizard.type_essay', null, 'Esai') }, `Bagian ${sectionIndex + 1} • ${questionType === 'PG' ? 'Pilihan Ganda' : 'Esai'}`);
      }

      // Ensure media.gambar is always an array
      if (!this._draft.media) this._draft.media = { video: { enabled: false, src: null }, gambar: [] };
      if (!Array.isArray(this._draft.media.gambar)) this._draft.media.gambar = [];

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
        this._uploading = false;
      }, 250);
    },

    _renderForm() {
      if (!this._draft) return;
      const isPG = !!this._draft.pilihan;
      const gambar = this._draft.media?.gambar || [];

      this._body.innerHTML = `
        <div class="albedu-soal-editor">
          <div class="albedu-soal-editor-section">
            <label class="albedu-soal-editor-label" for="q-pertanyaan">${t('create.question_label', null, 'Pertanyaan')} <span class="albedu-required">*</span></label>
            <textarea id="q-pertanyaan" class="albedu-textarea albedu-soal-textarea" placeholder="${t('create.question_placeholder', null, 'Tulis pertanyaan...')}">${this._esc(this._draft.pertanyaan || '')}</textarea>
            <span class="albedu-field-hint">${t('create.question_hint', null, 'Mendukung HTML sederhana. Min. 3 karakter setelah tag di-strip.')}</span>
          </div>

          ${isPG ? `
            <div class="albedu-soal-editor-section">
              <label class="albedu-soal-editor-label">${t('create.answer_options_label', null, 'Opsi Jawaban')} <span class="albedu-required">*</span></label>
              <p class="albedu-field-hint" style="margin-bottom:8px;">${t('create.answer_options_hint', null, 'Klik radio untuk menandai jawaban benar')}</p>
              <div class="albedu-soal-options">
                ${['A', 'B', 'C', 'D'].map((letter) => `
                  <div class="albedu-soal-option ${this._draft.jawaban_benar === letter ? 'albedu-option-correct' : ''}" data-letter="${letter}">
                    <input type="radio" name="jawaban-benar" value="${letter}" ${this._draft.jawaban_benar === letter ? 'checked' : ''} aria-label="${t('create.correct_answer_aria', { letter }, 'Jawaban benar: ' + letter)}">
                    <span class="albedu-soal-option-letter">${letter}</span>
                    <input type="text" class="albedu-input albedu-soal-option-input" data-letter="${letter}" value="${this._esc(this._draft.pilihan[letter] || '')}" placeholder="${t('create.option_placeholder', { letter }, 'Opsi ' + letter)}">
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}

          <div class="albedu-soal-editor-section">
            <label class="albedu-soal-editor-label">${t('create.media_label', null, 'Media (opsional)')}</label>

            <!-- Image upload zone -->
            <div class="albedu-image-upload-zone" id="q-image-dropzone">
              <input type="file" id="q-image-input" accept="image/*" multiple hidden>
              <div class="albedu-image-upload-prompt">
                <span data-albedu-icon="add_photo_alternate" class="albedu-icon--24"></span>
                <span>${gambar.length >= MAX_IMAGES_PER_QUESTION
                  ? t('create.image_max_reached', null, 'Maksimal ' + MAX_IMAGES_PER_QUESTION + ' gambar per soal')
                  : t('create.image_drop_hint', null, 'Klik atau drag gambar ke sini')}</span>
                <span class="albedu-field-hint">${t('create.image_formats', null, 'JPG/PNG/WebP/GIF · maks 10 MB · auto-compress')}</span>
              </div>
            </div>

            <!-- Image previews -->
            <div class="albedu-image-previews" id="q-image-previews">
              ${gambar.map((img, i) => this._renderPreview(img, i)).join('')}
            </div>

            <!-- Upload progress -->
            <div class="albedu-image-upload-progress" id="q-upload-progress" hidden>
              <div class="albedu-image-upload-bar"></div>
              <span class="albedu-image-upload-text">${t('create.compressing', null, 'Mengompres...')}</span>
            </div>
          </div>

          <div class="albedu-soal-editor-section">
            <label class="albedu-toggle albedu-toggle-sm">
              <input type="checkbox" id="q-video-enabled" ${this._draft.media?.video?.enabled ? 'checked' : ''}>
              <span class="albedu-toggle-track"></span>
              <span class="albedu-toggle-label">${t('create.include_youtube', null, 'Sertakan video YouTube')}</span>
            </label>
            <div id="q-video-url-field" ${!this._draft.media?.video?.enabled ? 'hidden' : ''}>
              <input type="url" id="q-video-url" class="albedu-input albedu-field-input" value="${this._esc(this._draft.media?.video?.src || '')}" placeholder="https://youtube.com/watch?v=...">
              <span class="albedu-field-hint">${t('create.video_url_hint', null, 'URL harus diawali http:// atau https://')}</span>
            </div>
          </div>
        </div>
      `;

      // Wire pertanyaan
      document.getElementById('q-pertanyaan').addEventListener('input', (e) => {
        this._draft.pertanyaan = e.target.value;
      });

      if (isPG) {
        this._body.querySelectorAll('input[name="jawaban-benar"]').forEach((radio) => {
          radio.addEventListener('change', (e) => {
            this._draft.jawaban_benar = e.target.value;
            this._renderForm();
          });
        });
        this._body.querySelectorAll('.albedu-soal-option-input').forEach((input) => {
          input.addEventListener('input', (e) => {
            this._draft.pilihan[e.target.dataset.letter] = e.target.value;
          });
        });
      }

      // Wire image upload
      this._wireImageUpload();

      // Wire video
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

    _renderPreview(img, index) {
      const url = typeof img === 'object' ? img.url : img;
      const hash = typeof img === 'object' ? img.hash : '';
      const sizeLabel = img.compressed_size ? this._formatSize(img.compressed_size) : '';
      return `
        <div class="albedu-image-preview" data-index="${index}">
          <img src="${this._esc(url)}" alt="Gambar ${index + 1}" loading="lazy">
          ${sizeLabel ? `<span class="albedu-image-preview-size">${sizeLabel}</span>` : ''}
          <button type="button" class="albedu-image-preview-remove" data-index="${index}" aria-label="Hapus gambar">
            <span data-albedu-icon="close"></span>
          </button>
        </div>
      `;
    },

    _wireImageUpload() {
      const dropzone = document.getElementById('q-image-dropzone');
      const fileInput = document.getElementById('q-image-input');

      if (!dropzone || !fileInput) return;

      // Click to open file picker
      dropzone.addEventListener('click', (e) => {
        if (e.target.closest('.albedu-image-preview-remove')) return;
        if (this._draft.media.gambar.length >= MAX_IMAGES_PER_QUESTION) return;
        fileInput.click();
      });

      // File selected via picker
      fileInput.addEventListener('change', (e) => {
        const files = Array.from(e.target.files);
        this._handleFiles(files);
        fileInput.value = ''; // reset so same file can be re-selected
      });

      // Drag and drop
      dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('albedu-dropzone-active');
      });
      dropzone.addEventListener('dragleave', () => {
        dropzone.classList.remove('albedu-dropzone-active');
      });
      dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('albedu-dropzone-active');
        const files = Array.from(e.dataTransfer.files);
        this._handleFiles(files);
      });

      // Remove image buttons (event delegation)
      const previewsContainer = document.getElementById('q-image-previews');
      previewsContainer.addEventListener('click', (e) => {
        const removeBtn = e.target.closest('.albedu-image-preview-remove');
        if (!removeBtn) return;
        e.preventDefault();
        e.stopPropagation();
        const idx = parseInt(removeBtn.dataset.index, 10);
        this._removeImage(idx);
      });
    },

    async _handleFiles(files) {
      if (this._uploading) return;

      const imageFiles = files.filter((f) => f.type.startsWith('image/'));
      if (imageFiles.length === 0) {
        window.notify?.warning('Format tidak didukung', 'Pilih file gambar (JPG, PNG, WebP, GIF, BMP, AVIF).');
        return;
      }

      const remainingSlots = MAX_IMAGES_PER_QUESTION - this._draft.media.gambar.length;
      if (remainingSlots <= 0) {
        window.notify?.warning('Batas tercapai', `Maksimal ${MAX_IMAGES_PER_QUESTION} gambar per soal.`);
        return;
      }

      const filesToUpload = imageFiles.slice(0, remainingSlots);
      if (imageFiles.length > remainingSlots) {
        window.notify?.info('Beberapa gambar dilewati', `Hanya ${remainingSlots} dari ${imageFiles.length} gambar yang ditambahkan (batas ${MAX_IMAGES_PER_QUESTION}).`);
      }

      this._uploading = true;
      this._saveBtn.disabled = true;
      this._showProgress('Mengompres...');

      for (const file of filesToUpload) {
        try {
          await this._compressAndUpload(file);
        } catch (err) {
          console.error('[SoalEditorModal] Upload failed:', err);
          window.notify?.error('Upload gagal', err.message || 'Gagal mengunggah gambar. Coba lagi.');
        }
      }

      this._uploading = false;
      this._saveBtn.disabled = false;
      this._hideProgress();
      this._renderForm(); // re-render to show new previews
    },

    async _compressAndUpload(file) {
      console.log('[Upload DEBUG] Step 0: _compressAndUpload started', {
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type,
      });

      // Validate size
      if (file.size > MAX_FILE_SIZE) {
        throw new Error(`File terlalu besar (${this._formatSize(file.size)}). Maks ${this._formatSize(MAX_FILE_SIZE)}.`);
      }

      this._showProgress('Mengompres gambar...');

      // ── 1. Magic Compress™ via Web Worker ──
      console.log('[Upload DEBUG] Step 1: Loading ImageCompress module...');
      if (!window.ImageCompress) {
        const basePath = window.Auth?.getBasePath?.() || '/';
        console.log('[Upload DEBUG] Step 1a: Lazy-loading from', basePath + 'src/utils/image-compress.js');
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = basePath + 'src/utils/image-compress.js';
          s.defer = true;
          s.onload = () => { console.log('[Upload DEBUG] Step 1b: image-compress.js loaded'); resolve(); };
          s.onerror = () => reject(new Error('Gagal memuat modul kompresi.'));
          document.head.appendChild(s);
        });
      }
      console.log('[Upload DEBUG] Step 1c: ImageCompress ready:', !!window.ImageCompress);

      console.log('[Upload DEBUG] Step 2: Starting compression (Web Worker)...');
      let compressed;
      try {
        compressed = await window.ImageCompress.compressInWorker(file, {
          maxWidth: 1280,
          maxHeight: 720,
          targetMaxBytes: 300 * 1024,
          targetMinBytes: 80 * 1024,
        });
        console.log('[Upload DEBUG] Step 2a: Worker compression SUCCESS', {
          originalSize: compressed.originalSize,
          compressedSize: compressed.compressedSize,
          qualityUsed: compressed.qualityUsed,
          blobSize: compressed.blob?.size,
          blobType: compressed.blob?.type,
        });
      } catch (err) {
        console.warn('[Upload DEBUG] Step 2b: Worker compress failed, trying main thread:', err.message);
        compressed = await window.ImageCompress.magicCompress(file, {
          maxWidth: 1280,
          maxHeight: 720,
          targetMaxBytes: 300 * 1024,
          targetMinBytes: 80 * 1024,
        });
        console.log('[Upload DEBUG] Step 2c: Main thread compression SUCCESS', {
          originalSize: compressed.originalSize,
          compressedSize: compressed.compressedSize,
          blobSize: compressed.blob?.size,
        });
      }

      // Defense in depth
      if (compressed.compressedSize > 500 * 1024) {
        throw new Error('Gambar terlalu besar setelah kompresi. Coba gambar lain.');
      }

      this._showProgress('Mengunggah...');
      console.log('[Upload DEBUG] Step 3: Preparing upload to Edge Function...');

      // ── 2. Upload to asset-upload Edge Function ──
      const supabase = window.AlbEdu?.supabase?.client;
      if (!supabase) {
        throw new Error('Koneksi Supabase tidak tersedia. Refresh halaman dan coba lagi.');
      }

      // Get the user's access token for auth
      console.log('[Upload DEBUG] Step 3a: Getting session token...');
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) {
        throw new Error('Sesi login tidak ditemukan. Silakan login ulang.');
      }
      console.log('[Upload DEBUG] Step 3b: Token acquired, length:', accessToken.length);

      const formData = new FormData();
      formData.append('file', compressed.blob, `image-${Date.now()}.jpg`);
      formData.append('original_size', String(compressed.originalSize));
      formData.append('quality_used', String(compressed.qualityUsed || ''));
      console.log('[Upload DEBUG] Step 3c: FormData built, entries:', {
        file: compressed.blob?.size + ' bytes',
        original_size: compressed.originalSize,
        quality_used: compressed.qualityUsed,
      });

      // Build EF URL
      const supabaseUrl = supabase.supabaseUrl ||
                          window.AlbEdu?.supabase?._config?.url ||
                          '';
      if (!supabaseUrl) {
        throw new Error('URL Supabase tidak ditemukan. Refresh halaman.');
      }

      const efUrl = `${supabaseUrl}/functions/v1/asset-upload`;
      console.log('[Upload DEBUG] Step 4: Sending fetch to', efUrl);

      // CRITICAL: Supabase gateway requires BOTH 'apikey' AND 'Authorization' headers
      // when verify_jwt=true. Without apikey, the gateway blocks the request before
      // it reaches the Edge Function — the fetch hangs indefinitely.
      // The apikey is the Supabase anon key (public, safe to expose).
      const anonKey = supabase.supabaseKey ||
                      supabase?._config?.apiKey ||
                      window.AlbEdu?.supabase?._config?.anonKey ||
                      '';
      if (!anonKey) {
        throw new Error('Supabase anon key tidak ditemukan. Refresh halaman.');
      }
      console.log('[Upload DEBUG] Step 3d: anonKey acquired, length:', anonKey.length);

      const res = await fetch(efUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'apikey': anonKey,
        },
        body: formData,
      });

      console.log('[Upload DEBUG] Step 4a: fetch() returned', {
        status: res.status,
        statusText: res.statusText,
        ok: res.ok,
        headers: {
          'content-type': res.headers.get('content-type'),
          'access-control-allow-origin': res.headers.get('access-control-allow-origin'),
        },
      });

      if (!res.ok) {
        let msg = `Upload gagal (HTTP ${res.status})`;
        try {
          const errBody = await res.json();
          console.error('[Upload DEBUG] Step 4b: Error response body:', errBody);
          if (errBody?.message) msg = errBody.message;
          else if (errBody?.error) msg = errBody.error;
        } catch {}
        throw new Error(msg);
      }

      console.log('[Upload DEBUG] Step 5: Parsing response JSON...');
      const data = await res.json();
      console.log('[Upload DEBUG] Step 5a: Raw response:', data);

      // Handle Supabase EF response format: { data: {...} } or { ... }
      const result = data?.data || data;
      console.log('[Upload DEBUG] Step 5b: Extracted result:', result);
      if (!result?.hash || !result?.cdn_url) {
        throw new Error('Response tidak valid dari server (hash/url hilang).');
      }
      console.log('[Upload DEBUG] Step 6: SUCCESS — hash:', result.hash.slice(0, 16) + '...', 'url:', result.cdn_url);

      // ── 3. Add to draft ──
      this._draft.media.gambar.push({
        url: result.cdn_url,
        hash: result.hash,
        original_size: compressed.originalSize,
        compressed_size: compressed.compressedSize,
      });

      const ratio = Math.round((1 - compressed.compressedSize / compressed.originalSize) * 100);
      console.info('[SoalEditorModal] Image uploaded:', {
        hash: result.hash,
        originalSize: compressed.originalSize,
        compressedSize: compressed.compressedSize,
        ratio: ratio + '% smaller',
        dedup: result.dedup || false,
      });
    },

    _removeImage(index) {
      if (index < 0 || index >= this._draft.media.gambar.length) return;
      const removed = this._draft.media.gambar.splice(index, 1)[0];

      // Release the image (decrement ref_count) via ImageCleanup
      if (removed?.hash && window.ImageCleanup?.deleteImage) {
        window.ImageCleanup.deleteImage(removed).catch((err) => {
          console.warn('[SoalEditorModal] Failed to release image:', err?.message);
        });
      }

      this._renderForm();
    },

    _showProgress(text) {
      const el = document.getElementById('q-upload-progress');
      if (!el) return;
      el.hidden = false;
      const textEl = el.querySelector('.albedu-image-upload-text');
      if (textEl) textEl.textContent = text;
    },

    _hideProgress() {
      const el = document.getElementById('q-upload-progress');
      if (el) el.hidden = true;
    },

    _formatSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    },

    _save() {
      if (!this._draft) return;
      if (this._uploading) {
        window.notify?.warning('Tunggu', 'Sedang mengunggah gambar. Tunggu sebentar.');
        return;
      }

      // Validate pertanyaan
      const cleanQ = (this._draft.pertanyaan || '').replace(/<[^>]*>/g, '').trim();
      if (cleanQ.length < 3) {
        window.notify?.error(t('wizard.validation_failed', null, 'Validasi gagal'), t('wizard.question_too_short', null, 'Pertanyaan minimal 3 karakter'));
        return;
      }

      if (this._draft.pilihan) {
        if (!this._draft.jawaban_benar) {
          window.notify?.error(t('wizard.validation_failed', null, 'Validasi gagal'), t('wizard.pick_correct_answer', null, 'Pilih jawaban benar'));
          return;
        }
        const missing = ['A', 'B', 'C', 'D'].find((k) => !this._draft.pilihan[k]?.trim());
        if (missing) {
          window.notify?.error(t('wizard.validation_failed', null, 'Validasi gagal'), t('wizard.option_required', { n: missing }, `Opsi ${missing} harus diisi`));
          return;
        }
      }

      // Validate video URL if enabled
      if (this._draft.media?.video?.enabled) {
        const src = this._draft.media.video.src?.trim() || '';
        if (src && !/^https?:\/\//i.test(src)) {
          window.notify?.error(t('wizard.validation_failed', null, 'Validasi gagal'), t('wizard.invalid_video_url', null, 'URL video harus diawali http:// atau https://'));
          return;
        }
      }

      if (this._mode === 'new') {
        const type = this._draft.pilihan ? 'PG' : 'esai';
        const added = window.CreateAssessment.addQuestion(this._sectionIndex, type);
        if (!added) {
          window.notify?.error(t('wizard.title_failed', null, 'Gagal'), t('wizard.cannot_add_question', null, 'Tidak bisa menambah soal (limit tercapai?)'));
          return;
        }
        const qIdx = window.CreateAssessment.getState().examData.sections[this._sectionIndex].questions.length - 1;
        const newIdq = added.idq;
        const draftCopy = { ...this._draft, idq: newIdq };
        window.CreateAssessment.updateQuestion(this._sectionIndex, qIdx, draftCopy);
      } else {
        window.CreateAssessment.updateQuestion(this._sectionIndex, this._questionIndex, this._draft);
      }

      window.notify?.success(
        t('wizard.saved_title', null, 'Tersimpan'),
        t('wizard.saved_msg', { action: this._mode === 'new' ? t('wizard.saved_added', null, 'ditambahkan') : t('wizard.saved_updated', null, 'diperbarui') }, `Soal ${this._mode === 'new' ? 'ditambahkan' : 'diperbarui'}`),
        2000
      );
      this.close();
    },

    _esc(str) {
      return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    },
  };

  window.SoalEditorModal = SoalEditorModal;
})();
