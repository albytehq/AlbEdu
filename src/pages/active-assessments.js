// active-assessments.js — fetches and displays admin's assessments
// INDEPENDENT: creates own Supabase client, does NOT depend on window.AlbEdu.supabase

(function () {
  'use strict';

  const WORKER_BASE = (() => {
    const meta = document.querySelector('meta[name="albedu-worker-base"]');
    if (meta?.content) return meta.content;
    return 'https://edu.albyte-inc.workers.dev';
  })();

  const CONFIG_CACHE_KEY = 'albedu_sb_config';
  const CONFIG_CACHE_TTL = 60 * 60 * 1000;
  let _client = null;

  async function _getClient() {
    if (_client) return _client;
    if (window.AlbEdu?.supabase?.client) { _client = window.AlbEdu.supabase.client; return _client; }

    let config = null;
    try {
      const raw = sessionStorage.getItem(CONFIG_CACHE_KEY);
      if (raw) { const p = JSON.parse(raw); if (Date.now() - p.ts < CONFIG_CACHE_TTL) config = p.config; }
    } catch (_) {}

    if (!config) {
      const res = await fetch(`${WORKER_BASE}/api/supabase-config`, { headers: { 'Accept': 'application/json' } });
      if (!res.ok) throw new Error(`Config: HTTP ${res.status}`);
      config = await res.json();
      try { sessionStorage.setItem(CONFIG_CACHE_KEY, JSON.stringify({ ts: Date.now(), config })); } catch (_) {}
    }

    if (typeof window.supabase === 'undefined' || !window.supabase.createClient) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('SDK load failed'));
        document.head.appendChild(s);
        setTimeout(() => reject(new Error('SDK timeout')), 10000);
      });
    }

    _client = window.supabase.createClient(config.url, config.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
    return _client;
  }

  const ActiveAssessments = {
    init() {
      this._grid = document.getElementById('active-grid');
      this._empty = document.getElementById('active-empty');
      this._loading = document.getElementById('active-loading');
      this._noResults = document.getElementById('active-no-results');
      this._count = document.getElementById('active-count');
      this._searchInput = document.getElementById('active-search-input');

      if (!this._grid) return;

      if (this._searchInput) {
        let d;
        this._searchInput.addEventListener('input', (e) => { clearTimeout(d); d = setTimeout(() => this._filter(e.target.value), 300); });
      }

      this.load();
    },

    async load() {
      if (this._loading) this._loading.hidden = false;
      if (this._grid) this._grid.innerHTML = '';
      if (this._empty) this._empty.hidden = true;

      try {
        const sb = await _getClient();
        const { data: { session } } = await sb.auth.getSession();
        if (!session?.user) { if (this._loading) this._loading.hidden = true; if (this._empty) this._empty.hidden = false; return; }

        const { data, error } = await sb
          .from('assessments')
          .select('id, access_code, title, subject, duration_minutes, status, ac_manual_status, access_mode, created_at, sections')
          .eq('created_by', session.user.id)
          .order('created_at', { ascending: false })
          .limit(50);

        if (error) throw error;
        this._allData = data || [];
        this._render(this._allData);
      } catch (err) {
        console.error('[ActiveAssessments]', err);
        if (this._loading) this._loading.hidden = true;
        if (this._empty) this._empty.hidden = false;
      }
    },

    _filter(q) {
      if (!this._allData) return;
      q = (q || '').toLowerCase().trim();
      this._render(q ? this._allData.filter(a => (a.title||'').toLowerCase().includes(q) || (a.subject||'').toLowerCase().includes(q) || (a.access_code||'').includes(q)) : this._allData);
    },

    _render(items) {
      if (this._loading) this._loading.hidden = true;
      if (!items?.length) { if (this._grid) this._grid.innerHTML = ''; if (this._empty) this._empty.hidden = false; if (this._count) this._count.textContent = '0'; return; }
      if (this._empty) this._empty.hidden = true;
      if (this._noResults) this._noResults.hidden = true;
      if (this._count) this._count.textContent = String(items.length);
      if (!this._grid) return;

      this._grid.innerHTML = items.map(a => {
        const tq = (a.sections||[]).reduce((s,sec) => s + (sec.questions||[]).length, 0);
        let badge = '';
        if (a.status === 'archived') badge = '<span class="albedu-status-badge albedu-status-archived">Arsip</span>';
        else if (a.ac_manual_status === 'open') badge = '<span class="albedu-status-badge albedu-status-running">Berjalan</span>';
        else if (a.ac_manual_status === 'finished') badge = '<span class="albedu-status-badge albedu-status-finished">Selesai</span>';
        else badge = '<span class="albedu-status-badge albedu-status-paused">Dijeda</span>';
        return `<article class="albedu-exam-card" data-id="${a.id}"><div class="albedu-exam-card-header"><h3 class="albedu-exam-card-title">${this._esc(a.title||'Tanpa Judul')}</h3><span class="albedu-exam-card-token">#${this._esc(a.access_code||'—')}</span></div><div class="albedu-exam-card-meta"><span><span data-albedu-icon="book"></span> ${this._esc(a.subject||'-')}</span><span><span data-albedu-icon="schedule"></span> ${a.duration_minutes||0}m</span><span><span data-albedu-icon="quiz"></span> ${tq} soal</span>${badge}</div><div class="albedu-exam-card-date">Dibuat: ${this._fmt(a.created_at)}</div></article>`;
      }).join('');
    },

    _fmt(ts) { try { const d = new Date(ts); return isNaN(d.getTime()) ? '-' : d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }); } catch { return '-'; } },
    _esc(s) { return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); },
  };

  window.ActiveAssessments = ActiveAssessments;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => ActiveAssessments.init());
  else ActiveAssessments.init();
})();
