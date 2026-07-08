// list-view.js — default view of the buat-ujian page. Lists the admin's
// published assessments from the `assessments` table (read-only — start/stop/
// delete lives on ujian-peserta.html). Subscribes to realtime so newly
// published assessments appear without a manual refresh.

(function () {
  'use strict';

  const ListView = {
    init() {
      this._grid = document.getElementById('assessments-grid');
      this._empty = document.getElementById('empty-state');

      if (!this._grid) {
        console.warn('[ListView] grid element missing — not on create-assessment list view');
        return;
      }

      // Defer load until the platform layer + auth are ready.
      this._waitForAuthThenLoad();
    },

    _waitForAuthThenLoad() {
      // Auth bootstraps async on DOMContentLoaded. Poll up to 30s.
      let attempts = 0;
      const max = 300; // 300 × 100ms = 30s
      const tick = () => {
        attempts++;
        if (window.AlbEdu?.repository && window.AlbEdu?.supabase?.auth?.currentUser) {
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
        const repo = window.AlbEdu?.repository;
        const user = window.AlbEdu?.supabase?.auth?.currentUser;
        if (!repo || !user) return;

        const snap = await repo.getDocs('assessments', {
          eq: { created_by: user.id },
          order: { column: 'created_at', ascending: false },
          limit: 50,
        });
        const exams = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        this._render(exams);

        // Live updates: refetch on any change to my assessments.
        repo.subscribe(
          'list-view:assessments',
          'assessments',
          async () => {
            try {
              const s = await repo.getDocs('assessments', {
                eq: { created_by: user.id },
                order: { column: 'created_at', ascending: false },
                limit: 50,
              });
              const xs = s.docs.map((d) => ({ id: d.id, ...d.data() }));
              this._render(xs);
            } catch (err) {
              console.warn('[ListView] snapshot refetch error:', err);
            }
          },
          `created_by=eq.${user.id}`
        );
      } catch (err) {
        console.warn('[ListView] failed to load assessments:', err);
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
        // Fields are flat on the assessment doc.
        const judul = e.title || 'Tanpa Judul';
        const mapel = e.subject || '-';
        const durasi = e.duration_minutes || 0;
        const token = e.access_code || e.id;
        const tanggal = this._formatDate(e.created_at || e.createdAt);

        return `
          <article class="albedu-exam-card">
            <div class="albedu-exam-card-header">
              <h3 class="albedu-exam-card-title">${this._esc(judul)}</h3>
              <span class="albedu-exam-card-token">#${this._esc(token)}</span>
            </div>
            <div class="albedu-exam-card-meta">
              <span><span data-albedu-icon="book"></span> ${this._esc(mapel)}</span>
              <span><span data-albedu-icon="schedule"></span> ${this._esc(durasi)}m</span>
              ${e.identity_mode ? `<span><span data-albedu-icon="badge"></span> ${e.identity_mode === 'daftar' ? 'Daftar' : 'Manual'}</span>` : ''}
            </div>
            <div class="albedu-exam-card-date">Dibuat: ${tanggal}</div>
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

    // Called by WizardController to refresh after publish.
    refresh() {
      this._loadExams();
    },

    _esc(str) {
      return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    },
  };

  window.ListView = ListView;
})();
