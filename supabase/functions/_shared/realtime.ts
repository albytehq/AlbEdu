// _shared/realtime.ts — Realtime broadcast helper (currently a no-op).
// Supabase Realtime postgres_changes fires automatically when DB rows change,
// so block / submit / violation signals reach subscribed clients without any
// explicit broadcast. Kept as a stub so a custom WebSocket channel can be
// added later without touching every callsite.
// Channels:
//   session-{session_id}       — peserta receives block/force-submit signals
//   assessment-{assessment_id} — admin receives submit/violation signals
//   admin-{admin_id}           — admin receives notifications

import type { Env } from './types.ts';

export interface RealtimeEvent {
  channel: string;
  event: string;
  payload: any;
}

export function broadcast(env: Env, event: RealtimeEvent): void {
  // No-op: postgres_changes handles delivery. Kept for future custom broadcast.
  console.log(`[realtime] ${event.channel}:${event.event}`);
}
