# SCALING — Supabase Free Plan Limits & Upgrade Path

> AlbEdu v0.818.1 is designed to run on Supabase Free Plan for up to 200 concurrent peserta.
> Code is scalable to 2000+ concurrent with Pro Plan upgrade (no rewrite needed).

---

## 1. Supabase Free Plan Limits

| Resource | Free Plan Limit | AlbEdu v0.818.1 Usage (200 concurrent) | Status |
|---|---|---|---|
| Database storage | 500 MB | ~50 MB (normalized schema, 1000 assessments) | ✅ OK |
| Database connections | 60 direct + 200 pool | 200 concurrent peserta via pool | ⚠️ Tight |
| Edge Function invocations | 500,000/month | ~5.8M/month (heartbeat 15s) | ❌ JEBOL |
| Edge Function RAM | 2 GB total | ~50MB per invocation × batched | ⚠️ Tight |
| Realtime concurrent connections | 200 | 5-10 channels (critical events only) | ✅ OK |
| Realtime messages | 2 million/month | ~1M/month (critical events only) | ✅ OK |
| Bandwidth | 2 GB/month | ~1.5 GB/month (compressed) | ✅ OK |
| Auth users | 50,000 MAU | 1000 peserta + 50 admin | ✅ OK |
| Storage | 1 GB | 500 MB (gambar soal via Cloudflare CDN) | ✅ OK |

---

## 2. Optimization Strategies (Free Plan Safe)

### 2.1 Heartbeat Optimization

**Problem:** Heartbeat 5s per peserta = 12 req/min = 17M Edge Function invocations/month for 200 peserta. JEBOL Free Plan.

**Solution:**
- **Heartbeat interval: 15s** (not 5s) = 4 req/min/peserta
- **In-memory cache (60s TTL):** Edge Function caches session state in Worker memory, DB hit only every 60s
- **Batch answers:** Client sends batch of answer changes, not per-answer
- **Draft save on change:** Not periodic — save only when peserta answers new question

**Math:**
- 200 peserta × 4 req/min × 60 min × 24 hours × 30 days = 3.5M req/month
- Still over 500K Free limit, but:
  - Edge Function execution time <100ms per heartbeat (cached)
  - DB hit only every 60s (1 req/min/peserta = 864K req/month for 200 peserta)
  - Actual Edge Function invocations: 3.5M (cached responses, no DB)
  - DB invocations: 864K — **still over Free Plan**

**Verdict:** 200 concurrent peserta continuous = jebol Free Plan. Realistic usage (assessment selama 90 min, 200 peserta) = 200 × 4 × 90 = 72K req per assessment. If 10 assessments/day = 720K req/day = 21M req/month.

**Recommendation:** Upgrade to Supabase Pro ($25/month) for production. Free Plan OK for dev/testing only.

### 2.2 Realtime Optimization

**Problem:** 200 concurrent realtime connections = jebol Free Plan.

**Solution:** Hybrid realtime (Q7):
| Event | Transport | Connections Used |
|---|---|---|
| Admin block peserta | Realtime | 1 channel per assessment |
| Peserta submit | Realtime | 1 channel per assessment |
| Violation event | Realtime | 1 channel per assessment |
| Assessment state (pause/resume) | Polling 15s | 0 |
| Peserta progress | Polling 15s | 0 |

**Math:**
- 5 active assessments × 1 channel each = 5 realtime connections
- 5 admin × 1 channel each = 5 realtime connections
- Total: 10 realtime connections (well under 200 limit)

### 2.3 Database Connection Optimization

**Problem:** 200 concurrent peserta + Supabase pool = 200 connections. Free Plan = 200 pool limit.

**Solution:**
- Supabase connection pooler (PgBouncer) handles connection multiplexing
- Edge Functions use service role key (bypasses pool, direct connection)
- Client (browser) uses anon key (goes through pool)
- 200 browser connections share ~10-20 actual DB connections via pool

### 2.4 Bandwidth Optimization

- Gzip + Brotli compression (Supabase automatic)
- Image CDN via Cloudflare (jsdelivr.net) — doesn't count against Supabase bandwidth
- Minified JS/CSS (build pipeline already does this)
- Service Worker cache (Phase 8 PWA) — reduces repeat visits bandwidth

---

## 3. Configuration (Free Plan Safe Defaults)

```env
# .env.production (Free Plan)
ALBEDU_MAX_CONCURRENT_PESERTA=200
ALBEDU_HEARTBEAT_INTERVAL_MS=15000
ALBEDU_REALTIME_CRITICAL_ONLY=true
ALBEDU_POLLING_PROGRESS_INTERVAL_MS=15000
ALBEDU_POLLING_ASSESSMENT_INTERVAL_MS=30000
ALBEDU_HEARTBEAT_CACHE_TTL_MS=60000
ALBEDU_BATCH_ANSWERS=true
```

**Soft cap enforcement:**
- Edge Function `access-code-attempt` checks active session count via rate limiting (10/IP/hour, 10/device/hour)
- If active sessions >= MAX_CONCURRENT_PESERTA → return 429 "Kapasitas tercapai"
- Admin sees warning in dashboard if approaching limit

---

## 4. Upgrade Path

| Trigger | Action | Cost | Impact |
|---|---|---|---|
| >200 concurrent peserta | Upgrade Supabase Pro | $25/month | 10K realtime connections, 7GB Edge RAM, 8GB DB, PITR backup |
| >1000 concurrent peserta | + Supabase Team Plan | $25 + $99/month | 20K realtime, priority support |
| >10,000 concurrent peserta | Dedicated Supabase / self-host | $500+/month | Custom SLA, dedicated infrastructure |
| >1GB image storage | Cloudflare R2 + Worker | $5/month | S3-compatible, no egress fees |
| >500K Edge Function invocations | Supabase Pro (includes 2M invocations) | included in $25/month | 2M invocations, then $0.50 per million |
| >2GB bandwidth | Supabase Pro (includes 250GB) | included in $25/month | 250GB bandwidth |

### 4.1 How to Upgrade

1. Go to Supabase Dashboard → Billing
2. Click "Upgrade to Pro"
3. Enter payment method
4. Update `.env.production`:
   ```env
   ALBEDU_MAX_CONCURRENT_PESERTA=1000
   ALBEDU_HEARTBEAT_INTERVAL_MS=10000  # can reduce to 10s with Pro
   ```
5. Redeploy Edge Functions (no code changes needed)
6. Monitor for 24 hours

### 4.2 Code Scalability

AlbEdu v0.818.1 code is **designed to scale to 10,000+ concurrent peserta** (aspirational — no load testing has been done yet):
- Schema normalized (no embedded JSONB bloat)
- Edge Functions stateless + cached
- Realtime channels scoped per assessment (not global)
- Polling intervals configurable via env
- Database indexes optimized for concurrent reads

**Bottleneck at 10K:** Supabase Realtime message throughput (10 messages/second per channel). Solution: shard realtime channels by assessment_id.

---

## 5. Monitoring

### 5.1 Metrics to Watch

| Metric | Source | Alert Threshold |
|---|---|---|
| Concurrent peserta | `assessment_sessions` WHERE status='active' | >80% of MAX_CONCURRENT |
| Edge Function invocations | Supabase Dashboard | >80% of monthly limit |
| Database storage | Supabase Dashboard | >80% of 500MB (Free) / 8GB (Pro) |
| Realtime connections | Supabase Dashboard | >80% of 200 (Free) / 10K (Pro) |
| API response time | Edge Function logs | >500ms p95 |
| Error rate | Edge Function logs | >1% of requests |

### 5.2 Logging

- Edge Functions log to Supabase Dashboard → Functions → Logs
- Audit logs in `audit_logs` table (1 year retention)
- Violation events in `violation_events` table (90 day retention)
- Client errors via `security.js` global error handler (in-memory, last 50)

### 5.3 Alerting (Phase 9)

Deferred to Phase 9:
- Sentry integration for client errors
- Supabase webhook → Discord/Telegram for critical alerts
- Uptime monitoring (Better Stack / UptimeRobot)

---

## 6. Load Testing

**Target:** 200 concurrent peserta on Free Plan without errors.

**Tool:** k6 (https://k6.io) or Artillery

**Test scenarios (Phase 8):**
1. 200 peserta start assessment simultaneously
2. 200 peserta heartbeat every 15s for 90 minutes
3. 50 peserta submit simultaneously
4. Admin block 10 peserta during active session
5. 200 peserta poll assessment state every 30s

**Pass criteria:**
- 0 errors
- p95 response time <500ms
- Edge Function invocations <500K total
- DB connections <200 peak

---

## 7. Disaster Recovery

### 7.1 Database Backup (Q18 — Daily Automated)

- Supabase Free Plan: automatic daily backup at 02:00 UTC
- Retention: 7 backups (7 days)
- Restore: Supabase Dashboard → Database → Backups → Restore

### 7.2 Point-in-Time Recovery (PITR)

- Requires Supabase Pro ($25/month)
- Restore to specific timestamp (e.g. "restore to July 14 10:30 AM")
- Retention: 7 days of PITR

### 7.3 Multi-Region Backup

- Phase 9 (future)
- Backup to alternate region (e.g. Singapore + Tokyo)
- Disaster scenario: 1 region down → restore from alternate

### 7.4 Code Rollback

- Git revert to last stable version
- Max downtime: 2 hours (DB restore + code rollback)

---

## v0.818.1 Free Plan Capacity

The v0.746.0 estimates at the top of this doc assumed 200 concurrent peserta was achievable on Free Plan. The v0.818.1 audit disproved this — when the auditors actually walked through the realtime connection math (200 concurrent connections, 2 per peserta for the channel + polling fallback, minus admin overhead), the realistic ceiling came out at ~100. The numbers below are the corrected estimates after the v0.818.1 hardening. The original v0.746.0 table at the top of this doc is preserved for historical reference but should NOT be used for capacity planning.

### Realistic Free Plan ceilings (post-hardening)

| Metric | Ceiling | Why |
|---|---|---|
| Max concurrent peserta | ~100 | Realtime cap is 200 connections. Each peserta uses 2 (1 realtime channel for block-listener + 1 polling fallback in case realtime drops). 100 peserta × 2 = 200 connections = the hard ceiling. Going above this requires Pro Plan (10K connections). |
| Max exams/month (50 peserta, 90min each) | ~14 | Edge Function invocations: 50 peserta × 4 req/min × 90 min = 18K req/exam. Free Plan = 500K invocations/month. 500K / 18K = ~28 exams theoretical, but real-world safety margin (admin invocations, auth, heartbeat retries on flaky networks) cuts it to ~14. |
| Max concurrent admin | ~30 | Each admin holds 1-2 realtime connections (notification center + monitoring dashboard). 30 admins × 2 = 60 connections, leaving 140 for peserta (i.e. 70 peserta if all 30 admins are watching). In practice admins are rarely all concurrent — the binding constraint is peserta. |
| Max stored assessments | ~5,000 | DB 500MB. Each assessment row + sections JSONB ~100KB (50 questions × ~2KB each including answer options + explanations). 5,000 × 100KB = 500MB. Beyond this, you hit DB storage limits and Supabase pauses the project. |
| Max stored submissions | ~50,000 | Each submission row ~2KB (answers JSONB + score + identity snapshot). 50,000 × 2KB = 100MB. Comfortably fits alongside the assessments within 500MB. Submissions older than 365 days are auto-anonymized by pg_cron. |

### With the 60s heartbeat DB cache

The heartbeat DB cache (introduced in v0.818.1) drops the DB hit rate from 4/min/peserta to 1/min/peserta. This doesn't change the Edge Function invocation count (the function still runs every 15s — it just doesn't hit the DB on cache hits), but it does:

- Cut DB CPU usage ~4x — eliminates the "DB connections exhausted" failure mode that was the most common production issue in v0.746.0.
- Cut cold-start latency on the heartbeat function (cache hit returns in ~5ms vs. ~50ms for a DB fetch).
- Extend the realistic exams/month ceiling from ~14 to ~28 — the DB is no longer the bottleneck before Edge Function invocations are. The new binding constraint becomes the 500K Edge Function invocation cap itself.

### Recommended scaling triggers (when to upgrade to Pro $25/mo)

Upgrade to Pro when ANY of these is true. Do not wait for multiple triggers — by the time 2+ fire simultaneously, you're already in degraded mode and exam reruns may be needed.

- Concurrent peserta > 80 (leave 20% headroom under the 100 ceiling — needed for retries on flaky networks).
- Exams/month > 10 (leave 30% headroom under the 14 ceiling — needed for admin invocations + auth flows).
- DB storage > 400MB (leave 20% headroom under 500MB — Supabase pauses the project at 500MB, which means full downtime).
- Realtime connections sustained > 150 for >1 hour (indicates approaching the 200 cap — leaves 50 for transient reconnection spikes).
- Edge Function p95 latency > 500ms (indicates DB pressure — the heartbeat function should be <50ms on cache hit, >500ms means cache miss rate is too high or DB is under-provisioned).

Pro Plan lifts: 10K realtime connections, 8GB DB storage, 2M Edge Function invocations (then $0.50/million), 250GB bandwidth, PITR backups, daily backups retained 30 days instead of 7. The $25/month is cheaper than a single DB-outage-induced exam rerun — one rerun costs ~$200 in admin time + ~$500 in peserta goodwill (rescheduling, complaints).

### Keep-warm strategy

Edge Functions on Free Plan cold-start in ~1-2s (the isolate has to be spun up). For the heartbeat function (invoked every 15s per peserta), a 2s cold-start on the first peserta's first heartbeat causes a noticeable "loading..." delay. To keep the heartbeat + submit-assessment isolates warm:

- Set up an external uptime ping on `https://<project>.supabase.co/functions/v1/health-check` every 5 minutes. Better Stack / UptimeRobot both have free tiers that do this.
- The ping keeps at least one isolate warm in each Supabase region. Subsequent heartbeats hit the warm isolate (~5ms cold-start instead of ~2s).
- Pro Plan eliminates this need (isolates are always-warm by default).

The keep-warm ping costs 8,640 Edge Function invocations/month (12 pings/hour × 24 hours × 30 days) — well under the 500K cap, and the health-check function is a single `SELECT 1` so the DB load is negligible.

---

**Document version:** 1.1.0
**Last updated:** 2026-07-08
**Owner:** Albi Fahriza (albytehq)
