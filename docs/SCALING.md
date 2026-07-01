# SCALING — Supabase Free Plan Limits & Upgrade Path

> AlbEdu v1.0.0 is designed to run on Supabase Free Plan for up to 200 concurrent peserta.
> Code is scalable to 2000+ concurrent with Pro Plan upgrade (no rewrite needed).

---

## 1. Supabase Free Plan Limits

| Resource | Free Plan Limit | AlbEdu v1.0.0 Usage (200 concurrent) | Status |
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
- Edge Function `start-session` checks active session count
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

AlbEdu v1.0.0 code is **scalable to 10,000+ concurrent peserta** without rewrite:
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

**Document version:** 1.0.0
**Last updated:** 2026-06-30
**Owner:** Albi Fahriza (albytehq)
