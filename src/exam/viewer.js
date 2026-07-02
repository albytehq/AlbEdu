// ExamViewer.js -- v0.3.0
// Changes from v4.2.0:
//   [F1] setSubmitLocked(bool) — tombol submit dikunci sampai 10 menit terakhir
//   [F4] renderMathIn() called after every DOM render for KaTeX support
//   [F5] applyLangClass() called after every DOM render for RTL/Arab auto-detect
// - Sidebar REMOVED (Desktop & Mobile)
// - Identity gate enforced before exam access
// - Shuffle soal: stable per-session (not per-render)
// - Hold Async confirm for submit
//
// FIXES v4.2.0:
//   [1] XSS: pertanyaan, catatan, pilihan sekarang di-sanitize sebelum dirender
//   [4] YouTube autoplay: pakai URL API — tidak lagi .replace('?', ...) yang bisa corrupt URL
//   [10] Dead exports renderSidebarTabs / updateTabProgress dihapus dari public API
//   [12] Option radio ganti dari '*'/'?' ke icon SVG circle — accessible + mobile-friendly

// ── HTML Sanitizer ───────────────────────────────────────────────────────────
// Guru diizinkan pakai basic formatting HTML di soal (bold, italic, list, dll).
// Tapi tanpa sanitasi, konten seperti <img src=x onerror=alert(1)> langsung
// dieksekusi di browser peserta. Kita strip semua atribut berbahaya + tag berbahaya
// sambil menjaga tag formatting yang aman tetap bisa dipakai.
//
// Strategy: DOMPurify jika tersedia (CDN di HTML parent) → tight regex fallback.
const _sanitizeHTML = (() => {
  // F5: Added ruby/rt/rp (furigana), bdi/bdo (bidirectional), mark (highlight).
  // NOTE: KaTeX tags (span.katex) are NOT here intentionally — we sanitize BEFORE
  // calling renderMathIn(), so KaTeX hasn't run yet. Sanitize input, not KaTeX output.
  const ALLOWED_TAGS   = ['b','i','em','strong','br','p','ul','ol','li','span','sub','sup',
                           'u','s','ruby','rt','rp','bdi','bdo','mark'];
  // F5: lang and dir added for accessibility (lang="ar" dir="rtl")
  const ALLOWED_ATTRS  = ['class','style','lang','dir'];
  const DANGEROUS_CSS_PROPS = /position\s*:|z-index\s*:|pointer-events\s*:|opacity\s*:|display\s*:|visibility\s*:|transform\s*:|animation\s*:|content\s*:|behavior\s*:|expression\s*\(/gi;

  if (typeof DOMPurify !== 'undefined') {
    return (html) => DOMPurify.sanitize(html, {
      ALLOWED_TAGS,
      ALLOWED_ATTR:    ALLOWED_ATTRS,
      ALLOW_DATA_ATTR: false,
      FORCE_BODY:      false,
    });
  }

  // Regex fallback — for when DOMPurify isn't loaded.
  // WHY not parse with a temp DOM element? Because innerHTML-parsing untrusted
  // HTML to "sanitize" it can itself trigger scripts in some browsers.
  const SAFE_TAG_RE = /^(b|i|em|strong|br|p|ul|ol|li|span|sub|sup|u|s|ruby|rt|rp|bdi|bdo|mark)$/i;
  return function sanitizeFallback(html) {
    return String(html ?? '')
      .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '')
      .replace(/(?:href|src|action)\s*=\s*(?:"[^"]*(?:javascript|data):[^"]*"|'[^']*(?:javascript|data):[^']*')/gi, '')
      .replace(/<(?:script|iframe|object|embed|style|link|meta|base)[^>]*>[\s\S]*?<\/(?:script|iframe|object|embed|style|link)>/gi, '')
      .replace(/<(?:script|iframe|object|embed|style|link|meta|base)[^>]*\/?>/gi, '')
      .replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g, (match, tag) => {
        return SAFE_TAG_RE.test(tag) ? match : '';
      });
  };
})();

/**
 * resolveImageUrl — compatibility normalizer for gambar entries.
 *
 * AlbEdu stores images in two formats depending on when the exam was created:
 *   OLD (pre-Worker migration):  gambar = ["https://..."]        → plain string
 *   NEW (post-Worker migration): gambar = [{ url, hash }]        → object
 *
 * Any renderer that interpolates a raw gambar entry as a string will produce
 * "[object Object]" and a 404.  Always route through this helper.
 *
 * @param  {string|{url:string,hash?:string}|null|undefined} img
 * @returns {string}  resolved URL, or '' if entry is absent/invalid
 */
function resolveImageUrl(img) {
  if (!img) return '';
  if (typeof img === 'string') return img;
  if (typeof img === 'object') return img.url || '';
  return '';
}

// For values that must NEVER contain HTML (option keys, names in attributes)
function _escAttr(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// FIX [12]: SVG radio icons — replaces the old '*' / '?' placeholder chars.
// Proper icons work on all screen sizes and screen readers get aria-hidden.
const _RADIO_EMPTY    = `<svg class="radio-svg" viewBox="0 0 18 18" aria-hidden="true" focusable="false"><circle cx="9" cy="9" r="7.5" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>`;
const _RADIO_SELECTED = `<svg class="radio-svg" viewBox="0 0 18 18" aria-hidden="true" focusable="false"><circle cx="9" cy="9" r="7.5" stroke="currentColor" stroke-width="1.5" fill="none"/><circle cx="9" cy="9" r="4" fill="currentColor"/></svg>`;

// Image focus crossfade duration — matches the CSS opacity transition on .img-focus-img
const IMG_FOCUS_CROSSFADE_MS = 120;

// ── Main Module ──────────────────────────────────────────────────────────────
const ExamViewer = (() => {
  let _container       = null;
  let _onAnswerCb      = null;
  let _onNavigateCb    = null;
  let _onSubmitCb      = null;
  let _themeColor      = '#2563eb';

  // --- Theme -----------------------------------------------------------------
  function applyTheme(themeObj) {
    const tw = themeObj?.TW;
    // FIX BUG-19: Validate theme color sebelum dipakai — cegah CSS injection.
    // Sebelumnya _validateHexColor() didefinisikan tapi tidak dipanggil di sini.
    _themeColor = (tw && tw !== 'default') ? _validateHexColor(tw) : '#2563eb';
    document.documentElement.style.setProperty('--color-primary', _themeColor);
    document.documentElement.style.setProperty('--color-primary-dark', _shadeColor(_themeColor, -15));
    document.documentElement.style.setProperty('--color-primary-light', _shadeColor(_themeColor, 90));
    document.documentElement.style.setProperty('--color-primary-muted', _hexToRgba(_themeColor, 0.12));
    document.documentElement.style.setProperty('--color-primary-ring', _hexToRgba(_themeColor, 0.25));
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta); }
    meta.content = _themeColor;
  }

  // FIX BUG-19: Validate theme color — hanya izinkan hex format (#RRGGBB).
// Tanpa validasi, guru bisa inject CSS melalui theme color yang merusak UI ujian.
function _validateHexColor(value, fallback = '#1E40AF') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed;
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    // Expand shorthand #RGB → #RRGGBB
    return '#' + trimmed[1]+trimmed[1] + trimmed[2]+trimmed[2] + trimmed[3]+trimmed[3];
  }
  return fallback;
}

function _shadeColor(hex, pct) {
    const n = parseInt(hex.replace('#',''), 16);
    const r = Math.min(255, Math.max(0, (n >> 16) + pct));
    const g = Math.min(255, Math.max(0, ((n >> 8) & 0xff) + pct));
    const b = Math.min(255, Math.max(0, (n & 0xff) + pct));
    return `rgb(${r},${g},${b})`;
  }

  function _hexToRgba(hex, alpha) {
    const n = parseInt(hex.replace('#',''), 16);
    return `rgba(${n >> 16},${(n >> 8) & 0xff},${n & 0xff},${alpha})`;
  }

  // --- Mount -----------------------------------------------------------------
  function mount(container) {
    _container = container;
    _container.innerHTML = `
      <div class="exam-layout" id="examLayout">
        <header class="exam-header" id="examHeader">
          <div class="exam-header-left">
            <div class="exam-subject-badge" id="examSubjectBadge"></div>
            <div class="exam-info">
              <div class="exam-title" id="examTitle"></div>
              <div class="exam-user" id="examUser"></div>
            </div>
          </div>
          <div class="exam-header-right">
            <div class="exam-timer" id="examTimer">
              <i class="material-symbols-outlined">timer</i>
              <span id="timerDisplay">--:--</span>
            </div>
          </div>
        </header>
        <!-- Progress strip pinned below header — updates via updateProgress() -->
        <div class="exam-progress-strip" id="examProgressStrip">
          <div class="exam-progress-fill" id="progressBarFill" style="width:0%"></div>
        </div>
        <div class="exam-body">
          <main class="exam-main" id="examMain"></main>
        </div>
      </div>

      <!-- IMAGE FOCUS PREVIEW OVERLAY -->
      <div id="imgFocusOverlay" class="img-focus-overlay" style="display:none;" role="dialog" aria-modal="true">
        <div class="img-focus-backdrop" id="imgFocusBackdrop"></div>
        <div class="img-focus-container">
          <button class="img-focus-close" id="imgFocusClose" aria-label="Tutup"><i class="material-symbols-outlined">close</i></button>
          <div class="img-focus-nav" id="imgFocusNav">
            <button class="img-focus-arrow left" id="imgFocusPrev" aria-label="Sebelumnya"><i class="material-symbols-outlined">chevron_left</i></button>
            <button class="img-focus-arrow right" id="imgFocusNext" aria-label="Berikutnya"><i class="material-symbols-outlined">chevron_right</i></button>
          </div>
          <img id="imgFocusImg" class="img-focus-img" src="" alt="Preview" draggable="false" />
          <div class="img-focus-counter" id="imgFocusCounter"></div>
        </div>
      </div>

      <!-- VIDEO FOCUS OVERLAY -->
      <div id="videoFocusOverlay" class="video-focus-overlay" style="display:none;" role="dialog" aria-modal="true">
        <div class="video-focus-backdrop" id="videoFocusBackdrop"></div>
        <div class="video-focus-container" id="videoFocusContainer">
          <div class="video-focus-header">
            <span class="video-focus-label"><i class="material-symbols-outlined">fullscreen</i> Mode Fokus Video</span>
            <button class="video-focus-close" id="videoFocusClose" aria-label="Tutup"><i class="material-symbols-outlined">close</i></button>
          </div>
          <div class="video-focus-player" id="videoFocusPlayer"></div>
        </div>
      </div>
    `;
    _initImageFocusOverlay();
    _initVideoFocusOverlay();
  }

  // --- Header ----------------------------------------------------------------
  function renderHeader(ujianInfo, identitas) {
    document.getElementById('examSubjectBadge').textContent = ujianInfo?.mata_pelajaran || 'Ujian';
    document.getElementById('examTitle').textContent = ujianInfo?.judul || '';

    // v2.0.0: identity shape unified — _display_name + optional tab_nama/kelas + field values
    // Backward compat: kalau masih pakai shape lama {nama, kelas}, tetap support
    const displayName = identitas?._display_name || identitas?.nama || 'Peserta';
    const subLabel = identitas?.tab_nama || identitas?.kelas ||
                     (identitas?._mode === 'manual' ? 'Peserta' : '');

    // identitas comes from user input — escape it
    document.getElementById('examUser').innerHTML = `
      <i class="material-symbols-outlined">account_circle</i>
      <strong>${_escAttr(displayName)}</strong>${subLabel ? ' &mdash; ' + _escAttr(subLabel) : ''}
    `;
  }

  // NOTE: renderSidebarTabs() and updateTabProgress() removed entirely — sidebar
  // was deleted but the NOOPs were still being exported, which masked broken callers.
  // FIX [10]: If you still have callers, remove them — they were doing nothing.

  function updateProgress(progress) {
    const count = document.getElementById('progressCount');
    const fill  = document.getElementById('progressBarFill');
    if (count) count.textContent = `${progress.dijawab}/${progress.total}`;
    // Update both the old sidebar fill (no-op if element gone) and the new header strip
    if (fill)  fill.style.width  = `${progress.persentase}%`;
  }

  // --- Identity Page ---------------------------------------------------------
  function renderIdentityPage(ujianInfo, catatan, readonly) {
    const main = document.getElementById('examMain');
    if (!main) return;
    const hjRaw   = ujianInfo?.theme?.HJ;
    const hjColor = (hjRaw && hjRaw !== 'default') ? _validateHexColor(hjRaw) : _themeColor;
    const navHTML = readonly ? `
      <div class="page-nav-bar">
        <span></span>
        <button class="btn-nav-bottom btn-nav-next" id="btnIdentityNext">
          Lanjut <i class="material-symbols-outlined">arrow_forward</i>
        </button>
      </div>` : '';

    // FIX [1]: catatan comes from Firestore (admin/teacher input).
    // We allow basic HTML formatting via _sanitizeHTML (e.g. <b>, <br>)
    // but strip all script injection vectors.
    const catatanSafe = catatan ? _sanitizeHTML(catatan) : '';

    main.innerHTML = `
      <div class="page-identity page-slide-enter-right">
        <div class="hj-banner" style="background: linear-gradient(135deg, ${hjColor}, ${_shadeColor(hjColor, -20)})">
          <div class="hj-meta">${_escAttr(ujianInfo?.mata_pelajaran || '')}</div>
          <h1 class="hj-title">${_escAttr(ujianInfo?.judul || 'Ujian')}</h1>
          <div class="hj-chips">
            <span class="hj-chip"><i class="material-symbols-outlined">schedule</i> ${_escAttr(ujianInfo?.time || '')}</span>
            ${(() => {
              // v2.0.0: tampilkan identity info berdasarkan mode
              const mode = ujianInfo?.identity_mode;
              if (mode === 'daftar') {
                const label = ujianInfo?.identity_config?.daftar_label ||
                              ujianInfo?.identity_config?.daftar_tipe || 'Daftar';
                return `<span class="hj-chip"><i class="material-symbols-outlined">format_list_bulleted</i> ${_escAttr(label)}</span>`;
              }
              if (mode === 'manual') {
                const fields = ujianInfo?.identity_config?.fields || [];
                const namaField = fields.find(f => (f.label || '').toLowerCase().includes('nama'));
                const label = namaField ? 'Identitas Peserta' : 'Form Manual';
                return `<span class="hj-chip"><i class="material-symbols-outlined">keyboard</i> ${label}</span>`;
              }
              // Legacy fallback
              const kelasArr = ujianInfo?.kelas || [];
              if (Array.isArray(kelasArr) && kelasArr.length > 0) {
                return `<span class="hj-chip"><i class="material-symbols-outlined">layers</i> Kelas ${_escAttr(kelasArr.join(', '))}</span>`;
              }
              return '';
            })()}
          </div>
        </div>
        ${catatanSafe ? `
          <div class="catatan-box">
            <div class="catatan-icon"><i class="material-symbols-outlined">info</i></div>
            <div class="catatan-text">${catatanSafe}</div>
          </div>` : ''}
        <div class="identity-section">
          <div class="section-header-label">Data Diri Peserta</div>
          <div id="identityFormMount"></div>
        </div>
        ${navHTML}
      </div>
    `;
    if (readonly) {
      main.querySelector('#btnIdentityNext')?.addEventListener('click', () => {
        if (_onNavigateCb) _onNavigateCb('page', 0);
      });
    }

    // F4+F5: Identity page may have catatan with math or Arab text
    if (typeof window.renderMathIn  === 'function') window.renderMathIn(main);
    if (typeof window.applyLangClass === 'function') window.applyLangClass(main);
  }

  // --- Soal Page (Shuffle stable per session) --------------------------------
  function renderSoalPage(page, getJawabanFn, ujianInfo, pageIdx, totalPages, slideDir) {
    const main = document.getElementById('examMain');
    if (!main) return;
    const cuRaw    = ujianInfo?.theme?.CU;
    const cuColor  = (cuRaw && cuRaw !== 'default') ? _validateHexColor(cuRaw) : _themeColor;
    const nilaiMaks     = ujianInfo?.global_skor || 100;
    const totalSoalAll  = _getTotalSoalAll();
    const poinPerSoal   = totalSoalAll > 0 ? parseFloat((nilaiMaks / totalSoalAll).toFixed(1)) : 0;
    const isLast  = pageIdx === totalPages - 1;
    const navHTML = _buildNavBar(pageIdx, isLast);
    const slideClass = slideDir === 'left' ? 'page-slide-enter-left' : 'page-slide-enter-right';

    const shuffledQuestions = (typeof ExamLogic !== 'undefined')
      ? ExamLogic.getShuffledPage(page.pageKey)
      : page.questions;

    main.innerHTML = `
      <div class="page-soal ${slideClass}">
        <div class="soal-page-header">
          <div class="soal-page-title">${_escAttr(page.label)}</div>
          <div class="soal-page-count">${page.questions.length} Soal</div>
        </div>
        <div class="soal-list" id="soalList">
          ${shuffledQuestions.map((q, i) => _buildSoalCard(q, i, page.pageKey, getJawabanFn, cuColor, poinPerSoal)).join('')}
        </div>
        ${navHTML}
      </div>
    `;

    // S5 fix: event delegation — single click listener on main container
    // instead of N×4 per-option listeners. For 40-question exam: 160 listeners
    // per render → 1 listener. Old DOM dies via innerHTML wipe so listeners
    // were GC'd, but registration cost was real. Delegation also handles
    // dynamically added options without re-attaching.
    //
    // Phase 13 critique fix: use AbortController to auto-cleanup previous
    // delegated listener before adding new one. Without this, listener
    // accumulated on every renderSoalPage call (main element persists).
    if (main._delegatedAbort) main._delegatedAbort.abort();
    main._delegatedAbort = new AbortController();
    main.addEventListener('click', (e) => {
      const item = e.target.closest('.option-item');
      if (!item) return;
      const pagekey = item.dataset.pagekey;
      const idq     = item.dataset.idq;
      const key     = item.dataset.key;
      if (!pagekey || !idq) return;
      const wasSelected = item.classList.contains('selected');
      main.querySelectorAll(`.option-item[data-idq="${idq}"][data-pagekey="${pagekey}"]`)
        .forEach(o => o.classList.remove('selected'));
      if (!wasSelected) {
        item.classList.add('selected');
        if (_onAnswerCb) _onAnswerCb(pagekey, parseInt(idq), key);
      } else {
        if (_onAnswerCb) _onAnswerCb(pagekey, parseInt(idq), null);
      }
      _updateSoalAnsweredState(pagekey, idq, !wasSelected);
    }, { signal: main._delegatedAbort.signal });

    main.querySelector('#btnNavPrev')?.addEventListener('click', () => {
      if (pageIdx === 0) {
        if (_onNavigateCb) _onNavigateCb('identity');
      } else {
        if (_onNavigateCb) _onNavigateCb('page', pageIdx - 1, 'left');
      }
    });
    main.querySelector('#btnNavNext')?.addEventListener('click', () => {
      if (_onNavigateCb) _onNavigateCb('page', pageIdx + 1, 'right');
    });
    // F1: Submit button may be locked. If locked, disabled attr prevents click natively.
    // But we also guard in listener so programmatic calls can't sneak through.
    const submitBtn = main.querySelector('#btnNavSubmit');
    if (submitBtn) {
      submitBtn.addEventListener('click', () => {
        // If still locked (shouldn't happen with disabled attr, but belt-and-suspenders)
        if (submitBtn.disabled) return;
        if (_onSubmitCb) _onSubmitCb();
      });
      // Remove one-shot pulse animation class once it completes
      submitBtn.addEventListener('animationend', () => {
        submitBtn.classList.remove('btn-submit-pulse');
      }, { once: true });
    }

    _bindImagePreviews(main);
    _bindVideoFocusButtons(main);

    // F4: Render math expressions (KaTeX) in soal list after DOM is set.
    // F5: Apply RTL/Arab auto-detect classes after render.
    // These MUST run together at every render point — pair them always.
    if (typeof window.renderMathIn  === 'function') window.renderMathIn(main);
    if (typeof window.applyLangClass === 'function') window.applyLangClass(main);
  }

  // --- Build Soal Card -------------------------------------------------------
  function _buildSoalCard(q, displayIdx, pageKey, getJawabanFn, cuColor, poinPerSoal) {
    const jawabanSaat = getJawabanFn(pageKey, q.idq);
    const isAnswered  = !!jawabanSaat;
    const mediaHTML   = _buildMediaHTML(q, pageKey);

    // FIX [1]: q.pertanyaan and pilihan values come from Firestore.
    // pertanyaan intentionally supports HTML formatting → _sanitizeHTML.
    // pilihan values also go through sanitize (teacher may paste formatted text).
    // Key labels (A, B, C, D) are plain text only → _escAttr.
    // Sort A→B→C→D regardless of storage order in Firestore
    const pilihanHTML = Object.entries(q.pilihan || {}).sort(([a],[b]) => a.localeCompare(b)).map(([key, val]) => {
      const sel       = jawabanSaat === key;
      // FIX [12]: Proper SVG radio icons instead of '*' / '?'
      const radioIcon = sel ? _RADIO_SELECTED : _RADIO_EMPTY;
      return `
        <li class="option-item${sel ? ' selected' : ''}"
            data-pagekey="${pageKey}" data-idq="${q.idq}" data-key="${_escAttr(key)}"
            role="radio" aria-checked="${sel}" tabindex="0">
          <span class="option-radio" aria-hidden="true">${radioIcon}</span>
          <span class="option-key-label">${_escAttr(key)}.</span>
          <span class="option-value">${_sanitizeHTML(val)}</span>
        </li>
      `;
    }).join('');

    const poinLabel      = poinPerSoal > 0 ? `${poinPerSoal} poin` : '';
    const pertanyaanSafe = _sanitizeHTML(q.pertanyaan || '');

    return `
      <div class="soal-card" id="soalCard_${pageKey}_${q.idq}" role="group" aria-label="Soal ${displayIdx + 1}">
        <div class="soal-card-top" style="background: ${cuColor}">
          <span class="soal-num-badge">
            <svg style="display:inline-block;vertical-align:-1px;margin-right:4px" width="9" height="9" viewBox="0 0 9 9" fill="none"><circle cx="4.5" cy="4.5" r="4.5" fill="rgba(255,255,255,0.3)"/></svg>Soal ${displayIdx + 1}
          </span>
          <div class="soal-badge-right">
            ${poinLabel ? `<span class="soal-poin-badge">${poinLabel}</span>` : ''}
            <span class="soal-status-badge" id="soalStatus_${pageKey}_${q.idq}" aria-live="polite">
              ${isAnswered ? '✓ Dijawab' : 'Belum'}
            </span>
          </div>
        </div>
        <div class="soal-card-body">
          <div class="question-text">${pertanyaanSafe}</div>
          ${mediaHTML}
          <ul class="options-list" role="radiogroup" aria-label="Pilihan jawaban">${pilihanHTML}</ul>
        </div>
      </div>
    `;
  }

  // --- Build Media HTML ------------------------------------------------------
  function _buildMediaHTML(q, pageKey) {
    const video  = q.media?.video;
    const images = (q.media?.gambar || []).slice(0, 4);
    let html = '';

    if (video?.enabled) {
      // New format: videoId stored explicitly (YouTube-only flow)
      if (video.videoId) {
        const embedSrc = `https://www.youtube.com/embed/${video.videoId}?rel=0&modestbranding=1`;
        html += _buildYouTubeEmbed(video.videoId, embedSrc, pageKey, q.idq);
      } else if (video.src) {
        // Backward compat: old records with raw src URL (Cloudinary or YouTube URL string)
        const isYoutube = /youtube\.com|youtu\.be/.test(video.src);
        const isVimeo   = /vimeo\.com/.test(video.src);
        html += _buildVideoPlayer(video.src, isYoutube, isVimeo, pageKey, q.idq);
      }
      // If neither videoId nor src: graceful silence (no broken element rendered)
    }

    if (images.length > 0) {
      // Compat normalizer: new format = { url, hash }, old format = plain string
      const imgUrls = images.map(resolveImageUrl);

      const gridClass = images.length === 1 ? 'img-grid-1'
                      : images.length === 2 ? 'img-grid-2'
                      : images.length === 3 ? 'img-grid-3'
                      : 'img-grid-4';
      html += `
        <div class="question-images-wrap" data-pagekey="${pageKey}" data-idq="${q.idq}">
          <div class="question-img-grid ${gridClass}">
            ${imgUrls.map((src, idx) => `
              <div class="q-img-cell" data-img-index="${idx}" data-img-src="${_escAttr(src)}">
                <img src="${_escAttr(src)}" class="q-img" alt="Gambar soal ${idx + 1}"
                     loading="lazy" decoding="async" draggable="false" />
                <div class="q-img-overlay">
                  <button class="q-img-focus-btn" data-img-index="${idx}" aria-label="Perbesar gambar ${idx + 1}">
                    <i class="material-symbols-outlined">zoom_in</i>
                  </button>
                </div>
              </div>
            `).join('')}
          </div>
          ${images.length > 1
            ? `<div class="img-count-hint"><i class="material-symbols-outlined">photo_library</i> ${images.length} gambar &mdash; ketuk untuk perbesar</div>`
            : '<div class="img-count-hint"><i class="material-symbols-outlined">zoom_in</i> Ketuk gambar untuk perbesar</div>'
          }
        </div>
      `;
    }

    return html;
  }

  // --- YouTube Embed Builder (new flow: videoId-first) ----------------------
  // Clean, safe embed from an already-extracted videoId. No regex needed here.
  function _buildYouTubeEmbed(videoId, embedSrc, pageKey, idq) {
    const uid = `vid_${pageKey}_${idq}`;
    return `
      <div class="question-video-wrap" id="${uid}_wrap">
        <div class="video-embed-container" id="${uid}_embed">
          <div class="video-aspect-box" style="padding-bottom:56.25%">
            <iframe src="${_escAttr(embedSrc)}" class="video-embed-iframe" frameborder="0"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowfullscreen loading="lazy"></iframe>
          </div>
        </div>
        <div class="video-toolbar">
          <span class="video-toolbar-label"><i class="material-symbols-outlined">play_circle</i> Video Soal</span>
          <button class="video-focus-btn"
                  data-video-src="${_escAttr(`https://www.youtube.com/watch?v=${videoId}`)}"
                  data-video-type="youtube"
                  data-embed-src="${_escAttr(embedSrc)}"
                  aria-label="Perbesar video">
            <i class="material-symbols-outlined">fullscreen</i> Fokus
          </button>
        </div>
      </div>
    `;
  }

  // --- Video Player Builder (backward compat: raw src URL) ------------------
  function _buildVideoPlayer(src, isYoutube, isVimeo, pageKey, idq) {
    const uid = `vid_${pageKey}_${idq}`;
    if (isYoutube || isVimeo) {
      let embedSrc = src;
      if (isYoutube) {
        const yt = src.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
        if (yt) embedSrc = `https://www.youtube.com/embed/${yt[1]}?rel=0&modestbranding=1`;
      } else if (isVimeo) {
        const vm = src.match(/vimeo\.com\/(\d+)/);
        if (vm) embedSrc = `https://player.vimeo.com/video/${vm[1]}`;
      }
      return `
        <div class="question-video-wrap" id="${uid}_wrap">
          <div class="video-embed-container" id="${uid}_embed">
            <div class="video-aspect-box" style="padding-bottom:56.25%">
              <iframe src="${_escAttr(embedSrc)}" class="video-embed-iframe" frameborder="0"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowfullscreen loading="lazy"></iframe>
            </div>
          </div>
          <div class="video-toolbar">
            <span class="video-toolbar-label"><i class="material-symbols-outlined">play_circle</i> Video Soal</span>
            <button class="video-focus-btn"
                    data-video-src="${_escAttr(src)}"
                    data-video-type="${isYoutube ? 'youtube' : 'vimeo'}"
                    data-embed-src="${_escAttr(embedSrc)}"
                    aria-label="Perbesar video">
              <i class="material-symbols-outlined">fullscreen</i> Fokus
            </button>
          </div>
        </div>
      `;
    } else {
      return `
        <div class="question-video-wrap" id="${uid}_wrap">
          <div class="video-native-container" id="${uid}_native">
            <video id="${uid}" class="video-native" controls preload="metadata" playsinline
                   controlsList="nodownload" oncontextmenu="return false">
              <source src="${_escAttr(src)}" />
              Browser Anda tidak mendukung video.
            </video>
          </div>
          <div class="video-toolbar">
            <span class="video-toolbar-label"><i class="material-symbols-outlined">videocam</i> Video Soal</span>
            <button class="video-focus-btn" data-video-src="${_escAttr(src)}" data-video-type="native" aria-label="Perbesar video">
              <i class="material-symbols-outlined">fullscreen</i> Fokus
            </button>
          </div>
        </div>
      `;
    }
  }

  // --- Image Focus -----------------------------------------------------------
  let _focusImages = [];
  let _focusIndex  = 0;

  function _initImageFocusOverlay() {
    const overlay  = document.getElementById('imgFocusOverlay');
    const backdrop = document.getElementById('imgFocusBackdrop');
    const closeBtn = document.getElementById('imgFocusClose');
    const prevBtn  = document.getElementById('imgFocusPrev');
    const nextBtn  = document.getElementById('imgFocusNext');
    const close = () => { overlay.style.display = 'none'; document.body.style.overflow = ''; };
    backdrop?.addEventListener('click', close);
    closeBtn?.addEventListener('click', close);
    prevBtn?.addEventListener('click', e => {
      e.stopPropagation();
      if (_focusImages.length > 1) { _focusIndex = (_focusIndex - 1 + _focusImages.length) % _focusImages.length; _updateFocusImage(); }
    });
    nextBtn?.addEventListener('click', e => {
      e.stopPropagation();
      if (_focusImages.length > 1) { _focusIndex = (_focusIndex + 1) % _focusImages.length; _updateFocusImage(); }
    });
    document.addEventListener('keydown', e => {
      if (overlay.style.display === 'none') return;
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft' && _focusImages.length > 1) { _focusIndex = (_focusIndex - 1 + _focusImages.length) % _focusImages.length; _updateFocusImage(); }
      if (e.key === 'ArrowRight' && _focusImages.length > 1) { _focusIndex = (_focusIndex + 1) % _focusImages.length; _updateFocusImage(); }
    });
  }

  function _updateFocusImage() {
    const img = document.getElementById('imgFocusImg');
    const counter = document.getElementById('imgFocusCounter');
    const nav = document.getElementById('imgFocusNav');
    if (!img) return;
    img.style.opacity = '0';
    setTimeout(() => { img.src = resolveImageUrl(_focusImages[_focusIndex]); img.style.opacity = '1'; }, IMG_FOCUS_CROSSFADE_MS);
    if (counter) counter.textContent = _focusImages.length > 1 ? `${_focusIndex + 1} / ${_focusImages.length}` : '';
    if (nav) nav.style.display = _focusImages.length > 1 ? 'flex' : 'none';
  }

  function _openImageFocus(images, startIndex) {
    _focusImages = images;
    _focusIndex  = startIndex;
    const overlay = document.getElementById('imgFocusOverlay');
    if (!overlay) return;
    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    const img = document.getElementById('imgFocusImg');
    if (img) { img.src = resolveImageUrl(images[startIndex]); img.style.opacity = '1'; }
    const counter = document.getElementById('imgFocusCounter');
    if (counter) counter.textContent = images.length > 1 ? `${startIndex + 1} / ${images.length}` : '';
    const nav = document.getElementById('imgFocusNav');
    if (nav) nav.style.display = images.length > 1 ? 'flex' : 'none';
  }

  function _bindImagePreviews(main) {
    main.querySelectorAll('.question-images-wrap').forEach(wrap => {
      const imgs = Array.from(wrap.querySelectorAll('.q-img-cell')).map(c => c.dataset.imgSrc);
      wrap.querySelectorAll('.q-img-focus-btn, .q-img').forEach(el => {
        el.addEventListener('click', e => {
          const cell = e.target.closest('.q-img-cell');
          const idx  = cell ? parseInt(cell.dataset.imgIndex) : 0;
          _openImageFocus(imgs, idx);
        });
      });
    });
  }

  // --- Video Focus -----------------------------------------------------------
  function _initVideoFocusOverlay() {
    const overlay  = document.getElementById('videoFocusOverlay');
    const backdrop = document.getElementById('videoFocusBackdrop');
    const closeBtn = document.getElementById('videoFocusClose');
    const close = () => {
      const player = document.getElementById('videoFocusPlayer');
      if (player) player.innerHTML = '';
      overlay.style.display = 'none';
      document.body.style.overflow = '';
    };
    backdrop?.addEventListener('click', close);
    closeBtn?.addEventListener('click', close);
    document.addEventListener('keydown', e => { if (overlay.style.display !== 'none' && e.key === 'Escape') close(); });
  }

  // FIX [4]: Old code used embedSrc.replace('?', '?autoplay=1&') which silently
  // corrupts the URL if there's no '?' in embedSrc — you'd get something like
  // "https://youtube.com/embed/IDautoplay=1&" which 404s. URL API handles all
  // cases correctly: with params, without params, Vimeo, YouTube, custom.
  function _addAutoplay(embedSrc, type) {
    try {
      const url = new URL(embedSrc);
      url.searchParams.set('autoplay', '1');
      // Also mute — most browsers block unmuted autoplay
      if (type === 'youtube') url.searchParams.set('mute', '1');
      return url.toString();
    } catch (_) {
      // Fallback if embedSrc is somehow not a valid absolute URL
      const sep = embedSrc.includes('?') ? '&' : '?';
      return `${embedSrc}${sep}autoplay=1`;
    }
  }

  function _openVideoFocus(src, type, embedSrc) {
    const overlay = document.getElementById('videoFocusOverlay');
    const player  = document.getElementById('videoFocusPlayer');
    if (!overlay || !player) return;
    player.innerHTML = '';
    if (type === 'native') {
      // Native video: DOM APIs instead of innerHTML — cleaner, no injection surface
      const video = document.createElement('video');
      video.className = 'video-focus-native';
      video.controls = true; video.autoplay = true; video.playsInline = true;
      video.setAttribute('controlsList', 'nodownload');
      video.oncontextmenu = () => false;
      const source = document.createElement('source');
      source.src = src;
      video.appendChild(source);
      player.appendChild(video);
    } else {
      const autoSrc  = _addAutoplay(embedSrc, type);
      const wrap     = document.createElement('div');
      wrap.className = 'video-focus-embed-wrap';
      const iframe   = document.createElement('iframe');
      iframe.src = autoSrc; iframe.frameBorder = '0';
      iframe.allow = 'autoplay; fullscreen'; iframe.allowFullscreen = true;
      wrap.appendChild(iframe);
      player.appendChild(wrap);
    }
    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }

  function _bindVideoFocusButtons(main) {
    main.querySelectorAll('.video-focus-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _openVideoFocus(btn.dataset.videoSrc, btn.dataset.videoType, btn.dataset.embedSrc || btn.dataset.videoSrc);
      });
    });
  }

  // --- Nav Bar ---------------------------------------------------------------
  // F1: _submitLocked state tracked here so _buildNavBar and setSubmitLocked
  // can render the same locked/unlocked markup consistently.
  let _submitLocked = true; // locked by default at exam start

  function _buildNavBar(pageIdx, isLast) {
    const submitBtn = isLast ? _buildSubmitBtn(_submitLocked) : '';
    return `
      <div class="page-nav-bar">
        <button class="btn-nav-bottom btn-nav-prev" id="btnNavPrev">
          <i class="material-symbols-outlined">arrow_back</i> Kembali
        </button>
        ${isLast
          ? submitBtn
          : `<button class="btn-nav-bottom btn-nav-next" id="btnNavNext">
               Lanjut <i class="material-symbols-outlined">arrow_forward</i>
             </button>`
        }
      </div>
    `;
  }

  // Builds the submit button HTML for a given locked state.
  // Extracted so setSubmitLocked() can call it without re-rendering the whole page.
  function _buildSubmitBtn(locked) {
    if (locked) {
      return `
        <div class="submit-wrap" id="submitWrap">
          <button class="btn-nav-bottom btn-nav-submit btn-submit-locked"
                  id="btnNavSubmit"
                  disabled
                  aria-disabled="true"
                  aria-label="Kumpulkan ujian (terkunci, tersedia 10 menit sebelum ujian selesai)"
                  title="Tombol ini terbuka 10 menit sebelum ujian berakhir">
            <i class="material-symbols-outlined">lock</i> Kumpulkan
          </button>
          <div class="submit-lock-hint" id="submitLockHint">
            <i class="material-symbols-outlined">info</i>
            Pengumpulan dibuka 10 menit sebelum ujian selesai
          </div>
        </div>`;
    }
    return `
      <div class="submit-wrap" id="submitWrap">
        <button class="btn-nav-bottom btn-nav-submit btn-submit-unlocked btn-submit-pulse"
                id="btnNavSubmit"
                aria-label="Kumpulkan ujian">
          <i class="material-symbols-outlined">send</i> Kumpulkan
        </button>
      </div>`;
  }

  // --- Submit Lock (Feature 1) -----------------------------------------------
  /**
   * Lock or unlock the submit button without re-rendering the whole page.
   * Called from kerjakan-ujian.html controller when 10-minute threshold is reached.
   *
   * @param {boolean} locked - true = show lock icon + disable, false = unlock
   */
  function setSubmitLocked(locked) {
    _submitLocked = locked;
    const wrap = document.getElementById('submitWrap');
    if (!wrap) return; // not on last page — no-op, will apply on next render

    wrap.outerHTML = _buildSubmitBtn(locked);

    // Re-bind the click handler after innerHTML swap — old listener is gone
    const newBtn = document.getElementById('btnNavSubmit');
    if (newBtn && !locked) {
      newBtn.addEventListener('click', () => {
        if (_onSubmitCb) _onSubmitCb();
      });
      // Remove pulse class after animation completes — it's a one-shot signal, not infinite
      newBtn.addEventListener('animationend', () => {
        newBtn.classList.remove('btn-submit-pulse');
      }, { once: true });
    }
  }

  function _getTotalSoalAll() {
    if (typeof ExamLogic !== 'undefined') {
      return ExamLogic.getSoalPages().reduce((acc, p) => acc + p.questions.length, 0);
    }
    return 0;
  }

  // FIX [12]: In-place update now replaces SVG icons, not just text content.
  // Also updates aria-checked for proper screen reader state.
  function _updateSoalAnsweredState(pageKey, idq, isAnswered) {
    const status = document.getElementById(`soalStatus_${pageKey}_${idq}`);
    if (status) status.textContent = isAnswered ? '✓ Dijawab' : 'Belum';
    const card = document.getElementById(`soalCard_${pageKey}_${idq}`);
    if (!card) return;
    card.querySelectorAll('.option-item').forEach(item => {
      const radio = item.querySelector('.option-radio');
      if (!radio) return;
      const nowSelected = item.classList.contains('selected');
      radio.innerHTML = nowSelected ? _RADIO_SELECTED : _RADIO_EMPTY;
      item.setAttribute('aria-checked', nowSelected ? 'true' : 'false');
    });
  }

  // --- Timer -----------------------------------------------------------------
  function updateTimer(sisaDetik) {
    const el      = document.getElementById('timerDisplay');
    const timerEl = document.getElementById('examTimer');
    if (!el) return;
    const m = Math.floor(sisaDetik / 60);
    const s = sisaDetik % 60;
    el.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    if (!timerEl) return;
    timerEl.classList.remove('timer-warning','timer-critical');
    if (sisaDetik <= 60)       timerEl.classList.add('timer-critical');
    else if (sisaDetik <= 300) timerEl.classList.add('timer-warning');
  }

  // --- Render Hasil ----------------------------------------------------------
  function renderHasil(container, hasil) {
    const { identitas, totalSoal, benar, salah, tidakDijawab, nilai,
            nilaiMaksimal, durasiDetik, detailPerBagian } = hasil;
    const menit = Math.floor(durasiDetik / 60);
    const detik = durasiDetik % 60;
    const lulus = nilai >= 75;
    const gradeLabel = nilai >= 90 ? 'Luar Biasa!' : nilai >= 75 ? 'Lulus' : nilai >= 60 ? 'Cukup' : 'Perlu Belajar Lagi';

    // FIX [1]: pertanyaan in result review also comes from Firestore — sanitize
    const detailHTML = detailPerBagian.map(({ label, detail }) => `
      <div class="result-bagian">
        <div class="result-bagian-title">${_escAttr(label)}</div>
        <ul class="detail-list">
          ${detail.map((d, i) => `
            <li class="detail-item detail-${d.status}">
              <div class="detail-num">${i + 1}</div>
              <div class="detail-info">
                <div class="detail-pertanyaan">${_sanitizeHTML(d.pertanyaan || '')}</div>
                <div class="detail-answers">
                  <span><i class="material-symbols-outlined">person</i> ${d.jawabanPeserta
                    ? `Jawaban: <strong>${_escAttr(d.jawabanPeserta)}</strong>`
                    : '<em>Tidak dijawab</em>'
                  }</span>
                  <span><i style="color:var(--green-500)" class="material-symbols-outlined">check</i> Kunci: <strong>${_escAttr(d.jawabanBenar)}</strong></span>
                </div>
              </div>
              <i class="material-symbols-outlined ${d.status === 'benar' ? 'detail-icon-benar' : d.status === 'salah' ? 'detail-icon-salah' : 'detail-icon-kosong'}">${d.status === 'benar' ? 'check_circle' : d.status === 'salah' ? 'cancel' : 'remove_circle'}</i>
            </li>`).join('')}
        </ul>
      </div>`).join('');

    container.innerHTML = `
      <div class="result-page">
        <div class="result-header">
          <div class="result-icon ${lulus ? 'grade-pass' : 'grade-fail'}">
            <i class="material-symbols-outlined">${lulus ? 'emoji_events' : 'menu_book'}</i>
          </div>
          <h2 class="result-title">${gradeLabel}</h2>
          <p class="result-user">${_escAttr(identitas._display_name || identitas.nama)}${(identitas.tab_nama || identitas.kelas) ? ' &mdash; ' + _escAttr(identitas.tab_nama || identitas.kelas) : ''}</p>
        </div>
        <div class="result-score-big ${lulus ? 'grade-pass' : 'grade-fail'}">
          <span class="score-number">${nilai}</span>
          <span class="score-max">/ ${nilaiMaksimal}</span>
        </div>
        <div class="result-stats">
          <div class="stat-card"><i style="color:var(--green-500)" class="material-symbols-outlined">check_circle</i><span class="stat-num">${benar}</span><span class="stat-label">Benar</span></div>
          <div class="stat-card"><i style="color:var(--red-500)" class="material-symbols-outlined">cancel</i><span class="stat-num">${salah}</span><span class="stat-label">Salah</span></div>
          <div class="stat-card"><i style="color:var(--gray-400)" class="material-symbols-outlined">remove_circle</i><span class="stat-num">${tidakDijawab}</span><span class="stat-label">Kosong</span></div>
          <div class="stat-card"><i style="color:var(--color-primary)" class="material-symbols-outlined">schedule</i><span class="stat-num">${menit}<small>m</small>${String(detik).padStart(2,'0')}<small>s</small></span><span class="stat-label">Waktu</span></div>
        </div>
        <div class="result-detail">
          <h3 class="detail-title">Pembahasan</h3>
          ${detailHTML}
        </div>
      </div>
    `;

    // F4+F5: Render math and apply language classes in result page
    if (typeof window.renderMathIn  === 'function') window.renderMathIn(container);
    if (typeof window.applyLangClass === 'function') window.applyLangClass(container);
  }

  function getIdentityFormMount() {
    return document.getElementById('identityFormMount');
  }

  function onAnswer(cb)   { _onAnswerCb   = cb; }
  function onNavigate(cb) { _onNavigateCb = cb; }
  function onSubmit(cb)   { _onSubmitCb   = cb; }

  // FIX [10]: renderSidebarTabs and updateTabProgress removed from exports.
  // They were NOOP dead code. Callers should be cleaned up too.
  return {
    applyTheme, mount, renderHeader,
    updateProgress, renderIdentityPage,
    renderSoalPage, updateTimer, renderHasil,
    getIdentityFormMount, onAnswer, onNavigate, onSubmit,
    setSubmitLocked, // F1: public API for submit lock control from controller
  };
})();