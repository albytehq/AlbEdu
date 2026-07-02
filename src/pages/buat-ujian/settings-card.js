// =============================================================================
// settings-card.js — Card 3: max_halaman + theme (advanced settings)
// =============================================================================
// Wires max_halaman (1-10, default 3) and theme (default/dark/light).
// global_skor is NOT user-editable — auto-distributed at 100 (see buat-ujian.js).
// Loaded as classic <script defer>. Exposes window.SettingsCard.
// =============================================================================

(function () {
  'use strict';

  const SettingsCard = {
    init() {
      this._maxHalaman = document.getElementById('bu-max-halaman');
      this._theme = document.getElementById('bu-theme');

      if (!this._maxHalaman) {
        console.warn('[SettingsCard] required elements missing');
        return;
      }

      this._maxHalaman.addEventListener('input', (e) => {
        const state = window.BuatUjian.getState();
        const v = parseInt(e.target.value, 10);
        state.examData.ujian.max_halaman = (isNaN(v) || v < 1) ? 3 : Math.min(v, 10);
        window.BuatUjian.setState(state);
      });

      this._theme.addEventListener('change', (e) => {
        const state = window.BuatUjian.getState();
        state.examData.ujian.theme.tema = e.target.value;
        window.BuatUjian.setState(state);
      });

      window.BuatUjian.subscribe((state) => this._sync(state));
    },

    _sync(state) {
      const u = state.examData.ujian;
      if (parseInt(this._maxHalaman.value, 10) !== u.max_halaman) {
        this._maxHalaman.value = u.max_halaman;
      }
      if (this._theme.value !== u.theme.tema) {
        this._theme.value = u.theme.tema;
      }
    },
  };

  window.SettingsCard = SettingsCard;
})();
