# AlbEdu Security Roadmap

**Version:** v0.821.0 (security audit baseline)
**Status:** Active — findings from 4 parallel security audits
**Last Updated:** 2026-07-10
**Owner:** AlbEdu Websoftware Architecture
**Audience:** Engineering team, security reviewers, DevOps

---

## Executive Summary

Four parallel security audits (SEC-A through SEC-D) were conducted in July 2026, covering:
- **SEC-A:** Authentication & session security
- **SEC-B:** Authorization & Row-Level Security (RLS)
- **SEC-C:** Input validation & injection vectors
- **SEC-D:** Infrastructure & network security

**Findings: 8 CRITICAL, 12 HIGH, 15 MEDIUM** vulnerabilities across the codebase.

The single most dangerous finding: **a peserta can become admin in one SQL UPDATE statement** (SEC-B Critical #1). This is an existential risk — any peserta with browser console access can escalate to full admin privileges.

This roadmap provides a phased remediation plan over 4 weeks, prioritized by severity and exploitability.

---

## Audit Reports (Full Detail)

All audit findings are in `/home/z/my-project/worklog.md`:
- **SEC-A-AUTH:** lines ~2280–2986 (authentication, JWT, OAuth, device fingerprint, brute force)
- **SEC-B-RLS:** lines ~2987–3289 (RLS matrix, privilege escalation, audit log tampering)
- **SEC-C-INJECTION:** lines ~3290–3804 (XSS, SQL injection, file upload, CSRF, KaTeX)
- **SEC-D-INFRA:** lines ~3805–4255 (secrets, DDoS, TLS, backups, monitoring, IR)

**Total audit output:** ~2000 lines of detailed findings.

---

## Vulnerability Summary by Severity

### 🔴 CRITICAL (P0 — Fix Immediately, within 48 hours)

| # | ID | Finding | Audit | Exploitability |
|---|---|---|---|---|
| 1 | SEC-B-C1 | **Peserta → admin self-escalation** via `users.peran` UPDATE (no column guard, no WITH CHECK) | SEC-B | Trivial — browser console, 1 line of JS |
| 2 | SEC-B-C2 | **`log_audit()` RPC callable by anyone** — peserta can insert fake audit entries, frame other users | SEC-B | Easy — single fetch() call |
| 3 | SEC-A-C1 | **JWT + refresh token in localStorage** — any XSS = full account takeover for 30 days | SEC-A | Requires XSS vector (several exist) |
| 4 | SEC-A-C2 | **No brute-force protection on login** — no Turnstile, no per-account lockout, no backoff | SEC-A | Easy — automated scripts |
| 5 | SEC-A-C3 | **Public admin registration** — no setup token, no approval, anyone can register as admin | SEC-A | Trivial — open URL |
| 6 | SEC-B-C3 | **4 tables with unverifiable RLS** (daftar_nama, admin_storages, user_devices, registration_attempts) — created via Studio SQL, no migration | SEC-B | Unknown — could be wide open |
| 7 | SEC-D-C1 | **Zero monitoring/alerting** — active attacks go undetected for hours | SEC-D | N/A (detection gap, not exploit) |
| 8 | SEC-D-C2 | **No Incident Response plan** — no key rotation runbook, no on-call, no status page | SEC-D | N/A (operational gap) |

### 🟠 HIGH (P1 — Fix within 1-2 weeks)

| # | ID | Finding | Audit |
|---|---|---|---|
| 9 | SEC-A-H1 | Device fingerprint trivially bypassed (localStorage UUID — clear cache = new device) | SEC-A |
| 10 | SEC-A-H2 | Device-limit race condition (concurrent requests bypass 2-admin/device limit) | SEC-A |
| 11 | SEC-B-H1 | Heartbeat EF lets peserta zero-out own `violation_count` | SEC-B |
| 12 | SEC-B-H2 | `submit_assessment_atomic` RPC takes `p_user_id` parameter (no auth.uid() check) | SEC-B |
| 13 | SEC-C-H1 | XSS in `math-paste-converter.js:367` — `innerHTML = content` without sanitization | SEC-C |
| 14 | SEC-C-H2 | KaTeX `strict: false` — weakens LaTeX safety | SEC-C |
| 15 | SEC-C-M1 | PostgREST filter injection via un-encoded session_id/assessment_id | SEC-C |
| 16 | SEC-C-M2 | IP rate-limit bypass via X-Forwarded-For header manipulation | SEC-C |
| 17 | SEC-D-H1 | B2 assets unbacked — no versioning, no replication, GC bug = permanent loss | SEC-D |
| 18 | SEC-D-H2 | No PITR (Point-in-Time Recovery) — up to 24h DB data loss | SEC-D |
| 19 | SEC-D-H3 | No branch protection / CI — direct push to main deploys instantly | SEC-D |
| 20 | SEC-C-M3 | Error message leakage — SQL errors, table names exposed to client | SEC-C |

### 🟡 MEDIUM (P2 — Fix within 1 month)

| # | ID | Finding | Audit |
|---|---|---|---|
| 21 | SEC-A-M1 | Account enumeration via login timing ("Email not confirmed" error) | SEC-A |
| 22 | SEC-A-M2 | forgot-password timing side-channel (existing vs non-existent emails) | SEC-A |
| 23 | SEC-C-M4 | No Content Security Policy (CSP) anywhere | SEC-C |
| 24 | SEC-D-M1 | Same service_role key duplicated across Worker + all Edge Functions | SEC-D |
| 25 | SEC-D-M2 | No dependency vulnerability scanning (no Dependabot) | SEC-D |
| 26 | SEC-D-M3 | Realtime channels not authenticated (RLS may not be enforced) | SEC-D |
| 27 | SEC-D-M4 | Service Worker cache poisoning risk (no cache integrity check) | SEC-D |
| 28 | SEC-A-M3 | No concurrent session limit (unlimited devices per user) | SEC-A |
| 29 | SEC-A-M4 | Email verification not enforced before admin login | SEC-A |
| 30 | SEC-B-M1 | Cross-organization data leak latent (no org_id scoping in RLS) | SEC-B |
| 31 | SEC-C-M5 | Edge Function body size limits not set (DoS via large payloads) | SEC-C |
| 32 | SEC-D-M5 | Supabase DB password strength unknown | SEC-D |
| 33 | SEC-D-M6 | No backup restore testing (backups exist but never verified) | SEC-D |
| 34 | SEC-A-M5 | Logout doesn't invalidate JWT server-side (client-side only) | SEC-A |
| 35 | SEC-C-M6 | `/api/supabase-config` returns anon key to any origin in allowlist | SEC-C |

---

## Phased Remediation Plan

### Phase S0 — Emergency Fixes (48 hours) — v0.821.0 → v0.821.0

**Goal:** Close the 8 CRITICAL vulnerabilities that allow immediate exploitation.

**Effort:** 3-4 dev-days
**Risk:** Low (additive — new migration, new RLS, no client behavior change)
**Rollback:** Drop new migration, revert Edge Function deployments

#### Tasks

1. **FIX SEC-B-C1: Peserta → admin escalation (THE MOST CRITICAL)**
   
   Create migration `20260712_024_freeze_users_peran.sql`:
   ```sql
   -- Drop the dangerous permissive policy
   DROP POLICY IF EXISTS users_update_own ON public.users;
   
   -- Recreate with column restriction: users can update everything EXCEPT peran
   CREATE POLICY users_update_own ON public.users
     FOR UPDATE TO authenticated
     USING (id = auth.uid())
     WITH CHECK (id = auth.uid());
   
   -- Add trigger: block peran changes by non-service-role
   CREATE OR REPLACE FUNCTION public.prevent_peran_change()
   RETURNS TRIGGER AS $$
   BEGIN
     -- Allow service_role to change anything
     IF auth.role() = 'service_role' THEN
       RETURN NEW;
     END IF;
     -- Block peran changes for everyone else
     IF NEW.peran IS DISTINCT FROM OLD.peran THEN
       RAISE EXCEPTION 'Cannot modify peran field directly';
     END IF;
     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql SECURITY DEFINER;
   
   CREATE TRIGGER users_peran_immutable
     BEFORE UPDATE OF peran ON public.users
     FOR EACH ROW
     EXECUTE FUNCTION public.prevent_peran_change();
   ```
   
   **Acceptance:** Peserta cannot run `supabase.from('users').update({peran:'admin'}).eq('id', ownId)` — trigger blocks it.

2. **FIX SEC-B-C2: log_audit() RPC callable by anyone**
   
   Create migration `20260712_025_revoke_log_audit.sql`:
   ```sql
   -- Revoke public access to log_audit RPC
   REVOKE ALL ON FUNCTION public.log_audit FROM PUBLIC, authenticated;
   GRANT EXECUTE ON FUNCTION public.log_audit TO service_role;
   
   -- Same for other SECURITY DEFINER functions that should be service_role only
   REVOKE ALL ON FUNCTION public.count_active_sessions_for_user FROM PUBLIC, authenticated;
   GRANT EXECUTE ON FUNCTION public.count_active_sessions_for_user TO service_role;
   
   REVOKE ALL ON FUNCTION public.count_submissions_for_user FROM PUBLIC, authenticated;
   GRANT EXECUTE ON FUNCTION public.count_submissions_for_user TO service_role;
   
   REVOKE ALL ON FUNCTION public.submit_assessment_atomic FROM PUBLIC, authenticated;
   GRANT EXECUTE ON FUNCTION public.submit_assessment_atomic TO service_role;
   
   REVOKE ALL ON FUNCTION public.cleanup_rate_limits FROM PUBLIC, authenticated;
   GRANT EXECUTE ON FUNCTION public.cleanup_rate_limits TO service_role;
   ```

3. **FIX SEC-B-C3: Verify RLS on undocumented tables**
   
   Create migration `20260712_026_verify_rls_undocumented.sql`:
   ```sql
   -- Enable RLS on all tables that were created manually (no migration)
   ALTER TABLE public.daftar_nama ENABLE ROW LEVEL SECURITY;
   ALTER TABLE public.admin_storages ENABLE ROW LEVEL SECURITY;
   ALTER TABLE public.user_devices ENABLE ROW LEVEL SECURITY;
   ALTER TABLE public.registration_attempts ENABLE ROW LEVEL SECURITY;
   
   -- Add service_role-only policies (same pattern as assets_manifest)
   CREATE POLICY daftar_nama_service_role ON public.daftar_nama
     USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
   CREATE POLICY admin_storages_service_role ON public.admin_storages
     USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
   CREATE POLICY user_devices_service_role ON public.user_devices
     USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
   CREATE POLICY registration_attempts_service_role ON public.registration_attempts
     USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
   ```

4. **FIX SEC-A-C2: Add brute-force protection to login**
   
   Add to `pages/login.html`:
   - Cloudflare Turnstile widget (same as register-admin)
   - Client-side rate limit display (after 5 failed attempts, show "Coba lagi dalam X detik")
   
   Update `src/auth/user-auth-portal.js`:
   - Send Turnstile token with login request
   - Server-side: add per-account rate limit (5 failed logins per 15 min per email)
   
   Create Edge Function `login-attempt` (or extend `user-auth-preflight`):
   - Track failed login attempts per email in `registration_attempts` table
   - Lock account after 5 failures for 15 minutes
   - Reset counter on successful login

5. **FIX SEC-A-C3: Admin registration approval gate**
   
   Option A (quick): Add `REGISTER_WORKER_SECRET` env var requirement
   - `register-admin` Edge Function checks for secret in request header
   - Secret is set in Supabase Dashboard, shared only with authorized registrants
   
   Option B (proper, Phase S1): Manual approval workflow
   - New table `admin_registrations` (pending/approved/rejected)
   - Registration creates pending request
   - Existing admin approves via dashboard
   - Only approved users can complete registration

6. **FIX SEC-D-C1: Set up basic monitoring**
   
   - Sign up for UptimeRobot (free, 50 monitors)
   - Monitor: `https://edu.albyte-inc.workers.dev/api/health` (every 5 min)
   - Monitor: `https://kzsrerxhhrtsxnpnmqgl.supabase.co/functions/v1/health-check` (every 5 min)
   - Monitor: `https://albytehq.github.io/AlbEdu/` (every 5 min)
   - Email alert on downtime
   
   - Set up Cloudflare Workers Analytics (built-in, free)
   - Monitor: 5xx error rate > 1% in 5 min window
   - Monitor: Worker CPU time > 50ms p95

7. **FIX SEC-D-C2: Create Incident Response plan**
   
   Create `docs/security/INCIDENT-RESPONSE.md` (see Phase S0 deliverable #2)

8. **FIX SEC-A-C1 (partial): Add CSP to mitigate XSS → JWT theft**
   
   Add Content-Security-Policy meta tag to all HTML pages:
   ```html
   <meta http-equiv="Content-Security-Policy" 
         content="default-src 'self'; 
                 script-src 'self' 'unsafe-inline' https://esm.sh https://cdn.jsdelivr.net https://challenges.cloudflare.com;
                 style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net;
                 img-src 'self' data: https: blob:;
                 connect-src 'self' https://*.supabase.co https://edu.albyte-inc.workers.dev https://esm.sh;
                 worker-src 'self';
                 font-src 'self' data:;
                 object-src 'none';
                 base-uri 'self';">
   ```
   
   This doesn't fix JWT-in-localStorage, but limits XSS surface significantly.

#### Deliverables
- `supabase/migrations/20260712_024_freeze_users_peran.sql`
- `supabase/migrations/20260712_025_revoke_log_audit.sql`
- `supabase/migrations/20260712_026_verify_rls_undocumented.sql`
- Updated `pages/login.html` (Turnstile + rate limit UI)
- Updated `src/auth/user-auth-portal.js` (send Turnstile token)
- Updated `supabase/functions/user-auth-preflight/index.ts` (login rate limit)
- New `docs/security/INCIDENT-RESPONSE.md`
- CSP meta tag added to all HTML pages
- UptimeRobot monitors configured

#### Acceptance Criteria
- [ ] Peserta cannot escalate to admin (trigger blocks UPDATE peran)
- [ ] Peserta cannot call log_audit() RPC (403 Forbidden)
- [ ] All 4 undocumented tables have RLS enabled + service_role policy
- [ ] Login page has Turnstile + per-account rate limit
- [ ] UptimeRobot monitors active (3 endpoints)
- [ ] INCIDENT-RESPONSE.md exists with key rotation runbook
- [ ] CSP meta tag on all HTML pages (verified via DevTools)

---

### Phase S1 — High Priority Fixes (Week 2) — v0.821.0 → v0.821.0

**Goal:** Close HIGH vulnerabilities that enable data manipulation or service disruption.

**Effort:** 5-7 dev-days

#### Tasks

1. **FIX SEC-A-C1 (full): Migrate JWT from localStorage to HttpOnly cookie**
   
   This is the biggest change — requires Supabase Auth configuration update:
   - Set `cookie_options` in Supabase Dashboard (Auth → Settings)
   - Enable `secure: true`, `sameSite: 'strict'`, `httpOnly: true`
   - Update `supabase-client.js` to use `cookieStorage` instead of `localStorage`
   - Test all auth flows (login, logout, refresh, OAuth callback)
   
   **Risk:** High — auth is core. Test thoroughly in staging first.

2. **FIX SEC-B-H1: Heartbeat EF violation_count manipulation**
   
   Update `supabase/functions/heartbeat/index.ts`:
   - Remove `body.violation_count` from the UPDATE payload
   - Violation count should only be incremented by the `block-participant` EF
   - Heartbeat EF should only UPDATE `last_heartbeat_at` and `connection_status`

3. **FIX SEC-B-H2: submit_assessment_atomic auth check**
   
   Update the RPC function (migration):
   ```sql
   CREATE OR REPLACE FUNCTION public.submit_assessment_atomic(...)
   RETURNS ...
   LANGUAGE plpgsql SECURITY DEFINER AS $$
   DECLARE
     v_user_id UUID := auth.uid();  -- Use JWT, not parameter
   BEGIN
     -- Ignore p_user_id parameter, use auth.uid() instead
     ...
   END;
   $$;
   ```

4. **FIX SEC-C-H1: XSS in math-paste-converter.js**
   
   Change `target.innerHTML = content` to `target.textContent = content` (or use DOMPurify).

5. **FIX SEC-C-H2: KaTeX strict mode**
   
   Change `strict: false` to `strict: 'ignore'` in `math-renderer.js:35`.

6. **FIX SEC-C-M1: PostgREST filter injection**
   
   Add `encodeURIComponent()` to all user-supplied filter values in:
   - `supabase/functions/_shared/rate-limit.ts` (lines 57, 72, 97, 111)
   - `supabase/functions/_shared/db.ts` (all filter methods)

7. **FIX SEC-C-M2: IP rate-limit bypass**
   
   Update `supabase/functions/_shared/audit.ts:45-51`:
   - Only trust `CF-Connecting-IP` header (Cloudflare sets this, can't be spoofed)
   - Remove fallback to `X-Forwarded-For` (client can set this)

8. **FIX SEC-D-H1: B2 backup**
   
   - Enable B2 bucket lifecycle rules (keep last 30 versions)
   - Set up daily B2 → Supabase Storage backup script (for avatars)
   - Document B2 restore procedure in `docs/security/DISASTER-RECOVERY.md`

9. **FIX SEC-D-H2: Enable PITR**
   
   - Upgrade Supabase to Pro plan ($25/month) — enables 7-day PITR
   - Or: implement application-level WAL archiving (complex, not recommended)
   - PITR is the only way to recover from destructive migration / DB corruption

10. **FIX SEC-D-H3: Branch protection + CI**
    
    - Add `.github/workflows/ci.yml` — lint + test on PR
    - Enable branch protection on `main`:
      - Require PR review (1 reviewer)
      - Require status checks (CI must pass)
      - No direct push to `main`
    - Add Dependabot config (`.github/dependabot.yml`) for dependency updates

11. **FIX SEC-C-M3: Error message sanitization**
    
    Update `supabase/functions/_shared/error.ts`:
    - In production: return generic error messages, log full detail server-side
    - In development: return full detail (gated by `DENO_ENV=development`)

---

### Phase S2 — Medium Priority Hardening (Week 3-4) — v0.821.0 → v0.822.0

**Goal:** Close MEDIUM vulnerabilities and add defense-in-depth.

**Effort:** 5-7 dev-days

#### Tasks

1. **Account enumeration fixes (SEC-A-M1, M2)**
   - Login: always return "Email atau kata sandi salah" (don't differentiate)
   - Forgot-password: always return "Jika email terdaftar, instruksi telah dikirim" + constant-time delay

2. **Dependency scanning (SEC-D-M2)**
   - Add Dependabot alerts + security updates
   - Add `npm audit` to CI pipeline
   - Pin all CDN dependencies to specific versions (no floating tags)

3. **Realtime authentication (SEC-D-M3)**
   - Verify Supabase Realtime RLS enforcement
   - Add explicit auth check in Realtime subscription filters
   - Test: peserta A cannot subscribe to peserta B's session events

4. **Service Worker integrity (SEC-D-M4)**
   - Add Subresource Integrity (SRI) hashes to script tags
   - Add `integrity` attribute to CDN script tags

5. **Concurrent session limit (SEC-A-M3)**
   - Add `max_sessions_per_user` config (default: 5)
   - When user logs in on 6th device, oldest session is revoked

6. **Email verification enforcement (SEC-A-M4)**
   - Block admin login until email is verified
   - Add `email_verified_at` check in `requireAdmin`

7. **Edge Function body size limits (SEC-C-M5)**
   - Set `max_body_size` in `supabase/config.toml` per function
   - Reject payloads > 10 MB at the Edge Function level

8. **Backup restore testing (SEC-D-M6)**
   - Monthly restore test: restore latest Supabase backup to staging
   - Verify data integrity (row counts, sample data)
   - Document restore time + issues

9. **Server-side logout (SEC-A-M5)**
   - Call Supabase `auth.signOut()` on logout (revokes refresh token)
   - Clear all localStorage/sessionStorage on logout
   - Redirect to login page (prevent back-button cache)

10. **Cross-organization RLS (SEC-B-M1)**
    - Add `organization_id` check to all RLS policies
    - Add `org_id()` helper function (returns user's org from JWT claim)
    - Future-proofs for multi-tenant when org support ships

---

### Phase S3 — Advanced Security (Month 2+) — v0.822.0+

**Goal:** Enterprise-grade security hardening.

#### Tasks (lower priority, parked for when scale demands)

1. **Hardware device fingerprint (SEC-A-H1)**
   - Integrate FingerprintJS Pro (or open-source FingerprintJS)
   - Combine: canvas fingerprint + audio fingerprint + font enumeration + WebGL
   - Store server-side hash, not client-side UUID
   - Privacy: disclose in privacy policy, allow opt-out

2. **WebAuthn / Passkey for admins**
   - Add passkey as 2FA option for admin accounts
   - Reduces password-based attack surface
   - Use `@simplewebauthn/server` library

3. **Secret rotation automation**
   - Add quarterly secret rotation reminder (calendar/cron)
   - Document rotation procedure for each secret (Supabase service role, B2 keys, Worker AUTH_TOKEN)
   - Automate where possible (Supabase CLI for key rotation)

4. **Security Headers**
   - Add `Strict-Transport-Security: max-age=31536000; includeSubDomains`
   - Add `X-Content-Type-Options: nosniff`
   - Add `X-Frame-Options: DENY` (prevent clickjacking)
   - Add `Referrer-Policy: strict-origin-when-cross-origin`
   - Add `Permissions-Policy: camera=(), microphone=(), geolocation=()`

5. **Penetration testing**
   - After Phase S2, hire external pen-test firm
   - Scope: auth bypass, RLS bypass, XSS, injection, IDOR
   - Budget: $5-15K for 1-week engagement

6. **Bug bounty program**
   - Launch on HackerOne or Intigriti
   - Scope: albedu.co domain + Supabase project
   - Rewards: $50 (low) to $1000 (critical)

7. **SOC 2 / ISO 27001 compliance** (when enterprise customers demand)
   - Implement formal security policies
   - Access control reviews
   - Change management process
   - Incident response drills

---

## Risk Register

| # | Risk | Probability | Impact | Mitigation | Phase |
|---|---|---|---|---|---|
| SR1 | Peserta escalates to admin | HIGH (trivial exploit) | CRITICAL (full system compromise) | Phase S0 #1 (trigger + WITH CHECK) | S0 |
| SR2 | Audit trail tampered | HIGH (easy exploit) | HIGH (legal/compliance risk) | Phase S0 #2 (REVOKE from PUBLIC) | S0 |
| SR3 | JWT stolen via XSS | MEDIUM (XSS vectors exist) | CRITICAL (account takeover) | Phase S0 #8 (CSP) + Phase S1 #1 (HttpOnly cookie) | S0+S1 |
| SR4 | Brute-force admin login | MEDIUM (no protection) | HIGH (admin account compromise) | Phase S0 #4 (Turnstile + rate limit) | S0 |
| SR5 | Unauthorized admin registration | HIGH (open URL) | HIGH (attacker becomes admin) | Phase S0 #5 (approval gate) | S0 |
| SR6 | Data loss (no PITR) | LOW (rare event) | CRITICAL (lose 24h of data) | Phase S1 #9 (Supabase Pro) | S1 |
| SR7 | B2 asset permanent loss | LOW (GC bug) | HIGH (broken images forever) | Phase S1 #8 (versioning + backup) | S1 |
| SR8 | Supply chain attack | LOW (no branch protection) | CRITICAL (malicious code deploy) | Phase S1 #10 (branch protection + CI) | S1 |
| SR9 | Account enumeration | MEDIUM (timing leaks) | LOW (info disclosure) | Phase S2 #1 (constant-time responses) | S2 |
| SR10 | Undetected attack | HIGH (no monitoring) | HIGH (delayed response) | Phase S0 #6 (UptimeRobot) | S0 |

---

## Security Metrics (Post-Remediation Targets)

| Metric | Current (v0.821.0) | Target (v0.822.0) |
|---|---|---|
| Critical vulnerabilities | 8 | 0 |
| High vulnerabilities | 12 | 0 |
| Medium vulnerabilities | 15 | <5 |
| Time-to-detect (attack) | Hours-days | <5 min (UptimeRobot) |
| Time-to-respond (key rotation) | 2-4h improvised | <30 min (runbook) |
| Backup restore tested | Never | Monthly |
| Branch protection | None | Required PR + CI |
| Dependency scanning | None | Dependabot + npm audit |
| CSP | None | All pages |
| JWT storage | localStorage (XSS-vulnerable) | HttpOnly cookie |
| Pen-test | Never | Annual |

---

## Version History

| Version | Phase | Date | Summary |
|---|---|---|---|
| v0.821.0 | (audit baseline) | 2026-07-10 | 4 security audits completed, 35 vulnerabilities found |
| v0.821.0 | Phase S0 | 2026-07-12 | Emergency fixes: 8 CRITICAL vulnerabilities closed |
| v0.821.0 | Phase S1 | 2026-07-19 | HIGH fixes: JWT cookie, heartbeat, XSS, branch protection |
| v0.822.0 | Phase S2 | 2026-07-31 | MEDIUM fixes: enumeration, deps, realtime, sessions |
| v0.823.0+ | Phase S3 | 2026-08+ | Advanced: hardware fingerprint, passkey, pen-test, SOC 2 |

---

## References

- **Audit reports:** `/home/z/my-project/worklog.md` (SEC-A through SEC-D, ~2000 lines)
- **Incident Response:** `docs/security/INCIDENT-RESPONSE.md`
- **Disaster Recovery:** `docs/security/DISASTER-RECOVERY.md` (Phase S1)
- **Current SECURITY.md:** `docs/SECURITY.md` (legacy, will be updated in Phase S0)
- **OWASP Top 10:** https://owasp.org/Top10/
- **Supabase Security Guide:** https://supabase.com/docs/guides/auth#security
- **Cloudflare Security:** https://developers.cloudflare.com/workers/learning/security/
