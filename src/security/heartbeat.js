// heartbeat.js — Phase 3 wave architecture: event-driven answer sync
//
// CHANGED in Phase 3: NO more heartbeat timer. pg_cron `heartbeat-wave` job
// (migration 038) bulk-updates last_heartbeat_at for all active sessions
// every 60s on the server side. Peserta client no longer sends heartbeat
// PATCH every 60s — saves 72,000 HTTP requests per exam session.
//
// This module now ONLY syncs draft_answers + current_section + current_question
// + violation_count when they CHANGE (event-driven, debounced 2s).
//
// Block detection: handled by block-check.js (10s SELECT poll, <15s budget).
//
// Architecture:
//   pg_cron (60s) → UPDATE last_heartbeat_at WHERE status='active' (server-side)
//   peserta client → PATCH draft_answers (debounced 2s on answer change)
//   block-checker → SELECT status (10s poll, unchanged)

(function () {
  'use strict';

  const ANSWER_SYNC_DEBOUNCE_MS = 2_000; // 2s debounce on answer changes
  const SECTION_SYNC_IMMEDIATE = true;   // section change = immediate PATCH
  const MAX_RETRIES = 3;
  const RETRY_BACKOFF_MS = 5_000;

  const Heartbeat = {
    _sessionId: null,
    _running: false,
    _debounceTimer: null,
    _lastSyncAt: null,
    _pendingPatch: null,
    _retryCount: 0,
    _onBlocked: null,
    _onSubmitted: null,
    _onExpired: null,
    _listenersBound: false,
    _onOnline: null,
    _onOffline: null,
    _onBeforeUnload: null,

    /**
     * Start event-driven answer sync. NO timer — pg_cron handles heartbeat.
     * @param {string} sessionId
     * @param {Object} options - { onBlocked, onSubmitted, onExpired }
     */
    start(sessionId, options = {}) {
      this._sessionId = sessionId;
      this._onBlocked = options.onBlocked;
      this._onSubmitted = options.onSubmitted;
      this._onExpired = options.onExpired;

      if (this._running) {
        this.stop();
      }

      this._running = true;
      this._retryCount = 0;
      this._pendingPatch = null;

      // No setInterval — pg_cron handles last_heartbeat_at server-side.
      // We only sync when answers/section/violations change (event-driven).

      this._bindLifecycleListeners();

      console.info(`[heartbeat] Started (session=${sessionId}, event-driven, pg_cron handles last_heartbeat_at)`);
    },

    stop() {
      this._running = false;
      if (this._debounceTimer) {
        clearTimeout(this._debounceTimer);
        this._debounceTimer = null;
      }
      this._unbindLifecycleListeners();
      this._sessionId = null;
      this._onBlocked = null;
      this._onSubmitted = null;
      this._onExpired = null;
      this._pendingPatch = null;
      console.info('[heartbeat] Stopped');
    },

    /**
     * Called when peserta answers a question (or changes answer).
     * Debounced 2s — if peserta answers 5 questions in 2s, only 1 PATCH fires.
     */
    onAnswerChange() {
      if (!this._running) return;
      this._scheduleSync();
    },

    /**
     * Called when peserta navigates to a different section/question.
     * Immediate PATCH (no debounce) — section change is important state.
     */
    onSectionChange() {
      if (!this._running) return;
      this._syncNow(); // immediate
    },

    /**
     * Called when violation count changes (DevTools detected, etc.).
     * Immediate PATCH — violation_count needs to be synced for auto-block.
     */
    onViolationChange() {
      if (!this._running) return;
      this._syncNow();
    },

    /**
     * Force sync now (e.g. before page unload, or on reconnect).
     */
    async syncNow() {
      await this._syncNow();
    },

    getLastSyncAt() {
      return this._lastSyncAt;
    },

    _scheduleSync() {
      if (this._debounceTimer) {
        clearTimeout(this._debounceTimer);
      }
      this._debounceTimer = setTimeout(() => {
        this._debounceTimer = null;
        this._syncNow();
      }, ANSWER_SYNC_DEBOUNCE_MS);
    },

    async _syncNow() {
      if (!this._running || !this._sessionId) return;

      const state = window.ExamLogic?.getState?.() || {};
      const draftAnswers = state.jawaban || {};
      const currentSection = state.activePageIdx || 0;
      const currentQuestion = state.soalPages?.[currentSection]?.questions?.length || 0;
      const violationCount = state.violations || 0;

      const patch = {
        current_section: currentSection,
        current_question: currentQuestion,
        violation_count: violationCount,
        draft_answers: draftAnswers,
        // NOTE: last_heartbeat_at is NOT set here — pg_cron handles it.
        // If we set it, the rate-limit trigger (migration 034) fires.
      };

      try {
        const resilience = window.AlbEduResilience;
        let result;

        if (resilience?.patchSession) {
          result = await resilience.patchSession(this._sessionId, patch);
        } else {
          // Fallback: direct PostgREST without actly
          const supabase = window.AlbEdu?.supabase?.client;
          if (!supabase) return;
          const { data, error } = await supabase
            .from('assessment_sessions')
            .update(patch)
            .eq('id', this._sessionId)
            .in('status', ['active', 'paused', 'disconnected'])
            .select('id, status, blocked_reason');
          if (error) throw error;
          result = { ok: true, rowsUpdated: data?.length || 0, data: data || [] };
        }

        this._retryCount = 0;
        this._lastSyncAt = Date.now();

        // If 0 rows updated, status changed (blocked/submitted/expired).
        // BlockChecker (10s poll) will catch it — but as fast fallback, check now.
        if (!result.ok || result.rowsUpdated === 0) {
          console.info('[heartbeat] 0 rows updated — status changed, checking...');
          const selectResult = resilience?.selectSession
            ? await resilience.selectSession(this._sessionId)
            : await this._fallbackSelect();

          const fresh = selectResult?.data || selectResult;
          if (fresh?.status === 'blocked') {
            this.stop();
            this._onBlocked?.(fresh.blocked_reason);
            return;
          }
          if (fresh?.status === 'submitted') {
            this.stop();
            this._onSubmitted?.();
            return;
          }
          if (fresh?.status === 'expired') {
            this.stop();
            this._onExpired?.();
            return;
          }
        }
      } catch (err) {
        if (err?.message?.includes('heartbeat_rate_limited')) {
          console.warn('[heartbeat] Rate limited (should not happen — we do not set last_heartbeat_at)');
          return;
        }
        console.error('[heartbeat] Sync error:', err);
        this._retryCount++;
        if (this._retryCount >= MAX_RETRIES) {
          console.error('[heartbeat] Max retries, will retry on next event');
          this._retryCount = 0; // reset, let next answer-change trigger fresh retry
        }
      }
    },

    async _fallbackSelect() {
      const supabase = window.AlbEdu?.supabase?.client;
      if (!supabase) return { ok: false };
      const { data, error } = await supabase
        .from('assessment_sessions')
        .select('status, blocked_reason')
        .eq('id', this._sessionId)
        .maybeSingle();
      if (error) return { ok: false, error };
      return { ok: true, data };
    },

    _bindLifecycleListeners() {
      if (this._listenersBound) return;
      this._onOnline = () => {
        if (!this._running) return;
        console.info('[heartbeat] Back online, syncing pending changes');
        this._retryCount = 0;
        this._syncNow();
      };
      this._onOffline = () => {
        console.info('[heartbeat] Offline, queuing changes');
      };
      this._onBeforeUnload = () => {
        // Sync immediately before unload (best-effort, no await)
        if (this._running && this._pendingPatch) {
          this._syncNow();
        }
      };
      window.addEventListener('online', this._onOnline);
      window.addEventListener('offline', this._onOffline);
      window.addEventListener('beforeunload', this._onBeforeUnload);
      this._listenersBound = true;
    },

    _unbindLifecycleListeners() {
      if (!this._listenersBound) return;
      if (this._onOnline) window.removeEventListener('online', this._onOnline);
      if (this._onOffline) window.removeEventListener('offline', this._onOffline);
      if (this._onBeforeUnload) window.removeEventListener('beforeunload', this._onBeforeUnload);
      this._onOnline = null;
      this._onOffline = null;
      this._onBeforeUnload = null;
      this._listenersBound = false;
    },
  };

  window.Heartbeat = Heartbeat;
})();
