// list-view.js — lists admin's assessments on the buat-ujian page
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

  const ListView = {
    init() {
      this._grid = document.getElementById('assessments-grid');
      this._empty = document.getElementById('empty-state');
      if (!this._grid) return;
      this._loadExams();
    },

    async _loadExams() {
      try {
        const sb = await _getClient();
        const { data: { session } } = await sb.auth.getSession();
        if (!session?.user) { this._render([]); return; }

        const { data, error } = await sb
          .from('assessments')
          .select('id, access_code, title, subject, duration_minutes, status, ac_manual_status, access_mode, created_at, sections, identity_mode')
          .eq('created_by', session.user.id)
          .order('created_at', { ascending: false })
          .limit(50);

        if (error) throw error;
        this._render(data || []);
      } catch (err) {
        console.warn('[ListView]', err);
        this._render([]);
      }
    },

    _render(exams) {
      if (!exams?.length) { this._grid.hidden = true; this._grid.innerHTML = ''; this._empty.hidden = false; return; }
      this._grid.hidden = false;
      this._empty.hidden = true;

      this._grid.innerHTML = exams.map(e => {
        const tq = (e.sections||[]).reduce((s,sec) => s + (sec.questions||[]).length, 0);
        return `<article class="albedu-exam-card"><div class="albedu-exam-card-header"><h3 class="albedu-exam-card-title">${this._esc(e.title||'Tanpa Judul')}</h3><span class="albedu-exam-card-token">#${this._esc(e.access_code||e.id)}</span></div><div class="albedu-exam-card-meta"><span><span data-albedu-icon="book"></span> ${this._esc(e.subject||'-')}</span><span><span data-albedu-icon="schedule"></span> ${e.duration_minutes||0}m</span><span><span data-albedu-icon="quiz"></span> ${tq} soal</span>${e.identity_mode ? `<span><span data-albedu-icon="badge"></span> ${e.identity_mode === 'daftar' ? 'Daftar' : 'Manual'}</span>` : ''}</div><div class="albedu-exam-card-date">Dibuat: ${this._fmt(e.created_at)}</div></article>`;
      }).join('');
    },

    _fmt(ts) { try { const d = new Date(ts); return isNaN(d.getTime()) ? '-' : d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }); } catch { return '-'; } },
    refresh() { this._loadExams(); },
    _esc(s) { return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); },
  };

  window.ListView = ListView;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => ListView.init());
  else ListView.init();
})();
