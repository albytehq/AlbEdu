// security/anti-cheat.js — anti-cheat orchestrator
//
// Single entry point that coordinates ALL anti-cheat modules:
//   1. ExamGuardian — anti-copy (7 layers), keyboard shortcuts, visibility change
//   2. DevToolsDetector — 3 methods (size diff, debugger timing, console trap)
//   3. Heartbeat — 15s progress sync + server-side block detection
//   4. BlockListener — instant block via Realtime
//
// Only active during the 'exam' phase (not identity/result).
//
// Violation flow:
//   Guardian/DevTools detects → AntiCheat.onViolation → log to server via Heartbeat
//   Max violations (4 from Guardian + 3 from DevTools) → reset + reshuffle

(function () {
  'use strict';

  const MAX_TOTAL_VIOLATIONS = 4; // Combined Guardian + DevTools

  const AntiCheat = {
    _isActive: false,
    _sessionId: null,
    _violationLog: [],       // Array of { type, message, timestamp, source }
    _onViolation: null,      // Callback: (violation) => void
    _onMaxViolations: null,  // Callback: () => void — reset + reshuffle
    _onBlocked: null,        // Callback: (reason) => void — redirect to blocked.html
    _onSubmitted: null,      // Callback: () => void — redirect to submitted.html
    _onExpired: null,        // Callback: () => void — auto-submit

    // Start all anti-cheat modules. Call when exam phase starts (after
    // identity submit).
    start(sessionId, callbacks = {}) {
      if (this._isActive) {
        console.warn('[anti-cheat] Already active, stopping first');
        this.stop();
      }

      this._isActive = true;
      this._sessionId = sessionId;
      this._onViolation = callbacks.onViolation;
      this._onMaxViolations = callbacks.onMaxViolations;
      this._onBlocked = callbacks.onBlocked;
      this._onSubmitted = callbacks.onSubmitted;
      this._onExpired = callbacks.onExpired;
      this._violationLog = [];

      if (window.ExamGuardian) {
        window.ExamGuardian.onViolation((v) => this._handleGuardianViolation(v));
        window.ExamGuardian.onMaxViolation(() => this._handleMaxViolations('guardian'));
        window.ExamGuardian.activate();
        console.info('[anti-cheat] ExamGuardian activated');
      } else {
        console.warn('[anti-cheat] ExamGuardian not available');
      }

      if (window.DevToolsDetector) {
        window.DevToolsDetector.start({
          onViolation: (v) => this._handleDevToolsViolation(v),
          onMaxViolation: () => this._handleMaxViolations('devtools'),
        });
        console.info('[anti-cheat] DevToolsDetector started');
      } else {
        console.warn('[anti-cheat] DevToolsDetector not available');
      }

      if (window.Heartbeat) {
        window.Heartbeat.start(sessionId, {
          intervalMs: 15000,
          onBlocked: (reason) => this._handleBlocked(reason),
          onSubmitted: () => this._handleSubmitted(),
          onExpired: () => this._handleExpired(),
        });
        console.info('[anti-cheat] Heartbeat started');
      }

      if (window.BlockListener) {
        window.BlockListener.start(sessionId, {
          onBlocked: (reason) => this._handleBlocked(reason),
          onSubmitted: () => this._handleSubmitted(),
        });
        console.info('[anti-cheat] BlockListener started');
      }

      // Named handler so we can actually remove it on stop() — anonymous
      // arrows would leak and stack on every start().
      this._onBeforeUnload = () => this.stop();
      window.addEventListener('beforeunload', this._onBeforeUnload);

      console.info(`[anti-cheat] All modules active (session=${sessionId})`);
    },

    // Stop all anti-cheat modules. Call on exam end, submit, block, or page
    // unload.
    stop() {
      if (!this._isActive) return;
      this._isActive = false;

      if (this._onBeforeUnload) {
        window.removeEventListener('beforeunload', this._onBeforeUnload);
        this._onBeforeUnload = null;
      }

      if (window.ExamGuardian) {
        window.ExamGuardian.deactivate();
      }
      if (window.DevToolsDetector) {
        window.DevToolsDetector.stop();
      }
      if (window.Heartbeat) {
        window.Heartbeat.stop();
      }
      if (window.BlockListener) {
        window.BlockListener.stop();
      }

      console.info('[anti-cheat] All modules stopped');
    },

    // Temporarily deactivate (during submit dialog, for example) — prevents false
    // positive visibilitychange when the dialog opens.
    pause() {
      if (window.ExamGuardian) window.ExamGuardian.deactivate();
      if (window.DevToolsDetector) window.DevToolsDetector.stop();
      console.info('[anti-cheat] Paused (Guardian + DevToolsDetector)');
    },

    resume() {
      if (!this._isActive) return;
      if (window.ExamGuardian) {
        window.ExamGuardian.activate();
      }
      if (window.DevToolsDetector) {
        window.DevToolsDetector.start({
          onViolation: (v) => this._handleDevToolsViolation(v),
          onMaxViolation: () => this._handleMaxViolations('devtools'),
        });
      }
      console.info('[anti-cheat] Resumed');
    },

    _handleGuardianViolation(v) {
      const violation = {
        type: 'guardian',
        message: v.pesan,
        timestamp: Date.now(),
        source: 'ExamGuardian',
        count: v.ke,
        max: v.maks,
      };
      this._violationLog.push(violation);
      this._onViolation?.(violation);

      if (window.ExamLogic?.addViolation) {
        window.ExamLogic.addViolation();
      }

      console.warn(`[anti-cheat] Guardian violation ${v.ke}/${v.maks}: ${v.pesan}`);
    },

    _handleDevToolsViolation(v) {
      const violation = {
        type: 'devtools',
        message: v.message,
        timestamp: Date.now(),
        source: 'DevToolsDetector',
        count: v.count,
        max: v.max,
      };
      this._violationLog.push(violation);
      this._onViolation?.(violation);

      // DevTools violations count toward the combined max (4 total, either
      // source).
      const guardianCount = window.ExamGuardian?.getWarningCount?.() || 0;
      const totalCount = guardianCount + v.count;

      if (window.ExamLogic?.addViolation) {
        window.ExamLogic.addViolation();
      }

      console.warn(`[anti-cheat] DevTools violation ${v.count}/${v.max}: ${v.message}`);

      if (totalCount >= MAX_TOTAL_VIOLATIONS) {
        this._handleMaxViolations('combined');
      }
    },

    _handleMaxViolations(source) {
      console.error(`[anti-cheat] MAX VIOLATIONS reached (source: ${source})`);
      this._onMaxViolations?.();

      this._logViolationEvent('max_violations_reached', `Max violations from ${source}`);
    },

    _handleBlocked(reason) {
      if (!this._isActive) return;
      console.warn(`[anti-cheat] BLOCKED: ${reason}`);
      this.stop();
      this._onBlocked?.(reason);
    },

    _handleSubmitted() {
      if (!this._isActive) return;
      console.info('[anti-cheat] SUBMITTED signal');
      this.stop();
      this._onSubmitted?.();
    },

    _handleExpired() {
      if (!this._isActive) return;
      console.warn('[anti-cheat] EXPIRED signal');
      this.stop();
      this._onExpired?.();
    },

    // Log violation to server (via heartbeat, not direct DB).
    //
    // Violations are logged via heartbeat's violation_count field — the
    // heartbeat Edge Function updates assessment_sessions.violation_count.
    // We could insert to violation_events directly, but that requires auth
    // + an Edge Function call per violation — too expensive. Rely on
    // heartbeat sync + server-side audit.
    _logViolationEvent(eventType, message) {
      // Best-effort: insert violation event directly (fire-and-forget)
      const user = window.AlbEdu?.supabase?.auth?.currentUser;
      const repo = window.AlbEdu?.repository;
      if (!user || !repo || !this._sessionId) return;

      repo.getDoc('assessment_sessions', this._sessionId).then((doc) => {
        if (!doc?.exists) return;
        const session = doc.data();

        repo.addDoc('violation_events', {
          assessment_id: session.assessment_id,
          session_id: this._sessionId,
          user_id: user.id,
          user_email: user.email,
          user_name: session.identity_snapshot?.nama || 'Unknown',
          exam_title: null,
          event_type: eventType,
          message: message,
          severity: eventType === 'max_violations_reached' ? 'critical' : 'warning',
          ip_address: null, // server fills via Edge Function
          user_agent: navigator.userAgent,
          device_id: localStorage.getItem('albedu_exam_device_id'),
        }).catch((err) => {
          console.warn('[anti-cheat] violation_events insert failed (non-blocking):', err);
        });
      }).catch(() => {});
    },

    getViolationLog() {
      return [...this._violationLog];
    },

    getTotalViolations() {
      const guardianCount = window.ExamGuardian?.getWarningCount?.() || 0;
      const devtoolsCount = window.DevToolsDetector?.getDetectionCount?.() || 0;
      return guardianCount + devtoolsCount;
    },

    isActive() {
      return this._isActive;
    },

    // Reset violation counts (after resetUjian, for example)
    reset() {
      if (window.ExamGuardian) window.ExamGuardian.resetWarningCount();
      if (window.DevToolsDetector) window.DevToolsDetector.resetDetectionCount();
      this._violationLog = [];
      console.info('[anti-cheat] Violation counts reset');
    },
  };

  window.AntiCheat = AntiCheat;
})();
