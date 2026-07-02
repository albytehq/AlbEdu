// =============================================================================
// publish-card.js — Card 4: summary + token + publish to Supabase
// =============================================================================
// Save logic verified from controller.js saveExamToSupabase:
//   - INSERT-only via db.runTransaction (no update)
//   - Doc ref = db.collection('ujian').doc(kodeId)
//   - Transaction guard: if doc.exists → throw "Token ujian sudah digunakan"
//   - access_control normalized based on mode (manual → manual_status='closed')
//   - Server timestamps via db.FieldValue.serverTimestamp()
//   - createdBy = user.uid, status = 'active' (no draft state in DB)
//
// Loaded as classic <script defer>. Exposes window.PublishCard.
// =============================================================================

(function () {
  'use strict';

  const PublishCard = {
    init() {
      this._summaryGrid = document.getElementById('bu-summary-grid');
      this._warning = document.getElementById('bu-publish-warning');
      this._warningText = document.getElementById('bu-publish-warning-text');
      this._tokenDisplay = document.getElementById('bu-token-display');
      this._tokenValue = document.getElementById('bu-token-value');
      this._btnPublishFinal = document.getElementById('bu-btn-publish-final');
      this._btnRegenerate = document.getElementById('bu-btn-regenerate-token');
      this._btnCopyToken = document.getElementById('bu-btn-copy-token');

      if (!this._summaryGrid) {
        console.warn('[PublishCard] required elements missing');
        return;
      }

      this._btnPublishFinal.addEventListener('click', () => this._publish());
      this._btnRegenerate.addEventListener('click', () => this._regenerateToken());
      this._btnCopyToken.addEventListener('click', () => this._copyToken());

      window.BuatUjian.subscribe((state) => this._render(state));
    },

    _render(state) {
      const sections = state.sections || [];
      const totalQ = sections.reduce((sum, s) => sum + s.questions.length, 0);
      const pgCount = sections.reduce(
        (sum, s) => sum + s.questions.filter((q) => q.pilihan).length,
        0
      );
      const esaiCount = totalQ - pgCount;
      const duration = parseInt(state.examData.ujian.time) || 0;

      this._summaryGrid.innerHTML = `
        <div class="bu-summary-item">
          <div class="bu-summary-label">Total Soal</div>
          <div class="bu-summary-value">${totalQ}</div>
        </div>
        <div class="bu-summary-item">
          <div class="bu-summary-label">PG / Esai</div>
          <div class="bu-summary-value">${pgCount} / ${esaiCount}</div>
        </div>
        <div class="bu-summary-item">
          <div class="bu-summary-label">Durasi</div>
          <div class="bu-summary-value">${duration}m</div>
        </div>
        <div class="bu-summary-item">
          <div class="bu-summary-label">Bagian</div>
          <div class="bu-summary-value">${sections.length}</div>
        </div>
      `;

      // Token display
      const token = state.examData.ujian.kode_id;
      if (token) {
        this._tokenDisplay.hidden = false;
        this._tokenValue.textContent = token;
      } else {
        this._tokenDisplay.hidden = true;
      }

      // Validate + enable/disable publish
      const { valid, errors } = window.BuatUjian.validate();
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
      const code = window.BuatUjian.generateToken();
      window.notify?.success('Token Baru', `Token ${code} di-generate`, 2000);
    },

    _copyToken() {
      const token = window.BuatUjian.getToken();
      if (!token) {
        window.notify?.warning('Belum ada token', 'Generate token dulu');
        return;
      }
      navigator.clipboard?.writeText(token).then(() => {
        window.notify?.success('Tersalin', `Token ${token} disalin`, 2000);
      }).catch(() => {
        // Fallback — select text
        const range = document.createRange();
        range.selectNode(this._tokenValue);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        window.notify?.info('Token dipilih', 'Tekan Cmd/Ctrl+C untuk menyalin');
      });
    },

    async _publish() {
      const { valid, errors } = window.BuatUjian.validate();
      if (!valid) {
        window.notify?.error('Validasi gagal', errors[0]?.message || 'Lengkapi semua field');
        return;
      }

      // Ensure token exists
      let token = window.BuatUjian.getToken();
      if (!token) {
        token = window.BuatUjian.generateToken();
      }

      const confirmed = await this._confirmPublish();
      if (!confirmed) return;

      try {
        window.UI?.showAuthLoading?.('Publishing ujian...');
        const examData = window.BuatUjian.exportExamData();
        await this._saveToSupabase(examData);

        window.UI?.hideAuthLoading?.();
        window.notify?.success('Berhasil!', `Ujian dipublish dengan token ${token}`, 4000);

        // Return to list view (don't redirect away — keep user on Buat Ujian page)
        setTimeout(() => {
          window.WizardController?.returnToListView?.();
        }, 1500);
      } catch (err) {
        window.UI?.hideAuthLoading?.();
        window.notify?.error('Gagal Publish', err?.message || 'Unknown error');
        console.error('[PublishCard] publish failed:', err);
      }
    },

    // ── Save to Supabase (verified from controller.js saveExamToSupabase) ──
    // Uses Firestore-compatible shim: window.firebaseDb.collection('ujian').doc(kodeId)
    // Wrapped in runTransaction() to guard against token collisions.
    async _saveToSupabase(examData) {
      const kodeId = examData.ujian?.kode_id;
      if (!kodeId) throw new Error('Token tidak ditemukan');

      const db = window.firebaseDb;
      const user = window.firebaseAuth?.currentUser;
      if (!user) throw new Error('User tidak terautentikasi');
      if (!db) throw new Error('Database belum siap (firebaseDb undefined)');

      const docRef = db.collection('ujian').doc(kodeId);

      await db.runTransaction(async (transaction) => {
        const doc = await transaction.get(docRef);
        if (doc.exists) throw new Error('Token ujian sudah digunakan, generate ulang token');

        const acMode = examData.access_control?.mode || 'manual';
        const normalizedAC = {
          ...examData.access_control,
          ...(acMode === 'manual' ? {
            manual_status: 'closed',
            end: null,
            remaining_time: null,
            override: false,
          } : {}),
        };

        transaction.set(docRef, {
          ...examData,
          access_control: normalizedAC,
          judul: examData.ujian?.judul ?? null,
          mata_pelajaran: examData.ujian?.mata_pelajaran ?? null,
          identity_mode: examData.identity_mode ?? examData.ujian?.identity_mode ?? 'manual',
          identity_config: examData.identity_config ?? examData.ujian?.identity_config ?? {},
          sections: examData.sections ?? [],
          createdBy: user.uid,
          createdByEmail: user.email || null,
          createdAt: db.FieldValue.serverTimestamp(),
          updatedAt: db.FieldValue.serverTimestamp(),
          status: 'active',
        });
      });
    },

    async _confirmPublish() {
      if (!window.notify?.confirm) {
        return confirm('Publish ujian? Peserta bisa mulai mengerjakan setelah ini.');
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
          title: 'Publish Ujian',
          message: 'Setelah publish, peserta bisa mulai mengerjakan ujian dengan token. Yakin?',
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
