// =============================================================================
// take-assessment/fetch.js — Data fetch + access check + theme application
// =============================================================================
// Part of the take-assessment split (see README.md in this directory).
//
// Functions: _fetchAssessment, _fetchSession, _restoreDraft,
//            _checkAccess, _applyTheme
//
// Load order: MUST load after utils.js, before take-assessment.js.
// =============================================================================

(function () {
  'use strict';

  const _internal = window.TakeAssessment = window.TakeAssessment || {};
  _internal._internal = _internal._internal || { state: {}, dom: {}, constants: {}, t: null };
  const I = _internal._internal;
  const t = I.t || ((key, vars, fallback) => fallback || key);

  // ── Fetch assessment (peserta view — strips admin fields) ───────────────
  async function _fetchAssessment(token) {
    const repo = window.AlbEdu?.repository;
    if (!repo) return null;
    try {
      const snap = await repo.getDoc('assessment_view_peserta', token, 'access_code');
      if (!snap.exists) return null;
      return { id: snap.id, ...snap.data() };
    } catch (err) {
      console.error('[take] fetchAssessment error:', err);
      return null;
    }
  }

  // ── Fetch session ───────────────────────────────────────────────────────
  async function _fetchSession(sessionId) {
    const repo = window.AlbEdu?.repository;
    if (!repo) return null;
    try {
      const snap = await repo.getDoc('assessment_sessions', sessionId);
      if (!snap.exists) return null;
      return { id: snap.id, ...snap.data() };
    } catch (err) {
      console.error('[take] fetchSession error:', err);
      return null;
    }
  }

  // ── EDGE #1/#2/#3: restore draft + identity from server ─────────────────
  function _restoreDraft(session) {
    if (!session) return;

    // Restore identity snapshot
    if (session.identity_snapshot && typeof session.identity_snapshot === 'object'
        && (session.identity_snapshot._display_name || session.identity_snapshot.nama)) {
      I.state.identity = { ...session.identity_snapshot };
    }

    // Restore draft answers
    if (session.draft_answers && typeof session.draft_answers === 'object') {
      const draft = session.draft_answers;
      const normalized = {};
      for (const key of Object.keys(draft)) {
        const val = draft[key];
        if (val && typeof val === 'object') {
          for (const idq of Object.keys(val)) {
            normalized[`${key}__${idq}`] = val[idq];
          }
        } else {
          normalized[key] = val;
        }
      }
      I.state.jawaban = { ...I.state.jawaban, ...normalized };
    }

    // Restore violation count
    if (typeof session.violation_count === 'number') {
      I.state.violations = session.violation_count;
    }
  }

  // ── Access check (open / closed / paused / scheduled) ───────────────────
  function _checkAccess(assessment) {
    const now = Date.now();

    if (assessment.status !== 'active') {
      return {
        allowed: false,
        title: t('assessment.closed_default_title', null, 'Asesmen Tidak Tersedia'),
        message: t('assessment.closed_archived_msg', null, 'Asesmen telah diarsipkan atau tidak aktif.'),
        kind: 'danger',
      };
    }

    if (assessment.access_mode === 'manual') {
      if (assessment.ac_manual_status === 'closed') {
        if (assessment.ac_end && new Date(assessment.ac_end).getTime() < now) {
          return { allowed: false,
            title: t('assessment.closed_session_ended_title', null, 'Asesmen Selesai'),
            message: t('assessment.closed_session_ended_msg', null, 'Asesmen ini telah berakhir.'), kind: 'danger' };
        }
        return { allowed: false,
          title: t('assessment.closed_session_title', null, 'Asesmen Belum Dibuka'),
          message: t('assessment.closed_session_msg', null, 'Tunggu admin membuka asesmen, lalu muat ulang halaman.'),
          kind: 'warning' };
      }
      if (assessment.ac_manual_status === 'finished') {
        return { allowed: false,
          title: t('assessment.closed_session_ended_title', null, 'Asesmen Selesai'),
          message: t('assessment.closed_session_ended_msg', null, 'Asesmen ini telah berakhir.'), kind: 'danger' };
      }
      if (assessment.ac_end && new Date(assessment.ac_end).getTime() < now) {
        return { allowed: false,
          title: t('assessment.closed_session_ended_title', null, 'Asesmen Selesai'),
          message: t('assessment.closed_time_ended_msg', null, 'Waktu asesmen telah berakhir.'), kind: 'danger' };
      }
    } else if (assessment.access_mode === 'scheduled') {
      const start = assessment.ac_scheduled_start ? new Date(assessment.ac_scheduled_start).getTime() : null;
      const end   = assessment.ac_scheduled_end ? new Date(assessment.ac_scheduled_end).getTime() : null;
      if (start && now < start) {
        const locale = ('id' || 'id') === 'en' ? 'en-US' : 'id-ID';
        const startStr = new Date(start).toLocaleString(locale, {
          day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
        });
        return { allowed: false,
          title: t('assessment.closed_not_started_title', null, 'Asesmen Belum Dimulai'),
          message: t('assessment.closed_not_started_msg', { time: startStr }, `Asesmen dimulai pada ${startStr}.`), kind: 'warning' };
      }
      if (end && now > end) {
        return { allowed: false,
          title: t('assessment.closed_session_ended_title', null, 'Asesmen Selesai'),
          message: t('assessment.closed_time_ended_msg', null, 'Waktu asesmen telah berakhir.'), kind: 'danger' };
      }
    }

    return { allowed: true };
  }

  // ── Theme application ───────────────────────────────────────────────────
  function _applyTheme(themeConfig) {
    if (!themeConfig || typeof themeConfig !== 'object') return;
    _internal._waitForThemeSystem().then(() => {
      try {
        const cfg = {
          primary: themeConfig.primary || (themeConfig.TW && themeConfig.TW !== 'default' ? themeConfig.TW : undefined),
          font: themeConfig.font || 'Plus Jakarta Sans',
          mode: themeConfig.mode || 'auto',
          preset: themeConfig.preset || 'default',
        };
        if (window.ThemeSystem?.apply) {
          window.ThemeSystem.apply(cfg);
        }
      } catch (err) {
        console.warn('[take] theme apply failed:', err);
      }
    });
  }

  // ── Expose ──────────────────────────────────────────────────────────────
  Object.assign(_internal, {
    _fetchAssessment,
    _fetchSession,
    _restoreDraft,
    _checkAccess,
    _applyTheme,
  });
})();
