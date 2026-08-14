// results-analytics.js — v2: Card-based hasil peserta with expandable detail
//
// Flow:
//   1. Load assessments (admin's own)
//   2. On select → load submissions for that assessment
//   3. Render summary bar (count, mean, highest, lowest)
//   4. Render submission cards (name, correct, wrong, score)
//   5. Click card → expand detail (per-question: question, student answer, correct answer, status)
//
// DB schema:
//   submissions(id, assessment_id, session_id, user_id, identity_snapshot jsonb,
//               answers jsonb, score numeric, max_score int, correct_count int,
//               total_count int, grading_detail jsonb, duration_seconds int,
//               submitted_at timestamptz, attempt_number int)
//   assessments(id, access_code, title, subject, sections jsonb, status, created_by)

(function () {
  'use strict';

  const _state = {
    assessments: [],
    selectedAssessmentId: '',
    selectedAssessment: null,
    submissions: [],
  };

  function _esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function _truncate(str, n) {
    const s = String(str ?? '').replace(/\s+/g, ' ').trim();
    return s.length <= n ? s : s.slice(0, n).trimEnd() + '…';
  }

  function _formatDate(v) {
    if (!v) return '—';
    try {
      return new Date(v).toLocaleString('id-ID', {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
      });
    } catch { return '—'; }
  }

  function _formatDuration(seconds) {
    if (!seconds || seconds < 1) return '—';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m > 0 ? `${m}m ${s}d` : `${s}d`;
  }

  function _getDisplayName(submission) {
    const snap = submission.identity_snapshot;
    if (snap) {
      return snap._display_name || snap.nama || snap.field_nama || submission.user_email || 'Peserta';
    }
    return submission.user_email || 'Peserta';
  }

  function _getScoreColor(score, maxScore) {
    if (!maxScore || maxScore === 0) return 'ra-score-neutral';
    const pct = (score / maxScore) * 100;
    if (pct >= 75) return 'ra-score-high';
    if (pct >= 50) return 'ra-score-mid';
    return 'ra-score-low';
  }

  // ═══════════════════════════════════════════════════════════════
  // Boot
  // ═══════════════════════════════════════════════════════════════
  async function _init() {
    // Wait for auth + supabase
    await _waitForAuth();

    // Wire controls
    document.getElementById('ra-assessment-select')?.addEventListener('change', (e) => {
      _state.selectedAssessmentId = e.target.value;
      if (e.target.value) _loadSubmissions();
      else _showEmptySelect();
    });

    document.getElementById('btn-ra-export-excel')?.addEventListener('click', _exportExcel);
    document.getElementById('btn-ra-export-json')?.addEventListener('click', _exportJSON);

    // Load assessments
    await _loadAssessments();
  }

  function _waitForAuth() {
    // FIX v0.855.0: Wait for an actual authenticated session, not just the
    // client object. The client can exist long before getSession() returns
    // a valid user. We now poll for a real session with a user.id.
    return new Promise((resolve) => {
      let attempts = 0;
      const check = async () => {
        attempts++;
        const sb = window.AlbEdu?.supabase?.client;
        if (sb) {
          try {
            const { data: { session } } = await sb.auth.getSession();
            if (session?.user?.id) {
              resolve();
              return;
            }
          } catch (_) { /* session not ready yet */ }
        }
        if (attempts < 100) {
          setTimeout(check, 100);
        } else {
          resolve(); // give up after 10s, let downstream handle error
        }
      };
      check();
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // Load assessments
  // ═══════════════════════════════════════════════════════════════
  async function _loadAssessments() {
    const sb = window.AlbEdu?.supabase?.client;
    if (!sb) {
      console.warn('[results] Supabase client not ready');
      _showAssessmentError('Sistem belum siap. Muat ulang halaman.');
      return;
    }

    try {
      const { data: { session } } = await sb.auth.getSession();
      if (!session?.user?.id) {
        console.warn('[results] No authenticated session');
        _showAssessmentError('Sesi tidak ditemukan. Silakan login ulang.');
        return;
      }

      const { data, error } = await sb
        .from('assessments')
        .select('id, title, subject, access_code, status, sections')
        .eq('created_by', session.user.id)
        .in('status', ['active', 'archived'])  // FIX: show archived too — results still accessible
        .order('created_at', { ascending: false });

      if (error) throw error;

      _state.assessments = data || [];
      if (_state.assessments.length === 0) {
        _showAssessmentEmpty();
      } else {
        _populateAssessmentSelect();
      }
    } catch (err) {
      console.error('[results] loadAssessments:', err);
      _showAssessmentError('Gagal memuat daftar asesmen: ' + (err?.message || 'Unknown error'));
    }
  }

  // Show error state in the assessment select (distinguish from empty/loading)
  function _showAssessmentError(msg) {
    const sel = document.getElementById('ra-assessment-select');
    if (sel) {
      sel.innerHTML = `<option value="">— Gagal memuat —</option>`;
      sel.disabled = false;
    }
    window.notify?.error?.('Gagal Memuat Asesmen', msg, 5000);
  }

  // Show empty state (admin has no assessments yet)
  function _showAssessmentEmpty() {
    const sel = document.getElementById('ra-assessment-select');
    if (sel) {
      sel.innerHTML = `<option value="">— Belum ada asesmen —</option>`;
    }
  }

  function _populateAssessmentSelect() {
    const sel = document.getElementById('ra-assessment-select');
    if (!sel) return;

    const options = ['<option value="">— Pilih asesmen —</option>']
      .concat(_state.assessments.map(a => {
        const archived = a.status === 'archived' ? ' (Arsip)' : '';
        const label = `${a.title || 'Tanpa Judul'}${a.subject ? ' · ' + a.subject : ''}${a.access_code ? ' · ' + a.access_code : ''}${archived}`;
        return `<option value="${a.id}">${_esc(label)}</option>`;
      }))
      .join('');
    sel.innerHTML = options;
  }

  // ═══════════════════════════════════════════════════════════════
  // Load submissions
  // ═══════════════════════════════════════════════════════════════
  async function _loadSubmissions() {
    _showLoading();

    const sb = window.AlbEdu?.supabase?.client;
    if (!sb) {
      _showSubmissionsError('Sistem belum siap. Muat ulang halaman.');
      return;
    }

    try {
      // Find the assessment (for sections data — needed to render question details)
      _state.selectedAssessment = _state.assessments.find(a => a.id === _state.selectedAssessmentId);

      const { data, error } = await sb
        .from('submissions')
        .select('*')
        .eq('assessment_id', _state.selectedAssessmentId)
        .order('submitted_at', { ascending: false });

      if (error) throw error;

      _state.submissions = data || [];

      if (_state.submissions.length === 0) {
        _showEmpty();
        return;
      }

      _renderSummary();
      _renderSubmissions();
      _enableExportButtons();
    } catch (err) {
      console.error('[results] loadSubmissions:', err);
      _showSubmissionsError('Gagal memuat hasil: ' + (err?.message || 'Unknown error'));
    }
  }

  // Show error state for submissions (don't mask as empty select)
  function _showSubmissionsError(msg) {
    const list = document.getElementById('ra-submissions-list');
    if (list) {
      list.innerHTML = `
        <div class="ra-empty" role="alert">
          <span data-albedu-icon="error" style="font-size:48px;color:var(--albedu-danger,#EF4444);"></span>
          <h3>Gagal Memuat Hasil</h3>
          <p>${msg}</p>
          <button class="albedu-btn albedu-btn-secondary" onclick="window.ResultsAnalytics._retry()">Coba Lagi</button>
        </div>
      `;
      window.AlbEdu?.bindIcons?.(list);
    }
    window.notify?.error?.('Gagal Memuat Hasil', msg, 5000);
  }

  // ═══════════════════════════════════════════════════════════════
  // Render summary bar
  // ═══════════════════════════════════════════════════════════════
  function _renderSummary() {
    const subs = _state.submissions;
    const count = subs.length;
    const scores = subs.map(s => Number(s.score) || 0);
    const mean = count > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / count) : 0;
    const highest = count > 0 ? Math.max(...scores) : 0;
    const lowest = count > 0 ? Math.min(...scores) : 0;

    document.getElementById('ra-summary-count').textContent = count;
    document.getElementById('ra-summary-mean').textContent = mean;
    document.getElementById('ra-summary-highest').textContent = highest;
    document.getElementById('ra-summary-lowest').textContent = lowest;

    document.getElementById('ra-summary').hidden = false;
  }

  // ═══════════════════════════════════════════════════════════════
  // Render submission cards
  // ═══════════════════════════════════════════════════════════════
  function _renderSubmissions() {
    const container = document.getElementById('ra-submissions');
    if (!container) return;

    document.getElementById('ra-loading').hidden = true;
    document.getElementById('ra-empty-select').hidden = true;
    document.getElementById('ra-empty').hidden = true;
    container.hidden = false;

    container.innerHTML = _state.submissions.map((sub, idx) => _renderCard(sub, idx)).join('');

    // Wire click to expand/collapse
    container.querySelectorAll('.ra-card').forEach(card => {
      card.addEventListener('click', (e) => {
        // Don't toggle if clicking inside the detail (links, buttons)
        if (e.target.closest('.ra-detail')) return;
        card.classList.toggle('ra-card-expanded');
        const detail = card.querySelector('.ra-detail');
        if (detail) {
          detail.hidden = !card.classList.contains('ra-card-expanded');
        }
      });
    });
  }

  function _renderCard(sub, idx) {
    const name = _getDisplayName(sub);
    const score = Number(sub.score) || 0;
    const maxScore = Number(sub.max_score) || 100;
    const correct = Number(sub.correct_count) || 0;
    const total = Number(sub.total_count) || 0;
    const wrong = total - correct;
    const scoreClass = _getScoreColor(score, maxScore);
    const submittedAt = _formatDate(sub.submitted_at);
    const duration = _formatDuration(sub.duration_seconds);
    const attempt = sub.attempt_number || 1;

    // Build detail HTML (per-question breakdown)
    const detailHTML = _renderDetail(sub);

    return `
      <div class="ra-card" data-submission-id="${_esc(sub.id)}">
        <div class="ra-card__header">
          <div class="ra-card__identity">
            <div class="ra-card__avatar">${_esc(name.charAt(0).toUpperCase())}</div>
            <div class="ra-card__info">
              <div class="ra-card__name">${_esc(name)}</div>
              <div class="ra-card__meta">
                <span><span data-albedu-icon="schedule"></span> ${submittedAt}</span>
                <span><span data-albedu-icon="timer"></span> ${duration}</span>
                <span><span data-albedu-icon="refresh"></span> Percobaan ${attempt}</span>
              </div>
            </div>
          </div>
          <div class="ra-card__stats">
            <div class="ra-card__stat ra-card__stat--correct">
              <span class="ra-card__stat-value">${correct}</span>
              <span class="ra-card__stat-label">Benar</span>
            </div>
            <div class="ra-card__stat ra-card__stat--wrong">
              <span class="ra-card__stat-value">${wrong}</span>
              <span class="ra-card__stat-label">Salah</span>
            </div>
            <div class="ra-card__stat ra-card__stat--score ${scoreClass}">
              <span class="ra-card__stat-value">${score}</span>
              <span class="ra-card__stat-label">/${maxScore}</span>
            </div>
          </div>
          <div class="ra-card__chevron">
            <span data-albedu-icon="expand_more"></span>
          </div>
        </div>
        <div class="ra-detail" hidden>
          ${detailHTML}
        </div>
      </div>
    `;
  }

  // ═══════════════════════════════════════════════════════════════
  // Render detail (per-question breakdown)
  // ═══════════════════════════════════════════════════════════════
  function _renderDetail(sub) {
    // FORENSIC SNAPSHOT: Prefer submission's snapshot over live assessment data.
    // This fixes 2 bugs:
    // 1. If assessment is deleted (SET NULL), snapshot still has sections
    // 2. If assessment sections are edited after submit, snapshot has ORIGINAL
    const assessment = _state.selectedAssessment;
    const sections = sub.assessment_sections_snapshot
      || (assessment && assessment.sections)
      || null;

    if (!sections || !Array.isArray(sections)) {
      return '<div class="ra-detail__empty">Data soal tidak tersedia.</div>';
    }

    const answers = sub.answers || {};
    const gradingDetail = sub.grading_detail || {};

    let html = '';

    sections.forEach((sec, sIdx) => {
      const secName = sec.name || `Bagian ${sIdx + 1}`;
      const secType = sec.type_question || 'PG';
      const questions = Array.isArray(sec.questions) ? sec.questions : [];
      const sectionAnswers = answers[`section_${sIdx}`] || {};

      html += `<div class="ra-detail__section">`;
      html += `<div class="ra-detail__section-title">${_esc(secName)} <span class="ra-detail__section-type">${secType === 'PG' ? 'Pilihan Ganda' : 'Esai'}</span></div>`;

      questions.forEach((q, qIdx) => {
        const studentAnswer = sectionAnswers[String(qIdx + 1)] || sectionAnswers[qIdx] || '';
        const correctAnswer = q.jawaban_benar || '';
        const questionText = _truncate(q.pertanyaan || 'Soal kosong', 100);
        const isCorrect = gradingDetail[`section_${sIdx}`]?.[qIdx]?.correct ?? (studentAnswer === correctAnswer && secType === 'PG');

        let statusBadge = '';
        let answerDisplay = '';

        if (secType === 'PG') {
          if (!studentAnswer) {
            statusBadge = '<span class="ra-detail__badge ra-detail__badge--empty">Kosong</span>';
            answerDisplay = '<span class="ra-detail__answer ra-detail__answer--empty">Tidak dijawab</span>';
          } else if (isCorrect) {
            statusBadge = '<span class="ra-detail__badge ra-detail__badge--correct">✓ Benar</span>';
            answerDisplay = `<span class="ra-detail__answer">Jawaban: <strong>${_esc(studentAnswer)}</strong></span>`;
          } else {
            statusBadge = '<span class="ra-detail__badge ra-detail__badge--wrong">✗ Salah</span>';
            answerDisplay = `<span class="ra-detail__answer ra-detail__answer--wrong">Jawaban: <strong>${_esc(studentAnswer)}</strong></span>`;
          }
          if (correctAnswer) {
            answerDisplay += `<span class="ra-detail__correct-answer">Benar: <strong>${_esc(correctAnswer)}</strong></span>`;
          }
        } else {
          // Esai
          statusBadge = '<span class="ra-detail__badge ra-detail__badge--essay">Esai</span>';
          answerDisplay = studentAnswer
            ? `<div class="ra-detail__essay">${_esc(_truncate(studentAnswer, 200))}</div>`
            : '<span class="ra-detail__answer ra-detail__answer--empty">Tidak dijawab</span>';
        }

        html += `
          <div class="ra-detail__question">
            <div class="ra-detail__q-header">
              <span class="ra-detail__q-num">${qIdx + 1}</span>
              <span class="ra-detail__q-text">${_esc(questionText)}</span>
              ${statusBadge}
            </div>
            <div class="ra-detail__q-body">
              ${answerDisplay}
            </div>
          </div>
        `;
      });

      html += `</div>`;
    });

    if (!html) {
      html = '<div class="ra-detail__empty">Tidak ada data soal.</div>';
    }

    return html;
  }

  // ═══════════════════════════════════════════════════════════════
  // UI state helpers
  // ═══════════════════════════════════════════════════════════════
  function _showLoading() {
    document.getElementById('ra-loading').hidden = false;
    document.getElementById('ra-empty-select').hidden = true;
    document.getElementById('ra-empty').hidden = true;
    document.getElementById('ra-submissions').hidden = true;
    document.getElementById('ra-summary').hidden = true;
    _disableExportButtons();
  }

  function _showEmptySelect() {
    document.getElementById('ra-loading').hidden = true;
    document.getElementById('ra-empty-select').hidden = false;
    document.getElementById('ra-empty').hidden = true;
    document.getElementById('ra-submissions').hidden = true;
    document.getElementById('ra-summary').hidden = true;
    _disableExportButtons();
  }

  function _showEmpty() {
    document.getElementById('ra-loading').hidden = true;
    document.getElementById('ra-empty-select').hidden = true;
    document.getElementById('ra-empty').hidden = false;
    document.getElementById('ra-submissions').hidden = true;
    document.getElementById('ra-summary').hidden = true;
    _disableExportButtons();
  }

  function _enableExportButtons() {
    document.getElementById('btn-ra-export-excel').disabled = false;
    document.getElementById('btn-ra-export-json').disabled = false;
  }

  function _disableExportButtons() {
    document.getElementById('btn-ra-export-excel').disabled = true;
    document.getElementById('btn-ra-export-json').disabled = true;
  }

  // ═══════════════════════════════════════════════════════════════
  // Export
  // ═══════════════════════════════════════════════════════════════
  function _exportJSON() {
    if (_state.submissions.length === 0) return;
    const data = {
      assessment: _state.selectedAssessment?.title || 'Unknown',
      exported_at: new Date().toISOString(),
      submissions: _state.submissions,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    _downloadBlob(blob, `hasil-${_state.selectedAssessment?.access_code || 'asesmen'}.json`);
  }

  function _exportExcel() {
    if (_state.submissions.length === 0) return;
    const rows = [['Nama', 'Email', 'Nilai', 'Max', 'Benar', 'Salah', 'Total Soal', 'Durasi (d)', 'Dikumpulkan']];
    _state.submissions.forEach(sub => {
      const name = _getDisplayName(sub);
      const correct = Number(sub.correct_count) || 0;
      const total = Number(sub.total_count) || 0;
      rows.push([
        name,
        sub.user_email || '',
        sub.score || 0,
        sub.max_score || 100,
        correct,
        total - correct,
        total,
        sub.duration_seconds || 0,
        sub.submitted_at || '',
      ]);
    });
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    _downloadBlob(blob, `hasil-${_state.selectedAssessment?.access_code || 'asesmen'}.csv`);
  }

  function _downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ═══════════════════════════════════════════════════════════════
  // Public API (exposed for retry button + debugging)
  // ═══════════════════════════════════════════════════════════════
  window.ResultsAnalytics = {
    _retry: () => {
      if (_state.selectedAssessmentId) {
        _loadSubmissions();
      } else {
        _loadAssessments();
      }
    },
    reload: () => _loadAssessments(),
  };

  // ═══════════════════════════════════════════════════════════════
  // Boot
  // ═══════════════════════════════════════════════════════════════
  // FIX v0.855.0: Drop `{ once: true }` — it fires on the FIRST auth-ready
  // event which has role=null (before role is resolved). Gate on role==='admin'
  // instead, matching the pattern used by byteward.js, navigasi.js, and
  // self-storage.js. This was the root cause of "no assessments showing" —
  // _init() ran with no session, _loadAssessments() silently returned empty.
  function _tryInit(e) {
    const role = e?.detail?.role || window.Auth?.userRole;
    if (role === 'admin') {
      document.removeEventListener('auth-ready', _tryInit);
      _init();
    }
  }

  if (window.Auth?.authReady && window.Auth?.userRole === 'admin') {
    _init();
  } else {
    document.addEventListener('auth-ready', _tryInit);
  }
})();
