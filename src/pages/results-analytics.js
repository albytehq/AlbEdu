// =============================================================================
// results-analytics.js — AlbEdu Hasil & Analitik v1.0.0
// =============================================================================
//
// Analytics dashboard for admin. Loads submissions for a given assessment,
// computes statistics, renders CSS-only histogram, item-difficulty table with
// distractor analysis, and per-class breakdown. Exports to PDF (print),
// Excel (CSV), and JSON.
//
// DB access: AlbEdu.repository (native Supabase).
//            See /src/legacy/firebase-compat.js for the bridge layer.
//
// Schema (already exists):
//   submissions(
//     id uuid PK,
//     assessment_id uuid,
//     session_id uuid,
//     user_id uuid,
//     identity_snapshot jsonb,     -- { nama, kelas, isManual, ... }
//     answers jsonb,               -- { "section_0": { "1": "A", "2": "B" } }
//     score numeric(5,2),
//     max_score int DEFAULT 100,
//     correct_count int,
//     total_count int,
//     grading_detail jsonb,        -- [{ section_idx, idq, peserta_answer, jawaban_benar, is_correct, status, points }]
//     duration_seconds int,
//     submitted_at timestamptz,
//     attempt_number int DEFAULT 1
//   )
//
//   assessments(id, access_code, title, subject, sections jsonb, status)
//
// Depends on:
//   - AlbEdu.repository             (typed table access)
//   - AlbEdu.supabase.auth          (native auth)
//   - window.notify / .confirm     (QNotify bridge)
// =============================================================================

(function () {
  'use strict';

  const t = (key, vars, fallback) => fallback;

  // ─── Constants ──────────────────────────────────────────────────────────
  const COLLECTION_ASSESSMENTS = 'assessments';
  const COLLECTION_SUBMISSIONS = 'submissions';
  const AUTH_WAIT_TIMEOUT_MS   = 10_000;
  const HISTOGRAM_BIN_COUNT    = 10;   // 10 bins of width 10
  const OPTION_KEYS            = ['A', 'B', 'C', 'D'];
  const QUESTION_TRUNCATE_LEN  = 80;

  // ─── State ──────────────────────────────────────────────────────────────
  const _state = {
    user:                  null,
    assessments:           [],   // [{ id, title, access_code, subject, status, sections, ... }]
    selectedAssessmentId:  '',
    selectedAssessment:    null, // full assessment object (with sections)
    submissions:           [],   // normalized submissions
  };

  // ─── DOM cache ──────────────────────────────────────────────────────────
  const _dom = {};

  // ─── Helpers ────────────────────────────────────────────────────────────

  function _t(key, params) { return key; }

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

  function _safeNum(v, fallback) {
    if (v === null || v === undefined || v === '') return fallback ?? 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : (fallback ?? 0);
  }

  function _formatDate(v) {
    if (!v) return '—';
    try {
      const d = v instanceof Date ? v : new Date(v);
      if (isNaN(d.getTime())) return '—';
      return d.toLocaleString('id-ID', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    } catch (_) {
      return '—';
    }
  }

  function _formatDuration(sec) {
    const s = _safeNum(sec, 0);
    if (s <= 0) return '0s';
    const m = Math.floor(s / 60);
    const r = s % 60;
    if (m >= 60) {
      const h = Math.floor(m / 60);
      return `${h}j ${m % 60}m`;
    }
    if (m > 0) return `${m}m ${r}s`;
    return `${r}s`;
  }

  function _round(n, decimals) {
    const f = Math.pow(10, decimals ?? 2);
    return Math.round((n + Number.EPSILON) * f) / f;
  }

  function _todayStamp() {
    const d = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  }

  // ─── Firebase / Auth wait ───────────────────────────────────────────────

  async function _waitForFirebase(timeout) {
    if (window.AlbEdu?.supabase?.isReady?.()) return true;
    if (typeof window.waitForFirebase === 'function') {
      try {
        await window.waitForFirebase(timeout);
        return true;
      } catch (_) {
        return false;
      }
    }
    return new Promise((resolve) => {
      const t = setTimeout(() => { cleanup(); resolve(false); }, timeout);
      function cleanup() {
        clearTimeout(t);
        document.removeEventListener('albedu:platform-ready', onReady);
        document.removeEventListener('albedu:platform-error', onError);
      }
      function onReady() { cleanup(); resolve(true); }
      function onError() { cleanup(); resolve(false); }
      document.addEventListener('albedu:platform-ready', onReady, { once: true });
      document.addEventListener('albedu:platform-error', onError, { once: true });
    });
  }

  async function _waitForAuth(timeout) {
    const auth = window.AlbEdu?.supabase?.auth;
    if (auth && auth.currentUser) return auth.currentUser;

    return new Promise((resolve) => {
      let settled = false;
      let unsub = null;
      let poll  = null;

      const done = (user) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (unsub) { try { unsub(); } catch (_) {} }
        if (poll)  clearInterval(poll);
        resolve(user || null);
      };
      const timer = setTimeout(() => done(null), timeout);

      try {
        unsub = auth && typeof auth.onAuthStateChange === 'function'
          ? auth.onAuthStateChange((u) => { if (u) done(u); })
          : null;
      } catch (_) { /* noop */ }

      poll = setInterval(() => {
        if (window.AlbEdu?.supabase?.auth?.currentUser) {
          done(window.AlbEdu.supabase.auth.currentUser);
        }
      }, 200);
    });
  }

  // ─── DOM cache + wiring ─────────────────────────────────────────────────

  function _cacheDom() {
    _dom.selectAssessment = document.getElementById('ra-assessment-select');
    _dom.btnExportPdf     = document.getElementById('btn-ra-export-pdf');
    _dom.btnExportExcel   = document.getElementById('btn-ra-export-excel');
    _dom.btnExportJson    = document.getElementById('btn-ra-export-json');

    _dom.statsGrid        = document.getElementById('ra-stats');
    _dom.statMean         = document.getElementById('ra-stat-mean');
    _dom.statMedian       = document.getElementById('ra-stat-median');
    _dom.statMin          = document.getElementById('ra-stat-min');
    _dom.statMax          = document.getElementById('ra-stat-max');
    _dom.statStd          = document.getElementById('ra-stat-std');
    _dom.statCount        = document.getElementById('ra-stat-count');

    _dom.histogramSection = document.getElementById('ra-histogram-section');
    _dom.histogram        = document.getElementById('ra-histogram');

    _dom.itemSection      = document.getElementById('ra-item-section');
    _dom.itemTbody        = document.getElementById('ra-item-tbody');

    _dom.classSection     = document.getElementById('ra-class-section');
    _dom.classTbody       = document.getElementById('ra-class-tbody');

    _dom.emptySelect      = document.getElementById('ra-empty-select');
    _dom.empty            = document.getElementById('ra-empty');
  }

  function _wireEvents() {
    if (_dom.selectAssessment) {
      _dom.selectAssessment.addEventListener('change', (e) => {
        _state.selectedAssessmentId = e.target.value || '';
        _state.selectedAssessment   = _state.assessments.find((a) => a.id === _state.selectedAssessmentId) || null;
        if (_state.selectedAssessmentId) _loadSubmissions();
        else _showEmptySelect();
      });
    }
    if (_dom.btnExportPdf)   _dom.btnExportPdf.addEventListener('click',   () => _exportPdf());
    if (_dom.btnExportExcel) _dom.btnExportExcel.addEventListener('click', () => _exportExcel());
    if (_dom.btnExportJson)  _dom.btnExportJson.addEventListener('click',  () => _exportJson());
  }

  // ─── Load assessments ───────────────────────────────────────────────────

  async function _loadAssessments() {
    const repo = window.AlbEdu?.repository;
    if (!repo) {
      window.notify?.error?.(
        t('results.db_not_available_title', null, 'DB Tidak Tersedia'),
        t('results.db_not_available_msg', null, 'Platform layer belum siap.')
      );
      return;
    }
    try {
      // Native repository — note: 'in' filter not directly supported in our helper,
      // so we fetch all and filter client-side (small dataset: assessments per admin).
      const snap = await repo.getDocs(COLLECTION_ASSESSMENTS, {
        order: { column: 'created_at', ascending: false },
      });

      _state.assessments = (snap.docs || [])
        .map((d) => {
          const data = d.data() || {};
          return _normalizeAssessment(d.id, data);
        })
        .filter(a => a.status === 'active' || a.status === 'archived');

      _populateDropdown();
    } catch (err) {
      console.error('[ResultsAnalytics] load assessments:', err);
      window.notify?.error?.(
        t('results.load_failed_title', null, 'Gagal Memuat Asesmen'),
        (err && err.message) || t('results.load_failed_msg', null, 'Tidak dapat memuat daftar asesmen.')
      );
      _state.assessments = [];
      _populateDropdown();
    }
  }

  function _normalizeAssessment(id, data) {
    return {
      id,
      access_code: data.access_code || data.accessCode || '',
      title:       data.title || '(Tanpa Judul)',
      subject:     data.subject || '',
      status:      data.status || 'active',
      sections:    Array.isArray(data.sections) ? data.sections : [],
      created_at:  data.created_at || data.createdAt || null,
    };
  }

  function _populateDropdown() {
    if (!_dom.selectAssessment) return;
    const current = _dom.selectAssessment.value;

    // Preserve first option (placeholder)
    const placeholder = _dom.selectAssessment.querySelector('option:first-child');
    _dom.selectAssessment.innerHTML = '';
    if (placeholder) _dom.selectAssessment.appendChild(placeholder);

    for (const a of _state.assessments) {
      const opt = document.createElement('option');
      opt.value = a.id;
      const codeTag = a.access_code ? ` [${a.access_code}]` : '';
      const subjTag = a.subject ? ` · ${a.subject}` : '';
      opt.textContent = `${a.title}${subjTag}${codeTag}`;
      _dom.selectAssessment.appendChild(opt);
    }

    // Restore previous selection if still present
    if (current && _state.assessments.some((a) => a.id === current)) {
      _dom.selectAssessment.value = current;
    }
  }

  // ─── Load submissions ───────────────────────────────────────────────────

  async function _loadSubmissions() {
    const repo = window.AlbEdu?.repository;
    if (!repo || !_state.selectedAssessmentId) return;

    _setBusy(true);
    try {
      const snap = await repo.getDocs(COLLECTION_SUBMISSIONS, {
        eq: { assessment_id: _state.selectedAssessmentId },
        order: { column: 'submitted_at', ascending: false },
      });

      _state.submissions = (snap.docs || []).map((d) => {
        const data = d.data() || {};
        return _normalizeSubmission(d.id, data);
      });

      if (_state.submissions.length === 0) {
        _showEmptyData();
        return;
      }

      _renderAll();
    } catch (err) {
      console.error('[ResultsAnalytics] load submissions:', err);
      window.notify?.error?.(
        'Gagal Memuat Hasil',
        (err && err.message) || 'Tidak dapat memuat data submission.'
      );
      _state.submissions = [];
      _showEmptyData();
    } finally {
      _setBusy(false);
    }
  }

  function _normalizeSubmission(id, data) {
    const identity = (data.identity_snapshot && typeof data.identity_snapshot === 'object'
                      && !Array.isArray(data.identity_snapshot))
      ? data.identity_snapshot : {};

    let grading = data.grading_detail;
    if (!Array.isArray(grading)) grading = [];

    let answers = data.answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) answers = {};

    return {
      id,
      assessment_id:    data.assessment_id || data.assessmentId || null,
      session_id:       data.session_id    || data.sessionId    || null,
      user_id:          data.user_id       || data.userId       || null,
      identity_snapshot: {
        nama:     identity.nama     ?? identity.name     ?? identity._display_name ?? '',
        kelas:    identity.kelas    ?? identity.class    ?? '',
        isManual: identity.isManual ?? (identity.is_manual ?? null),
      },
      raw_identity: identity,
      answers,
      score:           _safeNum(data.score, null),
      max_score:       _safeNum(data.max_score, 100),
      correct_count:   _safeNum(data.correct_count, 0),
      total_count:     _safeNum(data.total_count, 0),
      grading_detail:  grading,
      duration_seconds: _safeNum(data.duration_seconds, 0),
      submitted_at:    data.submitted_at || data.submittedAt || null,
      attempt_number:  _safeNum(data.attempt_number, 1),
    };
  }

  // ─── Statistics ─────────────────────────────────────────────────────────

  function _computeStats(subs) {
    const scores = subs
      .map((s) => s.score)
      .filter((v) => v !== null && Number.isFinite(v))
      .map(Number);
    const n = scores.length;
    if (n === 0) {
      return { mean: null, median: null, min: null, max: null, std: null, count: 0 };
    }
    const sum = scores.reduce((a, b) => a + b, 0);
    const mean = sum / n;
    const sorted = [...scores].sort((a, b) => a - b);
    const mid = Math.floor(n / 2);
    const median = (n % 2 === 0)
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
    const min = sorted[0];
    const max = sorted[n - 1];
    const variance = scores.reduce((acc, s) => acc + Math.pow(s - mean, 2), 0) / n;
    const std = Math.sqrt(variance);
    return {
      mean:   _round(mean,   2),
      median: _round(median, 2),
      min:    _round(min,    2),
      max:    _round(max,    2),
      std:    _round(std,    2),
      count:  n,
    };
  }

  function _renderStats(stats) {
    if (_dom.statMean)   _dom.statMean.textContent   = stats.mean   === null ? '—' : String(stats.mean);
    if (_dom.statMedian) _dom.statMedian.textContent = stats.median === null ? '—' : String(stats.median);
    if (_dom.statMin)    _dom.statMin.textContent    = stats.min    === null ? '—' : String(stats.min);
    if (_dom.statMax)    _dom.statMax.textContent    = stats.max    === null ? '—' : String(stats.max);
    if (_dom.statStd)    _dom.statStd.textContent    = stats.std    === null ? '—' : String(stats.std);
    if (_dom.statCount)  _dom.statCount.textContent  = String(stats.count);
  }

  // ─── Histogram ──────────────────────────────────────────────────────────

  function _binIndex(score) {
    if (score <= 0)   return 0;
    if (score >= 100) return HISTOGRAM_BIN_COUNT - 1;
    return Math.min(HISTOGRAM_BIN_COUNT - 1, Math.ceil(score / 10) - 1);
  }

  function _computeHistogram(subs) {
    const bins = new Array(HISTOGRAM_BIN_COUNT).fill(0);
    for (const s of subs) {
      if (s.score === null || !Number.isFinite(s.score)) continue;
      bins[_binIndex(Number(s.score))]++;
    }
    return bins;
  }

  function _renderHistogram(bins, totalCount) {
    if (!_dom.histogram) return;
    const max = Math.max(1, ...bins);
    _dom.histogram.innerHTML = '';

    bins.forEach((count, idx) => {
      const bar = document.createElement('div');
      bar.className = 'ra-histo-bar';
      const pct = totalCount > 0 ? ((count / totalCount) * 100) : 0;
      // Height proportional to count (at least 2px so empty bars are visible)
      const heightPct = max > 0 ? (count / max) * 100 : 0;
      bar.style.height = count === 0 ? '2px' : `${Math.max(4, heightPct)}%`;
      bar.setAttribute('data-count', String(count));
      const lo = idx * 10;
      const hi = idx === 0 ? 10 : (idx * 10 + 10);
      bar.setAttribute('title', `${lo}-${hi}: ${count} peserta (${_round(pct, 1)}%)`);
      bar.setAttribute('aria-label', `Bin ${lo}-${hi}: ${count} peserta (${_round(pct, 1)}%)`);
      _dom.histogram.appendChild(bar);
    });
  }

  // ─── Item difficulty ────────────────────────────────────────────────────

  /**
   * Build a flat list of all questions across all sections:
   *   [{ section_idx, idq, type, pertanyaan, pilihan, jawaban_benar, skor }]
   * Defensive against missing/oddly-shaped sections (Firestore shim lowercases
   * keys — we normalize defensively).
   */
  function _flattenQuestions(sections) {
    if (!Array.isArray(sections)) return [];
    const out = [];
    sections.forEach((sec, sIdx) => {
      const questions = Array.isArray(sec?.questions) ? sec.questions : [];
      const typeQuestion = sec?.type_question || sec?.typeQuestion || 'PG';
      questions.forEach((q) => {
        const idq = q?.idq ?? q?.id ?? null;
        if (idq === null || idq === undefined) return;
        const pilihan = (q?.pilihan && typeof q.pilihan === 'object' && !Array.isArray(q.pilihan))
          ? q.pilihan : null;
        out.push({
          section_idx:    sIdx,
          idq,
          type:           typeQuestion === 'esai' ? 'esai' : 'PG',
          pertanyaan:     q?.pertanyaan || q?.question || '',
          pilihan,
          jawaban_benar:  q?.jawaban_benar || q?.jawabanBenar || null,
          skor:           _safeNum(q?.skor, 0),
        });
      });
    });
    return out;
  }

  /**
   * Find a grading_detail entry for a given (section_idx, idq) within one
   * submission's grading_detail array. Defensive against case differences.
   */
  function _findGradingEntry(grading, sectionIdx, idq) {
    if (!Array.isArray(grading)) return null;
    const idqStr = String(idq);
    return grading.find((g) => {
      if (!g) return false;
      const gSec = g.section_idx ?? g.sectionIdx;
      const gIdq = String(g.idq ?? g.id ?? '');
      return gSec === sectionIdx && gIdq === idqStr;
    }) || null;
  }

  function _isCorrectEntry(g) {
    if (!g) return false;
    if (typeof g.is_correct === 'boolean') return g.is_correct;
    const st = String(g.status || '').toLowerCase();
    return st === 'benar' || st === 'correct';
  }

  function _entryAnswer(g) {
    if (!g) return null;
    const a = g.peserta_answer ?? g.pesertaAnswer ?? g.answer ?? null;
    return (a === null || a === undefined || a === '') ? null : String(a);
  }

  function _computeItemDifficulty(questions, subs) {
    const total = subs.length;
    return questions.map((q) => {
      let correct = 0;
      let answered = 0;
      // Distractor tally for PG
      const distractors = {};
      for (const k of OPTION_KEYS) distractors[k] = 0;
      let emptyCount = 0;

      for (const s of subs) {
        // Prefer grading_detail; fall back to answers[section_idx][idq]
        let entry = _findGradingEntry(s.grading_detail, q.section_idx, q.idq);
        let answer = null;
        if (entry) {
          answer = _entryAnswer(entry);
          if (_isCorrectEntry(entry)) correct++;
        } else {
          // Fallback: read raw answers
          const secKey = `section_${q.section_idx}`;
          const secAnswers = s.answers?.[secKey] || {};
          const raw = secAnswers[String(q.idq)];
          answer = (raw === null || raw === undefined || raw === '') ? null : String(raw);
          if (q.type === 'PG' && q.jawaban_benar && answer !== null
              && String(answer).toUpperCase() === String(q.jawaban_benar).toUpperCase()) {
            correct++;
          }
        }

        if (q.type === 'PG') {
          if (answer === null) {
            emptyCount++;
          } else {
            const up = String(answer).toUpperCase();
            if (OPTION_KEYS.includes(up)) {
              distractors[up]++;
              answered++;
            } else {
              // Unknown option — treat as empty
              emptyCount++;
            }
          }
        }
      }

      const pctCorrect = total > 0 ? (correct / total) * 100 : 0;
      let level = 'medium';
      if (pctCorrect >= 70) level = 'easy';
      else if (pctCorrect < 30) level = 'hard';

      return {
        ...q,
        total,
        correct,
        pctCorrect: _round(pctCorrect, 1),
        level,
        distractors: q.type === 'PG' ? distractors : null,
        emptyCount,
      };
    });
  }

  function _renderItemDifficulty(items) {
    if (!_dom.itemTbody) return;
    if (items.length === 0) {
      _dom.itemTbody.innerHTML = `
        <tr><td colspan="4" style="text-align:center;color:var(--albedu-body,#64748b);padding:24px;">
          Soal tidak tersedia pada asesmen ini.
        </td></tr>`;
      return;
    }

    _dom.itemTbody.innerHTML = items.map((it, idx) => {
      const qText = _esc(_truncate(_stripHtml(it.pertanyaan), QUESTION_TRUNCATE_LEN)) || `<em>(soal ${it.idq})</em>`;
      const fillPct = Math.max(0, Math.min(100, it.pctCorrect));
      const distractorHtml = it.distractors
        ? _renderDistractors(it.distractors, it.jawaban_benar, it.total, it.emptyCount)
        : `<span style="color:var(--albedu-body,#64748b);font-style:italic;">Esai — dinilai manual</span>`;

      return `
        <tr>
          <td><code>${idx + 1}</code></td>
          <td>${qText}</td>
          <td>
            <div class="ra-difficulty-bar">
              <div class="ra-difficulty-track">
                <div class="ra-difficulty-fill ${it.level}" style="width:${fillPct}%;"></div>
              </div>
              <span class="ra-difficulty-pct">${_round(it.pctCorrect, 1)}%</span>
            </div>
          </td>
          <td>${distractorHtml}</td>
        </tr>`;
    }).join('');
  }

  function _renderDistractors(distractors, jawabanBenar, total, emptyCount) {
    const correctKey = jawabanBenar ? String(jawabanBenar).toUpperCase() : null;
    const maxOpt = Math.max(1, ...Object.values(distractors), emptyCount);
    const rows = OPTION_KEYS.map((k) => {
      const c = distractors[k] || 0;
      const pct = total > 0 ? (c / total) * 100 : 0;
      const widthPct = (c / maxOpt) * 100;
      const isCorrect = (k === correctKey);
      return `
        <div class="ra-distractor-row">
          <span class="ra-distractor-label">${k}</span>
          <div class="ra-distractor-bar">
            <div class="ra-distractor-bar-fill ${isCorrect ? 'correct' : ''}" style="width:${widthPct}%;"></div>
          </div>
          <span class="ra-distractor-pct">${c}</span>
        </div>`;
    }).join('');
    // Append "kosong" row if any empty answers
    let extra = '';
    if (emptyCount > 0) {
      const widthPct = (emptyCount / maxOpt) * 100;
      extra = `
        <div class="ra-distractor-row">
          <span class="ra-distractor-label" style="color:#ef4444;">–</span>
          <div class="ra-distractor-bar">
            <div class="ra-distractor-bar-fill" style="width:${widthPct}%;background:rgba(239,68,68,.5);"></div>
          </div>
          <span class="ra-distractor-pct">${emptyCount}</span>
        </div>`;
    }
    return `<div class="ra-distractors">${rows}${extra}</div>`;
  }

  function _stripHtml(str) {
    // Very light HTML stripping for question preview (we re-escape after)
    const s = String(str ?? '');
    return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // ─── Per-class breakdown ────────────────────────────────────────────────

  function _computeClassBreakdown(subs) {
    const groups = new Map(); // kelas → array of subs
    for (const s of subs) {
      const kelas = (s.identity_snapshot?.kelas || '').toString().trim() || '(Tanpa Kelas)';
      if (!groups.has(kelas)) groups.set(kelas, []);
      groups.get(kelas).push(s);
    }
    const rows = [];
    for (const [kelas, group] of groups) {
      const stats = _computeStats(group);
      rows.push({ kelas, count: stats.count, mean: stats.mean, median: stats.median, min: stats.min, max: stats.max });
    }
    // Sort: real classes first alphabetically, then "(Tanpa Kelas)" last
    rows.sort((a, b) => {
      if (a.kelas === '(Tanpa Kelas)') return 1;
      if (b.kelas === '(Tanpa Kelas)') return -1;
      return a.kelas.localeCompare(b.kelas, 'id-ID');
    });
    return rows;
  }

  function _renderClassBreakdown(rows) {
    if (!_dom.classTbody) return;
    if (rows.length === 0) {
      _dom.classTbody.innerHTML = `
        <tr><td colspan="6" style="text-align:center;color:var(--albedu-body,#64748b);padding:24px;">
          Tidak ada data kelas.
        </td></tr>`;
      return;
    }
    _dom.classTbody.innerHTML = rows.map((r) => `
      <tr>
        <td><strong>${_esc(r.kelas)}</strong></td>
        <td>${r.count}</td>
        <td>${r.mean   === null ? '—' : r.mean}</td>
        <td>${r.median === null ? '—' : r.median}</td>
        <td>${r.min    === null ? '—' : r.min}</td>
        <td>${r.max    === null ? '—' : r.max}</td>
      </tr>`).join('');
  }

  // ─── Render orchestration ───────────────────────────────────────────────

  function _renderAll() {
    const subs = _state.submissions;

    // Stats
    const stats = _computeStats(subs);
    _renderStats(stats);

    // Histogram
    const bins = _computeHistogram(subs);
    _renderHistogram(bins, subs.length);

    // Item difficulty (requires assessment.sections)
    const questions = _flattenQuestions(_state.selectedAssessment?.sections || []);
    const items = _computeItemDifficulty(questions, subs);
    _renderItemDifficulty(items);

    // Per-class breakdown
    const classRows = _computeClassBreakdown(subs);
    _renderClassBreakdown(classRows);

    _showData(classRows.length > 0, items.length > 0);
    _enableExports(true);
  }

  // ─── View toggles ───────────────────────────────────────────────────────

  function _hideAll() {
    if (_dom.statsGrid)        _dom.statsGrid.hidden        = true;
    if (_dom.histogramSection) _dom.histogramSection.hidden = true;
    if (_dom.itemSection)      _dom.itemSection.hidden      = true;
    if (_dom.classSection)     _dom.classSection.hidden     = true;
    if (_dom.emptySelect)      _dom.emptySelect.hidden      = true;
    if (_dom.empty)            _dom.empty.hidden            = true;
    _enableExports(false);
  }

  function _showEmptySelect() {
    _hideAll();
    if (_dom.emptySelect) _dom.emptySelect.hidden = false;
    _state.submissions = [];
  }

  function _showEmptyData() {
    _hideAll();
    if (_dom.empty) _dom.empty.hidden = false;
    _enableExports(false);
  }

  function _showData(hasClassData, hasItemData) {
    if (_dom.emptySelect) _dom.emptySelect.hidden = true;
    if (_dom.empty)       _dom.empty.hidden       = true;
    if (_dom.statsGrid)        _dom.statsGrid.hidden        = false;
    if (_dom.histogramSection) _dom.histogramSection.hidden = false;
    if (_dom.itemSection)      _dom.itemSection.hidden      = !hasItemData;
    if (_dom.classSection)     _dom.classSection.hidden     = !hasClassData;
  }

  function _setBusy(busy) {
    if (_dom.selectAssessment) _dom.selectAssessment.disabled = busy;
  }

  function _enableExports(enable) {
    if (_dom.btnExportPdf)   _dom.btnExportPdf.disabled   = !enable;
    if (_dom.btnExportExcel) _dom.btnExportExcel.disabled = !enable;
    if (_dom.btnExportJson)  _dom.btnExportJson.disabled  = !enable;
  }

  // ─── Exports ────────────────────────────────────────────────────────────

  function _exportPdf() {
    if (!_state.submissions.length) {
      window.notify?.warning?.(
        t('results.no_data_title', null, 'Tidak Ada Data'),
        t('results.select_with_submission', null, 'Pilih asesmen yang memiliki submission terlebih dahulu.')
      );
      return;
    }
    // Use browser's print dialog (page CSS hides sidebar/header for print via media=print)
    window.notify?.info?.(
      t('results.print_pdf_title', null, 'Cetak PDF'),
      t('results.print_pdf_msg', null, 'Dialog cetak browser akan terbuka.')
    );
    try {
      window.print();
    } catch (err) {
      console.error('[ResultsAnalytics] print:', err);
      window.notify?.error?.(
        t('results.print_failed_title', null, 'Gagal Cetak'),
        (err && err.message) || t('results.print_failed_msg', null, 'Tidak dapat mencetak.')
      );
    }
  }

  function _exportExcel() {
    if (!_state.submissions.length) {
      window.notify?.warning?.(
        t('results.no_data_title', null, 'Tidak Ada Data'),
        t('results.select_with_submission', null, 'Pilih asesmen yang memiliki submission terlebih dahulu.')
      );
      return;
    }
    try {
      const header = ['Name', 'Class', 'Score', 'Correct', 'Total', 'Duration', 'Submitted At'];
      const rows = _state.submissions.map((s) => [
        s.identity_snapshot?.nama || '',
        s.identity_snapshot?.kelas || '',
        s.score ?? '',
        s.correct_count,
        s.total_count,
        _formatDuration(s.duration_seconds),
        s.submitted_at ? new Date(s.submitted_at).toISOString() : '',
      ]);
      const csv = [header, ...rows]
        .map((r) => r.map(_csvEscape).join(','))
        .join('\r\n');
      // Prepend BOM so Excel reads UTF-8 correctly
      const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
      _downloadBlob(blob, `albedu-results-${_todayStamp()}.csv`);
      window.notify?.success?.(
        t('results.excel_exported_title', null, 'Excel Diekspor'),
        t('results.excel_exported_msg', { count: rows.length }, `${rows.length} baris diunduh sebagai CSV.`)
      );
    } catch (err) {
      console.error('[ResultsAnalytics] export excel:', err);
      window.notify?.error?.(
        t('results.export_failed_title', null, 'Gagal Ekspor'),
        (err && err.message) || t('results.excel_export_failed_msg', null, 'Tidak dapat mengekspor Excel.')
      );
    }
  }

  function _csvEscape(v) {
    const s = (v === null || v === undefined) ? '' : String(v);
    if (/[",\r\n]/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }

  function _exportJson() {
    if (!_state.submissions.length) {
      window.notify?.warning?.(
        t('results.no_data_title', null, 'Tidak Ada Data'),
        t('results.select_with_submission', null, 'Pilih asesmen yang memiliki submission terlebih dahulu.')
      );
      return;
    }
    try {
      const payload = {
        exported_at: new Date().toISOString(),
        assessment: _state.selectedAssessment
          ? {
              id:          _state.selectedAssessment.id,
              title:       _state.selectedAssessment.title,
              access_code: _state.selectedAssessment.access_code,
              subject:     _state.selectedAssessment.subject,
            }
          : null,
        count: _state.submissions.length,
        submissions: _state.submissions,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8;' });
      _downloadBlob(blob, `albedu-results-${_todayStamp()}.json`);
      window.notify?.success?.(
        t('results.json_exported_title', null, 'JSON Diekspor'),
        t('results.json_exported_msg', { count: _state.submissions.length }, `${_state.submissions.length} submission diunduh.`)
      );
    } catch (err) {
      console.error('[ResultsAnalytics] export json:', err);
      window.notify?.error?.(
        t('results.export_failed_title', null, 'Gagal Ekspor'),
        (err && err.message) || t('results.json_export_failed_msg', null, 'Tidak dapat mengekspor JSON.')
      );
    }
  }

  function _downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try { document.body.removeChild(a); } catch (_) {}
      try { URL.revokeObjectURL(url); } catch (_) {}
    }, 100);
  }

  // ─── Init ───────────────────────────────────────────────────────────────

  async function init() {
    console.info('[ResultsAnalytics] v1.0.0 init');
    _cacheDom();
    _wireEvents();
    _showEmptySelect();

    const fbOk = await _waitForFirebase(AUTH_WAIT_TIMEOUT_MS);
    if (!fbOk) {
      window.notify?.error?.(
        t('results.firebase_not_ready_title', null, 'Firebase Tidak Siap'),
        t('results.firebase_not_ready_msg', null, 'Tidak dapat terhubung ke database.')
      );
      return;
    }

    const user = await _waitForAuth(AUTH_WAIT_TIMEOUT_MS);
    if (!user) {
      window.notify?.warning?.(
        t('results.not_logged_in_title', null, 'Belum Login'),
        t('results.not_logged_in_msg', null, 'Silakan login untuk mengakses halaman ini.')
      );
      return;
    }
    _state.user = user;

    await _loadAssessments();
  }

  // ─── Public API ─────────────────────────────────────────────────────────
  const ResultsAnalytics = {
    init,
    // Exposed for testing / external refresh
    reloadAssessments: () => _loadAssessments(),
    reloadSubmissions: () => _state.selectedAssessmentId ? _loadSubmissions() : Promise.resolve(),
    getState: () => _state,
  };

  window.ResultsAnalytics = ResultsAnalytics;
  document.addEventListener('DOMContentLoaded', () => ResultsAnalytics.init());
})();
