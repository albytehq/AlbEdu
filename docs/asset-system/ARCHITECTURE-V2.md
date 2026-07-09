# AlbEdu Asset System Architecture v2

**Version:** v0.818.3+ (Phase 0+ of ROADMAP.md)
**Status:** Active development
**Audience:** Engineers, architects, DevOps
**Companion docs:** [ROADMAP.md](./ROADMAP.md) | [DISASTER-RECOVERY.md](./DISASTER-RECOVERY.md) (Phase 6)

---

## 1. Design Principles

1. **No credit card required** — All free tiers must be accessible without payment info. Backblaze B2 and Supabase both qualify.
2. **No single point of failure** — Three independent providers (Cloudflare + Supabase + Backblaze). Any one can fail without total outage.
3. **Edge-first delivery** — Images served from Cloudflare edge cache (1ms TTFB) wherever possible. B2 is the origin, not the delivery layer.
4. **Hash-addressed, deduplicated** — SHA-256 content hash is the primary key. Same image = same hash = same storage, regardless of how many times uploaded.
5. **Refcount-based lifecycle** — `ref_count` tracks live references. Decrement on release; GC purges when ref_count=0 AND last_seen >7 days.
6. **Audit everything** — Every mutation (upload, release, GC, migrate, DSR) logged to `audit_logs` with 365-day retention.
7. **Progressive migration** — Legacy GitHub assets coexist with new B2 assets during migration. `storage_backend` column enables dual-path serving.

---

## 2. System Topology

```
                         ┌──────────────────────────┐
                         │     CLIENT (browser)     │
                         │  editor-panel.js         │
                         │  soal-editor-modal.js    │
                         │  ImageCleanup helper     │
                         │  take-assessment/exam.js │
                         └────────────┬─────────────┘
                                      │
                       ┌──────────────┼──────────────┐
                       │              │              │
                       ▼              ▼              ▼
              ┌──────────────┐ ┌────────────┐ ┌──────────────┐
              │  AVATAR      │ │  GAMBAR    │ │  IMAGE       │
              │  UPLOAD      │ │  SOAL      │ │  RENDER      │
              │  (peserta +  │ │  (admin    │ │  (peserta    │
              │   admin)     │ │   only)    │ │   view)      │
              └──────┬───────┘ └─────┬──────┘ └──────┬───────┘
                     │               │               │
                     │ JWT           │ JWT           │ <img src=
                     │               │               │  Worker/img/{hash}
                     ▼               ▼               ▼
              ┌──────────────────────────────────────────────┐
              │           SUPABASE (auth + DB)               │
              │                                              │
              │  Edge Functions (JWT-validated):             │
              │    • asset-upload   → B2 PUT + manifest INSERT│
              │    • asset-release  → manifest UPDATE         │
              │    • asset-gc       → B2 DELETE + manifest DEL│
              │                                              │
              │  Storage:                                    │
              │    • avatars bucket (RLS per-user folder)    │
              │                                              │
              │  Postgres:                                   │
              │    • assets_manifest (RLS, idx_gc_eligible)  │
              │    • audit_logs (365d retention via pg_cron)  │
              │    • pg_cron: asset-gc daily 03:00 UTC        │
              └──────────────┬───────────────────────────────┘
                             │
                             │ S3 API (B2 application key)
                             ▼
              ┌──────────────────────────────────────────────┐
              │           BACKBLAZE B2 (origin)              │
              │                                              │
              │  Bucket: albedu-assets-systems                  │
              │  Path: {hash[0:2]}/{hash}.{ext}              │
              │  Free: 10 GB storage + 2500 Class A/B per day│
              │  Egress: $0 (Cloudflare Bandwidth Alliance)  │
              └──────────────┬───────────────────────────────┘
                             │
                             │ B2 → Cloudflare (free egress)
                             ▼
              ┌──────────────────────────────────────────────┐
              │      CLOUDFLARE WORKER (edge cache)          │
              │                                              │
              │  • /api/supabase-config  (1h edge cache)     │
              │  • /api/health           (uptime monitor)    │
              │  • /img/{hash}    [NEW]  (24h edge cache)    │
              │                                              │
              │  Cache key: {hash}                           │
              │  Cache-Control: public, max-age=86400        │
              │  ETag: {hash} (enables 304 Not Modified)     │
              │                                              │
              │  On cache MISS: fetch from B2, cache, return │
              │  On cache HIT: return directly (0 B2 calls)  │
              └──────────────────────────────────────────────┘
```

---

## 3. Component Specifications

### 3.1 Supabase Storage — `avatars` bucket

**Purpose:** User avatar storage (peserta + admin profile pictures).

**Configuration:**
- Bucket name: `avatars`
- Public: Yes (avatars visible to other participants in daftar-nama)
- Max file size: 2 MB (server-enforced via Storage config)
- Allowed MIME: `image/jpeg`, `image/png`, `image/webp`

**Path convention:** `{user_id}/avatar-{timestamp}.{ext}`
- `user_id` enables RLS per-user folder
- `timestamp` prevents stale CDN cache after avatar update

**RLS policies:**
```sql
-- Upload: user can only write to their own folder
CREATE POLICY "avatars_upload_own" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text);

-- Update: user can only replace their own avatar
CREATE POLICY "avatars_update_own" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text);

-- Read: public (avatars appear in shared contexts like daftar-nama)
CREATE POLICY "avatars_read_public" ON storage.objects
  FOR SELECT USING (bucket_id = 'avatars');

-- Delete: user can delete their own; service_role can delete any
CREATE POLICY "avatars_delete_own" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text);
```

**Client usage:**
```javascript
// Upload
const { data, error } = await supabase.storage
  .from('avatars')
  .upload(`${user.id}/avatar-${Date.now()}.jpg`, compressedFile, {
    contentType: 'image/jpeg',
    upsert: false,
  });

// Get public URL
const { data: { publicUrl } } = supabase.storage
  .from('avatars')
  .getPublicUrl(data.path);

// Update users.avatar_url
await supabase.from('users').update({ avatar_url: publicUrl }).eq('id', user.id);
```

---

### 3.2 Backblaze B2 — `albedu-assets-systems` bucket

**Purpose:** Assessment question image storage (soal illustrations, diagrams, etc.).

**Configuration:**
- Bucket name: `albedu-assets-systems`
- Private: Yes (served only via Cloudflare Worker cache proxy, not directly)
- Versioning: Disabled (we use hash-based dedup, no need for versions)
- Lifecycle: None (GC handled by Supabase Edge Function)

**Path convention:** `{hash[0:2]}/{hash}.{ext}`
- 2-char hex prefix = 256 folders per bucket (optimal for S3 list performance)
- Hash = SHA-256 of file content (64 hex chars)
- Extension preserved from upload (`.jpg`, `.png`, `.webp`)

**Access pattern:**
- Write: Supabase Edge Function `asset-upload` (using B2 application key, S3 API)
- Read: Cloudflare Worker `/img/{hash}` (which fetches from B2 on cache miss)
- Delete: Supabase Edge Function `asset-gc` (using B2 application key)

**Cost model:**
| Resource | Free Tier | After Free | AlbEdu Mid Scale Est. |
|---|---|---|---|
| Storage | 10 GB | $0.006/GB/month | 150 GB = $0.84/mo |
| Class A (upload) | 2,500/day | $0.004 per 10K | <500/day = $0 |
| Class B (download) | 2,500/day | $0.004 per 1K | <100/day (Worker cache) = $0 |
| Egress | Unlimited via CF | $0.01/GB direct | $0 (Bandwidth Alliance) |
| **Total** | — | — | **~$0.84/mo** |

---

### 3.3 Supabase Edge Function — `asset-upload`

**Purpose:** Validate, dedup, and store assessment images to B2.

**Endpoint:** `POST /functions/v1/asset-upload`

**Auth:** Requires `Authorization: Bearer {JWT}` where JWT has `role = 'admin'`.

**Request:**
```http
POST /functions/v1/asset-upload
Authorization: Bearer eyJ...
Content-Type: multipart/form-data; boundary=...

------boundary
Content-Disposition: form-data; name="file"; filename="soal-1.jpg"
Content-Type: image/jpeg

<binary data>
------boundary--
```

**Flow:**
1. Verify JWT + role=admin (via `requireAdmin` shared helper)
2. Rate limit: 20 uploads/minute per admin (using `rate_limit_*` table)
3. Validate multipart: file present, size ≤ 5 MB, MIME in allowlist
4. Compute SHA-256 hash of file bytes
5. Query `assets_manifest WHERE hash = {hash}`:
   - If exists: PATCH `ref_count = ref_count + 1, pending_delete = false, last_seen = now()`, return existing `cdn_url`
   - If new: continue to step 6
6. Upload to B2 via S3 API:
   - Path: `{hash[0:2]}/{hash}.{ext}`
   - Headers: `Authorization: AWS4-HMAC-SHA256 ...` (S3 signature)
7. INSERT into `assets_manifest`:
   ```sql
   INSERT INTO assets_manifest (hash, repo, path, cdn_url, ref_count, pending_delete, storage_backend, created_at, last_seen)
   VALUES ({hash}, 'b2', '{path}', '{worker-img-url}', 1, false, 'b2', now(), now())
   ```
8. Log to `audit_logs` (action: `ASSET_UPLOAD`, target_id: hash, metadata: {admin_id, size, mime})
9. Return:
   ```json
   { "hash": "...", "cdn_url": "https://edu.albyte-inc.workers.dev/img/..." }
   ```

**Error responses:**
- 401 Unauthorized — invalid JWT
- 403 Forbidden — not admin role
- 413 Payload Too Large — file > 5 MB
- 415 Unsupported Media Type — MIME not in allowlist
- 429 Too Many Requests — rate limit exceeded
- 502 Bad Gateway — B2 upload failed

---

### 3.4 Supabase Edge Function — `asset-release`

**Purpose:** Decrement ref_count when an image is no longer referenced (e.g., soal deleted, section removed, wizard canceled).

**Endpoint:** `POST /functions/v1/asset-release`

**Auth:** Service role only (called from Edge Functions, not directly from client).

**Request:**
```json
{ "hashes": ["abc123...", "def456..."] }
```

**Flow:**
1. Verify service role key
2. For each hash:
   - UPDATE `assets_manifest SET ref_count = GREATEST(0, ref_count - 1), last_seen = now() WHERE hash = {hash}`
   - If new ref_count == 0: `pending_delete = true`
3. Log to `audit_logs` (action: `ASSET_RELEASE`, metadata: {count, hashes})
4. Return: `{ "released": N, "pending_delete": M }`

**Client-side wrapper:** `src/utils/image-cleanup.js` `ImageCleanup.deleteImages(entries)` calls this endpoint.

---

### 3.5 Supabase Edge Function — `asset-gc`

**Purpose:** Permanently delete orphaned assets (ref_count=0, pending_delete=true, last_seen >7 days).

**Trigger:** pg_cron daily at 03:00 UTC.

**Flow:**
1. Query: `SELECT * FROM assets_manifest WHERE pending_delete = true AND ref_count = 0 AND last_seen < now() - INTERVAL '7 days' LIMIT 100`
2. For each asset (parallel via `Promise.allSettled`):
   - Re-verify (race guard): re-fetch row, confirm still pending
   - Delete from B2 via S3 API
   - If B2 delete succeeds: DELETE from `assets_manifest`
   - If B2 delete fails: increment `gc_fail_count`, log warning
3. Log summary to `audit_logs` (action: `ASSET_GC_RUN`, metadata: {scanned, deleted, failed, skipped})
4. Return summary

**DRY_RUN support:**
- Accept `{ "dry_run": true }` in body
- Log what would be deleted, skip actual deletes
- Useful for manual verification before scheduled run

---

### 3.6 Cloudflare Worker — `/img/{hash}` cache proxy

**Purpose:** Serve images from Cloudflare edge cache, reducing B2 Class B transactions to near-zero.

**Endpoint:** `GET /img/{hash}`

**Flow:**
1. Parse `{hash}` from URL (64 hex chars expected)
2. Validate hash format (regex `^[a-f0-9]{64}$`) — reject invalid (400 Bad Request)
3. Check Cloudflare cache (key: `img-{hash}`)
   - **HIT:** Return cached bytes (1ms TTFB, 0 B2 calls)
   - **MISS:** Continue to step 4
4. Query `assets_manifest WHERE hash = {hash}` to get `storage_backend`, `repo`, `path`
   - If not found: 404 Not Found (with placeholder image bytes)
   - If found: continue
5. Fetch origin based on `storage_backend`:
   - `'b2'`: fetch from B2 via S3 API (signed URL)
   - `'github'` (legacy): fetch from `raw.githubusercontent.com/{owner}/{repo}/main/{path}`
   - `'supabase'` (future): fetch from Supabase Storage
6. Set response headers:
   - `Content-Type: image/{ext}`
   - `Cache-Control: public, max-age=86400` (24h edge cache)
   - `ETag: "{hash}"` (enables 304 Not Modified on subsequent requests)
   - `X-Cache: HIT` or `X-Cache: MISS` (debugging)
7. Store in Cloudflare cache (key: `img-{hash}`, TTL: 24h)
8. Return image bytes

**Cache invalidation:**
- Automatic: 24h TTL
- Manual (future): `POST /img/{hash}/purge` (admin-only, purges single hash)

**Cost model:**
- Cloudflare Worker free tier: 100K requests/day
- Cache hit ratio target: >95% (after warm-up period)
- B2 Class B transactions saved: ~99% reduction vs direct B2 access

---

### 3.7 `assets_manifest` table (final schema)

```sql
CREATE TABLE IF NOT EXISTS public.assets_manifest (
  hash              TEXT PRIMARY KEY,
  repo              TEXT NOT NULL,           -- 'b2' (after migration) or 'assets-N' (legacy)
  path              TEXT NOT NULL,           -- '{hash[0:2]}/{hash}.{ext}' for B2
  cdn_url           TEXT NOT NULL,           -- 'https://edu.albyte-inc.workers.dev/img/{hash}'
  ref_count         INTEGER NOT NULL DEFAULT 1 CHECK (ref_count >= 0),
  pending_delete    BOOLEAN NOT NULL DEFAULT false,
  storage_backend   TEXT NOT NULL DEFAULT 'b2' CHECK (storage_backend IN ('b2', 'github', 'supabase')),
  gc_fail_count     INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen         TIMESTAMPTZ NOT NULL DEFAULT now(),
  migrated_at       TIMESTAMPTZ              -- null until migrated from github to b2
);

-- Partial index for GC query (only pending_delete=true rows)
CREATE INDEX IF NOT EXISTS idx_gc_eligible
  ON public.assets_manifest (last_seen)
  WHERE pending_delete = true;

-- Index for storage_backend filtering (during migration)
CREATE INDEX IF NOT EXISTS idx_storage_backend
  ON public.assets_manifest (storage_backend)
  WHERE storage_backend != 'b2';

-- RLS: service_role only (Worker uses service_role key)
ALTER TABLE public.assets_manifest ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role only" ON public.assets_manifest;
CREATE POLICY "service_role only" ON public.assets_manifest
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
```

---

### 3.8 Magic Compress™ v2 — `src/utils/image-compress.js` + `image-compress-worker.js`

**Purpose:** Perceptual image compression. Not "quality = 80" but "human eye barely sees the difference." Uses complexity analysis + adaptive quality + SSIM to find the smallest JPEG that still looks good.

**Design philosophy:** Every image is unique. A solid-color logo compresses perfectly at q60. A detailed photograph needs q85+. Magic Compress™ analyzes each image and adapts.

#### Pipeline (9 stages)

```
Input (any format, ≤10 MB)
  │
  ▼
1. DECODE → ImageBitmap (createImageBitmap)
  │
  ▼
2. SMART RESIZE → fit to max 1920×1080, no upscale
  │
  ▼
3. COMPLEXITY ANALYSIS (via ImageData, O(n))
   • Shannon Entropy (per-channel, averaged) — information density
   • Edge Density (Sobel filter) — high-frequency detail
   • Noise Estimate (Laplacian variance) — sensor noise
   • Color Variance — color diversity
   → Complexity Score (0-100) → Tier → Initial Quality
  │
  ▼
4. SMART DENOISE (conditional Gaussian 3×3)
   Only if noise > 0.3; intensity scales with noise level
  │
  ▼
5. ADAPTIVE SHARPEN (unsharp mask)
   Intensity: low complexity → 0.3, medium → 0.4, high → 0.5
  │
  ▼
6. MOZJPEG ENCODE (WASM via @jsquash/jpeg)
   • Progressive JPEG
   • Optimized Huffman table
   • Trellis quantization (MozJPEG default)
   • Chroma subsampling 4:2:0
   Fallback: Canvas toBlob (if WASM fails to load)
  │
  ▼
7. BINARY SEARCH QUALITY (target 80-300 KB)
   Range: [q35, initial quality], 6 steps, converges to ±0.01
  │
  ▼
8. RESOLUTION FALLBACK (if quality floor hit)
   1920×1080 → 1700×956 → 1500×844 → 1280×720
   If 1280×720 at q35 still > 300 KB: accept best effort
  │
  ▼
9. SSIM CHECK (structural similarity)
   Compute SSIM between pre-encode ImageData and decoded JPEG
   • > 0.95: excellent — try smaller size
   • 0.85-0.95: good — accept
   • 0.75-0.85: fair — warn user
   • < 0.75: poor — strong warning
  │
  ▼
Output: { blob, width, height, originalSize, compressedSize,
          qualityUsed, compressionRatio, complexity, ssim, ssimTier, mozjpeg }
```

#### Complexity Score → Quality Mapping

| Score | Tier | Initial Quality | Rationale |
|---|---|---|---|
| 0-33 | Low | q72 | Simple images (logos, diagrams, text) compress well at lower quality |
| 34-66 | Medium | q82 | Balanced — photographs with moderate detail |
| 67-100 | High | q90 | Complex images (detailed photos, noise-heavy) need higher quality |

Score formula (weighted sum, normalized 0-100):
```
score = (entropy × 0.30 + edgeDensity × 0.30 + noise × 0.20 + colorVariance × 0.20) × 100
```

#### Quality Algorithm (binary search)

User spec: start at q90, decrement by 5, then 3, etc. until 80KB ≤ size ≤ 300KB.

Implementation: binary search (more efficient — converges in 6 steps vs ~15 for linear):
```
lo = 0.35 (quality floor)
hi = initialQuality (0.72 / 0.82 / 0.90)

for 6 iterations:
  mid = (lo + hi) / 2
  result = encode(imageData, mid)
  if result.size ≤ 300 KB:
    lo = mid  (try higher quality)
  else:
    hi = mid  (try lower quality)

return best result that fit
```

If even q35 produces > 300 KB, reduce resolution and repeat.

#### MozJPEG vs Canvas Fallback

| Feature | MozJPEG (WASM) | Canvas (fallback) |
|---|---|---|
| Progressive JPEG | ✅ | ❌ |
| Optimized Huffman | ✅ | ❌ |
| Trellis quantization | ✅ | ❌ |
| File size at same quality | 10-30% smaller | baseline |
| Load time | ~200KB WASM (one-time) | 0 |
| Browser support | All modern (WASM) | All |

Magic Compress™ tries MozJPEG first (loaded async from `esm.sh/@jsquash/jpeg@1.3.0`). If the CDN is blocked or WASM unsupported, it falls back to Canvas automatically. The `result.mozjpeg` flag tells the caller which encoder was used.

#### SSIM (Structural Similarity Index)

Computes global SSIM on the luminance channel between the pre-encode ImageData and the decoded JPEG.

Formula:
```
SSIM = ((2·μx·μy + C1)·(2·σxy + C2)) / ((μx² + μy² + C1)·(σx² + σy² + C2))
```

Where:
- μx, μy = means of x and y
- σx², σy² = variances
- σxy = covariance
- C1 = (0.01·255)², C2 = (0.03·255)² (stabilization constants)

**NOTE:** This is global SSIM (no 11×11 sliding window) for performance. Windowed SSIM would be ~10x slower with marginal accuracy gain.

#### Web Worker Integration

Compression of 10 MB images takes 2-4 seconds. To avoid blocking the UI, use the Web Worker wrapper:

```javascript
// Main thread
const worker = new Worker('src/utils/image-compress-worker.js');

worker.onmessage = (e) => {
  if (e.data.type === 'progress') {
    updateProgressBar(e.data.progress, e.data.stage);
  } else if (e.data.type === 'result') {
    if (e.data.success) {
      const { blob, compressedSize, ssim, complexity } = e.data.result;
      // Use the compressed blob
    } else {
      showError(e.data.error);
    }
  }
};

worker.postMessage({
  type: 'compress',
  file: selectedFile,
  options: { targetMaxBytes: 300 * 1024 }
});
```

The worker loads `image-compress.js` via `importScripts`, runs Magic Compress™ off the main thread, and posts the result back with progress updates.

#### Storage Impact with Magic Compress™ v2

Every image lands in the 80-300 KB sweet spot (avg ~150 KB):

| Scale | Images/Year | Storage/Year | B2 Free Tier Runway |
|---|---|---|---|
| Early Access (50 siswa) | 750 | ~110 MB | **90+ years** |
| Small (10-50 sekolah) | 7,500 | ~1.1 GB | **9+ years** |
| Mid (100-500 sekolah) | 75,000 | ~11 GB | ~11 months (then ~$1/mo) |
| Large (1000+ sekolah) | 150,000 | ~22 GB | ~5 months (then ~$2/mo) |

**Without Magic Compress™** (raw uploads, avg 2 MB/image): Mid scale = 150 GB/year = exceeds 10 GB in 24 days.

**Magic Compress™ v2 vs v1:** v2 adds complexity analysis (adaptive initial quality) + smart denoise + adaptive sharpen + MozJPEG WASM + SSIM. Result: 15-25% smaller files at the same visual quality compared to v1 (fixed q0.85 binary search).

#### Client API

```javascript
// Simple usage (main thread)
const result = await ImageCompress.magicCompress(file);
console.log(result.originalSize);     // 10_485_760 (10 MB)
console.log(result.compressedSize);   // 287_000 (287 KB)
console.log(result.compressionRatio); // 0.973 (97.3% smaller)
console.log(result.qualityUsed);      // 0.72
console.log(result.complexity.score); // 45
console.log(result.complexity.tier);  // 'medium'
console.log(result.ssim);             // 0.92
console.log(result.ssimTier);         // 'good'
console.log(result.mozjpeg);          // true (WASM encoder used)
console.log(result.width);            // 1280
console.log(result.height);           // 720

// Web Worker usage (non-blocking)
const worker = new Worker('src/utils/image-compress-worker.js');
worker.postMessage({ type: 'compress', file, options: {} });
worker.onmessage = (e) => { /* handle result */ };

// Pre-warm MozJPEG on page load (avoids first-upload delay)
ImageCompress.preload();
```

#### Implementation Files

- `src/utils/image-compress.js` — core pipeline (692 lines, pure functions, no DOM except canvas)
- `src/utils/image-compress-worker.js` — Web Worker wrapper (95 lines, non-blocking compression)

---

## 4. Data Flow Walkthroughs

### 4.1 Admin uploads image to assessment soal

```
1. Admin opens soal-editor-modal, drags image
2. Client: compress image (image-compress.js) → 1280×720 JPEG q80
3. Client: POST /functions/v1/asset-upload (JWT in Authorization header)
4. Supabase: validate JWT, role=admin
5. Supabase: rate limit check (rate_limit_submits)
6. Supabase: compute SHA-256 hash
7. Supabase: SELECT from assets_manifest WHERE hash = {hash}
   → NOT FOUND (new image)
8. Supabase: PUT to B2 at {hash[0:2]}/{hash}.jpg (S3 signed)
9. B2: returns 200 OK
10. Supabase: INSERT into assets_manifest (hash, repo='b2', path, cdn_url, ref_count=1, storage_backend='b2')
11. Supabase: INSERT into audit_logs (action='ASSET_UPLOAD')
12. Supabase: return { hash, cdn_url } to client
13. Client: store { url: cdn_url, hash } in soal.media.gambar[]
14. Client: render preview thumbnail
```

### 4.2 Peserta views assessment with images

```
1. Peserta opens take-assessment.html
2. Client: fetch assessment data (sections[].questions[].media.gambar[])
3. Client: for each image, render <img src="https://edu.albyte-inc.workers.dev/img/{hash}">
4. Browser: GET https://edu.albyte-inc.workers.dev/img/{hash}
5. Worker: parse hash, check Cloudflare cache
   → HIT: return cached bytes (1ms)
   → MISS: query assets_manifest, fetch from B2, cache 24h, return
6. Browser: render image
```

### 4.3 Admin deletes a soal with images

```
1. Admin clicks delete on soal-card
2. Client: confirm dialog
3. Client: for each image in soal.media.gambar[]:
   - Call ImageCleanup.deleteImage({ url, hash })
4. ImageCleanup: POST /functions/v1/asset-release { hashes: [...] }
5. Supabase: for each hash, ref_count -= 1 (clamped to 0)
6. Supabase: if ref_count == 0, set pending_delete = true
7. Supabase: log to audit_logs (action='ASSET_RELEASE')
8. Client: remove soal from sections array
9. Client: save assessment (PUT /functions/v1/assessment-lifecycle)
```

### 4.4 GC cron runs daily

```
1. pg_cron triggers POST /functions/v1/asset-gc at 03:00 UTC
2. Supabase: SELECT assets_manifest WHERE pending_delete=true AND ref_count=0 AND last_seen < now()-7d LIMIT 100
3. Supabase: for each asset (parallel):
   a. Re-verify (race guard)
   b. DELETE from B2 (S3 API)
   c. If success: DELETE from assets_manifest
   d. If fail: increment gc_fail_count
4. Supabase: INSERT into audit_logs (action='ASSET_GC_RUN', metadata={scanned, deleted, failed})
5. Return summary
```

### 4.5 User requests data deletion (DSR)

```
1. User submits DSR form (delete my data)
2. Supabase: INSERT into data_subject_requests
3. Admin approves DSR
4. Supabase: dsr-handler Edge Function runs:
   a. Delete user's avatar from Supabase Storage (avatars bucket)
   b. Soft-delete user row (set deleted_at = now())
   c. Anonymize audit_logs entries for this user (per UU PDP)
   d. Log to audit_logs (action='DSR_COMPLETED')
5. User data is now gone from:
   - users table (soft-deleted)
   - avatars bucket (deleted)
   - audit_logs (anonymized)
6. User data remains in (per UU PDP retention):
   - submissions (academic record, 7 years)
   - assessment_sessions (anonymized after 90 days)
```

---

## 5. Security Model

### 5.1 Authentication layers

| Layer | Auth Method | Scope |
|---|---|---|
| Client → Supabase Edge Function | User JWT (Supabase Auth) | Per-user, role-checked |
| Supabase Edge Function → B2 | B2 application key (S3 signature) | Bucket-scoped |
| Supabase Edge Function → Supabase DB | Service role key | Bypasses RLS |
| Cloudflare Worker → Supabase DB | Service role key (anon for SELECTs) | Bypasses RLS |
| Cloudflare Worker → B2 | B2 application key (S3 signature) | Bucket-scoped |

### 5.2 Authorization matrix

| Action | Peserta | Admin | Service Role |
|---|---|---|---|
| Upload avatar | ✅ Own folder | ✅ Own folder | ✅ Any |
| Upload soal image | ❌ | ✅ | ✅ |
| View avatar | ✅ Public | ✅ Public | ✅ Any |
| View soal image | ✅ Via Worker | ✅ Via Worker | ✅ Direct |
| Delete avatar | ✅ Own | ✅ Own | ✅ Any |
| Delete soal image | ❌ | ❌ (release only) | ✅ (GC only) |
| View assets_manifest | ❌ | ❌ | ✅ Only |
| Run GC | ❌ | ❌ | ✅ Only |

### 5.3 RLS summary

- `assets_manifest`: service_role only (clients never touch this table directly)
- `avatars` bucket: per-user folder (upload/update/delete), public read
- `audit_logs`: service_role only (clients read via Edge Function, not directly)

---

## 6. Reliability & Failure Modes

### 6.1 Failure mode matrix

| Component Fails | User Impact | Mitigation | Recovery |
|---|---|---|---|
| Cloudflare Worker | Images don't load | Worker has 99.99% SLA | Auto-failover within Cloudflare |
| Supabase Edge Function | Upload fails | Client retries with backoff | Cold start <500ms |
| Supabase Postgres | All asset ops fail | Supabase 99.9% SLA | Daily backups, 7-day PITR |
| Backblaze B2 | New uploads fail, existing cached images still serve | Worker cache serves for 24h | B2 99.9% SLA |
| Cloudflare cache miss + B2 down | Image 404s | `onerror` placeholder | Manual B2 status check |

### 6.2 Race condition handling

**Race 1: Upload reinstates pending_delete asset mid-GC**
- Guard: `asset-gc` re-verifies `pending_delete = true AND ref_count = 0` immediately before delete
- Mitigated: `asset-upload` always sets `pending_delete = false` on cache-hit (Phase 0 fix)

**Race 2: Two GC runs overlap**
- Guard: pg_cron `asset-gc` job has `concurrency: 1` (Supabase Edge Function default)
- B2 DELETE is idempotent (404 = success)

**Race 3: B2 delete succeeds, manifest delete fails**
- Guard: Next GC run finds B2 404 (already deleted), proceeds to manifest cleanup
- Idempotent: `DELETE FROM assets_manifest WHERE hash = {hash}` is no-op if row gone

### 6.3 Backup & recovery

| Data | Backup | Retention | RPO |
|---|---|---|---|
| assets_manifest | Supabase automated | 7-day PITR | <24h |
| B2 images | B2 server-side replication | Cross-region | <1h |
| audit_logs | Supabase automated | 365-day retention | <24h |
| avatars (Supabase Storage) | Supabase automated | 7-day PITR | <24h |

**RTO target:** <4 hours (Supabase restore + B2 verification)
**RPO target:** <24 hours (daily backups + PITR)

---

## 7. Migration Strategy (Legacy → New)

### 7.1 Legacy state (v0.818.3)

- Avatar uploads: broken (Worker requires AUTH_TOKEN client doesn't send)
- Soal images: not built (`media.gambar = []`)
- Storage: GitHub repos `assets-1` to `assets-20`
- GC: GitHub Actions weekly cron
- Manifest: manually created, no migration, no RLS, no indexes

### 7.2 New state (v0.823.0)

- Avatar uploads: Supabase Storage (JWT auth)
- Soal images: Backblaze B2 (via Edge Function)
- Storage: B2 + Supabase Storage (avatars)
- GC: Supabase Edge Function + pg_cron daily
- Manifest: migrated, RLS, indexes, CHECK constraints

### 7.3 Coexistence during migration

During Phases 1-5, both legacy and new systems run in parallel:
- `storage_backend` column distinguishes: `'github'` (legacy) vs `'b2'` (new)
- Worker `/img/{hash}` handles both transparently (fetches from appropriate origin)
- GC handles both (deletes from appropriate backend based on `storage_backend`)
- No client-side changes needed during migration

### 7.4 Cutover criteria

Phase 5 (GitHub repos decommission) only starts when ALL of:
- [ ] 100% of `assets_manifest` rows have `storage_backend = 'b2'`
- [ ] 7 consecutive days of zero `gc_fail_count` increments
- [ ] No image-related user reports for 7 days
- [ ] Backup of `assets_manifest` verified restorable in staging

---

## 8. Monitoring & Observability

### 8.1 Metrics collected

| Metric | Source | Frequency | Alert Threshold |
|---|---|---|---|
| Avatar upload success rate | `asset-upload` logs | Real-time | <95% over 1h |
| Soal image upload success rate | `asset-upload` logs | Real-time | <95% over 1h |
| Image load latency (peserta) | Worker analytics | Real-time | p95 >500ms |
| Worker cache hit ratio | Cloudflare analytics | Real-time | <90% over 24h |
| B2 storage usage | B2 API | Daily | >80% of free tier (8 GB) |
| B2 Class B transactions/day | B2 API | Daily | >2000 (80% of free) |
| GC success rate | `asset-gc` logs | Daily | <80% over 7 days |
| Orphan count | `assets_manifest` query | Daily | >100 (investigate) |
| `gc_fail_count >= 3` assets | `assets_manifest` query | Daily | Any (alert per asset) |

### 8.2 Alerting channels

- **Discord webhook** (primary): real-time alerts for critical failures
- **Email** (secondary): daily summary at 08:00 UTC
- **Supabase dashboard** (always): manual inspection

### 8.3 Audit trail

Every asset mutation logged to `audit_logs`:

| Action | Logged By | Metadata |
|---|---|---|
| `ASSET_UPLOAD` | asset-upload EF | {hash, admin_id, size, mime, assessment_id} |
| `ASSET_RELEASE` | asset-release EF | {hash, ref_count_after, released_by} |
| `ASSET_GC_RUN` | asset-gc EF | {scanned, deleted, failed, skipped} |
| `ASSET_MIGRATED` | migrate script | {hash, from_backend, to_backend} |
| `DSR_AVATAR_DELETE` | dsr-handler EF | {user_id, avatar_path} |

Retention: 365 days (existing pg_cron job).

---

## 9. Compliance (UU PDP Indonesia)

| Requirement | Implementation | Status |
|---|---|---|
| Right to access | User can request their data via DSR | ✅ Existing |
| Right to rectification | User can edit profile (avatar, name) | ✅ Existing |
| Right to erasure | DSR deletes avatar + soft-deletes user | ✅ Phase 6 |
| Data portability | DSR can export user data | ✅ Existing |
| Consent management | `consents` table tracks all consents | ✅ Existing |
| Audit trail | `audit_logs` 365-day retention | ✅ Existing |
| IP anonymization | IPs hashed after 90 days | ✅ Existing pg_cron |
| Breach notification | (Manual process, not automated) | ⚠️ Future |

---

## 10. Future Evolution

### 10.1 Triggers for next architecture iteration

| Trigger | Action |
|---|---|
| Storage >50 GB sustained 30 days | Add Filebase IPFS cold archive |
| Storage >500 GB | Add B2 paid tier (still ~$3/month) — no migration needed |
| EU customers with data sovereignty | Enable B2 EU region replication |
| 1000+ schools | Multi-tenant bucket isolation |
| Image AI tagging request | Add `asset_tags` table + ML pipeline |

### 10.2 Technology watch

- **BackBlaze B2 paid tier**: at >10 GB storage, B2 paid is $0.006/GB/month — still absurdly cheap. No vendor migration needed.
- **Storj**: decentralized alternative, $4/TB/month, no CC required. Evaluate only if B2 discontinues service.
- **Cloudflare R2**: ❌ EXCLUDED — requires credit card for free tier activation. Not a viable option for AlbEdu.
- **Supabase Storage v2**: if multi-region becomes available, evaluate for avatars
- **Web3/IPFS**: only if AlbEdu expands into credentialing (NFT certificates)

---

## 11. Glossary

| Term | Definition |
|---|---|
| **B2** | Backblaze B2 Cloud Storage — S3-compatible object storage |
| **Bandwidth Alliance** | Cloudflare-Backblaze partnership — egress from B2 via Cloudflare is free |
| **CDN** | Content Delivery Network — geographically distributed cache |
| **Class A transaction** | B2 term for upload/delete operations (2,500 free/day) |
| **Class B transaction** | B2 term for download operations (2,500 free/day) |
| **DSR** | Data Subject Request — UU PDP user data request |
| **Edge cache** | Cloudflare's globally distributed cache (300+ locations) |
| **EF** | Edge Function (Supabase Deno Deploy) |
| **GC** | Garbage Collector — deletes orphaned assets |
| **Hash** | SHA-256 content fingerprint (64 hex chars) |
| **IPFS** | InterPlanetary File System — decentralized content-addressed storage |
| **JWT** | JSON Web Token — Supabase Auth session token |
| **Manifest** | `assets_manifest` table — source of truth for all assets |
| **pg_cron** | PostgreSQL extension for scheduled SQL jobs |
| **PITR** | Point-in-Time Recovery — Supabase backup feature |
| **Refcount** | `ref_count` column — tracks live references to an asset |
| **RLS** | Row-Level Security — Postgres per-row access control |
| **RTO** | Recovery Time Objective — max acceptable downtime |
| **RPO** | Recovery Point Objective — max acceptable data loss |
| **S3 API** | AWS Simple Storage Service API — de facto object storage standard |
| **SPOF** | Single Point of Failure |
| **Worker** | Cloudflare Worker — serverless edge compute |

---

## 12. GitHub Pages Hosting Considerations

AlbEdu is hosted on **GitHub Pages** at `https://albytehq.github.io/AlbEdu/` (subpath deployment). This section documents how the asset system handles the subpath edge cases.

### 12.1 Path resolution pattern

All asset-system JavaScript uses `window.Auth.getBasePath()` to resolve URLs. This returns:
- **Production:** `/AlbEdu/` (GitHub Pages subpath)
- **Local dev:** `/` (root)

**Web Worker URL resolution:**
```javascript
// ImageCompress.compressInWorker() handles this internally:
const basePath = window.Auth?.getBasePath?.() || '/';
const workerUrl = basePath + 'src/utils/image-compress-worker.js';
const worker = new Worker(workerUrl);
```

**Worker-internal script loading:**
```javascript
// Inside image-compress-worker.js — uses self.location (not page URL)
const workerDir = self.location.href.replace(/\/[^/]+$/, '/');
self.importScripts(workerDir + 'image-compress.js');
```

This is subpath-safe: the worker derives its own directory from its URL, so `importScripts` always finds `image-compress.js` in the same folder.

### 12.2 CORS configuration (already in place)

| Component | CORS Allow-Origin | File |
|---|---|---|
| Cloudflare Worker | `albytehq.github.io` | `cloudflare-worker/worker-v6.js:34` |
| Supabase Edge Functions | `albytehq.github.io` | `supabase/functions/_shared/cors.ts:10` |
| esm.sh (MozJPEG WASM) | `*` (public) | N/A — public CDN |
| BackBlaze B2 | N/A — server-side only | Edge Function uses service role |

### 12.3 Content Security Policy

AlbEdu does **not** set a CSP meta tag in HTML. This means:
- ✅ `import('https://esm.sh/...')` works (no `script-src` restriction)
- ✅ `new Worker(...)` works (no `worker-src` restriction)
- ✅ `fetch('https://edu.albyte-inc.workers.dev/...')` works (no `connect-src` restriction)

If a CSP is added in the future, it must allow:
```
script-src  'self' 'unsafe-inline' https://esm.sh;
worker-src  'self';
connect-src 'self' https://*.supabase.co https://edu.albyte-inc.workers.dev https://esm.sh;
img-src     'self' https://edu.albyte-inc.workers.dev data:;
```

### 12.4 What does NOT work on GitHub Pages

- ❌ **Server-side rendering** — GitHub Pages is static-only. All dynamic logic is client-side JS or via Edge Functions/Worker.
- ❌ **`.htaccess` / nginx config** — no server config. All routing is client-side.
- ❌ **Custom response headers** — can't set `Cache-Control` on static files (GitHub Pages sets its own). The Cloudflare Worker `/img/{hash}` endpoint handles cache headers for images.
- ❌ **Large file serving** — GitHub Pages has a 1 GB per-file limit. Asset images are served from B2 via Worker, not from GitHub Pages. No issue.

---

## References

- **Migration roadmap:** [ROADMAP.md](./ROADMAP.md)
- **Disaster recovery:** [DISASTER-RECOVERY.md](./DISASTER-RECOVERY.md) (Phase 6)
- **Audit reports:** `/home/z/my-project/worklog.md` (ASSETS-A through ASSETS-E)
- **Backblaze B2 docs:** https://www.backblaze.com/cloud-storage/docs
- **Supabase Storage docs:** https://supabase.com/docs/guides/storage
- **Cloudflare Workers docs:** https://developers.cloudflare.com/workers/
- **pg_cron docs:** https://github.com/citusdata/pg_cron
