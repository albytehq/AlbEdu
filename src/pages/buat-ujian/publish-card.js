// publish-card.js — Card 3 of buat-ujian: summary, access-code display,
// and publish button. The actual publish to the `assessments` table lives
// in create-assessment.js `publishToSupabase()`; this card only triggers it.

(function () {
  'use strict';

  const t = (key, vars, fallback) => fallback;

  const PublishCard = {
    init() {
      this._summaryGrid = document.getElementById('summary-grid');
      this._warning = document.getElementById('publish-warning');
      this._warningText = document.getElementById('publish-warning-text');
      this._tokenDisplay = document.getElementById('token-display');
      this._tokenValue = document.getElementById('token-value');
      this._btnPublishFinal = document.getElementById('btn-publish-final');
      this._btnRegenerate = document.getElementById('btn-regenerate-token');
      this._btnCopyToken = document.getElementById('btn-copy-token');

      if (!this._summaryGrid) {
        console.warn('[PublishCard] required elements missing');
        return;
      }

      this._btnPublishFinal.addEventListener('click', () => this._publish());
      this._btnRegenerate.addEventListener('click', () => this._regenerateToken());
      this._btnCopyToken.addEventListener('click', () => this._copyToken());

      window.CreateAssessment.subscribe((state) => this._render(state));
    },

    _render(state) {
      const sections = state.examData.sections || [];
      const totalQ = sections.reduce((sum, s) => sum + s.questions.length, 0);
      const pgCount = sections.reduce(
        (sum, s) => sum + s.questions.filter((q) => q.pilihan).length,
        0
      );
      const esaiCount = totalQ - pgCount;
      const duration = parseInt(state.examData.duration_minutes, 10) || 0;

      this._summaryGrid.innerHTML = `
        <div class="albedu-summary-item">
          <div class="albedu-summary-label">Total Soal</div>
          <div class="albedu-summary-value">${totalQ}</div>
        </div>
        <div class="albedu-summary-item">
          <div class="albedu-summary-label">PG / Esai</div>
          <div class="albedu-summary-value">${pgCount} / ${esaiCount}</div>
        </div>
        <div class="albedu-summary-item">
          <div class="albedu-summary-label">Durasi</div>
          <div class="albedu-summary-value">${duration}m</div>
        </div>
        <div class="albedu-summary-item">
          <div class="albedu-summary-label">Bagian</div>
          <div class="albedu-summary-value">${sections.length}</div>
        </div>
      `;

      // Token display
      const token = state.examData.access_code;
      if (token) {
        this._tokenDisplay.hidden = false;
        this._tokenValue.textContent = token;
      } else {
        this._tokenDisplay.hidden = true;
      }

      // Validate + enable/disable publish
      const { valid, errors } = window.CreateAssessment.validate();
      if (valid && token) {
        this._warning.hidden = true;
        this._btnPublishFinal.disabled = false;
      } else {
        this._warning.hidden = false;
        const missing = [];
        if (!token) missing.push('generate token');
        if (errors.length) missing.push(errors[0].message);
        this._warningText.textContent = missing.join(' • ');
        this._btnPublishFinal.disabled = true;
      }
    },

    _regenerateToken() {
      const code = window.CreateAssessment.generateToken();
      window.notify?.success(
        t('wizard.token_new', null, 'Token Baru'),
        t('wizard.token_new_msg', { code }, `Token ${code} di-generate`),
        2000
      );
    },

    _copyToken() {
      const token = window.CreateAssessment.getToken();
      if (!token) {
        window.notify?.warning(
          t('wizard.no_token_title', null, 'Belum ada token'),
          t('wizard.no_token_msg', null, 'Generate token dulu')
        );
        return;
      }
      navigator.clipboard?.writeText(token).then(() => {
        window.notify?.success(
          t('wizard.token_copied', null, 'Tersalin'),
          t('wizard.token_copied_msg', { code: token }, `Token ${token} disalin`),
          2000
        );
      }).catch(() => {
        // Clipboard API unavailable — select the text so the user can copy manually.
        const range = document.createRange();
        range.selectNode(this._tokenValue);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        window.notify?.info(
          t('wizard.token_selected', null, 'Token dipilih'),
          t('wizard.token_selected_msg', null, 'Tekan Cmd/Ctrl+C untuk menyalin')
        );
      });
    },

    async _publish() {
      // Guard against rapid double-click: the confirm dialog is async, so a
      // second click would stack a second publish call. The UNIQUE constraint
      // on access_code would catch the duplicate, but the resulting error UX
      // is confusing ("duplicate key" — what?).
      if (this._isPublishing) return;
      this._isPublishing = true;
      try {
        await this._doPublish();
      } finally {
        this._isPublishing = false;
      }
    },

    async _doPublish() {
      const { valid, errors } = window.CreateAssessment.validate();
      if (!valid) {
        window.notify?.error(
          t('wizard.validation_failed', null, 'Validasi gagal'),
          errors[0]?.message || t('wizard.validation_incomplete', null, 'Lengkapi semua field')
        );
        return;
      }

      // Ensure token exists
      let token = window.CreateAssessment.getToken();
      if (!token) {
        token = window.CreateAssessment.generateToken();
      }

      const confirmed = await this._confirmPublish();
      if (!confirmed) return;

      try {
        window.UI?.showAuthLoading?.(t('wizard.publishing', null, 'Publishing asesmen...'));
        // publishToSupabase handles validate + token + DB insert
        const result = await window.CreateAssessment.publishToSupabase();

        window.UI?.hideAuthLoading?.();
        window.notify?.success(
          t('wizard.title_success', null, 'Berhasil!'),
          t('wizard.published_msg', { code: result.access_code }, `Asesmen dipublish dengan token ${result.access_code}`),
          4000
        );

        // Return to list view (don't redirect away — keep user on create-assessment page)
        setTimeout(() => {
          window.WizardController?.returnToListView?.();
        }, 1500);
      } catch (err) {
        window.UI?.hideAuthLoading?.();
        window.notify?.error(
          t('wizard.publish_failed', null, 'Gagal Publish'),
          err?.message || t('wizard.publish_unknown_error', null, 'Unknown error')
        );
        console.error('[PublishCard] publish failed:', err);
      }
    },

    async _confirmPublish() {
      if (!window.notify?.confirm) {
        return confirm(t('wizard.publish_confirm', null, 'Publish asesmen? Peserta bisa mulai mengerjakan setelah ini.'));
      }
      return new Promise((resolve) => {
        let settled = false;
        const done = (v) => {
          if (!settled) {
            settled = true;
            resolve(v);
          }
        };
        window.notify.confirm({
          title: t('wizard.btn_publish', null, 'Publish Asesmen'),
          message: t('wizard.publish_confirm_msg', null, 'Setelah publish, peserta bisa mulai mengerjakan asesmen dengan token. Yakin?'),
          intent: 'primary',
          onYes: () => done(true),
          onNo: () => done(false),
          onClose: () => done(false),
        });
      });
    },
  };

  window.PublishCard = PublishCard;
})();
