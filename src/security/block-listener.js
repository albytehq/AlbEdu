// =============================================================================
// security/block-listener.js — Instant block via Supabase Realtime
// =============================================================================
// Subscribes to `assessment_sessions` row changes for this session.
// When admin blocks peserta, status changes to 'blocked' → instant redirect.
//
// Latency: <500ms (Supabase Realtime postgres_changes)
// Fallback: heartbeat polling (15s) catches block if Realtime fails.
//
// Edge cases:
//   - Realtime connection fails → fallback to polling (heartbeat)
//   - Multiple block events → idempotent (only redirect once)
//   - Peserta navigates away → unsubscribe
//   - Block reason null → show generic message
//   - Block during submit → cancel submit, redirect
// =============================================================================

(function () {
  'use strict';

  const BlockListener = {
    _subscription: null,
    _sessionId: null,
    _onBlocked: null,
    _redirected: false,

    start(sessionId, onBlocked) {
      this._sessionId = sessionId;
      this._onBlocked = onBlocked;
      this._redirected = false;

      // Try Supabase Realtime (native platform layer)
      const sb = window.AlbEdu?.supabase?.client;
      if (sb) {
        try {
          this._subscription = sb
            .channel(`session-${sessionId}`)
            .on(
              'postgres_changes',
              {
                event: 'UPDATE',
                schema: 'public',
                table: 'assessment_sessions',
                filter: `id=eq.${sessionId}`,
              },
              (payload) => this._handleChange(payload)
            )
            .subscribe();

          console.info(`[block-listener] Subscribed to session-${sessionId}`);
        } catch (err) {
          console.warn('[block-listener] Realtime subscribe failed, relying on heartbeat:', err);
        }
      } else {
        console.warn('[block-listener] Supabase client not available, relying on heartbeat');
      }
    },

    stop() {
      if (this._subscription) {
        try {
          this._subscription.unsubscribe();
        } catch (err) {
          console.warn('[block-listener] unsubscribe error:', err);
        }
        this._subscription = null;
      }
      console.info('[block-listener] Stopped');
    },

    _handleChange(payload) {
      if (this._redirected) return;

      const newRow = payload.new;
      if (!newRow) return;

      if (newRow.status === 'blocked') {
        this._redirected = true;
        console.warn('[block-listener] BLOCKED signal received:', newRow.blocked_reason);
        this.stop();
        this._onBlocked?.(newRow.blocked_reason || 'Diblokir oleh admin');
      } else if (newRow.status === 'submitted') {
        // Someone (or server) marked as submitted
        this._redirected = true;
        console.info('[block-listener] SUBMITTED signal received');
        this.stop();
        this._onSubmitted?.();
      }
    },

    // Manual check (fallback if Realtime not available)
    async checkNow() {
      if (this._redirected || !this._sessionId) return;

      try {
        const user = window.AlbEdu?.supabase?.auth?.currentUser;
        if (!user) return;

        // Use native repository helper
        const doc = await window.AlbEdu?.repository?.getDoc('assessment_sessions', this._sessionId);
        if (!doc?.exists) return;

        const data = doc.data();
        if (data.status === 'blocked' && !this._redirected) {
          this._redirected = true;
          this.stop();
          this._onBlocked?.(data.blocked_reason || 'Diblokir oleh admin');
        }
      } catch (err) {
        console.warn('[block-listener] checkNow error:', err);
      }
    },
  };

  window.BlockListener = BlockListener;
})();
