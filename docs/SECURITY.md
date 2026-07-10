# SECURITY — Anti-Cheat Architecture

> AlbEdu v0.819.0 enterprise-grade anti-cheat: server-side scoring, heartbeat, DevTools detection, instant block.
> Note: Guardian.js (`src/exam/guardian.js`) still exists — it's the client-side anti-cheat layer that complements server-side scoring.

---

## 1. Threat Model

### 1.1 Assets to Protect

| Asset | Why Critical |
|---|---|
| Assessment answers (jawaban_benar) | If leaked before submit, peserta can cheat |
| Peserta scores | Must be accurate, tamper-proof |
| Peserta identity | Cannot impersonate another peserta |
| Assessment runtime state | Cannot extend time, bypass pause |

### 1.2 Attack Vectors

| # | Attack | v0.2.0 Vulnerability | v0.819.0 Mitigation |
|---|---|---|---|
| 1 | DevTools override `getHasil()` return 100 | Client-side scoring | Server-side scoring (Q5) — Edge Function re-scores independently |
| 2 | Clear localStorage to re-take assessment | Submit lock in localStorage | Server-side check in `assessment_sessions` table + `submissions` table |
| 3 | Open DevTools via browser menu (not shortcut) | Guardian.js only blocks shortcuts | DevTools detector (3 methods combined) + heartbeat stops if DevTools open |
| 4 | Edit `exam_data` in sessionStorage to modify soal | sessionStorage editable | Server-side scoring validates answers against stored sections |
| 5 | Multi-monitor focus loss (no visibilitychange) | Guardian.js misses | Heartbeat tracks active focus; if no heartbeat for 5 min → session disconnected |
| 6 | VM to bypass device fingerprint | Device limit per fingerprint | Phase 9: hardware attestation (future) |
| 7 | Brute-force access code (5-digit = 100K combos) | Rate limit only | 6-digit (1M combos) + Turnstile + rate limit (10/IP/jam, 10/device/jam) |
| 8 | Impersonate another peserta (use their name) | No identity verification | Identity snapshot immutable at submit; admin can verify via daftar_nama |
| 9 | Concurrent submissions (race condition) | No idempotency | `submissions_session_unique` constraint + Edge Function idempotency check |
| 10 | Admin A deletes admin B's assessment | No ownership check | RLS policy `assessments_admin_delete_own` — only creator can delete |

---

## 2. Architecture — Layered Defense

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 7: Compliance (UU PDP)                                │
│   • Consent popup                                           │
│   • Audit log (all actions)                                 │
│   • Data retention (auto-purge)                             │
├─────────────────────────────────────────────────────────────┤
│ Layer 6: Forensic (Audit Trail)                             │
│   • audit_logs table (25 event types, 1 year retention)     │
│   • violation_events table (90 day retention)               │
│   • IP anonymization after 90 days                          │
├─────────────────────────────────────────────────────────────┤
│ Layer 5: Server-Side Validation                             │
│   • submit-assessment Edge Function re-scores PG            │
│   • assessment-lifecycle Edge Function validates state      │
│   • block-participant Edge Function (admin-only via RLS)    │
│   • RLS policies on all tables                              │
├─────────────────────────────────────────────────────────────┤
│ Layer 4: Realtime Anti-Cheat                                │
│   • Instant block via Realtime channel session-{id}         │
│   • Violation events push to admin in real-time             │
│   • Submit events push to admin                             │
├─────────────────────────────────────────────────────────────┤
│ Layer 3: Heartbeat (Server-Side Session Tracking)           │
│   • 15s interval — server knows peserta is alive            │
│   • Stale session (>5 min no heartbeat) → 'disconnected'    │
│   • Proctoring dashboard shows live peserta list            │
├─────────────────────────────────────────────────────────────┤
│ Layer 2: Client-Side Anti-Cheat (Guardian.js + new modules) │
│   • DevTools detection (3 methods)                          │
│   • Anti-copy (7 layers)                                    │
│   • Keyboard shortcut blocking                              │
│   • Visibility change tracking                              │
│   • Block listener (Realtime)                               │
├─────────────────────────────────────────────────────────────┤
│ Layer 1: Authentication & Authorization                     │
│   • Supabase Auth (Google OAuth)                            │
│   • RLS policies (peran_user() SECURITY DEFINER)            │
│   • Edge Function JWT verification                          │
│   • Device fingerprint + rate limit                         │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Anti-Cheat Components

### 3.1 Guardian.js (v0.2.0 — Preserved + Enhanced)

**Kept from v0.2.0:**
- 7 layers anti-copy (CSS user-select, selectstart, copy/cut/paste, execCommand, navigator.clipboard, contextmenu, touchstart)
- Keyboard shortcut blocking (F12, Ctrl+Shift+I/J, Ctrl+U → violation)
- Visibility change tracking (800ms debounce → violation if hidden >800ms)
- Max 4 violations → reset assessment + reshuffle

**Added in v0.819.0:**
- DevTools detector integration (see 3.2)
- Block listener integration (see 3.4)
- Heartbeat integration (see 3.3)
- Server-side violation logging (via heartbeat Edge Function, not direct DB write)

### 3.2 DevTools Detector (`src/security/devtools-detector.js`)

**3 detection methods combined:**

1. **Window size diff** — if `window.outerWidth - window.innerWidth > 160` or `window.outerHeight - window.innerHeight > 160`, DevTools likely open (dock bottom/right)
2. **Debugger statement timing** — `debugger;` executes instantly if DevTools closed, but pauses if DevTools open. Measure time delta.
3. **console.log getter** — override `console.log` with getter; if DevTools open, getter fires (console panel renders the log)

**On detect:**
- Increment violation counter
- Log violation event via heartbeat Edge Function
- NOT instant block (false positive risk — some browser extensions trigger false positives)
- After 3 DevTools detections → max violation → reset

### 3.3 Heartbeat (`src/security/heartbeat.js`)

**Interval:** 15 seconds (configurable via env)

**Payload:**
```json
{
  "session_id": "uuid",
  "current_section": 0,
  "current_question": 5,
  "progress_pct": 35.5,
  "violation_count": 1,
  "draft_answers": {
    "section_0": { "1": "A", "2": "B", "3": "C", "4": "D", "5": "A" }
  }
}
```

**Edge Function `heartbeat` response:**
```json
{
  "ok": true,
  "blocked": false,
  "server_time": "2026-07-01T10:00:00Z",
  "session_status": "active"
}
```

**If blocked:**
```json
{
  "ok": false,
  "blocked": true,
  "reason": "Menyontek terdeteksi",
  "blocked_at": "2026-07-01T10:00:00Z"
}
```

**Client behavior on `blocked: true`:**
- Stop heartbeat
- Lock UI
- Show blocked screen with reason
- Redirect to `blocked.html`

### 3.4 Block Listener (`src/security/block-listener.js`)

**Realtime channel:** `session-{session_id}`

**Subscribe:**
```js
supabase
  .channel(`session-${sessionId}`)
  .on('postgres_changes',
    { event: 'UPDATE', schema: 'public', table: 'assessment_sessions', filter: `id=eq.${sessionId}` },
    (payload) => {
      if (payload.new.status === 'blocked') {
        showBlockedScreen(payload.new.blocked_reason);
      }
    }
  )
  .subscribe();
```

**Latency:** <500ms (Supabase Realtime)

**Fallback:** If Realtime fails, heartbeat polling (15s) catches block status.

### 3.5 Server-Side Scoring (`submit-assessment` Edge Function)

**Flow:**
1. Peserta click "Kumpulkan"
2. Client sends `{ session_id, answers, duration_seconds }` to Edge Function
3. Edge Function:
   - Verify JWT → get user_id
   - Fetch session → verify `session.user_id === user_id`
   - Verify session.status === 'active' (not blocked, not submitted)
   - Fetch assessment → get `sections` (with `jawaban_benar`)
   - Re-score PG server-side:
     ```typescript
     let correctCount = 0;
     let totalCount = 0;
     for (const section of sections) {
       for (const q of section.questions) {
         totalCount++;
         if (q.type_question === 'PG') {
           const pesertaAnswer = answers[sectionIdx]?.[q.idq];
           if (pesertaAnswer === q.jawaban_benar) correctCount++;
         }
       }
     }
     const score = totalCount > 0 ? Math.round((correctCount / totalCount) * 100) : 0;
     ```
   - Insert submission row with score
   - Update session.status = 'submitted'
   - Insert audit_log: SUBMIT_ASSESSMENT
   - Broadcast realtime to admin channel
4. Return `{ score, correct_count, total_count }` to peserta

**Security:** Peserta cannot fake score. Even if they modify client-side `getHasil()`, server re-scores independently from stored sections.

---

## 4. RLS Policies Summary

**Per-table RLS** (see migration files for full policies):

| Table | Admin | Peserta |
|---|---|---|
| `assessments` | SELECT all, INSERT/UPDATE/DELETE own | SELECT active only |
| `assessment_sessions` | SELECT all, UPDATE (block, force-submit) | SELECT/INSERT/UPDATE own |
| `submissions` | SELECT all, UPDATE (grade — Phase 9) | SELECT own, INSERT own |
| `violation_events` | SELECT all | SELECT own, INSERT own |
| `audit_logs` | SELECT all | SELECT own |
| `consents` | SELECT all | SELECT/INSERT/UPDATE own |
| `data_subject_requests` | SELECT all, UPDATE (resolve) | SELECT/INSERT own, UPDATE own (cancel pending) |
| `users` | SELECT all (non-deleted) | SELECT/UPDATE own |
| `organizations` | SELECT all | SELECT all |

**Helper function:** `peran_user()` — SECURITY DEFINER, returns role from users table. Avoids RLS recursion.

---

## 5. Edge Function Security

### 5.1 JWT Verification

All Edge Functions (except `access-code-attempt` which is pre-auth) verify JWT:

```typescript
const authHeader = request.headers.get('Authorization');
if (!authHeader?.startsWith('Bearer ')) {
  return new Response('Unauthorized', { status: 401 });
}
const token = authHeader.replace('Bearer ', '');
const { data: { user }, error } = await supabase.auth.getUser(token);
if (error || !user) {
  return new Response('Unauthorized', { status: 401 });
}
// user.id is now verified
```

### 5.2 RLS Bypass (Service Role)

Edge Functions use service role key for:
- Audit log inserts (`log_audit()` function)
- Cross-user queries (admin viewing all peserta sessions)
- Cleanup operations (pg_cron jobs)

Service role key **never** exposed to client. Only in Edge Function environment.

### 5.3 Rate Limiting

| Endpoint | Limit | Scope |
|---|---|---|
| `register-admin` | 5/hour | Per IP |
| `register-admin` | 3/hour | Per email |
| `user-auth-preflight` | 9/hour | Per device |
| `user-auth-preflight` | 120/hour | Per IP |
| `access-code-attempt` | 10/hour | Per IP |
| `access-code-attempt` | 10/hour | Per device |
| `heartbeat` | 4/minute | Per session |
| `submit-assessment` | 1/minute | Per session |

### 5.4 Turnstile Integration

**Endpoints with Turnstile:**
- `register-admin` — admin registration
- `user-auth-preflight` — peserta login preflight
- `access-code-attempt` — token entry (added v0.819.0)

**Verification:**
```typescript
const turnstileResponse = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    secret: env.TURNSTILE_SECRET_KEY,
    response: turnstileToken,
    remoteip: clientIP,
  }),
});
const { success } = await turnstileResponse.json();
if (!success) {
  return new Response('Turnstile verification failed', { status: 400 });
}
```

---

## 6. Audit Trail (Q9 Tier B)

**25 event types logged to `audit_logs` table:**

| Category | Events |
|---|---|
| Auth | LOGIN, LOGOUT, LOGIN_FAILED, REGISTER_ADMIN, REGISTER_PESERTA |
| Assessment lifecycle | CREATE_ASSESSMENT, PUBLISH_ASSESSMENT, ARCHIVE_ASSESSMENT, DELETE_ASSESSMENT, EDIT_ASSESSMENT, START_ASSESSMENT, PAUSE_ASSESSMENT, RESUME_ASSESSMENT, FINISH_ASSESSMENT |
| Session/participant | BLOCK_PARTICIPANT, UNBLOCK_PARTICIPANT, FORCE_SUBMIT, START_SESSION, END_SESSION |
| Submission | SUBMIT_ASSESSMENT |
| Compliance | CONSENT_GRANTED, CONSENT_REVOKED, DSR_REQUEST, DSR_RESOLVED, DATA_EXPORT, ACCOUNT_DELETE |
| Violations | VIOLATION_DETECTED, MAX_VIOLATIONS_REACHED |
| System | CONFIG_CHANGE, WORKER_DEPLOY |

**Each log entry includes:**
- actor_id, actor_email, actor_role
- action, target_type, target_id
- metadata (JSONB, action-specific)
- ip_address (anonymized after 90 days)
- user_agent
- created_at, expires_at (1 year)

**RLS:** Admins read all. Peserta read own. No client INSERT/UPDATE/DELETE (server-side only via `log_audit()` function).

---

## 7. Known Limitations (Phase 9 Deferrals)

| Limitation | Risk | Phase 9 Solution |
|---|---|---|
| DevTools open via browser menu still detectable but not blockable | Medium | Camera proctoring (snapshot on violation) |
| VM can bypass device fingerprint | Low | Hardware attestation (WebAuthn) |
| No screen recording detection | Medium | Screen capture API + watermarking |
| No browser extension detection | Low | Extension fingerprinting |
| No network proxy detection | Low | WebRTC IP leak detection |
| Peserta can photograph screen | High (unfixable client-side) | Camera proctoring (Phase 9) |

---

## 8. Security Checklist

- [x] RLS on all tables (Phase 1)
- [x] peran_user() SECURITY DEFINER (Phase 1)
- [x] Edge Function JWT verification (Phase 2)
- [x] Server-side scoring (Phase 2)
- [x] Heartbeat with server-side session tracking (Phase 2 + 5)
- [x] DevTools detector (Phase 5)
- [x] Instant block via Realtime (Phase 5)
- [x] Audit log 25 event types (Phase 1 + 2)
- [x] Rate limiting all endpoints (Phase 2)
- [x] Turnstile on token entry (Phase 2)
- [x] 6-digit access code (Phase 1)
- [x] IP anonymization after 90 days (Phase 1)
- [x] Soft delete for users (Phase 1)
- [x] Data export for DSR (Phase 2)
- [x] verify_jwt=true for all authenticated Edge Functions (v0.819.0)
- [x] RLS session-ownership check on rate_limit_heartbeats / rate_limit_submits / violation_events (v0.819.0)
- [x] peran_user() filters deleted_at (v0.819.0)
- [x] Cloudflare Worker /upload + /release locked to ALLOWED_ORIGINS + AUTH_TOKEN required (v0.819.0)
- [x] Worker soft-archive replaces hard-delete (v0.819.0)
- [x] Atomic submit_assessment() RPC (v0.819.0)
- [x] Consent previousVersion XSS escaped (v0.819.0)
- [x] PII leak fixed — auth/main.js no longer logs user.email (v0.819.0)
- [ ] Camera proctoring (Phase 9)
- [ ] Hardware attestation (Phase 9)
- [ ] Screen recording detection (Phase 9)

---

## v0.819.0 Security Hardening

The v0.819.0 cycle closed a number of defense-in-depth gaps that were latent in v0.746.0. None were known to be exploited in production, but each represents a class of attack that the audit deemed unacceptable for an exam platform. This section documents the gaps and the specific fixes applied — read it before touching any RLS policy or Edge Function config.

### RLS tightening — session ownership checks

Three tables had policies that were too permissive for a multi-tenant exam platform. The original policies checked `user_id = auth.uid()` on the row being inserted, but did NOT verify that the `session_id` on the row actually belonged to `auth.uid()`. This meant a peserta could insert fake heartbeats, fake violation events, or fake rate-limit rows for ANOTHER peserta's session — enabling both DOS (plant rate-limit rows to block the victim's submit) and audit-log poisoning (plant violation events to make the victim look like a cheater).

- `rate_limit_heartbeats` — was INSERT-any-authenticated. Now checks that the session being rate-limited belongs to `auth.uid()` via a join on `assessment_sessions`. The policy is `USING (EXISTS (SELECT 1 FROM assessment_sessions s WHERE s.id = session_id AND s.user_id = auth.uid()))`.
- `rate_limit_submits` — same pattern, same fix. Prevents a peserta from inserting fake rate-limit rows for another peserta's session to DOS their submit.
- `violation_events` — peserta INSERT was already restricted to `user_id = auth.uid()`, but the `session_id` field was not checked. Now requires `session_id` to belong to `auth.uid()`. Prevents planting fake violations on another peserta's session.

### `peran_user()` deleted_at filter

The `peran_user()` SECURITY DEFINER function was returning the role of soft-deleted users (`SELECT peran FROM users WHERE id = auth.uid()`). This meant a soft-deleted admin could still authenticate via a stale JWT (Supabase JWTs are valid for 1 hour by default) and read admin-only tables. The function now filters `WHERE deleted_at IS NULL`, so soft-deleted users get `NULL` (anonymous) privileges. The fix is in migration `20260708_021_v0815_7_stability_hardening.sql`.

### `verify_jwt=true` for 8 Edge Functions

Eight Edge Functions had `verify_jwt = false` in their `supabase/config.toml` entry. The functions still validated JWT in-code via `getUser()`, but the gateway-level check was missing defense-in-depth. A misconfigured CORS rule, a leaked service-role key, or a future refactor that removes the in-code `getUser()` call would have allowed anonymous invocation. Now `verify_jwt=true` for:

- `heartbeat`
- `submit-assessment`
- `block-participant`
- `assessment-lifecycle`
- `cleanup-assessment`
- `data-export`
- `dsr-handler`
- `user-auth-complete`

Four functions remain `verify_jwt=false` because they are pre-auth or anonymous by design: `access-code-attempt` (token entry before session is established), `register-admin` (registration before user exists), `user-auth-preflight` (login preflight), and `health-check` (public uptime monitoring).

### Cloudflare Worker CORS lock + AUTH_TOKEN required

The Cloudflare Worker (`cloudflare-worker/worker.js (legacy, deleted)`) `/upload` and `/release` endpoints were accepting requests from any `Origin` header and treating `AUTH_TOKEN` as optional (the env var was read but its absence only logged a warning, did not block). For a worker that can write to GitHub asset repos (`assets-1` to `assets-20`) and the `assets_manifest` table, this is unacceptable — an attacker could POST to `/upload` from any origin and fill the repos with garbage, or call `/release` to delete assets. Now:

- `Origin` header is checked against `ALLOWED_ORIGINS` (configured via env var, currently `albytehq.github.io`, `albedu-id.github.io`, `http://localhost:8765` for dev). Mismatched Origin → 403.
- `AUTH_TOKEN` header is required. Missing or mismatched → 401. The token is a 32-char random string stored in Cloudflare Worker env vars (set via `wrangler secret put AUTH_TOKEN`).

### Worker soft-archive replaces hard-delete — ⚠️ CORRECTION (v0.819.0)

**Historical claim (now corrected):** The `/release` endpoint was documented as setting `deleted_at = NOW()` on `assets_manifest` rows and deferring permanent deletion to a 365-day pg_cron retention job.

**Actual reality (verified by ASSETS-A/B/C audits):** No `deleted_at` column exists on `assets_manifest`. No pg_cron job touches `assets_manifest` (migration 013 schedules retention for `registration_attempts`, `violation_events`, `audit_logs`, `rate_limit_*` — but NOT `assets_manifest`). The actual `/release` endpoint decrements `ref_count` and sets `pending_delete=true` when ref_count reaches 0. The GC bot (GitHub Actions, weekly cron) then hard-deletes after a 7-day safety window.

**For audit/forensic needs:** The `audit_logs` table (365-day retention via pg_cron) records all asset mutations (`ASSET_UPLOAD`, `ASSET_RELEASE`, `ASSET_GC_RUN`). While the image bytes are deleted after 7 days of being orphaned, the audit log preserves the hash, timestamps, and actor for every operation — sufficient for forensic reconstruction.

**Migration in progress:** The asset system is being migrated to Supabase + Backblaze B2 with proper audit trail. See [`docs/asset-system/ROADMAP.md`](./asset-system/ROADMAP.md) Phase 6 for the monitoring, alerting, and audit trail improvements.

### PII leak fixed — `src/auth/main.js` no longer logs `user.email`

`src/auth/main.js` had a leftover debug log statement: `console.log('[auth] signed in:', user.email)`. This ran on every sign-in. On shared devices (school computer lab), on screen-recorded sessions (remote proctoring), or on any browser with DevTools open, the email was visible in the console. The log statement has been removed. Debugging now goes through `AlbEdu.observability.log()` which redacts `email` to `email: <redacted>@<domain>`.

### Consent `previousVersion` XSS escaped

`src/security/consent.js` was rendering the `previousVersion` field of the user's prior consent record as raw `innerHTML` — the intent was to show "you previously agreed to v3.0.0 of the privacy policy". A tampered consent record (e.g. via direct DB write by a malicious admin, or via SQL injection elsewhere) with `previousVersion: '<img src=x onerror=alert(document.cookie)>'` would execute in the peserta's browser. Now uses `AlbEdu.sanitize.setText()` which sets `textContent` (no HTML parsing). The displayed text is identical for legitimate inputs.

---

**Document version:** 1.0.0
**Last updated:** 2026-07-08
