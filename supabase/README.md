# Supabase — AlbEdu v1.0.0

Database schema, Edge Functions, and migrations for AlbEdu v1.0.0 enterprise.

---

## 1. Project Info

| Item | Value |
|---|---|
| Project URL | https://kzsrerxhhrtsxnpnmqgl.supabase.co |
| Region | Auto (Supabase default) |
| Plan | Free (200 concurrent peserta limit) |
| DB Size | ~50 MB (normalized schema) |

---

## 2. Schema Overview (v1.0.0)

### 2.1 Tables (13 total)

| # | Table | Purpose | Replaces (v0.2.0) |
|---|---|---|---|
| 1 | `users` | Admin + peserta accounts (Google OAuth) | `users` (refactored) |
| 2 | `organizations` | SCloud multi-tenant (Phase 9, nullable for now) | NEW |
| 3 | `assessments` | Assessment definitions | `ujian` |
| 4 | `assessment_sessions` | Active peserta sessions (proctoring, heartbeat) | NEW (was embedded JSONB) |
| 5 | `submissions` | Final submitted answers + server-side score | `ujian.hasil_peserta` JSONB |
| 6 | `violation_events` | Normalized violation log (1 row per event) | `violations` table + `ujian.violations` JSONB |
| 8 | `audit_logs` | Q9 audit trail tier B (~25 event types) | NEW |
| 9 | `consents` | UU PDP consent records | NEW |
| 10 | `data_subject_requests` | UU PDP DSR lifecycle | NEW |
| 11 | `daftar_nama` | Name lists (identity_mode='daftar') | `daftar_nama` (kept) |
| 12 | `admin_storages` | 1:1 storage provisioning per admin | `admin_storages` (kept) |
| 13 | `registration_attempts` | Rate limit tracking (multi-purpose) | `registration_attempts` (kept) |
| 14 | `user_devices` | Device fingerprint tracking | `user_devices` (kept) |
| 15 | `assets_manifest` | Image dedup (Cloudflare Worker) | `assets_manifest` (kept) |

### 2.2 Views (1)

| View | Purpose |
|---|---|
| `assessment_view_peserta` | Peserta-facing view, strips admin-only fields |

### 2.3 RPC Functions

| Function | Returns | Purpose |
|---|---|---|
| `peran_user()` | text | Current user's role (admin/peserta/NULL). SECURITY DEFINER. |
| `org_id()` | uuid | Current user's organization_id (SCloud, NULL for now) |
| `is_admin()` | boolean | Convenience check |
| `is_peserta()` | boolean | Convenience check |
| `generate_access_code()` | text | Random 6-digit string |
| `count_active_sessions_for_user(assessment_id, user_id)` | int | Check if peserta has active session |
| `count_submissions_for_user(assessment_id, user_id)` | int | Check attempt count (allow_retake enforcement) |
| `log_audit(...)` | uuid | Insert audit log entry (server-side only) |
| `count_verified_admins_by_device(device_id)` | int | Legacy, kept for register-admin |
| `count_verified_users_by_device(device_id)` | int | Legacy, kept for user-auth-complete |

---

## 3. Migration Files (15)

Run in order. See `migrations/` folder.

| # | File | Description |
|---|---|---|
| 001 | `20260701_001_create_organizations.sql` | SCloud-ready organizations table |
| 002 | `20260701_002_alter_users_snake_case.sql` | Rename foto_profil → avatar_url, add organization_id, locale, consent_at, deleted_at |
| 003 | `20260701_003_create_assessments.sql` | Replaces ujian. 6-digit access_code. Normalized ac_* columns. allow_retake. |
| 004 | `20260701_004_create_assessment_sessions.sql` | Proctoring sessions. Heartbeat tracking. Cross-device resume. |
| 005 | `20260701_005_create_submissions.sql` | Final answers + server-side score |
| 006 | `20260701_006_create_violation_events.sql` | Normalized violation log (1 row per event) |
| 008 | `20260701_008_create_audit_logs.sql` | Q9 audit trail tier B (~25 event types) |
| 009 | `20260701_009_create_consents.sql` | UU PDP consent records |
| 010 | `20260701_010_create_data_subject_requests.sql` | UU PDP DSR lifecycle |
| 011 | `20260701_011_create_view_assessment_peserta.sql` | Peserta view (strips admin fields) |
| 012 | `20260701_012_helper_functions.sql` | peran_user(), org_id(), log_audit(), etc. |
| 013 | `20260701_013_pg_cron_retention.sql` | Auto-purge jobs (30/90/365 day retention) |
| 014 | `20260701_014_migrate_legacy_ujian.sql` | Migrate ujian → assessments (idempotent, no-op if empty) |
| 015 | `20260701_015_drop_legacy_tables.sql` | Drop ujian + violations (legacy). KEEP assets_manifest, daftar_nama, etc. |

---

## 4. How to Run Migrations

### Option A: Supabase Dashboard (recommended for production)

1. Go to Supabase Dashboard → SQL Editor
2. Copy-paste each migration file content (in order 001 → 015)
3. Run each one
4. Verify with: `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;`

### Option B: Supabase CLI (for local dev / CI)

```bash
npm install -g supabase
supabase login
supabase link --project-ref kzsrerxhhrtsxnpnmqgl
supabase db push
```

### Option C: psql (direct connection)

```bash
psql "postgresql://postgres:[PASSWORD]@db.kzsrerxhhrtsxnpnmqgl.supabase.co:5432/postgres" \
  -f supabase/migrations/20260701_001_create_organizations.sql
# ... repeat for 002-015
```

---

## 5. Edge Functions (Phase 2 — pending)

```
supabase/functions/
├── submit-assessment/index.ts        # NEW — server-side scoring
├── heartbeat/index.ts                # NEW — 15s progress sync
├── block-participant/index.ts        # NEW — instant block via realtime
├── assessment-lifecycle/index.ts     # NEW — start/pause/resume/finish
├── cleanup-assessment/index.ts       # NEW — pre-delete check
├── data-export/index.ts              # NEW — DSR self-service export
├── dsr-handler/index.ts              # NEW — DSR request handler
├── register-admin/index.ts           # REFACTOR
├── user-auth-preflight/index.ts      # REFACTOR
├── user-auth-complete/index.ts       # REFACTOR
├── access-code-attempt/index.ts      # RENAME from exam-token-attempt + Turnstile
└── _shared/
    ├── auth.ts
    ├── audit.ts
    ├── rls.ts
    └── realtime.ts
```

**Deploy:**
```bash
supabase functions deploy submit-assessment --no-verify-jwt
# ... repeat for each function
```

**Config:** `supabase/config.toml` (existing, update function list)

---

## 6. RLS Policies Summary

All tables have RLS enabled. Helper function `peran_user()` (SECURITY DEFINER) used in policies.

| Table | Admin | Peserta |
|---|---|---|
| `users` | SELECT all (non-deleted) | SELECT/UPDATE own |
| `organizations` | SELECT all | SELECT all |
| `assessments` | SELECT all, INSERT/UPDATE/DELETE own | SELECT active only |
| `assessment_sessions` | SELECT all, UPDATE (block) | SELECT/INSERT/UPDATE own |
| `submissions` | SELECT all, UPDATE (grade) | SELECT/INSERT own |
| `violation_events` | SELECT all | SELECT/INSERT own |
| `audit_logs` | SELECT all | SELECT own |
| `consents` | SELECT all | SELECT/INSERT/UPDATE own |
| `data_subject_requests` | SELECT all, UPDATE (resolve) | SELECT/INSERT/UPDATE own (cancel) |
| `daftar_nama` | All on own (via storage_id) | No access |
| `admin_storages` | SELECT/INSERT own | No access |
| `registration_attempts` | (Service role only) | (Service role only) |
| `user_devices` | (Service role only) | (Service role only) |
| `assets_manifest` | (Service role only) | (Service role only) |

---

## 7. Indexes

All indexes created in respective migration files. Key indexes:

- `assessments`: created_by, status, access_code, organization_id, created_at
- `assessment_sessions`: assessment_id, user_id, status, last_heartbeat_at
- `submissions`: assessment_id, user_id, submitted_at, score, attempt_number
- `violation_events`: assessment_id, session_id, user_id, event_type, created_at, expires_at
- `audit_logs`: actor_id, action, target_type+target_id, created_at, expires_at

---

## 8. Triggers

| Table | Trigger | Function | Purpose |
|---|---|---|---|
| `assessments` | BEFORE UPDATE | `update_updated_at()` | Auto-update updated_at |
| `assessment_sessions` | BEFORE UPDATE | `update_updated_at()` | Auto-update updated_at |
| `assessment_sessions` | BEFORE INSERT/UPDATE OF status | `enforce_single_active_session()` | One active session per user per assessment |
| `data_subject_requests` | BEFORE UPDATE | `update_updated_at()` | Auto-update updated_at |

---

## 9. pg_cron Jobs (Q10 + Q17 retention)

| Job | Schedule | Action |
|---|---|---|
| `purge-registration-attempts` | Daily 03:00 UTC | DELETE rows >30 days |
| `purge-violation-events` | Daily 03:15 UTC | DELETE rows >90 days |
| `purge-audit-logs` | Daily 03:30 UTC | DELETE rows >365 days |
| `mark-stale-sessions-disconnected` | Every 1 min | UPDATE sessions with no heartbeat >5 min |
| `mark-expired-sessions` | Every 1 min | UPDATE sessions where ac_end passed |
| `anonymize-old-ips` | Daily 04:00 UTC | SHA-256 hash IPs >90 days |
| `archive-old-assessments` | Daily 04:15 UTC | UPDATE assessments >1 year to status='archived' |

**Enable pg_cron:** Supabase Dashboard → Database → Extensions → enable `pg_cron`

---

## 10. Verification Queries

After running all migrations, verify:

```sql
-- List all tables
SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
-- Expected: 13 tables (see §2.1)

-- List all views
SELECT viewname FROM pg_views WHERE schemaname = 'public';
-- Expected: assessment_view_peserta

-- List all functions
SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace ORDER BY proname;
-- Expected: peran_user, org_id, is_admin, is_peserta, generate_access_code,
--           count_active_sessions_for_user, count_submissions_for_user, log_audit,
--           update_updated_at, enforce_single_active_session,
--           count_verified_admins_by_device, count_verified_users_by_device

-- List all cron jobs
SELECT jobname, schedule FROM cron.job;
-- Expected: 7 jobs (see §9)

-- Check RLS enabled
SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' AND rowsecurity = true;
-- Expected: 10 tables with RLS enabled
```

---

## 11. Rollback

**Pre-migration backup:** Supabase Dashboard → Database → Backups → Create manual backup

**Rollback procedure:**
1. Supabase Dashboard → Database → Backups → Restore to pre-migration
2. Git revert code to `v0.2.0-baseline` commit
3. Redeploy Cloudflare Worker v5.1 (legacy)
4. Max downtime: 2 hours

---

## 12. Credentials

**NEVER commit credentials to repo.** Store in:

- `/home/z/my-project/AlbEdu/credentials/supabase-v1.json` (gitignored)
- `/home/z/my-project/AlbEdu/.env.local` (gitignored)
- Cloudflare Worker env vars (dashboard)
- Supabase Dashboard → Settings → API

**Service role key** bypasses RLS — for server-side only (Edge Functions, pg_cron). Never expose to client.

---

**Document version:** 1.0.0
**Last updated:** 2026-06-30
