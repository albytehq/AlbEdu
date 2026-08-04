// take-assessment/submit.js — submit flow + result rendering.
// MUST load after utils.js, fetch.js, identity.js, exam.js.

(function () {
  'use strict';

  const _internal = window.TakeAssessment = window.TakeAssessment || {};
  _internal._internal = _internal._internal || { state: {}, dom: {}, constants: {}, t: null };
  const I = _internal._internal;
  const t = I.t || ((key, vars, fallback) => fallback || key);
  const C = I.constants;
  const SUBMIT_MAX_RETRIES = C.SUBMIT_MAX_RETRIES || 3;
  const SUBMIT_RETRY_BASE_MS = C.SUBMIT_RETRY_BASE_MS || 1500;
  const SUBMIT_UNLOCK_SECONDS = C.SUBMIT_UNLOCK_SECONDS || 600;

  // Submit exam
  async function _submitExam(opts = {}) {
    const skipConfirm = opts.skipConfirm === true;
    const isAuto = opts.isAuto === true;
    const state = I.state;

    if (state.isSubmitting) return;
    if (state.phase === 'result') return;

    if (state.submitLocked && !isAuto) {
      const sisa = _internal._getCurrentSisa();
      const mins = Math.max(1, Math.ceil((SUBMIT_UNLOCK_SECONDS - sisa) / 60));
      window.notify?.info(
        t('assessment.submit_locked_title', null, 'Submit Terkunci'),
        t('assessment.submit_locked_msg', { mins }, `Submit terbuka dalam ${mins} menit (10 menit terakhir).`)
      );
      return;
    }

    if (!skipConfirm) {
      const confirmed = await _confirmSubmit();
      if (!confirmed) return;
    }

    state.isSubmitting = true;
    state.endTime = Date.now();

    _internal._pauseSecurity();
    window.Heartbeat?.stop?.();

    if (state._draftSyncTimer) {
      clearTimeout(state._draftSyncTimer);
      state._draftSyncTimer = null;
    }
    _internal._saveLocalDraft();

    const answers = _internal._buildAnswersPayload();
    const duration_seconds = state.startTime
      ? Math.floor((state.endTime - state.startTime) / 1000)
      : 0;

    // Submit is idempotent via the session_id UNIQUE constraint, so retries are
    // safe. Circuit breaker (3 fails → 60s cooldown) + exp backoff + 30s timeout.
    const resilience = window.AlbEdu?.resilience;
    const submitBody = {
      session_id: state.session.id,
      answers,
      duration_seconds,
      violation_count: state.violations,
    };

    try {
      let rawData;

      if (resilience) {
        const result = await resilience.submit(
          `submit:${state.session.id}`,
          async () => {
            const user = window.AlbEdu?.supabase?.auth?.currentUser;
            if (!user) throw new Error('Not authenticated');
            const rpc = window.AlbEdu?.supabase?.rpc;
            if (!rpc) throw new Error('Platform layer not ready');
            const { data, error } = await rpc.invoke('submit-assessment', submitBody);
            if (error) throw error;
            return data;
          }
        );

        if (!result.ok) {
          throw result.error || new Error('Submit failed after retries');
        }
        rawData = result.value;
      } else {
        // Fallback: raw call with manual retry
        let attempts = 0;
        while (attempts < SUBMIT_MAX_RETRIES) {
          try {
            const user = window.AlbEdu?.supabase?.auth?.currentUser;
            if (!user) throw new Error('Not authenticated');
            const rpc = window.AlbEdu?.supabase?.rpc;
            if (!rpc) throw new Error('Platform layer not ready');
            const { data, error: fnError } = await rpc.invoke('submit-assessment', submitBody);
            if (fnError) throw fnError;
            rawData = data;
            break;
          } catch (err) {
            attempts++;
            if (attempts >= SUBMIT_MAX_RETRIES) throw err;
            await new Promise(r => setTimeout(r, SUBMIT_RETRY_BASE_MS * attempts));
          }
        }
      }

      if (rawData?.error) {
        let code = '';
        let msg = rawData.error.message || rawData.error || 'Submit failed';
        if (rawData.error.code) code = rawData.error.code;

        if (code === 'SESSION_BLOCKED') {
          state.isSubmitting = false;
          _internal._handleBlocked(msg);
          return;
        }
        throw new Error(msg);
      }

      const result = rawData?.data || rawData;

      if (result?.idempotent) {
        _renderResult(result);
        _internal._clearLocalDraft();
        state.phase = 'result';
        state.isSubmitting = false;
        return;
      }

      _renderResult(result);
      _internal._clearLocalDraft();
      state.phase = 'result';
      state.isSubmitting = false;

    } catch (err) {
      // CRITICAL (C3 fix): Handle SESSION_BLOCKED regardless of how the error
      // is shaped. Previously the code only checked `err.status === 409`
      // (HTTP-level), but the resilience layer / rpc.invoke throws the
      // Supabase Fn error object directly, which carries `error.code` (not
      // `error.status`). The dead-code check at line 109 (`rawData?.error?.code`)
      // was unreachable because the inner fn threw before rawData was assigned.
      //
      // Now we check BOTH:
      //   - err.code === 'SESSION_BLOCKED'  (Supabase Fn error shape, thrown by inner fn)
      //   - err.status === 409              (HTTP-level conflict, thrown by fetch layer)
      //   - err.message includes 'SESSION_BLOCKED' (defensive — some wrappers stringify)
      const status = err?.status || err?.context?.status;
      const errCode = err?.code || err?.context?.code;
      const errMsg = err?.message || '';
      const isBlocked = status === 409
        || errCode === 'SESSION_BLOCKED'
        || /SESSION_BLOCKED/i.test(errMsg);

      if (isBlocked) {
        state.isSubmitting = false;
        _internal._handleBlocked(errMsg || 'Session blocked');
        return;
      }

      console.error('[take] submit failed after all retries:', err);
      state.isSubmitting = false;
      _internal._resumeSecurity();
      window.Heartbeat?.start?.(state.session.id, {
        onBlocked: (r) => _internal._handleBlocked(r),
        onSubmitted: () => _internal._handleSubmitted(),
        onExpired: () => _internal._handleExpired(),
      });
      _showSubmitRetryError(err);
    }
  }

  function _confirmSubmit() {
    return new Promise((resolve) => {
      if (window.notify?.confirm) {
        window.notify.confirm({
          title: t('assessment.submit_confirm_title', null, 'Kumpulkan Asesmen?'),
          message: t('assessment.submit_confirm_msg', null, 'Pastikan semua jawaban sudah terisi. Anda tidak bisa mengubah jawaban setelah dikumpulkan.'),
          intent: 'primary',
          confirmText: t('assessment.submit_confirm_btn', null, 'Ya, Kumpulkan'),
          cancelText: t('assessment.submit_cancel_btn', null, 'Batal'),
          onYes: () => resolve(true),
          onNo: () => resolve(false),
          onClose: () => resolve(false),
        });
      } else {
        resolve(confirm(t('assessment.submit_confirm_short', null, 'Kumpulkan asesmen? Tindakan ini tidak dapat dibatalkan.')));
      }
    });
  }

  function _showSubmitRetryError(err) {
    if (window.notify?.error) {
      window.notify.error(
        t('assessment.submit_failed', null, 'Gagal Mengumpulkan'),
        t('assessment.submit_retry_msg', { error: err.message || t('assessment.network_error', null, 'Kesalahan jaringan') }, `${err.message || 'Kesalahan jaringan'}. Jawaban Anda tetap tersimpan. Coba lagi dengan tombol Kumpulkan.`),
        8000
      );
    }
    if (I.dom.btnSubmit) {
      I.dom.btnSubmit.disabled = false;
      I.dom.btnSubmit.classList.remove('nav-btn--submit-locked');
    }
  }

  // Result render
  function _renderResult(result) {
    _internal._stopSecurity();
    _internal._stopTimer();
    window.removeEventListener('beforeunload', _internal._beforeUnloadGuard);
    window.removeEventListener('popstate', _internal._popstateTrap);

    _internal._setPhase('result');

    const state = I.state;
    const score = result.score ?? 0;
    const maxScore = result.max_score ?? 100;
    const correct = result.correct_count ?? 0;
    const total = result.total_count ?? 0;
    const empty = _internal._countEmpty();
    const durSec = result.duration_seconds ?? 0;

    const _rs = document.getElementById('result-score'); if (_rs) _rs.textContent = score;
    const _rsm = document.getElementById('result-score-max'); if (_rsm) _rsm.textContent = `/${maxScore}`;

    const stats = document.getElementById('result-stats');
    stats.innerHTML = `
      <div class="rs-stat rs-stat--benar">
        <div class="rs-stat__num">${correct}</div>
        <div class="rs-stat__label">Benar</div>
      </div>
      <div class="rs-stat rs-stat--salah">
        <div class="rs-stat__num">${Math.max(0, total - correct - empty)}</div>
        <div class="rs-stat__label">Salah</div>
      </div>
      <div class="rs-stat rs-stat--kosong">
        <div class="rs-stat__num">${empty}</div>
        <div class="rs-stat__label">Kosong</div>
      </div>
      <div class="rs-stat">
        <div class="rs-stat__num">${_internal._formatDuration(durSec)}</div>
        <div class="rs-stat__label">Durasi</div>
      </div>
    `;

    const detailEl = document.getElementById('result-detail');
    const gradingDetail = Array.isArray(result.grading_detail) ? result.grading_detail : [];

    const bySection = {};
    gradingDetail.forEach(item => {
      const key = `section_${item.section_idx}`;
      if (!bySection[key]) bySection[key] = { name: item.section_name || `Bagian ${item.section_idx + 1}`, items: [] };
      bySection[key].items.push(item);
    });

    if (gradingDetail.length === 0) {
      state.soalPages.forEach((page, idx) => {
        const key = page.pageKey;
        bySection[key] = { name: page.label, items: page.questions.map(q => ({
          section_idx: idx,
          section_name: page.label,
          idq: q.idq,
          type: page.typeQuestion,
          peserta_answer: state.jawaban[`${key}__${q.idq}`] || null,
          jawaban_benar: q.jawaban_benar || null,
          is_correct: false,
          status: 'kosong',
          points: 0,
          max_points: q.skor || 0,
        })) };
      });
    }

    detailEl.innerHTML = Object.values(bySection).map(sec => `
      <div class="rs-section">
        <h3 class="rs-section__title">${_internal._escAttr(sec.name)}</h3>
        ${sec.items.map((item, i) => _renderResultItem(item, i)).join('')}
      </div>
    `).join('');

    const backBtn = document.getElementById('btn-back-login');
    if (backBtn) {
      backBtn.onclick = () => {
        if (window.Auth?.authLogout) {
          window.Auth.authLogout({ skipConfirm: true });
        } else {
          window.location.href = '../login.html';
        }
      };
    }

    // Wire collapsible detail toggle
    const toggleBtn = document.getElementById('btn-toggle-detail');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        const expanded = toggleBtn.getAttribute('aria-expanded') === 'true';
        toggleBtn.setAttribute('aria-expanded', String(!expanded));
        if (detailEl) detailEl.hidden = expanded;
      });
    }

    _internal._renderMath(detailEl);
    window.AlbEdu?.bindIcons?.(detailEl);
  }

  function _renderResultItem(item, idx) {
    const status = item.status || (item.is_correct ? 'benar' : 'salah');
    const statusLabel = { benar: 'Benar', salah: 'Salah', kosong: 'Kosong' }[status] || status;
    const q = _internal._findQuestion(item.section_idx, item.idq);
    const qText = q ? _internal._sanitizeHTML(q.pertanyaan || '') : `(soal ${item.idq})`;

    let metaHTML = '';
    if (item.type === 'PG') {
      metaHTML = `
        <div><strong>Jawaban Anda:</strong> ${item.peserta_answer ? _internal._escAttr(item.peserta_answer) : '<em>(kosong)</em>'}</div>
        <div><strong>Kunci:</strong> ${item.jawaban_benar ? _internal._escAttr(item.jawaban_benar) : '<em>(esai)</em>'}</div>
      `;
    } else {
      metaHTML = `
        <div><strong>Jawaban Anda:</strong> ${item.peserta_answer ? _internal._escAttr(String(item.peserta_answer).slice(0, 200)) : '<em>(kosong)</em>'}</div>
        <div><em>Esai dinilai manual oleh guru</em></div>
      `;
    }

    return `
      <div class="rs-item">
        <div class="rs-item__head">
          <span class="rs-item__num">${idx + 1}</span>
          <span class="rs-item__status ${status}">${statusLabel}</span>
        </div>
        <div class="rs-item__q">${qText}</div>
        <div class="rs-item__meta">${metaHTML}</div>
      </div>
    `;
  }

  Object.assign(_internal, {
    _submitExam,
    _confirmSubmit,
    _showSubmitRetryError,
    _renderResult,
    _renderResultItem,
  });
})();
