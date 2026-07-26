// heartbeat.js — Peserta exam heartbeat with block/submitted/expired signals

(function () {
  'use strict';

  const DEFAULT_INTERVAL_MS = 15000;
  const MAX_RETRIES = 3;
  const BACKOFF_MS = 30000;

  const Heartbeat = {
    _timer: null,
    _backoffRecoveryTimer: null,
    _initialBeatTimer: null,
    _sessionId: null,
    _intervalMs: DEFAULT_INTERVAL_MS,
    _running: false,
    _isBeating: false,
    _retryCount: 0,
    _lastSyncAt: null,
    _onBlocked: null,
    _onSubmitted: null,
    _onExpired: null,
    _listenersBound: false,
    _onOnline: null,
    _onOffline: null,
    _onBeforeUnload: null,

    start(sessionId, options = {}) {
      this._sessionId = sessionId;
      this._intervalMs = options.intervalMs || DEFAULT_INTERVAL_MS;
      this._onBlocked = options.onBlocked;
      this._onSubmitted = options.onSubmitted;
      this._onExpired = options.onExpired;

      if (this._running) {
        this.stop();
      }

      this._running = true;
      this._retryCount = 0;
      this._isBeating = false;

      this._initialBeatTimer = setTimeout(() => this._beat(), 2000);
      this._timer = setInterval(() => this._beat(), this._intervalMs);

      this._bindLifecycleListeners();

      console.info(`[heartbeat] Started (session=${sessionId}, interval=${this._intervalMs}ms)`);
    },

    stop() {
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      if (this._backoffRecoveryTimer) { clearTimeout(this._backoffRecoveryTimer); this._backoffRecoveryTimer = null; }
      if (this._initialBeatTimer) { clearTimeout(this._initialBeatTimer); this._initialBeatTimer = null; }
      this._unbindLifecycleListeners();
      this._running = false;
      this._isBeating = false;
      this._onBlocked = null;
      this._onSubmitted = null;
      this._onExpired = null;
      console.info('[heartbeat] Stopped');
    },

    _bindLifecycleListeners() {
      if (this._listenersBound) return;
      this._onOnline = () => {
        if (!this._running) return;
        console.info('[heartbeat] Back online, resuming');
        this._retryCount = 0;
        this._beat();
      };
      this._onOffline = () => {
        console.info('[heartbeat] Offline, queuing');
      };
      this._onBeforeUnload = () => this.stop();
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

    async _beat() {
      if (!this._running || !this._sessionId) return;
      if (this._isBeating) {
        // Skip overlapping beat; the in-flight one will reschedule.
        return;
      }
      if (!navigator.onLine) {
        console.debug('[heartbeat] Offline, skipping');
        return;
      }

      this._isBeating = true;
      try {
        await this._doBeat();
      } catch (err) {
        console.error('[heartbeat] Unexpected error:', err);
      } finally {
        this._isBeating = false;
      }
    },

    async _doBeat() {
      const state = window.ExamLogic?.getState?.() || {};
      const draftAnswers = state.jawaban || {};
      const currentSection = state.activePageIdx || 0;
      const currentQuestion = state.soalPages?.[currentSection]?.questions?.length || 0;
      const totalQuestions = state.soalPages?.reduce((sum, p) => sum + (p.questions?.length || 0), 0) || 0;
      const progressPct = totalQuestions > 0
        ? Math.round((Object.keys(draftAnswers).length / totalQuestions) * 100)
        : 0;
      const violationCount = state.violations || 0;

      try {
        const supabase = window.AlbEdu?.supabase?.client;
        if (!supabase) {
          console.warn('[heartbeat] Supabase client not ready, skipping');
          return;
        }

        // Phase 3: direct PostgREST PATCH (bypasses heartbeat EF entirely).
        // RLS policy sessions_peserta_update_own_safe_fields (migration 016)
        // allows peserta to update: last_heartbeat_at, draft_answers,
        // current_section, current_question, progress_pct, violation_count.
        //
        // Conditional update: only fires if status is still active/paused/disconnected.
        // If status changed (blocked/submitted/expired), 0 rows returned →
        // BlockChecker (10s poll) will catch the change within 15s.
        //
        // PostgREST rate limit trigger (migration 034) fires on UPDATE of
        // last_heartbeat_at — limits to 4 full heartbeats/min per session.
        const { data, error } = await supabase
          .from('assessment_sessions')
          .update({
            last_heartbeat_at: new Date().toISOString(),
            current_section: currentSection,
            current_question: currentQuestion,
            progress_pct: progressPct,
            violation_count: violationCount,
            draft_answers: draftAnswers,
          })
          .eq('id', this._sessionId)
          .in('status', ['active', 'paused', 'disconnected'])
          .select('id, status, blocked_reason');

        if (error) {
          // Check if it's the rate-limit trigger error
          if (error.message?.includes('heartbeat_rate_limited')) {
            console.warn('[heartbeat] Rate limited by DB trigger, skipping this beat');
            return;
          }
          throw error;
        }

        this._retryCount = 0;
        this._lastSyncAt = Date.now();

        // If 0 rows returned, status changed mid-heartbeat (blocked/submitted/expired).
        // BlockChecker (10s poll) will catch it within 15s — no need to handle here.
        // But as a fast fallback, re-fetch and check:
        if (!data || data.length === 0) {
          console.info('[heartbeat] 0 rows updated — status changed, checking...');
          const { data: fresh } = await supabase
            .from('assessment_sessions')
            .select('status, blocked_reason')
            .eq('id', this._sessionId)
            .maybeSingle();

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
          // If fresh status is still active/paused/disconnected but 0 rows updated,
          // it might be a race condition — just skip this beat.
          console.debug('[heartbeat] Status still active but 0 rows updated, skipping');
        }
      } catch (err) {
        const status = err?.status || err?.context?.status;
        if (status === 429) {
          console.warn('[heartbeat] Rate limited, backing off');
          this._backoff();
          return;
        }
        if (status === 401) {
          console.error('[heartbeat] Unauthorized, stopping');
          this.stop();
          return;
        }
        console.error('[heartbeat] Error:', err);
        this._retryCount++;

        if (this._retryCount >= MAX_RETRIES) {
          console.error('[heartbeat] Max retries reached, backing off');
          this._backoff();
        }
      }
    },

    _backoff() {
      if (this._timer) clearInterval(this._timer);
      this._timer = setInterval(() => this._beat(), BACKOFF_MS);
      if (this._backoffRecoveryTimer) clearTimeout(this._backoffRecoveryTimer);
      console.info(`[heartbeat] Backed off to ${BACKOFF_MS}ms`);

      this._backoffRecoveryTimer = setTimeout(() => {
        if (this._running && this._retryCount === 0) {
          if (this._timer) clearInterval(this._timer);
          this._timer = setInterval(() => this._beat(), this._intervalMs);
          console.info('[heartbeat] Resumed normal interval');
        }
      }, BACKOFF_MS * 3);
    },

    async syncNow() {
      await this._beat();
    },

    getLastSyncAt() {
      return this._lastSyncAt;
    },
  };

  window.Heartbeat = Heartbeat;
})();
