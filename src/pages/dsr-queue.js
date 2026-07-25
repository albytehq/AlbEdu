// src/pages/dsr-queue.js — DSR admin queue UI
// Lists pending DSRs, lets admin approve/reject via dsr-process EF

import { supabase } from '../platform/supabase-client.js';

const DSRR_TYPES = ['access', 'correct', 'delete', 'portability'];
const DEADLINE_DAYS = 30;
const URGENT_DAYS = 7;
const CRITICAL_DAYS = 3;

document.addEventListener('DOMContentLoaded', async () => {
  await supabase.ready;

  document.getElementById('refresh-btn').addEventListener('click', loadDSRs);
  await loadDSRs();
});

async function loadDSRs() {
  const listEl = document.getElementById('dsr-list');
  listEl.innerHTML = '<div class="empty-state">Loading...</div>';

  try {
    // Fetch pending DSRs (RLS: admin can read all)
    const { data: pending, error } = await supabase.client
      .from('data_subject_requests')
      .select(`
        id, user_id, request_type, details, status, created_at,
        resolved_at, resolution_notes,
        users!inner(email, peran)
      `)
      .eq('status', 'pending')
      .order('created_at', { ascending: true });  // oldest first

    if (error) throw error;

    // Fetch resolved count last 30 days for stats
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { count: resolved30d } = await supabase.client
      .from('data_subject_requests')
      .select('id', { count: 'exact', head: true })
      .in('status', ['approved', 'rejected'])
      .gte('resolved_at', thirtyDaysAgo);

    // Update stats
    let urgent = 0, critical = 0;
    for (const dsr of pending || []) {
      const daysLeft = daysUntilDeadline(dsr.created_at);
      if (daysLeft <= CRITICAL_DAYS) critical++;
      else if (daysLeft <= URGENT_DAYS) urgent++;
    }
    document.getElementById('stat-pending').textContent = pending?.length || 0;
    document.getElementById('stat-urgent').textContent = urgent;
    document.getElementById('stat-critical').textContent = critical;
    document.getElementById('stat-resolved-30d').textContent = resolved30d || 0;

    // Render
    if (!pending || pending.length === 0) {
      listEl.innerHTML = '<div class="empty-state">✅ No pending DSRs. All caught up!</div>';
      return;
    }

    listEl.innerHTML = pending.map(renderDSRCard).join('');

    // Wire up buttons
    document.querySelectorAll('.btn-approve, .btn-reject').forEach(btn => {
      btn.addEventListener('click', handleAction);
    });
  } catch (err) {
    listEl.innerHTML = `<div class="empty-state">❌ Failed to load: ${err.message}</div>`;
  }
}

function renderDSRCard(dsr) {
  const daysLeft = daysUntilDeadline(dsr.created_at);
  const deadlineClass = daysLeft <= CRITICAL_DAYS ? 'badge-deadline-critical'
                      : daysLeft <= URGENT_DAYS ? 'badge-deadline-urgent' : '';
  const deadlineText = daysLeft <= 0 ? 'OVERDUE'
                     : `${daysLeft}d left`;

  const userEmail = dsr.users?.email || '(unknown)';
  const details = dsr.details
    ? JSON.stringify(dsr.details, null, 2)
    : '(no details provided)';

  return `
    <div class="dsr-card" data-dsr-id="${dsr.id}" data-user-email="${userEmail}">
      <div class="header">
        <div class="user-info">
          <div class="user-email">${userEmail}</div>
          <div class="meta">
            User ID: ${dsr.user_id.slice(0, 8)}... ·
            Submitted: ${new Date(dsr.created_at).toLocaleString()}
          </div>
        </div>
        <div>
          <span class="badge badge-type-${dsr.request_type}">${dsr.request_type}</span>
          ${deadlineClass ? `<span class="badge ${deadlineClass}" style="margin-left:8px">${deadlineText}</span>` : ''}
        </div>
      </div>
      <div class="details">${escapeHtml(details)}</div>
      <div class="actions">
        <input type="text" class="notes-input" placeholder="Resolution notes (optional, max 1000 chars)" maxlength="1000">
        <button class="btn-approve" data-action="approve">✓ Approve</button>
        <button class="btn-reject" data-action="reject">✗ Reject</button>
      </div>
    </div>
  `;
}

async function handleAction(event) {
  const btn = event.currentTarget;
  const card = btn.closest('.dsr-card');
  const dsrId = card.dataset.dsrId;
  const userEmail = card.dataset.userEmail;
  const action = btn.dataset.action;
  const notesInput = card.querySelector('.notes-input');
  const notes = notesInput.value.trim();

  // Confirm destructive action
  if (action === 'approve') {
    const confirmed = confirm(
      `Approve this DSR?\n\n` +
      `User: ${userEmail}\n` +
      `Action: ${action}\n` +
      (notes ? `Notes: ${notes}\n` : '') +
      `\nFor 'delete' DSRs, this will:\n` +
      `- Soft-delete the user\n` +
      `- Delete their avatar from Storage\n` +
      `- Anonymize their submissions\n` +
      `- Delete their sessions\n` +
      `\nThis cannot be undone.`
    );
    if (!confirmed) return;
  } else {
    if (!notes) {
      alert('Please provide a reason for rejection (in the notes field).');
      return;
    }
  }

  btn.disabled = true;
  btn.textContent = 'Processing...';

  try {
    const { data: { session } } = await supabase.client.auth.getSession();
    if (!session?.access_token) throw new Error('Not authenticated');

    const res = await fetch(`${location.origin.replace(/\/$/, '')}/functions/v1/dsr-process`.replace('/pages/admin', '') || `https://kzsrerxhhrtsxnpnmqgl.supabase.co/functions/v1/dsr-process`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': (await supabase.client.auth.getSession()).data.session?.user ? 'sb_publishable_p_uqWt9vKH-n7EoL6g9jpQ_CpS3wHNc' : '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        dsr_id: dsrId,
        action,
        resolution_notes: notes,
      }),
    });

    const result = await res.json();
    if (!res.ok) throw new Error(result.error?.message || `HTTP ${res.status}`);

    showToast(`${action === 'approve' ? 'Approved' : 'Rejected'} successfully`, 'success');

    // Remove card from list + refresh stats
    card.style.opacity = '0.5';
    setTimeout(() => {
      card.remove();
      loadDSRs();  // refresh stats
    }, 500);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = action === 'approve' ? '✓ Approve' : '✗ Reject';
    showToast(`Failed: ${err.message}`, 'error');
  }
}

function daysUntilDeadline(createdAt) {
  const created = new Date(createdAt).getTime();
  const deadline = created + DEADLINE_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();
  return Math.ceil((deadline - now) / (24 * 60 * 60 * 1000));
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

function showToast(message, type = 'success') {
  // Reuse QNotify if available, otherwise simple toast
  if (window.QNotify) {
    window.QNotify[type === 'error' ? 'error' : 'success'](message);
    return;
  }
  const toast = document.createElement('div');
  toast.className = `toast ${type} show`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}
