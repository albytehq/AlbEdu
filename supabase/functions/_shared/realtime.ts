// =============================================================================
// _shared/realtime.ts — Supabase Realtime broadcast helper
// =============================================================================
// Uses Supabase Realtime channels to push events to subscribed clients.
// Non-blocking: failures don't affect main request flow.
//
// Channels:
//   - session-{session_id}: peserta receives block/force-submit signals
//   - assessment-{assessment_id}: admin receives submit/violation signals
//   - admin-{admin_id}: admin receives notifications
// =============================================================================

import type { Env } from './types.ts';

// Broadcast via Supabase Realtime (using postgres_changes via direct insert)
// Actually, the simplest way to trigger realtime is to UPDATE a row that
// clients subscribe to. The postgres_changes event will fire automatically.
//
// For block: UPDATE assessment_sessions SET status='blocked' → peserta subscribed to that row receives UPDATE event
// For submit: INSERT submission → admin subscribed to submissions table receives INSERT event
//
// So this module is mostly a no-op — realtime is handled by DB changes.
// This file exists for documentation + future custom broadcast (e.g. via WebSocket).

export interface RealtimeEvent {
  channel: string;
  event: string;
  payload: any;
}

export function broadcast(env: Env, event: RealtimeEvent): void {
  // Future: implement custom WebSocket broadcast if needed.
  // For now, realtime is handled by Supabase Realtime postgres_changes
  // which fires automatically on DB row changes.
  //
  // To broadcast a custom event (not tied to DB change), we'd need to:
  // 1. Use Supabase Realtime broadcast API (requires client SDK)
  // 2. Or use a separate WebSocket server
  //
  // For v1.0.0, all realtime events are DB-change-triggered. This is a no-op.
  console.log(`[realtime] ${event.channel}:${event.event} (auto-broadcast via DB change)`);
}
