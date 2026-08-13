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

      // Initialize the ViolationSignaler (peserta→admin realtime pipeline).
      // Even the smallest violation (info severity) gets signaled — the
      // admin notification panel will show it within ~3s.
      if (window.ViolationSignaler) {
        try {
          const assessment = callbacks.assessment || window.TakeAssessment?._internal?.state?.assessment;
          window.ViolationSignaler.init(sessionId, {
            assessmentId: assessment?.id || null,
            assessmentTitle: assessment?.title || null,
          });
          console.info('[anti-cheat] ViolationSignaler initialized');
        } catch (e) {
          console.warn('[anti-cheat] ViolationSignaler init failed:', e?.message);
        }
      } else {
        console.warn('[anti-cheat] ViolationSignaler not loaded — violations will NOT be signaled to admin');
      }

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
        // Phase 3 wave architecture: NO heartbeat timer. pg_cron handles
        // last_heartbeat_at server-side. Heartbeat module is now event-driven
        // — only syncs draft_answers when peserta answers (debounced 2s).
        window.Heartbeat.start(sessionId, {
          onBlocked: (reason) => this._handleBlocked(reason),  // fallback
          onSubmitted: () => this._handleSubmitted(),
          onExpired: () => this._handleExpired(),
        });
        console.info('[anti-cheat] Heartbeat started (event-driven, pg_cron wave)');
      }

      if (window.BlockChecker) {
        // Phase 3: replaces BlockListener (Realtime subscription).
        // 10s SELECT poll, pure read, no DB trigger fires.
        // Block delivery: <15s (budget confirmed in ZERO-COST.md §3.1).
        // CRITICAL FIX: onAssessmentClosed callback MUST be wired — without it,
        // when admin closes the assessment mid-exam, BlockChecker detects the
        // closure but the callback is undefined → silent no-op → peserta
        // continues exam indefinitely.
        this._stopBlockChecker = window.BlockChecker.start(sessionId, {
          onBlocked: (reason) => this._handleBlocked(reason),
          onSubmitted: () => this._handleSubmitted(),
          onExpired: () => this._handleExpired(),
          onAssessmentClosed: (reason) => this._handleBlocked(reason),
          onError: (err) => console.warn('[anti-cheat] BlockChecker transient error:', err?.message),
        });
        console.info('[anti-cheat] BlockChecker started (10s poll, with onAssessmentClosed)');
      } else {
        console.warn('[anti-cheat] BlockChecker not available — block delivery will fall back to heartbeat (60s)');
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
      if (this._stopBlockChecker) {
        this._stopBlockChecker();
        this._stopBlockChecker = null;
      }
      // Destroy the ViolationSignaler (final flush happens inside destroy)
      if (window.ViolationSignaler) {
        try {
          window.ViolationSignaler.destroy();
        } catch (e) {
          console.warn('[anti-cheat] ViolationSignaler destroy failed:', e?.message);
        }
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

      // Signal to admin via ViolationSignaler (realtime pipeline).
      // Map Guardian's "pesan" to a known event_type. The mapping is heuristic
      // because Guardian doesn't expose a structured type — we infer from the
      // message text. This keeps backwards compat with Guardian's existing API.
      const eventType = this._inferEventType(v.pesan);
      if (eventType && window.ViolationSignaler) {
        try {
          window.ViolationSignaler.signal({
            event_type: eventType,
            message: v.pesan,
            severity: v.ke >= v.maks ? 'critical' : 'warning',
            metadata: { source: 'ExamGuardian', count: v.ke, max: v.maks },
          });
        } catch (e) {
          console.warn('[anti-cheat] ViolationSignaler.signal failed:', e?.message);
        }
      }

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

      // Signal to admin via ViolationSignaler
      if (window.ViolationSignaler) {
        try {
          window.ViolationSignaler.signal({
            event_type: 'devtools_open',
            message: v.message,
            severity: v.count >= v.max ? 'critical' : 'warning',
            metadata: { source: 'DevToolsDetector', count: v.count, max: v.max },
          });
        } catch (e) {
          console.warn('[anti-cheat] ViolationSignaler.signal failed:', e?.message);
        }
      }

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

      // Send a critical-severity signal immediately (bypasses the 3s debounce)
      // so the admin sees the max-violations alert in real-time.
      if (window.ViolationSignaler) {
        try {
          window.ViolationSignaler.signal({
            event_type: 'max_violations_reached',
            message: `Max violations reached (source: ${source}) — exam answers reset, questions reshuffled`,
            severity: 'critical',
            metadata: { source, total_violations: this.getTotalViolations() },
          });
          // Force an immediate flush — don't wait for the 3s timer
          window.ViolationSignaler.flush().catch(() => {});
        } catch (e) {
          console.warn('[anti-cheat] ViolationSignaler.signal(max) failed:', e?.message);
        }
      }
    },

    _handleBlocked(reason) {
      if (!this._isActive) return;
      console.warn(`[anti-cheat] BLOCKED: ${reason}`);

      // Signal the block event to admin (for audit trail)
      if (window.ViolationSignaler) {
        try {
          window.ViolationSignaler.signal({
            event_type: 'session_blocked',
            message: `Session blocked: ${reason}`,
            severity: 'critical',
            metadata: { reason },
          });
          window.ViolationSignaler.flush().catch(() => {});
        } catch (_) {}
      }

      this.stop();
      this._onBlocked?.(reason);
    },

    _handleSubmitted() {
      if (!this._isActive) return;
      console.info('[anti-cheat] SUBMITTED signal');

      // Final flush — make sure all pending violations reach the admin
      // before the page transitions.
      if (window.ViolationSignaler) {
        try {
          window.ViolationSignaler.flush().catch(() => {});
        } catch (_) {}
      }

      this.stop();
      this._onSubmitted?.();
    },

    _handleExpired() {
      if (!this._isActive) return;
      console.warn('[anti-cheat] EXPIRED signal');

      if (window.ViolationSignaler) {
        try {
          window.ViolationSignaler.signal({
            event_type: 'session_expired',
            message: 'Session expired (time limit reached)',
            severity: 'critical',
          });
          window.ViolationSignaler.flush().catch(() => {});
        } catch (_) {}
      }

      this.stop();
      this._onExpired?.();
    },

    // Map Guardian's human-readable "pesan" to a structured event_type.
    // Guardian doesn't expose a structured type — we infer from message text.
    // Returns null if no match (signal will be skipped).
    _inferEventType(pesan) {
      if (!pesan) return null;
      const p = String(pesan).toLowerCase();
      if (p.includes('devtools') || p.includes('inspect') || p.includes('f12')) return 'devtools_shortcut';
      if (p.includes('tab') || p.includes('visibility') || p.includes('hidden') || p.includes('pindah')) return 'tab_switch';
      // FIX v0.854.0: 'jendela' is Indonesian for 'window' — Guardian uses
      // Indonesian messages. Without this, blur violations were misclassified
      // as 'keyboard_violation' (the default fallback), breaking dedup.
      if (p.includes('blur') || p.includes('window') || p.includes('jendela') || p.includes('alt+tab') || p.includes('meninggalkan jendela')) return 'window_blur';
      if (p.includes('copy') || p.includes('salin')) return 'copy_attempt';
      if (p.includes('paste') || p.includes('tempel')) return 'paste_attempt';
      if (p.includes('context') || p.includes('right-click') || p.includes('klik kanan')) return 'context_menu';
      if (p.includes('select') || p.includes('seleksi')) return 'select_text';
      if (p.includes('keyboard') || p.includes('shortcut') || p.includes('ctrl')) return 'keyboard_violation';
      // Default: keyboard_violation is the closest catch-all
      return 'keyboard_violation';
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
