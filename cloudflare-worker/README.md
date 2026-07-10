# AlbEdu Cloudflare Worker — Architecture & Function Reference

**Version:** 7.0.0 (AlbEdu v0.821.0+)
**Status:** Production-ready
**Replaces:** worker.js (legacy, deleted) (decommissioned in v0.821.0)

---

## 🎯 Worker Role in AlbEdu Architecture

Worker is **NOT** an upload gateway anymore. It serves 3 distinct functions in the new asset system:

```
                    ┌─────────────────────────────────────┐
                    │       CLOUDFLARE WORKER v7          │
                    │                                     │
                    │  1. EDGE CACHE                      │
                    │     /img/{hash}                     │
                    │     ↓                               │
                    │     Cloudflare edge cache (24h TTL) │
                    │     ↓ cache miss                    │
                    │     assets_manifest lookup          │
                    │     ↓                               │
                    │     B2 (S3 signed) OR GitHub (CDN)  │
                    │                                     │
                    │  2. CONFIG ENDPOINT                 │
                    │     /api/supabase-config            │
                    │     ↓                               │
                    │     Edge-cached 1h (reduces DB load)│
                    │                                     │
                    │  3. HEALTH MONITOR                  │
                    │     /api/health                     │
                    │     ↓                               │
                    │     Independent of Supabase (always)│
                    │                                     │
                    │  4. LEGACY CRON (transitional)      │
                    │     sweepExpiredAssessments         │
                    │     ↓                               │
                    │     Archive expired assessments +   │
                    │     release image refcounts         │
                    │     (Phase 3 replaces with pg_cron) │
                    └─────────────────────────────────────┘
```

---

## 📡 Endpoint Reference

### `GET /api/supabase-config`

**Function:** Returns Supabase URL + anon key for client SDK initialization.

**Why it exists:** Client browsers need Supabase credentials to init the SDK. Serving them from the Worker (instead of hardcoding in HTML) allows central rotation — change once in Worker env, all clients pick up on next load.

**Caching:** Edge-cached for 1 hour (`Cache-Control: public, max-age=3600`). Reduces Supabase auth endpoint load by ~99% (clients hit Cloudflare edge, not Supabase directly).

**CORS:** Restricted to allowed origins (configurable via env). Rejects unknown origins with 403.

**Response shape:**
```json
{
  "supabaseUrl": "https://[project].supabase.co",
  "supabaseAnonKey": "eyJ..."
}
```

---

### `GET /api/health`

**Function:** Uptime monitoring endpoint.

**Why it exists:** External monitoring (UptimeRobot, BetterStack, etc.) pings this every 1-5 min. Returns 200 if Worker is alive, regardless of Supabase/B2 status. This separates "Worker down" from "Supabase down" in incident response.

**Design choice:** Does NOT query Supabase or B2. If it did, a Supabase outage would make the Worker appear "down" — confusing for on-call. Worker liveness is independent of upstream dependencies.

**Response shape:**
```json
{
  "status": "ok",
  "service": "albedu-worker",
  "timestamp": "2026-07-09T19:30:00.000Z",
  "version": "7.0.0",
  "config": {
    "supabase": true,
    "b2": true
  }
}
```

The `config` booleans tell you if env vars are set — useful for debugging "why is /img returning 500" without exposing the actual values.

**Caching:** `no-store` — always fresh.

---

### `GET /img/{hash}` — **THE KEY INNOVATION**

**Function:** Image cache proxy. Serves assessment images from Cloudflare edge cache.

**Why this is critical for B2 free tier:**

B2 free tier limits:
- 2,500 Class B transactions (downloads) per day
- After that: $0.004 per 1,000

Without cache: 1,000 peserta × 10 images = 10,000 B2 calls = **4x over free tier** = unexpected charges.

With Worker cache: same 1,000 peserta × 10 images = **10 B2 calls** (first load per image per edge location) = 0.4% of free tier. Cache hits cost $0.

**Cache strategy:**
- **Cache key:** `https://cache.local/img/{hash}` (synthetic URL, not user-facing)
- **TTL:** 24 hours (`Cache-Control: public, max-age=86400`)
- **ETag:** the hash itself (enables `304 Not Modified` responses — zero-byte transfer)
- **Cache location:** Cloudflare global edge network (300+ locations)

**Origin resolution flow:**

```
Request: GET /img/a3f1c9e4b2...

1. Validate hash format (64 hex chars = SHA-256)
   ↓ invalid → 400 Bad Request

2. Check Cloudflare cache
   ↓ HIT  → return cached (1ms TTFB, X-Cache: HIT)
   ↓ MISS → continue

3. Query Supabase: assets_manifest WHERE hash = {hash}
   ↓ not found → 404 Asset not found
   ↓ found     → read storage_backend field

4. Fetch origin based on storage_backend:
   ├─ 'b2'     → sign S3 GET request → fetch from B2
   └─ 'github' → fetch from jsDelivr CDN (legacy assets)

5. Stream response back + store in edge cache
   Headers:
     Content-Type: image/jpeg
     Cache-Control: public, max-age=86400
     ETag: "{hash}"
     X-Cache: MISS
     X-Storage-Backend: b2 | github
```

**Forward-compatible design:** The `storage_backend` column in `assets_manifest` lets the Worker handle both legacy GitHub assets AND new B2 assets transparently. During Phase 5 migration (GitHub → B2), no Worker code change needed — just update the manifest rows.

---

### `POST /upload` and `POST /release` — DECOMMISSIONED

**Function:** Return 410 Gone with migration instructions.

**Why decommissioned:** v6 used these for avatar/asset uploads, but the AUTH_TOKEN pattern was broken (no client sent the token). Phase 1 migrated avatars to Supabase Storage (direct SDK, JWT auth). Phase 2 will migrate soal images to B2 via Supabase Edge Functions.

**Response shape:**
```json
{
  "error": "Gone",
  "message": "This endpoint has been decommissioned in v0.821.0...",
  "docs": "docs/asset-system/ARCHITECTURE-V2.md",
  "migrated_in": "v0.821.0"
}
```

Keeping the endpoints (instead of removing) gives old clients a helpful error instead of a confusing 404.

---

### Cron Trigger: `sweepExpiredAssessments` (every 15 min)

**Function:** Archives assessments past their end time + 1 hour grace period.

**Flow:**
1. Query `assessments` where status=active AND end time passed
2. For each expired assessment:
   - Walk `sections[].questions[].media.gambar[]` to find image references
   - For each image: call `_releaseByHash(hash)` → decrement `ref_count` in manifest
   - If `ref_count` hits 0: set `pending_delete = true`
   - Update assessment `status = 'archived'`
3. Log summary

**Why kept in v7:** This is the ONLY mechanism currently archiving expired assessments. Phase 3 will replace this with a Supabase pg_cron job calling an `asset-gc` Edge Function — more reliable, no 15-min lag, no Cloudflare dependency.

**Race safety:** `_releaseByHash` uses `Math.max(0, ref_count - 1)` to prevent negative ref_count (was a bug in v6 that could cause GC to delete in-use assets).

---

## 🔐 Security Architecture

### Authentication layers

| Caller | Auth Method | What It Can Access |
|---|---|---|
| Browser (peserta/admin) | None — public endpoints | `/api/supabase-config`, `/api/health`, `/img/{hash}` |
| Supabase (server-to-server) | Service role key | `assets_manifest` queries (via Worker, not browser) |
| B2 (server-to-server) | AWS Signature V4 | B2 bucket objects (via Worker, not browser) |

### What the Worker does NOT do

- ❌ Does NOT accept uploads from browsers (Phase 1 moved to Supabase Storage)
- ❌ Does NOT expose any env var values in responses
- ❌ Does NOT log secrets (only logs hash prefixes, never keys)
- ❌ Does NOT trust client-provided hashes (validates format + checks manifest)
- ❌ Does NOT cache 4xx/5xx responses (only successful image fetches cached)

### CORS policy

Default allowed origins (hardcoded):
- `https://albytehq.github.io` (production)
- `https://albedu-id.github.io` (legacy)
- `http://localhost:8765` (local dev)
- `http://127.0.0.1:8765` (local dev)

Extend via `ALLOWED_ORIGINS` env var (comma-separated). Unknown origins get `Access-Control-Allow-Origin: null` (browser blocks the response).

### Rate limiting

- `/api/supabase-config`: 60 req/min per IP (in-memory, per Worker isolate)
- `/img/{hash}`: no rate limit (cache hits are free; cache misses self-limit via B2)
- `/api/health`: no rate limit (monitoring needs to always work)

Rate limit is per-Worker-isolate (Cloudflare runs many isolates globally). Not a hard DDoS shield — Supabase/B2 have their own rate limits. This is just to prevent runaway loops.

---

## ⚡ Performance Characteristics

### Latency (typical)

| Endpoint | Cache HIT | Cache MISS | Cold start |
|---|---|---|---|
| `/api/supabase-config` | 5ms | 30ms | 200ms |
| `/api/health` | 5ms | 10ms | 150ms |
| `/img/{hash}` | 5-20ms | 100-500ms (B2 fetch) | 300ms |
| `/upload` (410) | N/A | 10ms | N/A |

### Cache hit ratio target

- `/api/supabase-config`: >99% (1h TTL, low cardinality)
- `/img/{hash}`: >95% after warm-up (24h TTL, peserta load same images)

### Bandwidth

- Worker egress: free (Cloudflare doesn't charge for egress)
- B2 egress: free (Bandwidth Alliance — Cloudflare ↔ BackBlaze)
- Supabase egress: minimal (only manifest queries, ~100 bytes each)

### B2 transaction savings

| Scenario | Without Worker | With Worker | Savings |
|---|---|---|---|
| 1,000 peserta × 10 images | 10,000 B2 calls | ~10 B2 calls | 99.9% |
| 10,000 peserta × 20 images | 200,000 B2 calls | ~50 B2 calls | 99.97% |

At Mid scale (100-500 schools), this keeps B2 Class B transactions well under the 2,500/day free tier limit.

---

## 🔄 Migration Path

### v6 → v7 (current)

- `/upload` and `/release` endpoints decommissioned (return 410)
- `/img/{hash}` endpoint added (new)
- B2 S3 signing added (AWS Signature V4 via Web Crypto)
- `sweepExpiredAssessments` retained (Phase 3 will deprecate)
- Client code: no change needed for Phase 1 (avatars use Supabase Storage directly)

### v7 → v8 (future, Phase 3+)

After Phase 3 ships (pg_cron + asset-gc Edge Function):
- Remove `sweepExpiredAssessments` cron trigger
- Remove `scheduled()` handler
- Remove `_releaseByHash`, `_releaseAssessmentImages`, `_archiveExpiredAssessment`, `_isAssessmentExpired` functions
- Worker becomes pure cache + config + health (leaner, ~300 lines vs 630)

After Phase 5 ships (GitHub repos decommissioned):
- Remove GitHub CDN fallback in `/img/{hash}` (all assets will be on B2)
- Remove `GITHUB_TOKEN`, `GITHUB_USERNAME` env vars

---

## 🧪 Testing the Worker (Local Dev)

The Worker can be tested locally with Wrangler:

```bash
npm install -g wrangler
wrangler login

# In the cloudflare-worker/ directory:
wrangler dev worker.js

# Local dev server runs at http://localhost:8787
# Set env vars in .dev.vars file (gitignored):
#   SUPABASE_URL=...
#   SUPABASE_ANON_KEY=...
#   etc.
```

Test endpoints:
```bash
curl http://localhost:8787/api/health
curl http://localhost:8787/api/supabase-config
curl http://localhost:8787/img/test-invalid-hash
```

---

## 📊 Monitoring

### What to alert on

| Metric | Threshold | Action |
|---|---|---|
| `/api/health` non-200 | >1% of requests | Worker down — check Cloudflare status |
| `/img/{hash}` 5xx rate | >1% of requests | B2 or Supabase issue — check upstream |
| `/img/{hash}` cache hit ratio | <90% | Investigate cache invalidation or low cardinality |
| Cron trigger failures | Any | Check Worker logs for sweepExpiredAssessments errors |
| Worker CPU time | >50ms p95 | Investigate slow B2 fetches or Supabase queries |

### Logs

Worker logs go to Cloudflare's Workers Logs (Workers → edu.albyte-inc → Logs). Useful log lines:
- `[config] Blocked request from unknown origin` — CORS rejection
- `[img] B2 env vars not configured` — missing B2 credentials
- `[img] Origin fetch error` — B2 or GitHub fetch failed
- `[sweep] Archived assessment {code}` — cron archived an assessment
- `[sweep] No expired assessments found` — cron ran but nothing to do

---

## 📚 Related Documentation

- **Asset system architecture:** `docs/asset-system/ARCHITECTURE-V2.md` §3.6
- **Migration roadmap:** `docs/asset-system/ROADMAP.md` Phase 4
- **B2 setup guide:** `docs/asset-system/BACKBLAZE-SETUP.md`
- **Legacy worker (v6):** `cloudflare-worker/worker.js (legacy, deleted)` (kept for reference only — do not deploy)

---

## 🏗️ Design Decisions

### Why AWS Signature V4 (not B2 native API)?

B2 has two APIs:
1. **Native B2 API** (`api.backblazeb2.com`) — requires session token, expires after 24h, needs re-auth
2. **S3-compatible API** (`s3.{region}.backblazeb2.com`) — uses AWS Signature V4, no session, stateless

Worker uses S3 API because:
- ✅ Stateless — no session token to refresh
- ✅ AWS Signature V4 is well-documented, battle-tested
- ✅ Same code works for B2, AWS S3, R2, Wasabi (future flexibility)
- ✅ Web Crypto API supports HMAC-SHA256 natively (no Node.js deps needed)

### Why not use Cloudflare R2?

R2 requires a credit card even for the free tier. BackBlaze B2 does not. For an early-access product, zero-CC-onboarding is a hard requirement. B2 + Cloudflare Bandwidth Alliance gives the same $0 egress benefit.

### Why keep `sweepExpiredAssessments` in v7?

Phase 3 (pg_cron replacement) hasn't shipped yet. Removing the cron now would leave expired assessments un-archived, causing:
- Stale "active" assessments cluttering dashboards
- Image refcounts never decremented (orphans accumulate)
- DSR requests can't find all user data

Better to keep the legacy cron running until Phase 3 is verified live.

### Why 24h cache TTL for images?

Balance between:
- **Longer TTL** = higher cache hit ratio = fewer B2 calls = lower cost
- **Shorter TTL** = faster propagation when admin updates an image

24h is the sweet spot:
- Most assessment images are immutable once published
- Admin edits are rare (typically during authoring, not after publish)
- 24h aligns with daily GC cycle (orphan → 7 days → delete)

Future: Phase 6 will add a `/img/{hash}/purge` admin endpoint for manual cache invalidation when needed.

---

## 📄 File Structure

```
cloudflare-worker/
├── worker.js       # Production code (630 lines, this is what you deploy)
├── worker.js (legacy, deleted)       # Legacy (kept for reference, do not deploy)
├── README-v7.md       # This file (architecture reference)
└── README.md          # Legacy v6 README (deprecated)
```
