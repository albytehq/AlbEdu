# AlbEdu Unified Roadmap — Architecture + Security

**Version:** v0.821.0 (Phase S0 applied)
**Last Updated:** 2026-07-10
**Owner:** AlbEdu Websoftware Architecture
**Status:** Active — Phase 1 (asset) + Phase S0 (security) complete

---

## Executive Summary

This roadmap merges two parallel workstreams into a single execution plan:
1. **Asset System Migration** — GitHub repos → Supabase Storage + BackBlaze B2
2. **Security Hardening** — 4 audit findings (35 vulnerabilities) → phased remediation

Both workstreams are interleaved by priority — security fixes take precedence over feature work when severity is CRITICAL or HIGH.

**Current state:** v0.821.0 — Phase 1 (avatar migration) + Phase S0 (3 emergency security migrations) applied to production.

---

## Completed Work

### ✅ Asset System — Phase 0 (v0.817.0)
- `assets_manifest` migration created with RLS, indexes, CHECK constraints
- Magic Compress™ v2 implemented (perceptual compression: complexity analysis + MozJPEG WASM + SSIM)
- BackBlaze B2 setup guide created
- Documentation corrected (removed false `deleted_at` / R2 / 365-day retention claims)

### ✅ Asset System — Phase 1 (v0.819.0)
- Avatar uploads migrated to Supabase Storage `avatars` bucket
- Magic Compress™ v2 wired to avatar upload (256×256, JPEG q85, <50 KB)
- `image-cleanup.js` updated with `deleteAvatar(userId)` for DSR compliance
- `dsr-handler` Edge Function cascades avatar deletion (UU PDP Article 16)
- Worker `/upload` and `/release` endpoints decommissioned (return 410 Gone)
- Avatar old-file cleanup on replace (no orphan accumulation)
- Worker v7 (now `worker.js`) — edge cache + config + health

### ✅ Security — Phase S0 Emergency Fixes (v0.821.0)
- **Migration 024:** `users.peran` frozen (trigger + WITH CHECK) — blocks peserta → admin escalation
- **Migration 025:** 5 SECURITY DEFINER functions revoked from PUBLIC (`log_audit`, `count_active_sessions_for_user`, `count_submissions_for_user`, `submit_assessment_atomic`, `cleanup_rate_limits`)
- **Migration 026:** RLS enabled on 4 undocumented tables (`daftar_nama`, `admin_storages`, `user_devices`, `registration_attempts`)
- Incident Response plan created (`docs/security/INCIDENT-RESPONSE.md`)
- Security Roadmap created (`docs/security/SECURITY-ROADMAP.md`)

---

## Unified Phased Plan

### Phase 2 — Assessment Image Upload UI + B2 (Week 3-4) — v0.821.0 → v0.821.0

**Goal:** Build the missing image-upload UI for assessment questions. Wire to BackBlaze B2 via Supabase Edge Function.

**Effort:** 10-12 dev-days (largest phase — includes compression engine integration)
**Risk:** High (new UI component + new Edge Function + new storage backend)

#### Tasks

1. **Set up BackBlaze B2 account + bucket** (✅ done by user)
   - Bucket: `albedu-assets-systems` (private, S3-compatible)
   - Application key scoped to single bucket

2. **Build Supabase Edge Function `asset-upload`**
   - Path: `supabase/functions/asset-upload/index.ts`
   - Auth: requires user JWT (admin role only)
   - Flow: validate → Magic Compress™ (client-side) → compute SHA-256 → dedup check → B2 S3 PUT → INSERT assets_manifest
   - Server-side size guard: reject if post-compression >500 KB

3. **Build Supabase Edge Function `asset-release`**
   - Path: `supabase/functions/asset-release/index.ts`
   - Auth: service role only
   - Flow: decrement ref_count (with GREATEST(0,...) clamp) → set pending_delete if 0
   - Called from: soal delete, section delete, wizard cancel

4. **Build image-upload UI in `soal-editor-modal.js`**
   - Drag-and-drop zone + file picker + preview thumbnails
   - Compression indicator: "10.2 MB → 287 KB (97% smaller)"
   - Magic Compress™ v2 via Web Worker (non-blocking)
   - Store result in `media.gambar = [{ url, hash }]`

5. **Wire `ImageCleanup.deleteImage()` to `asset-release` EF**
   - Replace deprecated no-op with actual Edge Function call
   - Wire to: soal-card.js, wizard-controller.js, create-assessment.js

6. **Update `assets_manifest` schema**
   - Add columns: `storage_backend`, `original_size`, `compressed_size`, `compression_ratio`
   - Migration: `20260713_027_extend_assets_manifest.sql`

7. **Update `take-assessment/exam.js` image rendering**
   - Image URLs → `https://edu.albyte-inc.workers.dev/img/{hash}` (Worker cache proxy)
   - Add `<img onerror>` fallback + `loading="lazy"`

#### Acceptance Criteria
- [ ] Admin uploads 10 MB JPEG → compressed to 80-300 KB JPEG
- [ ] PNG transparency → white background JPEG
- [ ] EXIF stripped (verified: no GPS)
- [ ] Image appears in peserta's take-assessment view via Worker cache
- [ ] Deleting soal releases image (ref_count decrements)
- [ ] Canceling wizard releases all draft images
- [ ] Re-uploading same image returns existing cdn_url (dedup works)

---

### Phase S1 — High Priority Security Fixes (Week 2, parallel with Phase 2) — v0.821.0 → v0.821.0

**Goal:** Close 12 HIGH vulnerabilities that enable data manipulation or service disruption.

**Effort:** 5-7 dev-days

#### Tasks

1. **SEC-A-C1 (full): Migrate JWT from localStorage to HttpOnly cookie**
   - Configure Supabase Auth `cookie_options` (secure, sameSite=strict, httpOnly=true)
   - Update `supabase-client.js` to use `cookieStorage`
   - Test all auth flows (login, logout, refresh, OAuth callback)
   - **Risk:** High — auth is core. Test thoroughly in staging.

2. **SEC-B-H1: Heartbeat EF violation_count manipulation**
   - Remove `body.violation_count` from heartbeat UPDATE payload
   - Violation count only incremented by `block-participant` EF

3. **SEC-B-H2: submit_assessment_atomic auth check**
   - Use `auth.uid()` inside the RPC, ignore `p_user_id` parameter

4. **SEC-C-H1: XSS in math-paste-converter.js**
   - Change `target.innerHTML = content` to `target.textContent = content`

5. **SEC-C-H2: KaTeX strict mode**
   - Change `strict: false` to `strict: 'ignore'` in `math-renderer.js`

6. **SEC-C-M1: PostgREST filter injection**
   - Add `encodeURIComponent()` to all user-supplied filter values in `_shared/rate-limit.ts` + `_shared/db.ts`

7. **SEC-C-M2: IP rate-limit bypass**
   - Only trust `CF-Connecting-IP` header (Cloudflare-set, can't be spoofed)
   - Remove `X-Forwarded-For` fallback in `_shared/audit.ts`

8. **SEC-D-H1: B2 backup**
   - Enable B2 bucket lifecycle rules (keep last 30 versions)
   - Set up daily B2 → Supabase Storage backup script (avatars)

9. **SEC-D-H2: Enable PITR**
   - Upgrade Supabase to Pro plan ($25/month) — enables 7-day PITR
   - Or accept 24h RPO on free plan (documented risk)

10. **SEC-D-H3: Branch protection + CI**
    - Add `.github/workflows/ci.yml` — lint + test on PR
    - Enable branch protection on `main` (require PR review + CI pass)
    - Add Dependabot config

11. **SEC-C-M3: Error message sanitization**
    - Production: return generic errors, log full detail server-side
    - Development: return full detail (gated by `DENO_ENV`)

---

### Phase 3 — GC Migration to Supabase (Week 5) — v0.821.0 → v0.822.0

**Goal:** Replace GitHub Actions GC bot with Supabase Edge Function + pg_cron.

**Effort:** 4-5 dev-days

#### Tasks

1. **Build `asset-gc` Edge Function** (mirrors GC bot logic)
   - Query pending_delete=true AND ref_count=0 AND last_seen < 7 days
   - Re-verify (race guard) → B2 DELETE → manifest DELETE
   - BATCH_SIZE=100, Promise.allSettled (parallel)
   - DRY_RUN support (fixing GC bot's placebo)
   - `gc_fail_count` increment on failure, reset on success

2. **Schedule pg_cron job** `purge-orphaned-assets` (daily 03:00 UTC)

3. **Decommission GitHub Actions GC bot** (disable workflow)

---

### Phase 4 — Cloudflare Worker Cache Proxy (Week 6) — v0.822.0 → v0.823.0

**Goal:** Worker `/img/{hash}` cache proxy active for all assessment images.

**Effort:** 3-4 dev-days (Worker code already written in `cloudflare-worker/worker.js`)

#### Tasks

1. **Verify Worker B2 env vars configured** (✅ done by user)
2. **Test `/img/{hash}` with real B2 asset** (after Phase 2 ships)
3. **Update client image URLs** to use Worker cache proxy
4. **Verify cache hit ratio** >95% after warm-up

---

### Phase 5 — GitHub Repos Decommission (Week 7) — v0.823.0 → v0.824.0

**Goal:** Migrate remaining GitHub-hosted assets to B2. Delete 20 GitHub repos.

**Effort:** 5-7 dev-days

#### Tasks

1. **Build migration script** `scripts/migrate-github-to-b2.js`
   - Download from GitHub → upload to B2 → UPDATE manifest
   - Resumable, batch 50, verify each upload
2. **Run in staging first** (1 week)
3. **Run in production** (maintenance window)
4. **Delete 20 GitHub repos** (7-day safety window post-migration)
5. **Remove legacy code paths** (GitHub API helpers in Worker)

---

### Phase S2 — Medium Priority Hardening (Week 3-4, parallel) — v0.822.0 → v0.824.0

**Goal:** Close 15 MEDIUM vulnerabilities and add defense-in-depth.

**Effort:** 5-7 dev-days

#### Tasks

1. **Account enumeration fixes** (login + forgot-password constant-time responses)
2. **Dependency scanning** (Dependabot + npm audit in CI)
3. **Realtime authentication** (verify RLS enforcement on Realtime channels)
4. **Service Worker integrity** (add SRI hashes)
5. **Concurrent session limit** (max 5 devices per user)
6. **Email verification enforcement** (block admin login until verified)
7. **Edge Function body size limits** (max 10 MB)
8. **Backup restore testing** (monthly restore to staging)
9. **Server-side logout** (revoke refresh token + clear storage)
10. **Cross-organization RLS** (add org_id scoping for future multi-tenant)

---

### Phase 6 — Monitoring, Alerting & DR (Week 8) — v0.824.0 → v0.825.0

**Goal:** Add enterprise-grade monitoring, alerting, and disaster recovery.

**Effort:** 5-6 dev-days

#### Tasks

1. **Asset monitoring dashboard** (`pages/admin/asset-monitoring.html`)
2. **Alerting** (Discord/Slack webhook for GC failures, storage >80%, etc.)
3. **Audit trail** (all asset mutations logged to `audit_logs`)
4. **DSR cascade verification** (test avatar deletion end-to-end)
5. **Disaster Recovery doc** (`docs/security/DISASTER-RECOVERY.md`)
6. **UptimeRobot monitors** (✅ done in Phase S0, verify active)

---

### Phase S3 — Advanced Security (Month 2+) — v0.825.0+

**Goal:** Enterprise-grade security hardening.

#### Tasks (lower priority, parked for when scale demands)

1. **Hardware device fingerprint** (FingerprintJS Pro — canvas + audio + fonts + WebGL)
2. **WebAuthn / Passkey for admins** (2FA via `@simplewebauthn/server`)
3. **Secret rotation automation** (quarterly reminder + runbook)
4. **Security Headers** (HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy)
5. **Penetration testing** (external firm, $5-15K, 1-week engagement)
6. **Bug bounty program** (HackerOne or Intigriti)
7. **SOC 2 / ISO 27001 compliance** (when enterprise customers demand)

---

## Unified Timeline

```
Week 1  (v0.821.0) ✅ Phase S0 — 3 emergency security migrations applied
                    ✅ Phase 1 — Avatar migration to Supabase Storage
Week 2  (v0.821.0) 🔲 Phase S1 — JWT cookie, heartbeat fix, XSS, branch protection
                    🔲 Phase 2 — Assessment image upload UI + B2 (start)
Week 3-4 (v0.821.0) 🔲 Phase 2 — Assessment image upload UI + B2 (continue)
                    🔲 Phase S2 — Medium security fixes (parallel)
Week 5  (v0.822.0) 🔲 Phase 3 — GC migration to Supabase Edge Function
Week 6  (v0.823.0) 🔲 Phase 4 — Worker cache proxy active
Week 7  (v0.824.0) 🔲 Phase 5 — GitHub repos decommission
Week 8  (v0.825.0) 🔲 Phase 6 — Monitoring, alerting, DR
Month 2+           🔲 Phase S3 — Advanced security (fingerprint, passkey, pen-test)
```

---

## Risk Register (Top 10)

| # | Risk | Prob | Impact | Mitigation | Phase |
|---|---|---|---|---|---|
| 1 | ~~Peserta escalates to admin~~ | ~~HIGH~~ | ~~CRITICAL~~ | ✅ Migration 024 applied | ✅ S0 |
| 2 | ~~Audit trail tampered~~ | ~~HIGH~~ | ~~HIGH~~ | ✅ Migration 025 applied | ✅ S0 |
| 3 | ~~Undocumented tables open~~ | ~~HIGH~~ | ~~HIGH~~ | ✅ Migration 026 applied | ✅ S0 |
| 4 | JWT stolen via XSS | MEDIUM | CRITICAL | CSP (S0) + HttpOnly cookie (S1) | S0+S1 |
| 5 | Brute-force admin login | MEDIUM | HIGH | Turnstile + rate limit | S0 #4 |
| 6 | Unauthorized admin registration | HIGH | HIGH | Approval gate | S0 #5 |
| 7 | Data loss (no PITR) | LOW | CRITICAL | Supabase Pro (S1) | S1 |
| 8 | B2 asset permanent loss | LOW | HIGH | Versioning + backup (S1) | S1 |
| 9 | Supply chain attack | LOW | CRITICAL | Branch protection + CI (S1) | S1 |
| 10 | Undetected attack | HIGH | HIGH | UptimeRobot (✅) + alerting (Phase 6) | S0+6 |

---

## Version History

| Version | Date | Phases Completed | Summary |
|---|---|---|---|
| v0.816.0 | 2026-07-09 | (baseline) | Pre-migration, asset system broken |
| v0.817.0 | 2026-07-10 | Asset Phase 0 | Stabilization: migration, RLS, Magic Compress v2 |
| v0.818.0 | 2026-07-10 | Asset Phase 0+ | Magic Compress v2 (perceptual) + BackBlaze setup |
| v0.819.0 | 2026-07-10 | Asset Phase 1 | Avatar migration to Supabase Storage |
| v0.821.0 | 2026-07-10 | Security audit | 4 audits completed, roadmap + IR plan created |
| **v0.821.0** | **2026-07-10** | **Security S0** | **3 emergency migrations: peran freeze, RPC revoke, RLS verify** |
| v0.821.0 | (next) | Asset Phase 2 + Security S1 | Assessment images + B2 + JWT cookie + branch protection |
| v0.822.0 | (week 5) | Asset Phase 3 + Security S2 | GC migration + medium security fixes |
| v0.823.0 | (week 6) | Asset Phase 4 | Worker cache proxy active |
| v0.824.0 | (week 7) | Asset Phase 5 + S2 complete | GitHub repos decommission |
| v0.825.0 | (week 8) | Asset Phase 6 | Monitoring, alerting, DR |
| v0.826.0+ | (month 2+) | Security S3 | Hardware fingerprint, passkey, pen-test |

---

## References

- **Asset architecture:** `docs/asset-system/ARCHITECTURE-V2.md`
- **Security roadmap (detailed):** `docs/security/SECURITY-ROADMAP.md`
- **Incident response:** `docs/security/INCIDENT-RESPONSE.md`
- **BackBlaze setup:** `docs/asset-system/BACKBLAZE-SETUP.md`
- **Audit reports:** `/home/z/my-project/worklog.md` (SEC-A through SEC-D, ~2000 lines)
- **Worker architecture:** `cloudflare-worker/README.md`
