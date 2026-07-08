// take-assessment/exam.js — exam runtime: rendering, answers, timer, security.
// This is the largest module of the split. MUST load after utils.js, fetch.js,
// and identity.js.

(function () {
  'use strict';

  const _internal = window.TakeAssessment = window.TakeAssessment || {};
  _internal._internal = _internal._internal || { state: {}, dom: {}, constants: {}, t: null };
  const I = _internal._internal;
  const t = I.t || ((key, vars, fallback) => fallback || key);
  const C = I.constants;
  const SUBMIT_UNLOCK_SECONDS = C.SUBMIT_UNLOCK_SECONDS || 600;
  const TIMER_WARNING_SECONDS = C.TIMER_WARNING_SECONDS || 300;
  const TIMER_CRITICAL_SECONDS = C.TIMER_CRITICAL_SECONDS || 60;
  const DRAFT_SYNC_DEBOUNCE_MS = C.DRAFT_SYNC_DEBOUNCE_MS || 800;

  function _startExam(identity, options = {}) {
    const isResume = options?.isResume === true;
    const state = I.state;

    const seed = _internal._computeSeed(state.session);
    state.sessionNonce = seed;
    state.shuffledPages = _internal._shufflePages(state.soalPages, seed);

    state.startTime = state.startTime || Date.now();
    state.activePageIdx = state.activePageIdx || 0;

    _internal._setPhase('exam');

    I.dom.examSubject.textContent = state.assessment.subject || 'Asesmen';
    I.dom.examTitle.textContent = state.assessment.title || 'Asesmen';
    const displayName = identity?._display_name || identity?.nama || 'Peserta';
    const subLabel = identity?.tab_nama || identity?.kelas ||
                     (identity?._mode === 'manual' ? 'Peserta' : '');
    I.dom.examUserText.innerHTML = `${_internal._escAttr(displayName)}${subLabel ? ' — ' + _internal._escAttr(subLabel) : ''}`;

    _renderPageTabs();
    _renderQuestion(state.activePageIdx);
    _startTimer(state.assessment);
    _wireNavButtons();
    _startSecurity();
    _updateSubmitLockState();

    // Single teardown controller — every listener added during the exam
    // phase takes this signal so any exit path (blocked / submitted /
    // expired / result) can clean them up in one shot.
    if (I._examAbort) I._examAbort.abort();
    I._examAbort = new AbortController();
    const sig = I._examAbort.signal;

    window.addEventListener('beforeunload', _beforeUnloadGuard, { signal: sig });

    if (!isResume) {
      history.pushState({ albEduExamActive: true }, '', location.href);
    }
    window.addEventListener('popstate', _popstateTrap, { signal: sig });

    console.info('[take] exam started. resume=', isResume, 'seed=', seed,
      'questions=', state.soalPages.reduce((s, p) => s + (p.questions?.length || 0), 0));
  }

  // Tear down everything _startExam wired up. Idempotent — safe to call from
  // any exit path (blocked / submitted / expired / result).
  function _teardownExam() {
    _stopTimer();
    _stopSecurity();
    if (I._examAbort) {
      try { I._examAbort.abort(); } catch (_) {}
      I._examAbort = null;
    }
    if (I.dom.questionList && I.dom.questionList._delegatedAbort) {
      try { I.dom.questionList._delegatedAbort.abort(); } catch (_) {}
      I.dom.questionList._delegatedAbort = null;
    }
  }

  // Page tabs — always visible for consistent navigation context, even
  // when the assessment has only one section. Peserta gets a clearer
  // sense of structure (and prev/next still works for future sections).
  function _renderPageTabs() {
    const state = I.state;
    I.dom.pageTabs.hidden = false;
    I.dom.pageTabs.innerHTML = state.soalPages.map((p, idx) => `
      <button class="page-tab ${idx === state.activePageIdx ? 'active' : ''}"
              type="button" role="tab"
              aria-selected="${idx === state.activePageIdx}"
              data-page-idx="${idx}">
        ${_internal._escAttr(p.label)}
      </button>
    `).join('');
    I.dom.pageTabs.querySelectorAll('.page-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.pageIdx, 10);
        if (idx !== state.activePageIdx) {
          state.activePageIdx = idx;
          _renderQuestion(idx);
          _renderPageTabs();
        }
      });
    });
  }

  // Render question page
  function _renderQuestion(idx) {
    const state = I.state;
    const page = state.soalPages[idx];
    if (!page) return;

    I.dom.pageTitle.textContent = page.label;
    I.dom.pageCount.textContent = `${page.questions.length} Soal`;

    const shuffled = state.shuffledPages[page.pageKey] || page.questions;

    I.dom.questionList.innerHTML = shuffled.map((q, i) => _buildQuestionCard(q, i, page)).join('');

    // Wire option clicks via event delegation on the question list. A fresh
    // AbortController per render so re-renders don't accumulate handlers.
    if (I.dom.questionList._delegatedAbort) I.dom.questionList._delegatedAbort.abort();
    I.dom.questionList._delegatedAbort = new AbortController();
    I.dom.questionList.addEventListener('click', (e) => {
      const opt = e.target.closest('.option-item');
      if (!opt) return;
      const pageKey = opt.dataset.pagekey;
      const idq = opt.dataset.idq;
      const key = opt.dataset.key;
      if (!pageKey || !idq) return;
      const wasSelected = opt.classList.contains('selected');
      I.dom.questionList.querySelectorAll(`.option-item[data-idq="${idq}"][data-pagekey="${pageKey}"]`)
        .forEach(o => o.classList.remove('selected'));
      if (!wasSelected) {
        opt.classList.add('selected');
        _saveAnswer(pageKey, parseInt(idq, 10), key);
      } else {
        _saveAnswer(pageKey, parseInt(idq, 10), null);
      }
      _updateQuestionAnsweredState(pageKey, idq, !wasSelected);
      _updateProgress();
    }, { signal: I.dom.questionList._delegatedAbort.signal });

    // Wire esai textareas + image previews, then render math + icons.
    I.dom.questionList.querySelectorAll('textarea.esai-textarea').forEach(ta => {
      const pageKey = ta.dataset.pagekey;
      const idq = ta.dataset.idq;
      ta.addEventListener('input', _debounceEsai(pageKey, parseInt(idq, 10), ta));
    });

    // Wire image preview
    I.dom.questionList.querySelectorAll('img[data-zoom]').forEach(img => {
      img.addEventListener('click', () => {
        const src = img.dataset.zoom || img.src;
        if (src) window.open(src, '_blank', 'noopener,noreferrer');
      });
    });

    // Render math + bind icons
    _internal._renderMath(I.dom.questionList);
    window.AlbEdu?.bindIcons?.(I.dom.questionList);

    _updateProgress();
    _updateNavButtons();
  }

  function _buildQuestionCard(q, displayIdx, page) {
    const state = I.state;
    const pageKey = page.pageKey;
    const jawaban = state.jawaban[`${pageKey}__${q.idq}`];
    const isAnswered = !!jawaban;
    const qText = _internal._sanitizeHTML(q.pertanyaan || '');
    const mediaHTML = _buildMediaHTML(q);

    let bodyHTML = '';
    if (page.typeQuestion === 'esai') {
      bodyHTML = `
        <textarea class="albedu-textarea esai-textarea"
                  data-pagekey="${_internal._escAttr(pageKey)}"
                  data-idq="${_internal._escAttr(q.idq)}"
                  placeholder="Tulis jawaban Anda di sini..."
                  aria-label="Jawaban esai untuk soal ${displayIdx + 1}"
                  maxlength="5000">${_internal._escAttr(jawaban || '')}</textarea>
        <div class="question-points">Esai — dinilai manual oleh guru</div>
      `;
    } else {
      const pilihan = Array.isArray(q.pilihan) ? q.pilihan : [];
      const keys = ['A', 'B', 'C', 'D', 'E'];
      bodyHTML = `
        <div class="option-list" role="radiogroup" aria-label="Pilihan jawaban soal ${displayIdx + 1}">
          ${pilihan.slice(0, 5).map((opt, i) => {
            const key = keys[i];
            const sel = jawaban === key ? 'selected' : '';
            return `
              <div class="option-item ${sel}"
                   role="radio"
                   aria-checked="${jawaban === key}"
                   tabindex="0"
                   data-pagekey="${_internal._escAttr(pageKey)}"
                   data-idq="${_internal._escAttr(q.idq)}"
                   data-key="${_internal._escAttr(key)}">
                <div class="option-radio" aria-hidden="true"></div>
                <div class="option-key">${_internal._escAttr(key)}</div>
                <div class="option-label">${_internal._sanitizeHTML(opt)}</div>
              </div>
            `;
          }).join('')}
        </div>
      `;
    }

    return `
      <article class="exam-question-card ${isAnswered ? 'answered' : ''}"
               data-pagekey="${_internal._escAttr(pageKey)}"
               data-idq="${_internal._escAttr(q.idq)}">
        <div class="question-num" aria-label="Soal nomor ${displayIdx + 1}">${displayIdx + 1}</div>
        <div class="question-text">${qText}</div>
        ${mediaHTML}
        ${bodyHTML}
      </article>
    `;
  }

  function _buildMediaHTML(q) {
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
            <iframe src="${_internal._escAttr(embedSrc)}" loading="lazy"
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
          `<img src="${_internal._escAttr(u)}" data-zoom="${_internal._escAttr(u)}" alt="Gambar soal" loading="lazy" />`
        ).join(''));
      }
    }

    return parts.length > 0 ? `<div class="question-media">${parts.join('')}</div>` : '';
  }

  function _updateQuestionAnsweredState(pageKey, idq, answered) {
    const card = I.dom.questionList.querySelector(
      `.exam-question-card[data-pagekey="${pageKey}"][data-idq="${idq}"]`);
    if (card) card.classList.toggle('answered', answered);
  }

  // Answer save
  function _saveAnswer(pageKey, idq, answer) {
    const state = I.state;
    const key = `${pageKey}__${idq}`;
    if (answer === null || answer === undefined || answer === '') {
      delete state.jawaban[key];
    } else {
      state.jawaban[key] = answer;
    }
    _scheduleDraftSync();
  }

  function _debounceEsai(pageKey, idq, ta) {
    let timer = null;
    return () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        _saveAnswer(pageKey, idq, ta.value);
      }, 400);
    };
  }

  function _scheduleDraftSync() {
    _saveLocalDraft();
    if (I.state._draftSyncTimer) clearTimeout(I.state._draftSyncTimer);
    I.state._draftSyncTimer = setTimeout(() => {
      I.state._draftSyncTimer = null;
      window.Heartbeat?.syncNow?.();
    }, DRAFT_SYNC_DEBOUNCE_MS);
  }

  function _saveLocalDraft() {
    try {
      const state = I.state;
      const token = sessionStorage.getItem('assessment_token') || 'unknown';
      const userKey = window.AlbEdu?.supabase?.auth?.currentUser?.id || 'anon';
      const key = `albedu_take_draft_${token}_${userKey}`;
      localStorage.setItem(key, JSON.stringify({
        jawaban: state.jawaban,
        identity: state.identity,
        savedAt: Date.now(),
      }));
    } catch (_) { /* localStorage might be full */ }
  }

  function _clearLocalDraft() {
    try {
      const token = sessionStorage.getItem('assessment_token') || 'unknown';
      const userKey = window.AlbEdu?.supabase?.auth?.currentUser?.id || 'anon';
      const key = `albedu_take_draft_${token}_${userKey}`;
      localStorage.removeItem(key);
    } catch (_) {}
  }

  function _buildAnswersPayload() {
    const state = I.state;
    const out = {};
    state.soalPages.forEach(page => {
      const pageKey = page.pageKey;
      out[pageKey] = {};
      page.questions.forEach(q => {
        const ans = state.jawaban[`${pageKey}__${q.idq}`];
        if (ans !== undefined && ans !== null && ans !== '') {
          out[pageKey][String(q.idq)] = ans;
        }
      });
    });
    return out;
  }

  // Navigation
  function _wireNavButtons() {
    if (!I._examAbort) return;
    const sig = I._examAbort.signal;
    I.dom.btnPrev.addEventListener('click', () => {
      if (I.state.activePageIdx > 0) {
        I.state.activePageIdx--;
        _renderQuestion(I.state.activePageIdx);
        _renderPageTabs();
        I.dom.examPhase.querySelector('.exam-main').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, { signal: sig });
    I.dom.btnNext.addEventListener('click', () => {
      if (I.state.activePageIdx < I.state.soalPages.length - 1) {
        I.state.activePageIdx++;
        _renderQuestion(I.state.activePageIdx);
        _renderPageTabs();
        I.dom.examPhase.querySelector('.exam-main').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, { signal: sig });
    I.dom.btnSubmit.addEventListener('click', () => {
      if (I.dom.btnSubmit.disabled) return;
      _internal._submitExam();
    }, { signal: sig });
  }

  function _updateNavButtons() {
    const state = I.state;
    const isLast = state.activePageIdx === state.soalPages.length - 1;
    I.dom.btnPrev.disabled = state.activePageIdx === 0;
    I.dom.btnNext.disabled = isLast;
    I.dom.btnNext.hidden = isLast;
    I.dom.btnSubmit.hidden = !isLast;
  }

  function _updateProgress() {
    const state = I.state;
    const total = state.soalPages.reduce((s, p) => s + (p.questions?.length || 0), 0);
    const answered = Object.values(state.jawaban).filter(Boolean).length;
    const pct = total > 0 ? Math.round((answered / total) * 100) : 0;
    I.dom.progressFill.style.width = `${pct}%`;
    if (I.dom.navProgress) I.dom.navProgress.textContent = `${answered}/${total}`;
  }

  // Timer
  function _startTimer(assessment) {
    _stopTimer();
    const state = I.state;

    let endMs = null;
    if (assessment.access_mode === 'scheduled' && assessment.ac_scheduled_end) {
      endMs = new Date(assessment.ac_scheduled_end).getTime();
    } else if (assessment.ac_end) {
      endMs = new Date(assessment.ac_end).getTime();
    }

    if (!endMs || isNaN(endMs)) {
      const startMs = state.session?.started_at
        ? new Date(state.session.started_at).getTime()
        : Date.now();
      const durMs = (assessment.duration_minutes || 90) * 60 * 1000;
      endMs = startMs + durMs;
      console.warn('[take] ac_end missing — falling back to duration_minutes');
    }

    const tick = () => {
      const sisa = Math.max(0, Math.floor((endMs - Date.now()) / 1000));
      _updateTimerDisplay(sisa);

      if (sisa <= SUBMIT_UNLOCK_SECONDS && state.submitLocked) {
        state.submitLocked = false;
        _updateSubmitLockState();
      }

      if (sisa <= 0 && !state.isExpired && state.phase === 'exam') {
        state.isExpired = true;
        _stopTimer();
        _handleExpired();
      }
    };
    tick();
    state.timerInterval = setInterval(tick, 1000);
  }

  function _stopTimer() {
    if (I.state.timerInterval) {
      clearInterval(I.state.timerInterval);
      I.state.timerInterval = null;
    }
  }

  function _updateTimerDisplay(sisa) {
    const m = Math.floor(sisa / 60);
    const s = sisa % 60;
    I.dom.timerDisplay.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    I.dom.examTimer.classList.remove('warning', 'critical');
    if (sisa <= TIMER_CRITICAL_SECONDS) I.dom.examTimer.classList.add('critical');
    else if (sisa <= TIMER_WARNING_SECONDS) I.dom.examTimer.classList.add('warning');
  }

  function _updateSubmitLockState() {
    if (I.state.phase !== 'exam') return;
    const btn = I.dom.btnSubmit;
    if (I.state.submitLocked) {
      btn.disabled = true;
      btn.classList.add('nav-btn--submit-locked');
      const sisa = _getCurrentSisa();
      const mins = Math.max(0, Math.ceil((SUBMIT_UNLOCK_SECONDS - sisa) / 60));
      btn.title = `Submit terkunci. Buka dalam ${Math.max(1, mins)} menit (10 menit terakhir)`;
    } else {
      btn.disabled = false;
      btn.classList.remove('nav-btn--submit-locked');
      btn.title = 'Kumpulkan asesmen';
    }
  }

  function _getCurrentSisa() {
    const assessment = I.state.assessment;
    let endMs = null;
    if (assessment?.access_mode === 'scheduled' && assessment.ac_scheduled_end) {
      endMs = new Date(assessment.ac_scheduled_end).getTime();
    } else if (assessment?.ac_end) {
      endMs = new Date(assessment.ac_end).getTime();
    }
    if (!endMs) return SUBMIT_UNLOCK_SECONDS + 1;
    return Math.max(0, Math.floor((endMs - Date.now()) / 1000));
  }

  // Security
  function _startSecurity() {
    const state = I.state;
    if (window.AntiCheat?.start) {
      window.AntiCheat.start(state.session.id, {
        onViolation: (v) => {
          state.violations = window.AntiCheat.getTotalViolations();
          window.notify?.warning(
            `Peringatan ${state.violations}/4`,
            v.message || 'Pelanggaran terdeteksi',
            4000
          );
        },
        onMaxViolations: () => _handleMaxViolations(),
        onBlocked:  (reason) => _handleBlocked(reason),
        onSubmitted: () => _handleSubmitted(),
        onExpired:  () => _handleExpired(),
      });
    } else {
      console.warn('[take-assessment] AntiCheat not available, using individual modules');
      if (window.Heartbeat?.start) {
        window.Heartbeat.start(state.session.id, {
          onBlocked:  (reason) => _handleBlocked(reason),
          onSubmitted: () => _handleSubmitted(),
          onExpired:  () => _handleExpired(),
        });
      }
      if (window.BlockListener?.start) {
        window.BlockListener.start(state.session.id, {
          onBlocked:  (reason) => _handleBlocked(reason),
          onSubmitted: () => _handleSubmitted(),
        });
      }
      if (window.ExamGuardian?.activate) {
        window.ExamGuardian.onViolation?.(({ pesan, ke, maks }) => {
          state.violations = ke;
          window.notify?.warning(`Peringatan ${ke}/${maks}`, pesan, 4000);
        });
        window.ExamGuardian.onMaxViolation?.(() => _handleMaxViolations());
        window.ExamGuardian.activate();
      }
    }
  }

  function _stopSecurity() {
    if (window.AntiCheat?.stop) {
      window.AntiCheat.stop();
    } else {
      window.Heartbeat?.stop?.();
      window.BlockListener?.stop?.();
      window.ExamGuardian?.deactivate?.();
    }
  }

  function _pauseSecurity() {
    if (window.AntiCheat?.pause) {
      window.AntiCheat.pause();
    } else {
      window.ExamGuardian?.deactivate?.();
    }
  }

  function _resumeSecurity() {
    if (window.AntiCheat?.resume) {
      window.AntiCheat.resume();
    } else {
      window.ExamGuardian?.activate?.();
    }
  }

  // On max violations, reset + reshuffle. The peserta keeps their session
  // but loses all answers so far.
  async function _handleMaxViolations() {
    const state = I.state;
    window.notify?.error(
      t('assessment.max_violations_title', null, 'Pelanggaran Maksimal'),
      t('assessment.max_violations_msg', null, 'Soal akan diacak ulang. Jawaban sebelumnya direset.'),
      5000
    );

    _stopSecurity();

    state.jawaban = {};
    state.activePageIdx = 0;
    state.violations = 0;
    state.startTime = Date.now();
    state.submitLocked = true;

    if (window.AntiCheat?.reset) {
      window.AntiCheat.reset();
    }

    _clearLocalDraft();

    try {
      const repo = window.AlbEdu?.repository;
      if (repo) {
        await repo.updateDoc('assessment_sessions', state.session.id, {
          draft_answers: {},
          violation_count: 0,
          current_section: 0,
          current_question: 0,
          progress_pct: 0,
          updated_at: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.warn('[take] reset sync failed:', err);
    }

    const newSeed = ((_internal._computeSeed(state.session) ^ Date.now()) >>> 0);
    state.sessionNonce = newSeed;
    state.shuffledPages = _internal._shufflePages(state.soalPages, newSeed);

    _renderPageTabs();
    _renderQuestion(0);
    _updateProgress();
    _updateSubmitLockState();
    _startSecurity();
  }

  // Blocked / Submitted / Expired handlers
  function _handleBlocked(reason) {
    if (I.state._redirected) return;
    I.state._redirected = true;
    _teardownExam();
    const reasonEnc = encodeURIComponent(reason || 'Diblokir oleh admin');
    window.location.replace(`blocked.html?reason=${reasonEnc}`);
  }

  function _handleSubmitted() {
    if (I.state._redirected) return;
    I.state._redirected = true;
    _teardownExam();
    window.location.replace('submitted.html');
  }

  function _handleExpired() {
    if (I.state.isSubmitting || I.state.phase === 'result') return;
    window.notify?.warning(
      t('assessment.time_up', null, 'Waktu Habis'),
      t('assessment.time_up_msg', null, 'Waktu asesmen telah berakhir. Jawaban akan dikumpulkan otomatis.'),
      3000
    );
    _internal._submitExam({ skipConfirm: true, isAuto: true });
  }

  // Global event handlers (online/offline + alt+arrow nav)
  function _wireGlobalEvents() {
    window.addEventListener('online', () => {
      window.notify?.success(
        t('assessment.online_title', null, 'Kembali Online'),
        t('assessment.online_msg', null, 'Menyinkronkan jawaban...')
      );
      window.Heartbeat?.syncNow?.();
    });
    window.addEventListener('offline', () => {
      window.notify?.warning(
        t('assessment.offline_title', null, 'Offline'),
        t('assessment.offline_msg', null, 'Jawaban disimpan lokal. Akan disinkronkan saat online.')
      );
    });

    document.addEventListener('keydown', (e) => {
      if (I.state.phase !== 'exam') return;
      if (e.altKey && e.key === 'ArrowLeft' && !I.dom.btnPrev.disabled) {
        e.preventDefault();
        I.dom.btnPrev.click();
      } else if (e.altKey && e.key === 'ArrowRight' && !I.dom.btnNext.disabled) {
        e.preventDefault();
        I.dom.btnNext.click();
      }
    });
  }

  function _beforeUnloadGuard(e) {
    if (I.state._draftSyncTimer) {
      clearTimeout(I.state._draftSyncTimer);
      I.state._draftSyncTimer = null;
      _saveLocalDraft();
    }
    if (I.state.phase === 'exam') {
      try { window.Heartbeat?.syncNow?.(); } catch (_) {}
      e.preventDefault();
      e.returnValue = t('assessment.beforeunload_msg', null, 'Asesmen belum selesai. Yakin ingin meninggalkan halaman?');
      return e.returnValue;
    }
  }

  function _popstateTrap(e) {
    if (I.state.phase === 'exam') {
      history.pushState({ albEduExamActive: true }, '', location.href);
      window.notify?.warning(
        t('assessment.cannot_go_back_title', null, 'Tidak Dapat Kembali'),
        t('assessment.cannot_go_back_msg', null, 'Selesaikan atau kumpulkan asesmen terlebih dahulu.'),
        3000
      );
    }
  }

  Object.assign(_internal, {
    _startExam,
    _renderPageTabs,
    _renderQuestion,
    _buildQuestionCard,
    _buildMediaHTML,
    _updateQuestionAnsweredState,
    _saveAnswer,
    _debounceEsai,
    _scheduleDraftSync,
    _saveLocalDraft,
    _clearLocalDraft,
    _buildAnswersPayload,
    _wireNavButtons,
    _updateNavButtons,
    _updateProgress,
    _startTimer,
    _stopTimer,
    _updateTimerDisplay,
    _updateSubmitLockState,
    _getCurrentSisa,
    _startSecurity,
    _stopSecurity,
    _pauseSecurity,
    _resumeSecurity,
    _teardownExam,
    _handleMaxViolations,
    _handleBlocked,
    _handleSubmitted,
    _handleExpired,
    _wireGlobalEvents,
    _beforeUnloadGuard,
    _popstateTrap,
  });
})();
