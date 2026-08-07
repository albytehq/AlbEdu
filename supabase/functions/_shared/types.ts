// _shared/types.ts — Shared TypeScript types for AlbEdu Edge Functions.

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_DB_URL?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  CF_WORKER_URL?: string;
  AUTH_TOKEN?: string;
  // Phase 2: BackBlaze B2 for assessment images
  B2_KEY_ID?: string;
  B2_APPLICATION_KEY?: string;
  B2_BUCKET_NAME?: string;
  B2_ENDPOINT?: string;       // e.g. s3.us-west-002.backblazeb2.com
  B2_REGION?: string;         // e.g. us-west-002
  // Free Plan tunables. Defaults stay below Supabase limits.
  ALBEDU_MAX_CONCURRENT_PESERTA?: string;  // default 200
  ALBEDU_HEARTBEAT_INTERVAL_MS?: string;   // default 15000
  ALBEDU_HEARTBEAT_CACHE_TTL_MS?: string;  // default 60000
}

export interface AuthUser {
  id: string;
  email: string;
  role?: 'admin' | 'peserta';
}

export interface AssessmentSession {
  id: string;
  assessment_id: string;
  user_id: string;
  user_email: string | null;
  identity_snapshot: Record<string, any> | null;
  device_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  status: 'active' | 'paused' | 'submitted' | 'blocked' | 'expired' | 'disconnected';
  started_at: string;
  last_heartbeat_at: string;
  submitted_at: string | null;
  blocked_at: string | null;
  blocked_by: string | null;
  blocked_reason: string | null;
  current_section: number;
  current_question: number;
  progress_pct: number;
  violation_count: number;
  draft_answers: Record<string, any>;
  attempt_number: number;
}

export interface Assessment {
  id: string;
  access_code: string;
  organization_id: string | null;
  created_by: string;
  created_by_email: string | null;
  title: string;
  subject: string;
  duration_minutes: number;
  access_mode: 'manual' | 'scheduled';
  note_enabled: boolean;
  note_text: string | null;
  max_pages_per_section: number;
  total_score: number;
  theme_config: Record<string, any>;
  identity_mode: 'manual' | 'daftar';
  identity_config: Record<string, any>;
  sections: Section[];
  allow_retake: boolean;
  status: 'draft' | 'active' | 'archived';
  ac_manual_status: 'closed' | 'open' | 'finished';
  ac_override: boolean;
  ac_end: string | null;
  ac_remaining_time: number | null;
  ac_scheduled_start: string | null;
  ac_scheduled_end: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

export interface Section {
  id: number;
  name: string;
  type_question: 'PG' | 'esai';
  questions: Question[];
}

export interface Question {
  idq: number;
  pertanyaan: string;
  pilihan?: { A?: string; B?: string; C?: string; D?: string };
  jawaban_benar?: 'A' | 'B' | 'C' | 'D';
  skor: number;
  media?: {
    video?: { enabled: boolean; src: string | null };
    gambar?: any[];
  };
}

export interface Submission {
  id: string;
  assessment_id: string;
  session_id: string;
  user_id: string;
  identity_snapshot: Record<string, any>;
  user_email: string | null;
  answers: Record<string, any>;
  score: number | null;
  max_score: number;
  correct_count: number | null;
  total_count: number | null;
  grading_detail: any[] | null;
  started_at: string;
  submitted_at: string;
  duration_seconds: number | null;
  graded_by: string | null;
  graded_at: string | null;
  grading_notes: string | null;
  attempt_number: number;
}

export interface AuditLog {
  id: string;
  actor_id: string | null;
  actor_email: string | null;
  actor_role: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, any>;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

// Standard API response shapes.
export interface SuccessResponse<T = any> {
  success: true;
  data: T;
}

export interface ErrorResponse {
  error: {
    code: ErrorCode;
    message: string;
    details?: any;
  };
}

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'ASSESSMENT_NOT_ACTIVE'
  | 'SESSION_NOT_ACTIVE'
  | 'SESSION_BLOCKED'
  | 'SESSION_EXPIRED'
  | 'SESSION_ALREADY_SUBMITTED'
  | 'MAX_ATTEMPTS_REACHED'
  | 'CONCURRENT_LIMIT_REACHED'
  | 'TURNSTILE_FAILED'
  | 'INTERNAL_ERROR';
