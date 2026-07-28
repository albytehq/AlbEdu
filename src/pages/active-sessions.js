// active-sessions.js — Phase 3: replaces monitoring.js (Realtime proctoring)
//
// Phase 3 zero-cost architecture: monitoring feature REMOVED.
// This page is now a simple list of active sessions with manual refresh
// (or 30s auto-refresh toggle). No Realtime subscriptions.
//
// Admin actions per session:
//   - Block (calls block-participant EF)
//   - View detail (modal with progress_pct, violation_count, last_heartbeat_at)

(function () {
  'use strict';

  const REFRESH_INTERVAL_MS = 30_000; // 30s auto-refresh (when enabled)

  let _autoRefreshEnabled = false;
  let _autoRefreshTimer = null;
  let _lastRefreshAt = null;

  document.addEventListener('DOMContentLoaded', async () => {
    const supabase = window.AlbEdu?.supabase;
    if (!supabase) {
      console.error('[active-sessions] Supabase not ready');
      return;
    }
    await supabase.ready;

    // Wire up controls
    document.getElementById('btn-refresh')?.addEventListener('click', () => loadSessions(true));
    document.getElementById('btn-auto-refresh')?.addEventListener('click', toggleAutoRefresh);

    // Initial load
    await loadSessions(false);
  });

  async function loadSessions(showToast) {
    const supabase = window.AlbEdu.supabase.client;
    const listEl = document.getElementById('sessions-list');
    const countEl = document.getElementById('stat-active');
    const violationsEl = document.getElementById('stat-violations');
    const blockedEl = document.getElementById('stat-blocked');

    if (showToast) {
      const refreshBtn = document.getElementById('btn-refresh');
      if (refreshBtn) refreshBtn.disabled = true;
    }

    try {
      // Fetch active + paused + disconnected sessions (NOT submitted/expired/blocked — those are done)
      // RLS: admin can read all sessions
      const { data: sessions, error } = await supabase
        .from('assessment_sessions')
        .select(`
          id, status, started_at, last_heartbeat_at, current_section, current_question,
          progress_pct, violation_count, blocked_at, blocked_reason,
          user_id, user_email, identity_snapshot,
          assessments!inner(id, access_code, title, subject, duration_minutes, created_by)
        `)
        .in('status', ['active', 'paused', 'disconnected'])
        .order('last_heartbeat_at', { ascending: false, nullsFirst: false })
        .limit(100);

      if (error) throw error;

      _lastRefreshAt = new Date();
      updateLastRefresh();

      // Update stats
      const active = sessions?.filter(s => s.status === 'active') || [];
      const totalViolations = sessions?.reduce((sum, s) => sum + (s.violation_count || 0), 0) || 0;
      // For blocked count, separate query
      const { count: blockedCount } = await supabase
        .from('assessment_sessions')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'blocked');

      if (countEl) countEl.textContent = active.length;
      if (violationsEl) violationsEl.textContent = totalViolations;
      if (blockedEl) blockedEl.textContent = blockedCount || 0;

      // Render list
      if (!sessions || sessions.length === 0) {
        listEl.innerHTML = `
          <div class="albedu-empty-state">
            <span data-albedu-icon="person_off"><svg class="albedu-icon" aria-hidden="true"><use href="#i-person_off"/></svg></span>
            <h3>Tidak Ada Peserta Aktif</h3>
            <p>Belum ada peserta yang sedang mengerjakan asesmen saat ini.</p>
          </div>`;
        return;
      }

      listEl.innerHTML = sessions.map(renderSessionCard).join('');

      // Wire up block buttons
      document.querySelectorAll('.btn-block-session').forEach(btn => {
        btn.addEventListener('click', handleBlock);
      });
    } catch (err) {
      console.error('[active-sessions] load failed:', err);
      listEl.innerHTML = `
        <div class="albedu-empty-state">
          <span data-albedu-icon="error"><svg class="albedu-icon" aria-hidden="true"><use href="#i-error"/></svg></span>
          <h3>Gagal Memuat</h3>
          <p>${escapeHtml(err.message || 'Unknown error')}</p>
        </div>`;
    } finally {
      if (showToast) {
        const refreshBtn = document.getElementById('btn-refresh');
        if (refreshBtn) refreshBtn.disabled = false;
      }
    }
  }

  function renderSessionCard(s) {
    const assessment = s.assessments || {};
    const pesertaName = s.identity_snapshot?.nama || s.user_email || 'Unknown';
    const pesertaKelas = s.identity_snapshot?.kelas || '';
    const lastHb = s.last_heartbeat_at ? timeAgo(s.last_heartbeat_at) : '—';
    const progress = Number(s.progress_pct || 0).toFixed(0);
    const violations = s.violation_count || 0;
    const isStale = isHeartbeatStale(s.last_heartbeat_at);

    const statusBadge = s.status === 'active' ? '<span class="badge badge-success">Aktif</span>'
                      : s.status === 'paused' ? '<span class="badge badge-warn">Jeda</span>'
                      : '<span class="badge badge-danger">Terputus</span>';

    const staleWarning = isStale ? '<span class="badge badge-warn" title="Heartbeat >90s">⚠ Stale</span>' : '';

    return `
      <div class="session-card" data-session-id="${s.id}" data-assessment-id="${assessment.id}">
        <div class="session-header">
          <div class="session-info">
            <div class="session-name">${escapeHtml(pesertaName)} ${pesertaKelas ? `<span class="session-class">(${escapeHtml(pesertaKelas)})</span>` : ''}</div>
            <div class="session-meta">
              ${statusBadge} ${staleWarning}
              <span class="meta-text">${escapeHtml(assessment.title || 'Unknown')} · ${escapeHtml(assessment.access_code || '—')}</span>
            </div>
          </div>
          <div class="session-actions">
            <button class="albedu-btn albedu-btn-danger albedu-btn-sm btn-block-session" type="button">
              <span data-albedu-icon="block"><svg class="albedu-icon" aria-hidden="true"><use href="#i-block"/></svg></span>
              <span>Blokir</span>
            </button>
          </div>
        </div>
        <div class="session-stats">
          <div class="session-stat">
            <span class="stat-label">Progress</span>
            <span class="stat-value">${progress}%</span>
          </div>
          <div class="session-stat">
            <span class="stat-label">Posisi</span>
            <span class="stat-value">S${(s.current_section || 0) + 1} Q${(s.current_question || 0) + 1}</span>
          </div>
          <div class="session-stat">
            <span class="stat-label">Pelanggaran</span>
            <span class="stat-value ${violations >= 3 ? 'stat-danger' : violations >= 1 ? 'stat-warn' : ''}">${violations}</span>
          </div>
          <div class="session-stat">
            <span class="stat-label">Heartbeat</span>
            <span class="stat-value">${lastHb}</span>
          </div>
        </div>
      </div>`;
  }

  async function handleBlock(event) {
    const btn = event.currentTarget;
    const card = btn.closest('.session-card');
    const sessionId = card.dataset.sessionId;

    const reason = prompt('Alasan pemblokiran? (opsional, max 500 char)') || 'Blocked by admin';
    if (reason.length > 500) {
      alert('Alasan terlalu panjang (max 500 char)');
      return;
    }

    if (!confirm(`Yakin blokir peserta ini?\n\nAlasan: ${reason}\n\nPeserta akan diarahkan ke halaman blocked.html dalam ≤15 detik.`)) {
      return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span>Memproses...</span>';

    try {
      const supabase = window.AlbEdu.supabase.client;
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error('Not authenticated');

      const res = await fetch(`${window.AlbEdu.supabase.client.supabaseUrl}/functions/v1/block-participant`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'apikey': window.AlbEdu.supabase.client.supabaseKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ session_id: sessionId, reason }),
      });

      const result = await res.json();
      if (!res.ok) throw new Error(result.error?.message || `HTTP ${res.status}`);

      // Remove card from list
      card.style.opacity = '0.5';
      setTimeout(() => {
        card.remove();
        loadSessions(false); // refresh stats
      }, 500);

      window.notify?.success?.('Peserta diblokir', 'Peserta akan diarahkan ke halaman blocked.html dalam ≤15 detik.', 5000);
    } catch (err) {
      console.error('[active-sessions] block failed:', err);
      window.notify?.error?.('Gagal Memblokir', err.message, 5000);
      btn.disabled = false;
      btn.innerHTML = '<span data-albedu-icon="block"><svg class="albedu-icon" aria-hidden="true"><use href="#i-block"/></svg></span><span>Blokir</span>';
    }
  }

  function toggleAutoRefresh() {
    _autoRefreshEnabled = !_autoRefreshEnabled;
    const btn = document.getElementById('btn-auto-refresh');
    const indicator = document.getElementById('auto-refresh-indicator');

    if (_autoRefreshEnabled) {
      btn?.classList.add('active');
      btn?.setAttribute('aria-pressed', 'true');
      if (indicator) indicator.textContent = `Auto-refresh 30s (aktif)`;
      _autoRefreshTimer = setInterval(() => loadSessions(false), REFRESH_INTERVAL_MS);
      console.info('[active-sessions] Auto-refresh enabled (30s)');
    } else {
      btn?.classList.remove('active');
      btn?.setAttribute('aria-pressed', 'false');
      if (indicator) indicator.textContent = `Auto-refresh 30s`;
      if (_autoRefreshTimer) clearInterval(_autoRefreshTimer);
      _autoRefreshTimer = null;
      console.info('[active-sessions] Auto-refresh disabled');
    }
  }

  function updateLastRefresh() {
    const el = document.getElementById('last-refresh');
    if (el && _lastRefreshAt) {
      el.textContent = `Terakhir refresh: ${_lastRefreshAt.toLocaleTimeString('id-ID')}`;
    }
  }

  function isHeartbeatStale(lastHb) {
    if (!lastHb) return false;
    const age = Date.now() - new Date(lastHb).getTime();
    return age > 90_000; // >90s = stale (heartbeat is 60s, grace 30s)
  }

  function timeAgo(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return `${sec}d lalu`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m lalu`;
    const hr = Math.floor(min / 60);
    return `${hr}j lalu`;
  }

  function escapeHtml(str) {
    if (str == null) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  // Expose for debugging
  window.ActiveSessions = { load: loadSessions };
})();
