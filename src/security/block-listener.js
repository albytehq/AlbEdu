// block-listener.js — Realtime block/submitted signal for peserta exam runtime

(function () {
  'use strict';

  const BlockListener = {
    _subscription: null,
    _sessionId: null,
    _onBlocked: null,
    _onSubmitted: null,
    _redirected: false,

    // start(sessionId, handlers) — handlers: { onBlocked, onSubmitted }
    // onSubmitted fires when the server marks the session as 'submitted'
    // (admin force-submit or auto-expire). Without it the peserta stays on
    // a stale exam page.
    start(sessionId, handlers = {}) {
      this.stop();
      this._sessionId = sessionId;
      this._onBlocked = handlers.onBlocked || null;
      this._onSubmitted = handlers.onSubmitted || null;
      this._redirected = false;

      const sb = window.AlbEdu?.supabase?.client;
      if (!sb) {
        console.warn('[block-listener] Supabase client unavailable, relying on heartbeat');
        return;
      }

      try {
        // Route through AlbEdu.supabase.realtime so the channel is tracked
        // in the shared _channels Map and cleaned up by unsubscribeAll()
        // on logout / page teardown.
        const realtime = window.AlbEdu?.supabase?.realtime;
        if (realtime && typeof realtime.subscribe === 'function') {
          this._subscription = realtime.subscribe(
            `session-${sessionId}`,
            {
              event: 'UPDATE',
              schema: 'public',
              table: 'assessment_sessions',
              filter: `id=eq.${sessionId}`,
            },
            (payload) => this._handleChange(payload)
          );
        } else {
          // Fallback: direct channel (still works, just not tracked)
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
        }
      } catch (err) {
        console.warn('[block-listener] Realtime subscribe failed:', err);
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
      this._onBlocked = null;
      this._onSubmitted = null;
    },

    _handleChange(payload) {
      if (this._redirected) return;
      const newRow = payload.new;
      if (!newRow) return;

      if (newRow.status === 'blocked') {
        this._redirected = true;
        this.stop();
        this._onBlocked?.(newRow.blocked_reason || 'Diblokir oleh admin');
      } else if (newRow.status === 'submitted') {
        this._redirected = true;
        this.stop();
        this._onSubmitted?.();
      }
    },

    // Manual fallback when Realtime is unavailable.
    async checkNow() {
      if (this._redirected || !this._sessionId) return;
      try {
        const doc = await window.AlbEdu?.repository?.getDoc('assessment_sessions', this._sessionId);
        if (!doc?.exists) return;
        const data = doc.data();
        if (data.status === 'blocked' && !this._redirected) {
          this._redirected = true;
          this.stop();
          this._onBlocked?.(data.blocked_reason || 'Diblokir oleh admin');
        } else if (data.status === 'submitted' && !this._redirected) {
          this._redirected = true;
          this.stop();
          this._onSubmitted?.();
        }
      } catch (err) {
        console.warn('[block-listener] checkNow error:', err);
      }
    },
  };

  window.BlockListener = BlockListener;
})();
