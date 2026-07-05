# SECURITY — Anti-Cheat Architecture

> AlbEdu v0.746.0 enterprise-grade anti-cheat: server-side scoring, heartbeat, DevTools detection, instant block.
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

| # | Attack | v0.2.0 Vulnerability | v0.746.0 Mitigation |
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

**Added in v0.746.0:**
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
- `access-code-attempt` — token entry (added v0.746.0)

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
- [ ] Camera proctoring (Phase 9)
- [ ] Hardware attestation (Phase 9)
- [ ] Screen recording detection (Phase 9)

---

**Document version:** 1.0.0
**Last updated:** 2026-06-30
