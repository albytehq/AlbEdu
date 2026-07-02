// =============================================================================
// list-view.js — Exam list view for Buat Ujian page (v0.2.0)
// =============================================================================
// Default view when user opens buat-ujian.html. Shows existing exams owned
// by the current admin, loaded from Supabase table `ujian`. Read-only — all
// exam management (start/stop/delete) lives on ujian-peserta.html.
//
// Subscription via onSnapshot keeps the list live: when a new exam is
// published from the wizard view, the list refreshes automatically.
//
// Loaded as classic <script defer>. Exposes window.ListView.
// =============================================================================

(function () {
  'use strict';

  const ListView = {
    init() {
      this._grid = document.getElementById('bu-exams-grid');
      this._empty = document.getElementById('bu-empty-state');

      if (!this._grid) {
        console.warn('[ListView] grid element missing — not on buat-ujian list view');
        return;
      }

      // Defer load until firebaseDb + auth are ready
      this._waitForAuthThenLoad();
    },

    _waitForAuthThenLoad() {
      // Auth bootstraps async on DOMContentLoaded. Poll up to 30s.
      let attempts = 0;
      const max = 300; // 300 × 100ms = 30s
      const tick = () => {
        attempts++;
        if (window.firebaseDb && window.firebaseAuth?.currentUser) {
          this._loadExams();
          return;
        }
        if (attempts < max) {
          setTimeout(tick, 100);
        } else {
          console.warn('[ListView] auth/db not ready after 30s — giving up');
        }
      };
      tick();
    },

    async _loadExams() {
      try {
        const db = window.firebaseDb;
        const user = window.firebaseAuth?.currentUser;
        if (!db || !user) return;

        // Initial fetch
        const snap = await db.collection('ujian')
          .where('createdBy', '==', user.uid)
          .orderBy('createdAt', 'desc')
          .limit(50)
          .get();
        const exams = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        this._render(exams);

        // Subscribe to changes (live update)
        db.collection('ujian')
          .where('createdBy', '==', user.uid)
          .orderBy('createdAt', 'desc')
          .limit(50)
          .onSnapshot(
            (snap) => {
              const exams = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
              this._render(exams);
            },
            (err) => console.warn('[ListView] snapshot error:', err)
          );
      } catch (err) {
        console.warn('[ListView] failed to load exams:', err);
        // Show empty state on error
        this._render([]);
      }
    },

    _render(exams) {
      if (!exams || !exams.length) {
        this._grid.hidden = true;
        this._grid.innerHTML = '';
        this._empty.hidden = false;
        return;
      }
      this._grid.hidden = false;
      this._empty.hidden = true;

      this._grid.innerHTML = exams.map((e) => {
        const u = e.ujian || {};
        const judul = u.judul || e.judul || 'Tanpa Judul';
        const mapel = u.mata_pelajaran || e.mata_pelajaran || '-';
        const durasi = u.time || '0';
        const token = u.kode_id || e.id;
        const tanggal = this._formatDate(e.createdAt);

        return `
          <article class="bu-exam-card">
            <div class="bu-exam-card-header">
              <h3 class="bu-exam-card-title">${this._esc(judul)}</h3>
              <span class="bu-exam-card-token">#${this._esc(token)}</span>
            </div>
            <div class="bu-exam-card-meta">
              <span><i class="material-symbols-outlined">book</i> ${this._esc(mapel)}</span>
              <span><i class="material-symbols-outlined">schedule</i> ${this._esc(durasi)}m</span>
              ${e.identity_mode ? `<span><i class="material-symbols-outlined">badge</i> ${e.identity_mode === 'daftar' ? 'Daftar' : 'Manual'}</span>` : ''}
            </div>
            <div class="bu-exam-card-date">Dibuat: ${tanggal}</div>
          </article>
        `;
      }).join('');
    },

    _formatDate(ts) {
      if (!ts) return '-';
      try {
        const d = ts.toDate ? ts.toDate() : new Date(ts);
        if (isNaN(d.getTime())) return '-';
        return d.toLocaleDateString('id-ID', {
          day: 'numeric', month: 'long', year: 'numeric',
        });
      } catch {
        return '-';
      }
    },

    // Public API — called by WizardController to refresh after publish
    refresh() {
      this._loadExams();
    },

    _esc(str) {
      return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },
  };

  window.ListView = ListView;
})();
