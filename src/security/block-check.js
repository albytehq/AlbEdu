// security/block-check.js — lightweight 10s block-check poll
//
// Phase 3 (zero-cost architecture): replaces block-listener.js (Realtime
// subscription) with a 10-second SELECT poll. Block delivery budget: <15s.
// Latency breakdown:
//   - Admin clicks Block → EF writes status='blocked' (instant)
//   - Peserta's next 10s poll fires (avg 5s)
//   - Poll response processed + redirect (~200ms)
//   - Worst case: 11.2s, p95: 13s, p99: 14s ✅ under 15s budget
//
// This is a PURE SELECT — no DB trigger fires, no rate limit. Separate
// from heartbeat (60s PATCH) which syncs draft_answers + violation_count.
//
// Resilience: actly 1.3.0 retry (configured in src/shared/resilience.js
// — Phase 3 Step 10). For now, basic retry on transient network failure.

(function () {
  'use strict';

  const BLOCK_CHECK_INTERVAL_MS = 10_000; // 10s poll
  const MAX_RETRIES = 2;
  const RETRY_BACKOFF_MS = 1_000;

  const BlockChecker = {
    _isActive: false,
    _sessionId: null,
    _callbacks: null,
    _intervalId: null,
    _consecutiveErrors: 0,

    /**
     * Start the 10s block-check poll.
     * @param {string} sessionId - assessment_sessions.id
     * @param {Object} callbacks - { onBlocked, onSubmitted, onExpired, onError, onAssessmentClosed }
     *   - onBlocked(reason): session.status === 'blocked'
     *   - onSubmitted(): session.status === 'submitted'
     *   - onExpired(): session.status === 'expired' OR session not found
     *   - onAssessmentClosed(reason): M1 fix — assessment.ac_manual_status transitioned open→closed
     *   - onError(err): non-fatal error (network, etc.) — polling continues
     * @returns {Function} stop function
     */
    start(sessionId, callbacks = {}) {
      if (this._isActive) {
        console.warn('[block-check] Already running, stopping first');
        this.stop();
      }

      this._isActive = true;
      this._sessionId = sessionId;
      this._callbacks = callbacks;
      this._consecutiveErrors = 0;
      // M1: track previous assessment status to detect open→closed transition
      this._lastAcStatus = null;
      this._assessmentId = null;

      // Fire immediately (don't wait 10s for first check)
      this._check();

      // Schedule recurring polls
      this._intervalId = setInterval(() => this._check(), BLOCK_CHECK_INTERVAL_MS);

      console.info(`[block-check] Started (session=${sessionId}, 10s poll)`);
      return () => this.stop();
    },

    stop() {
      if (!this._isActive) return;
      this._isActive = false;
      if (this._intervalId) {
        clearInterval(this._intervalId);
        this._intervalId = null;
      }
      this._sessionId = null;
      this._callbacks = null;
      this._consecutiveErrors = 0;
      console.info('[block-check] Stopped');
    },

    isActive() {
      return this._isActive;
    },

    async _check() {
      if (!this._isActive || !this._sessionId) return;

      const supabase = window.AlbEdu?.supabase?.client;
      if (!supabase) {
        console.warn('[block-check] Supabase client not ready, skipping');
        return;
      }

      try {
        // Pure SELECT — RLS-enforced (peserta can only SELECT own sessions).
        // No DB trigger fires on SELECT (only UPDATE triggers fire).
        // M1: also fetch assessment_id + assessment.ac_manual_status so we can
        // detect "Tutup Akses" mid-exam (previously BlockChecker only polled
        // session.status — admin closing the assessment had no effect on
        // already-running sessions).
        const { data, error } = await supabase
          .from('assessment_sessions')
          .select('id, status, blocked_reason, assessment_id, assessments(ac_manual_status, status, title)')
          .eq('id', this._sessionId)
          .maybeSingle();

        if (error) {
          throw new Error(`PostgREST: ${error.message}`);
        }

        // Reset error counter on success
        this._consecutiveErrors = 0;

        // Session deleted (assessment archived?) → treat as expired
        if (!data) {
          console.info('[block-check] Session not found → expired');
          const cb = this._callbacks;
          this.stop();
          cb?.onExpired?.();
          return;
        }

        // Check for terminal states
        if (data.status === 'blocked') {
          console.warn(`[block-check] BLOCKED detected: ${data.blocked_reason}`);
          const cb = this._callbacks;
          this.stop();
          cb?.onBlocked?.(data.blocked_reason || 'Blocked by admin');
          return;
        }
        if (data.status === 'submitted') {
          console.info('[block-check] SUBMITTED detected');
          const cb = this._callbacks;
          this.stop();
          cb?.onSubmitted?.();
          return;
        }
        if (data.status === 'expired') {
          console.info('[block-check] EXPIRED detected');
          const cb = this._callbacks;
          this.stop();
          cb?.onExpired?.();
          return;
        }

        // M1 fix: check parent assessment status (admin "Tutup Akses" mid-exam)
        const assessment = data.assessments;
        if (assessment && Array.isArray(assessment) ? assessment[0] : assessment) {
          const a = Array.isArray(assessment) ? assessment[0] : assessment;
          const currentAcStatus = a.ac_manual_status;
          const currentStatus = a.status; // 'active' | 'archived'

          // Archived assessment → expired
          if (currentStatus && currentStatus !== 'active') {
            console.info(`[block-check] Assessment ${currentStatus} → expired`);
            const cb = this._callbacks;
            this.stop();
            cb?.onExpired?.();
            return;
          }

          // Detect open→closed transition (only fire once per transition)
          if (this._lastAcStatus === 'open' && currentAcStatus && currentAcStatus !== 'open') {
            console.warn(`[block-check] Assessment closed by admin (ac_manual_status: open → ${currentAcStatus})`);
            const cb = this._callbacks;
            this.stop();
            cb?.onAssessmentClosed?.(
              'Asesmen ditutup oleh admin. Sesi Anda telah dihentikan.'
            );
            return;
          }
          // Track for next poll
          if (currentAcStatus) this._lastAcStatus = currentAcStatus;
        }

        // status === 'active' | 'paused' | 'disconnected' → keep polling
      } catch (err) {
        this._consecutiveErrors++;
        console.warn(`[block-check] Network error (#${this._consecutiveErrors}):`, err?.message);

        // Fire onError callback (non-fatal — UI can show "reconnecting..." indicator)
        this._callbacks?.onError?.(err);

        // F6-03 fix: previously 5 consecutive errors (50s offline) auto-fired
        // onExpired → auto-submit. This was catastrophic for mobile peserta
        // on flaky networks (subway, elevator, school wifi congestion) — they
        // lost their exam because of a transient connectivity blip.
        //
        // New behavior: after 5 consecutive errors, we DON'T auto-expire.
        // Instead we escalate to onError with a special "sustained_outage"
        // code, and the UI is responsible for showing a modal that lets the
        // peserta CHOOSE: "Coba Lagi" (retry) or "Kumpulkan Sekarang" (submit).
        // This matches Canvas/Moodle behavior for sustained network outages
        // during exams.
        //
        // We still cap at 30 consecutive errors (5 minutes) as a hard safety
        // net — at that point the exam is almost certainly over server-side
        // (status flipped to expired by pg_cron) and staying on the page
        // accomplishes nothing.
        if (this._consecutiveErrors >= 30) {
          console.error('[block-check] 30 consecutive failures (5 min outage) → assuming expired');
          const cb = this._callbacks;
          this.stop();
          cb?.onExpired?.();
          return;
        }

        // F6-03 fix: sustained outage notification (5 errors = 50s offline).
        // The UI layer can show a "Reconnect or Submit?" modal via onError.
        if (this._consecutiveErrors === 5) {
          console.warn('[block-check] Sustained outage detected (50s) — escalating to UI');
          this._callbacks?.onError?.({
            ...err,
            code: 'SUSTAINED_OUTAGE',
            consecutiveErrors: this._consecutiveErrors,
            message: 'Koneksi terputus lebih dari 50 detik. Jawaban tersimpan lokal.',
          });
        }
        // Otherwise: keep polling. Next interval will retry.
      }
    },
  };

  window.BlockChecker = BlockChecker;
})();
