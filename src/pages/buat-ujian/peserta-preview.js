// peserta-preview.js — Preview assessment EXACTLY like peserta will see it.
// UI-only: no auth, no submit, no timer logic. Renders from CreateAssessment state.

(function () {
  'use strict';

  const Preview = {
    _overlay: null,
    _activeSection: 0,

    init() {
      // Create overlay element (hidden by default)
      this._overlay = document.createElement('div');
      this._overlay.id = 'peserta-preview-overlay';
      this._overlay.className = 'pp-overlay';
      this._overlay.hidden = true;
      this._overlay.innerHTML = `
        <div class="pp-backdrop" data-pp-close></div>
        <div class="pp-modal">
          <div class="pp-bar">
            <div class="pp-bar__left">
              <span class="pp-bar__badge" data-albedu-icon="visibility"></span>
              <span class="pp-bar__title">Preview Peserta</span>
              <span class="pp-bar__hint">Tampilan ini adalah apa yang peserta akan lihat</span>
            </div>
            <button class="pp-close" data-pp-close type="button" aria-label="Tutup preview">
              <span data-albedu-icon="close"></span>
            </button>
          </div>
          <div class="pp-content" id="pp-content"></div>
        </div>
      `;
      document.body.appendChild(this._overlay);

      // Wire close
      this._overlay.querySelectorAll('[data-pp-close]').forEach(el => {
        el.addEventListener('click', () => this.close());
      });

      // ESC to close
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !this._overlay.hidden) this.close();
      });
    },

    open() {
      const state = window.CreateAssessment?.getState?.();
      if (!state?.examData) {
        window.notify?.warning('Belum ada data', 'Tambahkan minimal 1 soal sebelum preview.', 3000);
        return;
      }

      const sections = state.examData.sections || [];
      const hasQuestions = sections.some(s => s.questions && s.questions.length > 0);
      if (!hasQuestions) {
        window.notify?.warning('Belum ada soal', 'Tambahkan minimal 1 soal sebelum preview.', 3000);
        return;
      }

      this._activeSection = 0;
      this._render(state.examData);

      this._overlay.hidden = false;
      document.body.style.overflow = 'hidden';
    },

    close() {
      this._overlay.hidden = true;
      document.body.style.overflow = '';
    },

    _render(examData) {
      const content = document.getElementById('pp-content');
      if (!content) return;

      const sections = examData.sections || [];
      const title = examData.title || 'Asesmen Tanpa Judul';
      const subject = examData.subject || '';
      const duration = examData.duration_minutes || 60;
      const identityMode = examData.identity_mode || 'manual';
      const identityConfig = examData.identity_config || {};
      const noteEnabled = examData.note_enabled;
      const noteText = examData.note_text;

      // Build identity form preview
      let identityHTML = '';
      if (identityMode === 'manual') {
        const fields = identityConfig.fields || [{ id: 'field_nama', type: 'text', label: 'Nama Lengkap', required: true, max_length: 60 }];
        identityHTML = fields.map(f => `
          <div class="pp-field">
            <label class="pp-field__label">${this._esc(f.label || f.id)}${f.required ? ' <span class="pp-required">*</span>' : ''}</label>
            ${f.type === 'select'
              ? `<div class="pp-select">${(f.options || []).map(o => `<div class="pp-select__opt">${this._esc(o)}</div>`).join('')}</div>`
              : `<div class="pp-input-fake">${f.placeholder || f.type === 'number' ? '0' : 'Ketik di sini...'}</div>`
            }
          </div>
        `).join('');
      } else if (identityMode === 'daftar') {
        const tabs = identityConfig.tabs || [];
        identityHTML = `
          <div class="pp-field">
            <label class="pp-field__label">Pilih Tab <span class="pp-required">*</span></label>
            <div class="pp-select"><div class="pp-select__opt">${this._esc(identityConfig.daftar_label || 'Pilih Tab')}</div></div>
          </div>
          <div class="pp-field">
            <label class="pp-field__label">Pilih Nama <span class="pp-required">*</span></label>
            <div class="pp-select"><div class="pp-select__opt">Pilih Nama...</div></div>
          </div>
        `;
      }

      // Build note block
      let noteHTML = '';
      if (noteEnabled && noteText) {
        noteHTML = `<div class="id-note pp-note">
          <span class="id-note__icon"><span data-albedu-icon="info"></span></span>
          <div class="id-note__body">${this._sanitize(noteText)}</div>
        </div>`;
      }

      // Build chips
      const chips = [
        `<span class="id-chip"><span data-albedu-icon="schedule"></span> ${duration} menit</span>`,
        identityMode === 'daftar'
          ? `<span class="id-chip"><span data-albedu-icon="format_list_bulleted"></span> ${this._esc(identityConfig.daftar_label || 'Daftar Nama')}</span>`
          : `<span class="id-chip"><span data-albedu-icon="keyboard"></span> Form Manual</span>`,
      ].join('');

      // Build section tabs
      const tabsHTML = sections.map((s, i) => `
        <button class="ex-section-tab ${i === this._activeSection ? 'active' : ''}" data-pp-tab="${i}" type="button">
          ${this._esc(s.name || `Bagian ${i + 1}`)}
        </button>
      `).join('');

      // Build questions for active section
      const activeSec = sections[this._activeSection] || sections[0];
      const questionsHTML = (activeSec?.questions || []).map((q, i) => this._renderQuestion(q, i, activeSec)).join('');

      // Total questions + answered count (mock: 0 answered)
      const totalQ = sections.reduce((sum, s) => sum + (s.questions?.length || 0), 0);

      // Build full preview HTML — mirrors take.html structure EXACTLY
      content.innerHTML = `
        <!-- IDENTITY PHASE PREVIEW — mirrors take.html <main id="identity-phase"> -->
        <main class="id-wrap" id="pp-identity" aria-labelledby="pp-identity-title">
          <div class="id-card">
            <header class="id-header">
              <div class="id-meta">${this._esc(subject || 'Asesmen')}</div>
              <h1 class="id-title" id="pp-identity-title">${this._esc(title)}</h1>
              <div class="id-chips">${chips}</div>
            </header>
            ${noteHTML}
            <div class="id-body">
              <div class="pp-identity-form">
                ${identityHTML}
              </div>
              <div class="pp-actions">
                <button class="albedu-btn albedu-btn-primary pp-start-btn" data-pp-goto-exam type="button">
                  <span data-albedu-icon="play_arrow"></span>
                  <span>Mulai Asesmen</span>
                </button>
              </div>
            </div>
          </div>
        </main>

        <!-- EXAM PHASE PREVIEW — mirrors take.html <main id="exam-phase"> -->
        <main class="ex-phase-preview" id="pp-exam" hidden aria-labelledby="pp-exam-title">
          <header class="ex-topbar">
            <div class="ex-topbar__left">
              <div class="ex-subject">${this._esc(subject || 'Asesmen')}</div>
              <h1 class="ex-title" id="pp-exam-title">${this._esc(title)}</h1>
            </div>
            <div class="ex-sections-wrap" id="pp-sections-wrap">
              <div class="ex-sections" id="pp-tabs" role="tablist" aria-label="Bagian Soal">${tabsHTML}</div>
            </div>
            <div class="ex-topbar__right">
              <div class="ex-user">
                <span data-albedu-icon="account_circle"></span>
                <span>Nama Peserta</span>
              </div>
              <div class="ex-timer" role="timer" aria-live="off" aria-atomic="true">
                <span data-albedu-icon="timer"></span>
                <span>${String(duration).padStart(2, '0')}:00</span>
              </div>
            </div>
          </header>

          <div class="ex-main">
            <div class="ex-content">
              <div class="ex-page-header">
                <h2 class="ex-page-title">${this._esc(activeSec?.name || 'Bagian 1')}</h2>
                <div class="ex-page-count">${activeSec?.questions?.length || 0} Soal</div>
              </div>
              <div id="pp-questions" role="region" aria-live="polite" aria-label="Daftar soal">${questionsHTML}</div>
            </div>
          </div>

          <nav class="ex-bottomnav" aria-label="Navigasi soal">
            <div class="ex-bottomnav__inner">
              <button class="ex-nav-btn ex-nav-btn--prev" data-pp-prev type="button" disabled aria-label="Bagian sebelumnya">
                <span data-albedu-icon="arrow_back"></span>
                <span>Sebelumnya</span>
              </button>
              <div class="ex-progress" aria-live="polite">0/${totalQ}</div>
              <button class="ex-nav-btn ex-nav-btn--next" data-pp-next type="button" aria-label="Bagian berikutnya">
                <span>Selanjutnya</span>
                <span data-albedu-icon="arrow_forward"></span>
              </button>
              <button class="ex-nav-btn ex-nav-btn--submit" data-pp-submit type="button" disabled aria-label="Kumpulkan asesmen" title="Submit terkunci">
                <span data-albedu-icon="lock"></span>
                <span>Kumpulkan</span>
              </button>
            </div>
          </nav>
        </main>

        <!-- RESULT PHASE PREVIEW — mirrors take.html <main id="result-phase"> -->
        <main class="rs-wrap" id="pp-result" hidden aria-labelledby="pp-result-title">
          <div class="rs-hero">
            <div class="rs-hero__icon">
              <span data-albedu-icon="task_alt"></span>
            </div>
            <h1 class="rs-hero__title" id="pp-result-title">Asesmen Selesai</h1>
            <p class="rs-hero__sub">Berikut adalah hasil pengerjaan Anda.</p>
            <div class="rs-score" aria-live="polite">
              <span class="rs-score__num">—</span>
              <span class="rs-score__max">/100</span>
            </div>
            <div class="rs-stats" id="pp-result-stats"></div>
          </div>
          <div class="rs-detail-section">
            <button class="rs-detail-toggle" data-pp-toggle-detail type="button" aria-expanded="false" aria-controls="pp-result-detail">
              <span data-albedu-icon="expand_more"></span>
              <span>Lihat Detail Jawaban</span>
            </button>
            <div class="rs-detail" id="pp-result-detail" hidden></div>
          </div>
          <div class="rs-actions">
            <button class="albedu-btn albedu-btn-secondary" data-pp-close type="button">
              <span data-albedu-icon="logout"></span>
              <span>Tutup Preview</span>
            </button>
          </div>
        </main>

        <!-- Dead pause banner removed — matches take.html cleanup -->
      `;

      // Wire interactions (UI only — no save/submit)
      this._wireInteractions(sections, totalQ);

      // Bind icons
      window.AlbEdu?.bindIcons?.(content);

      // FIX: Render KaTeX + apply language classes on initial render
      setTimeout(() => {
        if (window.renderMathIn) window.renderMathIn(content);
        if (window.applyLangClass) window.applyLangClass(content);
      }, 150);
    },

    _renderQuestion(q, idx, section) {
      const qText = this._sanitize(q.pertanyaan || '');
      const type = section.type_question || 'PG';

      // FIX: Build media HTML — mirrors take.html/exam.js _buildMediaHTML
      const mediaHTML = this._buildMediaHTML(q);

      let bodyHTML = '';
      if (type === 'esai') {
        bodyHTML = `
          <textarea class="ex-esai albedu-textarea"
                    placeholder="Tulis jawaban Anda di sini..."
                    aria-label="Jawaban esai untuk soal ${idx + 1}"
                    maxlength="5000"
                    disabled></textarea>
          <div class="ex-question__points">Esai — dinilai manual oleh guru</div>
        `;
      } else {
        // C1 FIX: handle both array and object pilihan
        let pilihan;
        if (Array.isArray(q.pilihan)) {
          pilihan = q.pilihan;
        } else if (q.pilihan && typeof q.pilihan === 'object') {
          pilihan = ['A', 'B', 'C', 'D', 'E'].map(k => q.pilihan[k]).filter(v => v != null && v !== '');
        } else {
          pilihan = [];
        }
        const keys = ['A', 'B', 'C', 'D', 'E'];
        bodyHTML = `
          <div class="ex-options" role="radiogroup" aria-label="Pilihan jawaban soal ${idx + 1}">
            ${pilihan.slice(0, 5).map((opt, i) => {
              const key = keys[i];
              // FIX: roving tabindex matching take.html (F4-01 pattern)
              const isFirst = i === 0;
              const tabindex = isFirst ? '0' : '-1';
              return `
              <div class="ex-option"
                   role="radio"
                   aria-checked="false"
                   tabindex="${tabindex}"
                   data-pp-option
                   data-key="${this._esc(key)}">
                <div class="ex-option__radio" aria-hidden="true"></div>
                <div class="ex-option__key">${this._esc(key)}</div>
                <div class="ex-option__label">${this._sanitize(String(opt))}</div>
              </div>
            `;
            }).join('')}
          </div>
        `;
      }

      // FIX: article structure matches take.html exactly
      // - aria-label on question num
      // - media container
      return `
        <article class="ex-question" data-pp-q="${idx}">
          <div class="ex-question__num" aria-label="Soal nomor ${idx + 1}">${idx + 1}</div>
          <div class="ex-question__body">
            <div class="ex-question__text">${qText}</div>
            <div class="ex-question__media">${mediaHTML}</div>
            ${bodyHTML}
          </div>
        </article>
      `;
    },

    /**
     * Build media HTML — mirrors take.html/exam.js _buildMediaHTML.
     * Handles video (YouTube embed) + images with zoom + onerror fallback.
     */
    _buildMediaHTML(q) {
      if (!q.media) return '';
      const parts = [];
      const video = q.media.video;
      const images = Array.isArray(q.media.gambar) ? q.media.gambar : [];

      if (video?.enabled) {
        let embedSrc = '';
        if (video.videoId) {
          embedSrc = `https://www.youtube.com/embed/${encodeURIComponent(video.videoId)}?rel=0&modestbranding=1`;
        } else if (video.src) {
          const yt = String(video.src).match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{6,})/);
          if (yt) embedSrc = `https://www.youtube.com/embed/${encodeURIComponent(yt[1])}?rel=0&modestbranding=1`;
        }
        if (embedSrc) {
          parts.push(`
            <div class="media-video">
              <iframe src="${this._esc(embedSrc)}" loading="lazy"
                      allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                      allowfullscreen
                      title="Video soal"></iframe>
            </div>
          `);
        }
      }

      if (images.length > 0) {
        const urls = images.map(img => {
          if (typeof img === 'string') return img;
          if (img && typeof img === 'object' && img.url) return img.url;
          return '';
        }).filter(Boolean);
        if (urls.length > 0) {
          parts.push(urls.map(u =>
            `<img src="${this._esc(u)}" data-zoom="${this._esc(u)}" alt="Gambar soal" loading="lazy" />`
          ).join(''));
        }
      }

      return parts.length > 0 ? parts.join('') : '';
    },

    _wireInteractions(sections, totalQ) {
      const content = document.getElementById('pp-content');

      // Identity → Exam transition
      content.querySelector('[data-pp-goto-exam]')?.addEventListener('click', () => {
        content.querySelector('#pp-identity').hidden = true;
        content.querySelector('#pp-exam').hidden = false;
      });

      // FIX: Submit → Result transition (mirrors take.html submit flow)
      content.querySelector('[data-pp-submit]')?.addEventListener('click', () => {
        const answered = content.querySelectorAll('.ex-option.selected').length;
        const score = totalQ > 0 ? Math.round((answered / totalQ) * 100) : 0;

        // Populate result stats (mock — preview can't actually score)
        const statsEl = content.querySelector('#pp-result-stats');
        if (statsEl) {
          statsEl.innerHTML = `
            <div class="rs-stat rs-stat--benar"><div class="rs-stat__num">—</div><div class="rs-stat__label">Benar</div></div>
            <div class="rs-stat rs-stat--salah"><div class="rs-stat__num">—</div><div class="rs-stat__label">Salah</div></div>
            <div class="rs-stat rs-stat--kosong"><div class="rs-stat__num">${totalQ - answered}</div><div class="rs-stat__label">Kosong</div></div>
            <div class="rs-stat"><div class="rs-stat__num">—</div><div class="rs-stat__label">Durasi</div></div>
          `;
        }
        const scoreNum = content.querySelector('.rs-score__num');
        if (scoreNum) scoreNum.textContent = score;

        content.querySelector('#pp-exam').hidden = true;
        content.querySelector('#pp-result').hidden = false;
        // Scroll to top of result
        content.scrollTop = 0;
      });

      // FIX: Result detail toggle (mirrors take.html btn-toggle-detail)
      content.querySelector('[data-pp-toggle-detail]')?.addEventListener('click', () => {
        const btn = content.querySelector('[data-pp-toggle-detail]');
        const detail = content.querySelector('#pp-result-detail');
        if (!btn || !detail) return;
        const expanded = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', String(!expanded));
        detail.hidden = expanded;
      });

      // Section tabs
      content.querySelectorAll('[data-pp-tab]').forEach(btn => {
        btn.addEventListener('click', () => {
          this._activeSection = parseInt(btn.dataset.ppTab, 10);
          this._renderSection(sections, totalQ);
        });
      });

      // Option click (visual only — toggle selected)
      content.addEventListener('click', (e) => {
        const opt = e.target.closest('[data-pp-option]');
        if (!opt) return;
        const siblings = opt.parentElement.querySelectorAll('.ex-option');
        siblings.forEach(s => {
          s.classList.remove('selected');
          s.setAttribute('aria-checked', 'false');
        });
        opt.classList.add('selected');
        opt.setAttribute('aria-checked', 'true');
        // Update answered count
        const answered = content.querySelectorAll('.ex-option.selected').length;
        const progress = content.querySelector('.ex-progress');
        if (progress) progress.textContent = `${answered}/${totalQ}`;
      });

      // Prev/Next section
      content.querySelector('[data-pp-prev]')?.addEventListener('click', () => {
        if (this._activeSection > 0) {
          this._activeSection--;
          this._renderSection(sections, totalQ);
        }
      });
      content.querySelector('[data-pp-next]')?.addEventListener('click', () => {
        if (this._activeSection < sections.length - 1) {
          this._activeSection++;
          this._renderSection(sections, totalQ);
        }
      });
    },

    _renderSection(sections, totalQ) {
      const content = document.getElementById('pp-content');
      const sec = sections[this._activeSection];
      if (!sec) return;

      // Update tabs
      content.querySelectorAll('[data-pp-tab]').forEach((btn, i) => {
        btn.classList.toggle('active', i === this._activeSection);
      });

      // Update page header
      content.querySelector('.ex-page-title').textContent = sec.name || `Bagian ${this._activeSection + 1}`;
      content.querySelector('.ex-page-count').textContent = `${sec.questions?.length || 0} Soal`;

      // Update questions
      const qContainer = content.querySelector('#pp-questions');
      qContainer.innerHTML = (sec.questions || []).map((q, i) => this._renderQuestion(q, i, sec)).join('');

      // Update nav buttons — mirrors take.html _updateNavButtons
      const prev = content.querySelector('[data-pp-prev]');
      const next = content.querySelector('[data-pp-next]');
      const submit = content.querySelector('[data-pp-submit]');
      if (prev) prev.disabled = this._activeSection === 0;
      if (next) {
        next.disabled = this._activeSection === sections.length - 1;
        next.hidden = this._activeSection === sections.length - 1;
      }
      if (submit) {
        // FIX: enable submit on last section (preview doesn't lock submit —
        // admin should be able to click it to see the result phase preview)
        submit.hidden = this._activeSection !== sections.length - 1;
        submit.disabled = false;
      }

      // Re-bind icons
      window.AlbEdu?.bindIcons?.(qContainer);

      // FIX: Render KaTeX + apply language classes in preview (match take.html)
      if (window.renderMathIn) window.renderMathIn(qContainer);
      if (window.applyLangClass) window.applyLangClass(qContainer);
    },

    _esc(s) {
      return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    },

    _sanitize(html) {
      if (!html) return '';
      if (window.DOMPurify) return window.DOMPurify.sanitize(String(html));
      return this._esc(html);
    },
  };

  // Expose
  window.PesertaPreview = Preview;

  // Auto-init on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => Preview.init());
  } else {
    Preview.init();
  }
})();
