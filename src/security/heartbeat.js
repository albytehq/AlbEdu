// =============================================================================
// security/heartbeat.js — Peserta heartbeat (15s sync + cross-device resume)
// =============================================================================
// Sends progress + draft answers to server every 15s.
// Detects block signal from server (instant redirect).
// Graceful degradation: if offline, queue + retry.
//
// Edge cases:
//   - Offline → queue, retry when online
//   - Server 429 (rate limit) → backoff to 30s
//   - Server returns blocked=true → trigger block listener
//   - Server returns submitted=true → already submitted, redirect
//   - Server returns expired=true → time up, force submit
//   - Peserta navigates away → stop heartbeat
//   - Peserta refreshes → heartbeat restarts (server has latest draft)
//   - Double heartbeat (race) → idempotent (server updates last_heartbeat_at)
// =============================================================================

(function () {
  'use strict';

  const DEFAULT_INTERVAL_MS = 15000;
  const MAX_RETRIES = 3;
  const BACKOFF_MS = 30000;

  const Heartbeat = {
    _timer: null,
    _sessionId: null,
    _intervalMs: DEFAULT_INTERVAL_MS,
    _running: false,
    _retryCount: 0,
    _lastSyncAt: null,
    _onBlocked: null,
    _onSubmitted: null,
    _onExpired: null,

    start(sessionId, options = {}) {
      this._sessionId = sessionId;
      this._intervalMs = options.intervalMs || DEFAULT_INTERVAL_MS;
      this._onBlocked = options.onBlocked;
      this._onSubmitted = options.onSubmitted;
      this._onExpired = options.onExpired;

      if (this._running) {
        console.warn('[heartbeat] Already running, stopping old first');
        this.stop();
      }

      this._running = true;
      this._retryCount = 0;

      // Initial heartbeat after 2s (let page settle)
      setTimeout(() => this._beat(), 2000);

      // Periodic heartbeat
      this._timer = setInterval(() => this._beat(), this._intervalMs);

      // Online/offline handlers
      window.addEventListener('online', () => {
        console.info('[heartbeat] Back online, resuming');
        this._retryCount = 0;
        this._beat();
      });

      window.addEventListener('offline', () => {
        console.info('[heartbeat] Offline, queuing');
      });

      // Stop on page unload
      window.addEventListener('beforeunload', () => this.stop());

      console.info(`[heartbeat] Started (session=${sessionId}, interval=${this._intervalMs}ms)`);
    },

    stop() {
      if (this._timer) {
        clearInterval(this._timer);
        this._timer = null;
      }
      this._running = false;
      console.info('[heartbeat] Stopped');
    },

    async _beat() {
      if (!this._running || !this._sessionId) return;
      if (!navigator.onLine) {
        console.debug('[heartbeat] Offline, skipping');
        return;
      }

      // Gather current state from ExamLogic (if available)
      const state = window.ExamLogic?.getState?.() || {};
      const draftAnswers = state.jawaban || {};
      const currentSection = state.activePageIdx || 0;
      const currentQuestion = state.soalPages?.[currentSection]?.questions?.length || 0;
      const totalQuestions = state.soalPages?.reduce((sum, p) => sum + (p.questions?.length || 0), 0) || 0;
      const progressPct = totalQuestions > 0
        ? Math.round((Object.keys(draftAnswers).length / totalQuestions) * 100)
        : 0;
      const violationCount = state.violations || 0;

      const body = {
        session_id: this._sessionId,
        current_section: currentSection,
        current_question: currentQuestion,
        progress_pct: progressPct,
        violation_count: violationCount,
        draft_answers: draftAnswers,
      };

      try {
        const user = window.firebaseAuth?.currentUser;
        if (!user) {
          console.warn('[heartbeat] No auth user, skipping');
          return;
        }

        const token = await user.getIdToken();
        const res = await fetch(
          'https://kzsrerxhhrtsxnpnmqgl.supabase.co/functions/v1/heartbeat',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify(body),
          }
        );

        if (!res.ok) {
          if (res.status === 429) {
            // Rate limited — backoff
            console.warn('[heartbeat] Rate limited, backing off to 30s');
            this._backoff();
            return;
          }
          if (res.status === 401) {
            console.error('[heartbeat] Unauthorized, stopping');
            this.stop();
            return;
          }
          throw new Error(`HTTP ${res.status}`);
        }

        const data = await res.json();

        // Reset retry count on success
        this._retryCount = 0;
        this._lastSyncAt = Date.now();

        // Check server signals
        if (data.data) {
          const d = data.data;
          if (d.blocked) {
            console.warn('[heartbeat] Server says BLOCKED:', d.blocked_reason);
            this.stop();
            this._onBlocked?.(d.blocked_reason);
            return;
          }
          if (d.submitted) {
            console.warn('[heartbeat] Server says SUBMITTED');
            this.stop();
            this._onSubmitted?.();
            return;
          }
          if (d.expired) {
            console.warn('[heartbeat] Server says EXPIRED');
            this.stop();
            this._onExpired?.();
            return;
          }
        }
      } catch (err) {
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
      console.info(`[heartbeat] Backed off to ${BACKOFF_MS}ms`);

      // Reset to normal after 3 successful beats
      setTimeout(() => {
        if (this._running && this._retryCount === 0) {
          if (this._timer) clearInterval(this._timer);
          this._timer = setInterval(() => this._beat(), this._intervalMs);
          console.info('[heartbeat] Resumed normal interval');
        }
      }, BACKOFF_MS * 3);
    },

    // Force sync now (e.g. before submit)
    async syncNow() {
      await this._beat();
    },

    getLastSyncAt() {
      return this._lastSyncAt;
    },
  };

  window.Heartbeat = Heartbeat;
})();
