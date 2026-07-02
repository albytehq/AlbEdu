// =============================================================================
// draft-storage.js — Auto-save Buat Ujian draft to localStorage
// =============================================================================
// Supabase writes are publish-only (INSERT via transaction, no update).
// Drafts are auto-saved to localStorage so refresh / accidental close
// doesn't lose work. Debounced 1500ms after the last state change.
// Loaded as classic <script defer>. Exposes window.DraftStorage.
// =============================================================================

(function () {
  'use strict';

  const DRAFT_KEY = 'albedu_buat_ujian_draft_v2';
  const DEBOUNCE_MS = 1500;
  const STATUS_INTERVAL_MS = 30000;

  let _timer = null;
  let _lastSavedAt = null;

  const DraftStorage = {
    init() {
      // Subscribe to state changes — schedule a debounced save on every change.
      window.BuatUjian.subscribe(() => this._scheduleSave());

      // Periodically refresh "Tersimpan • X menit lalu" text.
      setInterval(() => this._updateStatusText(), STATUS_INTERVAL_MS);

      // Try restore on init (after a tick so other modules are wired up).
      setTimeout(() => this._tryRestore(), 0);

      console.info('[DraftStorage] init — localStorage draft, debounce 1500ms');
    },

    _scheduleSave() {
      if (_timer) clearTimeout(_timer);
      this._setStatus('saving');
      _timer = setTimeout(() => this.saveNow(), DEBOUNCE_MS);
    },

    async saveNow() {
      try {
        const state = window.BuatUjian.getState();
        const envelope = {
          schemaVersion: '2.2.0',
          savedAt: new Date().toISOString(),
          state,
        };
        localStorage.setItem(DRAFT_KEY, JSON.stringify(envelope));
        _lastSavedAt = Date.now();
        this._setStatus('saved');
      } catch (err) {
        console.error('[DraftStorage] save failed:', err);
        this._setStatus('error');
        window.notify?.error('Draft gagal disimpan', err?.message || 'localStorage error', 4000);
      }
    },

    _tryRestore() {
      try {
        const raw = localStorage.getItem(DRAFT_KEY);
        if (!raw) return;
        const envelope = JSON.parse(raw);
        if (!envelope?.state) return;

        // Don't restore if the saved draft is empty (no judul, no sections, no token)
        const s = envelope.state;
        const isEmpty =
          (!s.examData?.ujian?.judul) &&
          (!s.sections || s.sections.length === 0) &&
          (!s.examData?.ujian?.kode_id);
        if (isEmpty) {
          localStorage.removeItem(DRAFT_KEY);
          return;
        }

        // Ask user before overwriting the fresh state.
        // Fall back to native confirm() if QNotify isn't available.
        if (window.notify?.confirm) {
          return new Promise((resolve) => {
            let settled = false;
            const done = (ok) => {
              if (settled) return;
              settled = true;
              if (ok) {
                window.BuatUjian.setState(envelope.state);
                window.notify?.info('Draft dipulihkan', 'Perubahan terakhir kamu dipulihkan', 3000);
              } else {
                localStorage.removeItem(DRAFT_KEY);
              }
              resolve();
            };
            window.notify.confirm({
              title: 'Lanjutkan draft?',
              message: 'Ditemukan draft ujian yang belum selesai. Lanjutkan mengedit?',
              intent: 'primary',
              onYes: () => done(true),
              onNo: () => done(false),
              onClose: () => done(false),
            });
          });
        }

        if (confirm('Ditemukan draft ujian yang belum selesai. Lanjutkan?')) {
          window.BuatUjian.setState(envelope.state);
        } else {
          localStorage.removeItem(DRAFT_KEY);
        }
      } catch (err) {
        console.warn('[DraftStorage] restore failed:', err);
      }
    },

    clear() {
      localStorage.removeItem(DRAFT_KEY);
      _lastSavedAt = null;
      this._setStatus('idle');
    },

    _setStatus(status) {
      const dotEl = document.querySelector('.bu-save-dot');
      const textEl = document.querySelector('.bu-save-text');
      if (!dotEl || !textEl) return;
      dotEl.className = `bu-save-dot bu-save-dot-${status}`;
      if (status === 'saving') {
        textEl.textContent = 'Menyimpan...';
      } else if (status === 'saved') {
        _lastSavedAt = Date.now();
        this._updateStatusText();
      } else if (status === 'error') {
        textEl.textContent = 'Gagal menyimpan';
      } else {
        textEl.textContent = 'Belum ada perubahan';
      }
    },

    _updateStatusText() {
      if (!_lastSavedAt) return;
      const textEl = document.querySelector('.bu-save-text');
      if (!textEl) return;
      const diffSec = Math.floor((Date.now() - _lastSavedAt) / 1000);
      let text;
      if (diffSec < 60) text = `Tersimpan • ${diffSec} detik lalu`;
      else if (diffSec < 3600) text = `Tersimpan • ${Math.floor(diffSec / 60)} menit lalu`;
      else text = `Tersimpan • ${Math.floor(diffSec / 3600)} jam lalu`;
      textEl.textContent = text;
    },
  };

  window.DraftStorage = DraftStorage;
})();
