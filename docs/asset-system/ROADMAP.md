# AlbEdu Asset System Roadmap v0.821.0

**Status:** Active — Phase 1 in progress (Phase 0 complete)
**Last Updated:** 2026-07-10
**Owner:** AlbEdu Websoftware Architecture
**Scope:** Migrate asset storage from GitHub repos + Cloudflare Worker → Supabase Storage + Backblaze B2 + repurposed Cloudflare Worker (edge cache)

---

## Executive Summary

AlbEdu's current asset system (GitHub repos `assets-1` to `assets-20` + Cloudflare Worker upload gateway + GitHub Actions GC bot) is **broken in production** and **not enterprise-ready**. Five parallel audits (ASSETS-A through ASSETS-E, see `/home/z/my-project/worklog.md`) revealed:

1. The avatar upload pipeline is non-functional (Worker requires `Authorization: Bearer ${AUTH_TOKEN}` but no client sends it).
2. The image-upload UI for assessment questions was never built (`media.gambar` is hardcoded to `[]` at 4 sites).
3. `ImageCleanup.deleteImage()` and `image-compress.js` are dead code (zero callers).
4. The `assets_manifest` table has no migration, no RLS, no indexes, no CHECK constraints.
5. Documentation lies in 3 places (claims `deleted_at` column, 365-day pg_cron retention, R2 backend — none exist).

This roadmap migrates the asset system to a **3-tier architecture** (Supabase Storage for avatars + Backblaze B2 for assessment images + repurposed Cloudflare Worker as edge cache + config endpoint) over **8 weeks, 7 phases**, at **$0/month for current scale** and **~$1/month at Mid scale (100-500 schools)**.

---

## Target Architecture (v0.823.0)

```
┌──────────────────────────────────────────────────────────────────┐
│                       CLIENT (browser)                           │
│  Avatar editor  │  Soal image editor  │  ImageCleanup helper    │
└───────┬─────────────────┬───────────────────────┬────────────────┘
        │                 │                       │
        ▼                 ▼                       ▼
┌──────────────────────────────────────────────────────────────────┐
│            CLOUDFLARE WORKER (repurposed — v2)                   │
│  • /api/supabase-config  (edge-cached, 1h TTL)                  │
│  • /api/health           (uptime monitor)                       │
│  • /img/{hash}    [NEW]  (B2 cache proxy, 24h TTL, saves Class B│
│                           transactions)                          │
│  No more /upload, /release, sweepExpiredAssessments             │
└───────┬──────────────────────────────────────────────────────────┘
        │ (config endpoint only — uploads bypass Worker)
        ▼
┌──────────────────────────────────────────────────────────────────┐
│             SUPABASE (Postgres + Storage + Edge Functions)       │
│  Edge Functions:                                                 │
│    • asset-upload   (JWT auth, dedup, B2 PUT + Supabase Storage) │
│    • asset-release  (service role, ref_count decrement)          │
│    • asset-gc       (pg_cron daily 03:00 UTC)                    │
│  Storage:                                                        │
│    • avatars bucket (1 GB free, RLS per-user folder)             │
│  Postgres:                                                       │
│    • assets_manifest (with RLS, idx_gc_eligible, CHECK >= 0)     │
│    • audit_logs (asset mutations logged)                         │
│    • pg_cron: asset-gc + existing retention jobs                 │
└───────┬──────────────────────────────────────────────────────────┘
        │ (S3 API)
        ▼
┌──────────────────────────────────────────────────────────────────┐
│             BACKBLAZE B2 (object storage)                        │
│  Bucket: albedu-assets-systems                                      │
│  Path: {hash[0:2]}/{full-hash}.{ext}                             │
│  Storage: 10 GB free + $0.006/GB/month after                     │
│  Egress: $0 (Cloudflare Bandwidth Alliance)                      │
└──────────────────────────────────────────────────────────────────┘
```

### System count: 3 (down from 4)
Removed: GitHub repos (assets-1 to assets-20) + GitHub Actions GC bot
Added: Backblaze B2 + Supabase Edge Functions + Supabase Storage

### Cost projection
| Scale | Storage Need | Monthly Cost | Annual Cost |
|---|---|---|---|
| Early Access (now) | <1 GB | $0 | $0 |
| Small (10-50 schools) | 1-5 GB | $0 | $0 |
| Mid (100-500 schools) | 30-150 GB | ~$1 | ~$12 |
| Large (1000+ schools) | 300+ GB | ~$2-5 | ~$24-60 |

---

## Phased Migration Plan

> ✅ **Phase 0 COMPLETE** — Stabilization done (migration created, race condition fixed, docs corrected, Magic Compress™ v2 implemented). BackBlaze B2 setup complete. Production assets_manifest table now has RLS + indexes + CHECK constraints.

### Phase 1 — Avatar Migration to Supabase Storage (Week 2) — v0.821.0 → v0.821.0

**Goal:** Move avatar uploads from broken Cloudflare Worker `/upload` to Supabase Storage. Fix the P0 production bug.

**Effort:** 4-6 dev-days
**Risk:** Medium (client-facing change to avatar upload — must handle existing base64 avatars in `users.avatar_url`)
**Rollback:** Revert `editor-panel.js`, re-enable Worker `/upload` endpoint (broken but no worse than before)

#### Tasks

1. **Create Supabase Storage bucket `avatars`**
   - Public bucket (avatars are visible to other participants in daftar-nama)
   - Max file size: 2 MB (server-enforced)
   - Allowed MIME types: `image/jpeg`, `image/png`, `image/webp`

2. **RLS policies for `avatars` bucket**
   ```sql
   -- Users can upload to their own folder only
   CREATE POLICY "avatars_upload_own" ON storage.objects
     FOR INSERT TO authenticated
     WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);

   -- Users can update their own avatar
   CREATE POLICY "avatars_update_own" ON storage.objects
     FOR UPDATE TO authenticated
     USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);

   -- Public read (avatars visible to other participants)
   CREATE POLICY "avatars_read_public" ON storage.objects
     FOR SELECT USING (bucket_id = 'avatars');
   ```

3. **Refactor `src/profile/editor-panel.js`**
   - Replace `fetch(${workerBase}/upload, ...)` with `supabase.storage.from('avatars').upload(...)`
   - Path: `{user_id}/avatar-{timestamp}.jpg` (timestamp prevents stale cache)
   - Get public URL: `supabase.storage.from('avatars').getPublicUrl(path)`
   - Update `users.avatar_url` with the public URL (not base64 anymore)
   - Compression: wire up Magic Compress™ v2 (`ImageCompress.compressInWorker()`) — resize to 256×256, JPEG quality 85%

4. **One-time migration script for existing base64 avatars**
   - Scan `users.avatar_url` for `data:image/` prefix
   - For each: decode base64 → upload to Supabase Storage → update `users.avatar_url` to public URL
   - Script: `scripts/migrate-base64-avatars.js` (Node.js, run once via `node scripts/migrate-base64-avatars.js`)
   - Estimated runtime: <5 minutes for ~50 users

5. **Decommission Worker `/upload` endpoint**
   - Comment out the route in `worker.js (legacy, deleted)` (don't delete yet — Phase 4 cleanup)
   - Return 410 Gone with helpful message: "Use Supabase Storage directly. See docs/asset-system/ARCHITECTURE-V2.md"

6. **Update `src/utils/image-cleanup.js`**
   - Add `deleteAvatar(userId)` function that deletes from Supabase Storage
   - Wire into DSR handler (`supabase/functions/dsr-handler/index.ts`) — when user requests deletion, also delete their avatar

#### Deliverables
- New Supabase Storage bucket + 3 RLS policies
- Refactored `src/profile/editor-panel.js`
- Updated `src/utils/image-compress.js` (Magic Compress™ v2 wired to avatar upload)
- New `scripts/migrate-base64-avatars.js`
- Updated `src/utils/image-cleanup.js` (deleteAvatar function)
- Updated `supabase/functions/dsr-handler/index.ts` (cascade avatar delete)
- Worker `/upload` returns 410

#### Acceptance Criteria
- [ ] Admin can upload avatar → appears in profile immediately
- [ ] Peserta can upload avatar → appears in OptionProfile dropdown
- [ ] Avatar upload works without any AUTH_TOKEN (uses Supabase JWT)
- [ ] Existing base64 avatars migrated (script ran, verified count)
- [ ] DSR delete request removes avatar from Storage (not just users table)
- [ ] Worker `/upload` returns 410 Gone

---

### Phase 2 — Assessment Image Upload UI + B2 Setup + Magic Compress (Week 3-4) — v0.821.0 → v0.821.0

**Goal:** Build the missing image-upload UI for assessment questions. Wire to Backblaze B2 via Supabase Edge Function. Implement Magic Compress™ to keep every image in the 80-300 KB sweet spot.

**Effort:** 10-12 dev-days (largest phase — includes compression engine)
**Risk:** High (new UI component + new Edge Function + new storage backend + compression algorithm)
**Rollback:** Disable image upload UI (revert to `media.gambar = []`), B2 bucket can stay (cost $0)

#### Tasks

1. **Set up Backblaze B2 account + bucket**
   - Sign up at backblaze.com (no credit card required)
   - Create bucket `albedu-assets-systems` (private — served via Cloudflare Worker cache proxy)
   - Create application key with read+write scope on this bucket only
   - Note: `keyID` + `applicationKey` → store as Supabase Edge Function secrets

2. **Register Cloudflare Worker with Bandwidth Alliance**
   - In Cloudflare dashboard → Bandwidth Alliance → enable Backblaze B2
   - Verify egress from B2 via Cloudflare = $0

3. **Implement Magic Compress™ in `src/utils/image-compress.js`** ✅ (DONE in Phase 0)
   - Brutal compression: any format → JPEG, 80-300 KB, 720p HD
   - Algorithm: decode → resize to 1280×720 max → encode q0.85 → binary search quality → fallback resize
   - EXIF auto-stripped (canvas redraw = no metadata)
   - Alpha → white background composite (JPEG has no transparency)
   - Never upscales small images
   - 10 MB input → 80-300 KB output in <2 seconds
   - Server-side validation: reject if >500 KB (defense in depth)

4. **Build Supabase Edge Function `asset-upload`**
   - Path: `supabase/functions/asset-upload/index.ts`
   - Auth: requires user JWT (admin role only — peserta cannot upload soal images)
   - Flow:
     1. Verify JWT + role=admin
     2. Receive multipart/form-data (file + metadata)
     3. Validate: max 10 MB input, MIME in [jpeg, png, webp, gif, bmp, avif]
     4. **Server-side size guard: reject if post-compression >500 KB** (client should have compressed; if not, reject with helpful error)
     5. Compute SHA-256 hash
     6. Check `assets_manifest` for existing hash → if found, PATCH ref_count+1, return existing cdn_url
     7. If new: upload to B2 via S3 API (path: `{hash[0:2]}/{hash}.{ext}`)
     8. INSERT into `assets_manifest` (hash, repo='b2', path, cdn_url, ref_count=1, storage_backend='b2')
     9. Return `{ hash, cdn_url, original_size, compressed_size }` to client
   - Rate limit: 20 uploads/minute per admin (using existing `rate_limit_*` table)

5. **Build Supabase Edge Function `asset-release`**
   - Path: `supabase/functions/asset-release/index.ts`
   - Auth: service role only (called from Edge Functions, not client)
   - Flow:
     1. Receive `{ hashes: [...] }` in body
     2. For each hash: decrement ref_count (with `GREATEST(0, ...)` SQL clamp)
     3. If ref_count == 0: set `pending_delete = true, last_seen = now()`
     4. Log to `audit_logs` (action: ASSET_RELEASE)
   - Called from: soal-card.js delete handler, wizard cancel, section delete

6. **Build image-upload UI in `soal-editor-modal.js`**
   - Replace `media.gambar = []` placeholder with actual UI:
     - Drag-and-drop zone (with visual feedback on dragover)
     - File picker button (accept="image/*")
     - Preview thumbnails (with delete X button per image)
     - Upload progress bar (per image)
     - Compression indicator: "10.2 MB → 287 KB (97% smaller)"
   - Compression flow:
     1. User selects file (any format, up to 10 MB)
     2. `ImageCompress.validate(file)` → check size/type
     3. `ImageCompress.magicCompress(file)` → returns compressed blob
     4. Show preview + compression stats to user
     5. On save: upload compressed blob to `asset-upload` Edge Function
   - Store result in `media.gambar = [{ url, hash }]`
   - Validation: max 5 images per question, max 10 MB input each

7. **Wire `ImageCleanup.deleteImage()` (revive dead code)**
   - `src/pages/buat-ujian/soal-card.js`: delete soal → call `ImageCleanup.deleteImage(gambar_entry)` for each image
   - `src/pages/create-assessment.js`: delete section → loop questions → call deleteImage for each
   - `src/pages/buat-ujian/wizard-controller.js`: cancel wizard → loop draft sections → release all images
   - `ImageCleanup.deleteImage` now calls `asset-release` Edge Function instead of Worker `/release`

8. **Update `assets_manifest` schema**
   - Add columns: `storage_backend`, `original_size`, `compressed_size`, `compression_ratio`
   - Migration: `20260711_023_extend_assets_manifest.sql`
   - Tracks compression effectiveness for monitoring

9. **Update `take-assessment/exam.js` image rendering**
   - Currently accepts both string URLs and `{url, hash}` objects
   - Add `<img onerror>` fallback: if image 404s, show placeholder "Gambar tidak tersedia"
   - Log broken image to `audit_logs` for monitoring
   - Add `loading="lazy"` for off-screen images (saves bandwidth)

#### Deliverables
- B2 account + bucket + application key (configured as Supabase secrets)
- New `supabase/functions/asset-upload/index.ts` (with server-side size guard)
- New `supabase/functions/asset-release/index.ts`
- New `supabase/migrations/20260711_023_extend_assets_manifest.sql`
- ✅ `src/utils/image-compress.js` (Magic Compress™ — done in Phase 0)
- Refactored `src/pages/buat-ujian/soal-editor-modal.js` (with image upload UI + compression preview)
- Updated `src/pages/buat-ujian/soal-card.js` (wired to ImageCleanup)
- Updated `src/pages/create-assessment.js` (wired to ImageCleanup)
- Updated `src/pages/buat-ujian/wizard-controller.js` (wired to ImageCleanup)
- Updated `src/utils/image-cleanup.js` (calls asset-release Edge Function)
- Updated `src/pages/take-assessment/exam.js` (onerror fallback + lazy loading)

#### Acceptance Criteria
- [ ] Admin uploads 10 MB JPEG → compressed to 80-300 KB JPEG
- [ ] Admin uploads 5 MB PNG (with transparency) → white background, 80-300 KB JPEG
- [ ] Admin uploads 8 MB WebP → re-encoded to 80-300 KB JPEG
- [ ] Compression indicator shows "X MB → Y KB (Z% smaller)"
- [ ] EXIF data stripped (verified: no GPS in output)
- [ ] Image quality pleasant (no blocky artifacts at normal viewing distance)
- [ ] Resolution ≤ 1280×720 (never upscaled)
- [ ] Server rejects uploads >500 KB post-compression (defense in depth)
- [ ] Admin can attach image to soal via drag-and-drop
- [ ] Image appears in peserta's take-assessment view
- [ ] Deleting soal releases image (ref_count decrements)
- [ ] Canceling wizard releases all uploaded draft images
- [ ] Re-uploading same image returns existing cdn_url (dedup works)
- [ ] B2 bucket contains the uploaded file (verified via B2 dashboard)
- [ ] assets_manifest row has `storage_backend = 'b2'` + compression stats
- [ ] Broken image shows placeholder, logged to audit_logs

#### Magic Compress™ Storage Impact

With Magic Compress™, every image is 80-300 KB (avg ~150 KB):

| Scale | Images/Year | Storage/Year | B2 Free Tier Runway |
|---|---|---|---|
| Early Access (50 siswa) | 750 | ~110 MB | **90+ years** |
| Small (10-50 sekolah) | 7,500 | ~1.1 GB | **9+ years** |
| Mid (100-500 sekolah) | 75,000 | ~11 GB | **~11 months** (then $0.06/GB = ~$1/mo) |
| Large (1000+ sekolah) | 150,000 | ~22 GB | ~5 months (then ~$2/mo) |

**Without Magic Compress™** (raw uploads, avg 2 MB/image): Mid scale = 150 GB/year = exceeds 10 GB in 24 days.
**Magic Compress™ makes the 10 GB free tier last 10x longer.**

---

### Phase 3 — GC Migration to Supabase (Week 5) — v0.821.0 → v0.821.0

**Goal:** Replace GitHub Actions GC bot with Supabase Edge Function + pg_cron. Eliminate dependency on GitHub Actions for asset cleanup.

**Effort:** 4-5 dev-days
**Risk:** Medium (new Edge Function + new pg_cron job; failure mode = orphans accumulate)
**Rollback:** Re-enable GitHub Actions GC bot (still works for GitHub-backed assets)

#### Tasks

1. **Build Supabase Edge Function `asset-gc`**
   - Path: `supabase/functions/asset-gc/index.ts`
   - Trigger: pg_cron daily 03:00 UTC (configured in migration)
   - Flow (mirrors `cleanup.js` logic):
     1. Query `assets_manifest WHERE pending_delete = true AND last_seen < now() - 7 days AND ref_count = 0`
     2. For each: re-verify (race guard) → delete from B2 → delete manifest row
     3. Log summary to `audit_logs` (action: ASSET_GC_RUN with counts)
   - BATCH_SIZE = 100 (higher than GC bot's 50 — Supabase has no GitHub API rate limit concern)
   - Parallel processing with `Promise.allSettled` (B2 S3 API has no rate limit like GitHub)

2. **Implement DRY_RUN support (fixing GC bot's placebo)**
   - Read `DENO_ENV` or function param: if `dry_run=true`, log what would be deleted, skip actual deletes
   - Allow manual trigger via `supabase functions invoke asset-gc --data '{"dry_run":true}'`

3. **Add `gc_fail_count` column to `assets_manifest`**
   - Migration: `20260712_024_add_gc_fail_count.sql`
   - `ALTER TABLE assets_manifest ADD COLUMN gc_fail_count INTEGER NOT NULL DEFAULT 0`
   - Edge Function increments on failure, resets on success
   - Alert (Phase 6) when `gc_fail_count >= 3`

4. **Schedule pg_cron job**
   - Migration: `20260712_025_schedule_asset_gc.sql`
   - ```sql
     SELECT cron.schedule(
       'purge-orphaned-assets',
       '0 3 * * *',
       $$SELECT net.http_post(
         url := '${SUPABASE_URL}/functions/v1/asset-gc',
         headers := jsonb_build_object(
           'Authorization', 'Bearer ${SERVICE_ROLE_KEY}',
           'Content-Type', 'application/json'
         ),
         body := '{}'::jsonb
       )$$
     );
     ```

5. **Decommission GitHub Actions GC bot**
   - Disable the workflow in GitHub (don't delete the repo yet — Phase 5)
   - Update `albedu-gc-bot-main/README.md` with deprecation notice pointing to new Edge Function

#### Deliverables
- New `supabase/functions/asset-gc/index.ts`
- New `supabase/migrations/20260712_024_add_gc_fail_count.sql`
- New `supabase/migrations/20260712_025_schedule_asset_gc.sql`
- Updated `albedu-gc-bot-main/README.md` (deprecated)
- pg_cron job `purge-orphaned-assets` registered (9th pg_cron job, total now 9)

#### Acceptance Criteria
- [ ] Manual trigger `supabase functions invoke asset-gc` runs successfully
- [ ] DRY_RUN mode logs but doesn't delete
- [ ] pg_cron job shows in `SELECT jobname FROM cron.job` (now 9 jobs)
- [ ] Failed asset has `gc_fail_count` incremented
- [ ] GitHub Actions workflow disabled

---

### Phase 4 — Cloudflare Worker Repurpose (Week 6) — v0.821.0 → v0.821.0

**Goal:** Strip upload/release from Worker. Add image cache proxy `/img/{hash}`. Worker becomes edge cache + config + health only.

**Effort:** 3-4 dev-days
**Risk:** Low (additive — new endpoint, decommission old)
**Rollback:** Re-add `/upload` and `/release` (but they're broken anyway)

#### Tasks

1. **Build `/img/{hash}` cache proxy endpoint**
   - Path: `cloudflare-worker/worker.js (legacy, deleted)` (or new `worker.js`)
   - Flow:
     1. Receive `GET /img/{hash}`
     2. Query `assets_manifest` for the hash → get `repo`, `path`, `storage_backend`
     3. If `storage_backend = 'b2'`: fetch from B2 via S3 API
     4. If `storage_backend = 'github'` (legacy): fetch from `raw.githubusercontent.com` (or jsDelivr)
     5. Set `Cache-Control: public, max-age=86400` (24h edge cache)
     6. Set `ETag` from hash (enables 304 Not Modified responses)
     7. Return image bytes
   - Cache key: `{hash}` — same hash = same cache entry globally
   - Cache hit ratio target: >95% (after warm-up)

2. **Decommission `/upload` and `/release` endpoints**
   - Remove route handlers (already returning 410 from Phase 1)
   - Remove helper functions (`handleUpload`, `handleRelease`, `_releaseByHash`, etc.)
   - Remove `sweepExpiredAssessments` cron trigger (replaced by pg_cron)
   - Keep `handleSupabaseConfig` and `handleHealth`

3. **Update Worker README**
   - Document new `/img/{hash}` endpoint
   - Remove upload/release docs
   - Add cache hit ratio monitoring instructions

4. **Update client image rendering**
   - `take-assessment/exam.js`: change image URLs from direct B2/Supabase URLs to `https://edu.albyte-inc.workers.dev/img/{hash}`
   - This routes all image traffic through Cloudflare edge cache
   - For legacy GitHub assets: same `/img/{hash}` endpoint handles them transparently

#### Deliverables
- Updated `cloudflare-worker/worker.js (legacy, deleted)` (or new `worker.js`)
- Updated `cloudflare-worker/README.md`
- Updated `src/pages/take-assessment/exam.js` (image URLs via Worker)

#### Acceptance Criteria
- [ ] `GET /img/{known-hash}` returns image bytes
- [ ] Second request to same hash hits Cloudflare cache (response time <50ms)
- [ ] B2 download count drops dramatically (verified in B2 dashboard)
- [ ] Peserta image loading is faster (edge cache vs direct B2)
- [ ] Worker no longer has `/upload` or `/release` routes

---

### Phase 5 — GitHub Repos Decommission (Week 7) — v0.821.0 → v0.822.0

**Goal:** Migrate remaining GitHub-hosted assets to B2. Decommission 20 GitHub repos. Remove legacy code paths.

**Effort:** 5-7 dev-days
**Risk:** High (data migration — must verify every asset)
**Rollback:** Keep GitHub repos alive for 30 days post-migration as safety net

#### Tasks

1. **Build migration script `scripts/migrate-github-to-b2.js`**
   - For each row in `assets_manifest WHERE storage_backend = 'github'`:
     1. Download file from GitHub (raw.githubusercontent.com)
     2. Upload to B2 (path: `{hash[0:2]}/{hash}.{ext}`)
     3. Verify B2 upload (HEAD request, check size matches)
     4. UPDATE `assets_manifest SET repo = 'b2', path = '{new-path}', storage_backend = 'b2', cdn_url = '{new-url}'`
     5. Log to `audit_logs` (action: ASSET_MIGRATED)
   - Resumable: tracks progress in `assets_manifest.migrated_at` column
   - Batch size: 50 at a time (GitHub API rate limit consideration)
   - Estimated runtime: 2-4 hours for ~1000 assets

2. **Run migration in staging first**
   - Clone production Supabase to staging
   - Run script against staging
   - Verify all assets accessible via `/img/{hash}` (which now serves from B2)
   - Run for 1 week in staging before production

3. **Run migration in production**
   - Schedule maintenance window (low-traffic time)
   - Run script
   - Monitor for errors
   - Verify count: `SELECT storage_backend, COUNT(*) FROM assets_manifest GROUP BY storage_backend` — should be 100% `b2`

4. **Delete 20 GitHub repos**
   - Wait 7 days after migration (safety window)
   - Delete `assets-1` through `assets-20` via GitHub API
   - Revoke GC bot PAT (no longer needed)

5. **Remove legacy code paths**
   - Remove `assets_manifest.repo` column (now always 'b2')
   - Remove `assets_manifest.path` column (derivable from hash)
   - Remove GitHub API helpers from Worker (already done in Phase 4)
   - Remove `albedu-gc-bot-main/` directory (archive in git history)

#### Deliverables
- New `scripts/migrate-github-to-b2.js`
- Migration run in production
- 20 GitHub repos deleted
- Legacy code paths removed

#### Acceptance Criteria
- [ ] `SELECT storage_backend, COUNT(*) FROM assets_manifest GROUP BY storage_backend` returns only `b2`
- [ ] All assessment images still render correctly (spot check 10 random assessments)
- [ ] GitHub repos `assets-1` to `assets-20` are deleted
- [ ] GC bot PAT revoked
- [ ] `albedu-gc-bot-main/` removed from repo

---

### Phase 6 — Monitoring, Alerting & Hardening (Week 8) — v0.822.0 → v0.823.0

**Goal:** Add enterprise-grade monitoring, alerting, and audit trail. Close all gaps from ASSETS-E audit.

**Effort:** 5-6 dev-days
**Risk:** Low (additive monitoring, no behavioral changes)
**Rollback:** Disable monitoring (no user impact)

#### Tasks

1. **Add monitoring dashboard**
   - New page: `pages/admin/asset-monitoring.html`
   - Shows:
     - Total assets in manifest
     - Pending delete count
     - GC success rate (last 7 days)
     - Top 10 failed assets (gc_fail_count >= 3)
     - B2 storage usage
     - Worker cache hit ratio
   - Refreshes every 5 minutes

2. **Add alerting (Discord/Slack webhook)**
   - New Edge Function `asset-alert` (triggered by pg_cron every hour)
   - Alerts on:
     - GC failure rate > 20% in last 24h
     - `gc_fail_count >= 3` for any asset
     - B2 storage > 80% of 10 GB free tier
     - Worker health check fails
   - Webhook URL stored as Supabase secret

3. **Add audit_logs entries for all asset mutations**
   - `asset-upload` Edge Function: log `ASSET_UPLOAD` with hash, admin_id, assessment_id
   - `asset-release` Edge Function: log `ASSET_RELEASE` with hash, ref_count_after
   - `asset-gc` Edge Function: log `ASSET_GC_RUN` with summary counts
   - `asset-migrate` script: log `ASSET_MIGRATED` per asset
   - Existing `audit_logs` retention (365 days via pg_cron) covers this

4. **DSR cascade for avatars**
   - Update `supabase/functions/dsr-handler/index.ts`:
     - On user deletion request: also delete from `avatars` bucket
     - Log to `audit_logs` (action: DSR_AVATAR_DELETE)
   - UU PDP compliance: right to be forgotten now actually works

5. **Add `concurrency` block to remaining GitHub Actions workflows**
   - Even though GC bot is decommissioned, other workflows may exist
   - Prevent overlapping runs

6. **Document disaster recovery procedure**
   - New doc: `docs/asset-system/DISASTER-RECOVERY.md`
   - Covers: B2 outage, Supabase outage, Worker outage, manifest corruption
   - Includes: backup verification, restore procedures, RTO/RPO targets

#### Deliverables
- New `pages/admin/asset-monitoring.html` + `src/pages/asset-monitoring.js`
- New `supabase/functions/asset-alert/index.ts`
- Updated `supabase/functions/asset-upload/index.ts` (audit_logs)
- Updated `supabase/functions/asset-release/index.ts` (audit_logs)
- Updated `supabase/functions/asset-gc/index.ts` (audit_logs)
- Updated `supabase/functions/dsr-handler/index.ts` (avatar cascade)
- New `docs/asset-system/DISASTER-RECOVERY.md`

#### Acceptance Criteria
- [ ] Admin can view asset monitoring dashboard
- [ ] Discord/Slack receives alert when GC fails
- [ ] All asset mutations appear in `audit_logs`
- [ ] DSR delete removes avatar from Storage
- [ ] Disaster recovery doc reviewed by team

---

## Risk Register

| # | Risk | Probability | Impact | Mitigation | Owner |
|---|---|---|---|---|---|
| R1 | B2 outage during assessment | Low | High (peserta can't see images) | Worker cache serves stale for 24h; fallback to placeholder | Phase 4 |
| R2 | Supabase Edge Function cold start latency | Medium | Low (200-500ms first request) | Pre-warm via pg_cron ping every 5 min | Phase 3 |
| R3 | Migration script corrupts manifest | Low | Critical (data loss) | Run in staging 1 week first; backup before production run | Phase 5 |
| R4 | Worker cache serves wrong image (hash collision) | Near-zero | Critical (wrong soal shown) | SHA-256 collision probability = 0; verify ETag matches hash | Phase 4 |
| R5 | B2 free tier exhausted at Mid scale | Medium | Low ($1/month extra cost) | Monitor usage; upgrade to paid tier (still cheap) | Phase 6 |
| R6 | pg_cron job fails silently | Low | Medium (orphans accumulate) | Alert on GC failure rate (Phase 6) | Phase 6 |
| R7 | DSR handler deletes wrong user's avatar | Low | Critical (privacy violation) | Integration test with mock users; RLS double-check | Phase 6 |
| R8 | GitHub repo deletion accidentally removes in-use asset | Low | Critical (broken images) | 7-day safety window post-migration; verify 100% B2 before delete | Phase 5 |

---

## Success Metrics

### Technical KPIs
| Metric | Current (v0.821.0) | Target (v0.823.0) |
|---|---|---|
| Avatar upload success rate | 0% (broken) | 100% |
| Assessment image upload | Not built | <3s per image |
| Image load time (peserta) | ~500ms (jsDelivr) | <100ms (Worker cache) |
| Orphan detection | Impossible | Automated (GC + monitoring) |
| Storage cost/month | $0 (GitHub free) | $0-1 (B2 free + Worker) |
| Systems to maintain | 4 (GitHub+Worker+Supabase+GC bot) | 3 (Worker+Supabase+B2) |
| Documentation accuracy | 3 false claims | 0 false claims |

### Business KPIs
| Metric | Current | Target |
|---|---|---|
| Admin can add image to soal | ❌ No UI | ✅ Drag-and-drop |
| Peserta sees image in assessment | ❌ Never | ✅ <100ms |
| UU PDP right-to-be-forgotten | ❌ Broken | ✅ Working |
| Disaster recovery RTO | Undefined | <4 hours |
| Disaster recovery RPO | Undefined | <24 hours |

---

## Version History

| Version | Phase | Date | Summary |
|---|---|---|---|
| v0.821.0 | (current) | 2026-07-09 | Pre-migration baseline. Asset system broken. |
| v0.821.0 | Phase 0 | 2026-07-10 | Stabilization: migration, RLS, index, doc fixes, race condition fix |
| v0.821.0 | Phase 1 | 2026-07-17 | Avatar migration to Supabase Storage |
| v0.821.0 | Phase 2 | 2026-07-31 | Assessment image upload UI + B2 setup |
| v0.821.0 | Phase 3 | 2026-08-07 | GC migration to Supabase Edge Function + pg_cron |
| v0.821.0 | Phase 4 | 2026-08-14 | Worker repurpose: edge cache + config + health |
| v0.822.0 | Phase 5 | 2026-08-21 | GitHub repos decommission |
| v0.823.0 | Phase 6 | 2026-08-28 | Monitoring, alerting, DR, audit trail |

---

## Post-Roadmap (Future, not scheduled)

Once v0.823.0 is stable, consider these enterprise upgrades:

1. **IPFS cold archive (Filebase)** — when storage exceeds 50 GB, archive cold assets to IPFS for $0.005/GB/month (cheaper than B2). Trigger: storage >50 GB sustained for 30 days.

2. **Multi-region B2 replication** — B2 supports replication to EU region. Trigger: EU customers with data sovereignty requirements.

3. **Image AI tagging** — auto-tag images with subject matter (math, science, etc.) for search. Trigger: asset count >10,000.

4. **CDN purge API** — when admin updates an image, purge Worker cache for that hash. Trigger: edit-image feature request.

5. **Storj migration (NOT R2)** — Cloudflare R2 requires a credit card even for the free tier, so it is permanently excluded from AlbEdu's options. If B2 ever becomes unavailable, alternatives to evaluate are Storj (decentralized, $4/TB/month, no CC required for paid tier) or Wasabi ($6.99/TB/month). Trigger: B2 service discontinuation or pricing model change.

These are NOT in the 8-week roadmap. They're parked for when scale demands them.

---

## References

- **Audit reports:** `/home/z/my-project/worklog.md` (sections ASSETS-A through ASSETS-E, ~2215 lines)
- **Architecture design:** `docs/asset-system/ARCHITECTURE-V2.md`
- **BackBlaze setup guide:** `docs/asset-system/BACKBLAZE-SETUP.md` (step-by-step B2 + Cloudflare Bandwidth Alliance)
- **Disaster recovery:** `docs/asset-system/DISASTER-RECOVERY.md` (Phase 6 deliverable)
- **Current architecture (legacy):** `docs/ARCHITECTURE-FINAL.md` (corrected in Phase 0)
- **Security model:** `docs/SECURITY.md` (corrected in Phase 0)
