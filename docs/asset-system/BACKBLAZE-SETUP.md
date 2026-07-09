# BackBlaze B2 Setup Guide for AlbEdu

**Version:** v0.819.0+
**Audience:** DevOps / Backend engineers
**Prerequisites:** BackBlaze account (free, no credit card required), Supabase project, Cloudflare account, GitHub Pages deployment

---

## Overview

This guide walks you through setting up BackBlaze B2 as the object storage backend for AlbEdu assets. B2 replaces the legacy GitHub repos (`assets-1` to `assets-20`) with a proper S3-compatible storage that has:

- **10 GB free storage** (forever, no credit card)
- **2,500 free downloads/day** (Class B transactions)
- **$0 egress** via Cloudflare Bandwidth Alliance
- **S3-compatible API** (drop-in for existing code)

**Bucket name:** `albedu-assets-systems` (holds all asset types — soal images, future asset categories)

**Time to complete:** 30-45 minutes

---

## ⚠️ GitHub Pages Hosting Notes

AlbEdu is hosted on **GitHub Pages** at `https://albytehq.github.io/AlbEdu/` (subpath, not root). This affects the asset system in several ways:

### What works fine on GitHub Pages
- ✅ **Static JS/CSS files** — served from GitHub Pages CDN, no config needed
- ✅ **Supabase Edge Functions** — called cross-origin via `fetch()`, Supabase handles CORS automatically
- ✅ **Cloudflare Worker** — called cross-origin, Worker has CORS headers (already configured in `worker-v6.js`)
- ✅ **B2 S3 API** — called from Supabase Edge Function (server-side), no browser CORS involvement
- ✅ **createImageBitmap / Canvas** — work on any HTTPS origin (GitHub Pages is HTTPS)

### Edge cases that need attention

1. **Web Worker path resolution** — AlbEdu's Web Worker (`image-compress-worker.js`) must be loaded with the correct subpath. Use `window.Auth.getBasePath()` to resolve:
   ```javascript
   // ✅ Correct — resolves to /AlbEdu/src/utils/image-compress-worker.js
   const basePath = window.Auth?.getBasePath?.() || '/';
   const worker = new Worker(basePath + 'src/utils/image-compress-worker.js');

   // ❌ Wrong — 404 on GitHub Pages (resolves to domain root)
   const worker = new Worker('/src/utils/image-compress-worker.js');
   ```
   **Or use the built-in helper** which handles this automatically:
   ```javascript
   const result = await ImageCompress.compressInWorker(file, { onProgress });
   ```

2. **MozJPEG WASM from esm.sh** — Magic Compress™ v2 loads MozJPEG via `import('https://esm.sh/@jsquash/jpeg@1.3.0/encode.js')`. This works on GitHub Pages because:
   - GitHub Pages does NOT set a Content-Security-Policy header by default
   - esm.sh sends proper `Access-Control-Allow-Origin: *` headers
   - The WASM binary is fetched internally by jsquash with CORS enabled
   - If the WASM load fails (network issue, CDN blocked), Magic Compress™ automatically falls back to Canvas encoder

3. **Worker `importScripts` inside the worker** — the worker loads `image-compress.js` via `importScripts`. It uses `self.location.href` to derive its own directory, which is subpath-safe:
   ```javascript
   // Inside image-compress-worker.js
   const workerDir = self.location.href.replace(/\/[^/]+$/, '/');
   self.importScripts(workerDir + 'image-compress.js');
   // → https://albytehq.github.io/AlbEdu/src/utils/image-compress.js
   ```

4. **Cloudflare Worker CORS** — the Cloudflare Worker (`edu.albyte-inc.workers.dev`) already has `albytehq.github.io` in its `ALLOWED_ORIGINS` list (see `worker-v6.js:34`). No change needed.

5. **Supabase Edge Function CORS** — the `_shared/cors.ts` file already allows `https://albytehq.github.io` (see `supabase/functions/_shared/cors.ts:10`). No change needed.

---

## Step 1: Create BackBlaze Account

1. Go to **https://www.backblaze.com/b2/sign-up.html**
2. Enter your email and create a password
3. Verify your email (click the confirmation link)
4. **No credit card required** — the 10 GB free tier is activated automatically

> ⚠️ **Important:** Do NOT add a payment method yet. The free tier (10 GB storage, 2,500 Class A/B transactions per day) works without any payment info. You only need to add payment if you exceed the free tier.

5. You'll be redirected to the B2 Cloud Storage dashboard at **https://secure.backblaze.com/b2_buckets.htm**

---

## Step 2: Create the Bucket

1. In the B2 dashboard, click **"Create a Bucket"**
2. Configure:
   - **Name:** `albedu-assets-systems` (must be globally unique — if taken, use `albedu-assets-systems-{your-org}`)
   - **Files in Bucket are:** **Private** (not public — images served only via Cloudflare Worker cache proxy)
   - **Bucket Info:** `AlbEdu assessment question images`
   - **Encryption:** **None** (Supabase Edge Function handles encryption at rest via B2 server-side encryption — this is automatic)
3. Click **"Create a Bucket"**

> ✅ **Verify:** The bucket should now appear in your bucket list with "Private" status.

---

## Step 3: Create Application Key

The application key is what Supabase Edge Functions use to upload/delete images in B2.

1. In the B2 dashboard, go to **"App Keys"** (left sidebar)
2. Click **"Add a New Application Key"**
3. Configure:
   - **Name:** `albedu-supabase-edge` (descriptive — this key is used by Supabase Edge Functions)
   - **Allow access to Bucket(s):** Select only `albedu-assets-systems` (scoped — this key cannot touch other buckets)
   - **Type of Access:** **Read and Write** (Edge Functions need to upload AND delete)
   - **File Access Only:** ✅ Yes (no bucket admin operations needed)
4. Click **"Create New Key"**

> ⚠️ **CRITICAL:** The `applicationKey` value is shown **ONLY ONCE**. Copy it immediately to a secure location. You cannot retrieve it later — if lost, you must delete the key and create a new one.

5. You'll see two values:
   - **keyID** (e.g., `0027a4b5e3c84700000000001`) — safe to store in plaintext
   - **applicationKey** (e.g., `K001xJ8aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV3wX4y`) — **SECRET, treat like a password**

---

## Step 4: Store Keys in Supabase Secrets

Supabase Edge Functions access B2 via environment variables (secrets). These are encrypted at rest by Supabase.

### Via Supabase Dashboard

1. Go to **https://supabase.com/dashboard** → select your project
2. **Project Settings** (gear icon) → **Edge Functions**
3. Scroll to **"Edge Function Secrets"**
4. Add these secrets:

| Key | Value |
|---|---|
| `B2_KEY_ID` | `0027a4b5e3c84700000000001` (your keyID from Step 3) |
| `B2_APPLICATION_KEY` | `K001xJ8aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV3wX4y` (your applicationKey from Step 3) |
| `B2_BUCKET_ID` | `a1b2c3d4e5f6` (from bucket URL in B2 dashboard) |
| `B2_BUCKET_NAME` | `albedu-assets-systems` |
| `B2_REGION` | `us-west-002` (shown in bucket details — could be `us-west-001`, `eu-central-003`, etc.) |

5. Click **"Save"** for each secret

### Via Supabase CLI (alternative)

```bash
supabase secrets set \
  B2_KEY_ID=0027a4b5e3c84700000000001 \
  B2_APPLICATION_KEY=K001xJ8aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV3wX4y \
  B2_BUCKET_ID=a1b2c3d4e5f6 \
  B2_BUCKET_NAME=albedu-assets-systems \
  B2_REGION=us-west-002
```

> ✅ **Verify:** Go back to Edge Functions secrets page — all 5 keys should be listed (values hidden).

---

## Step 5: Verify Free Egress (Automatic — No Setup Needed)

> 🎉 **GOOD NEWS (verified July 2026):** Cloudflare Bandwidth Alliance is **automatic** for BackBlaze B2. There is no wizard or "Connect" button to click. Egress from B2 → Cloudflare is automatically free as long as both accounts exist.
>
> Source: Backblaze official docs (https://www.backblaze.com/docs/cloud-storage-cloudflare-integrations) and Cloudflare Bandwidth Alliance page (https://www.cloudflare.com/bandwidth-alliance).

### How it works (no action required from you)

1. **AlbEdu uses a PRIVATE bucket** (`albedu-assets-systems`) — images are NOT publicly accessible.
2. **Cloudflare Worker (Phase 4)** fetches images from B2 using S3 signed URLs.
3. **Worker runs on Cloudflare's edge network** — its source IP is recognized as Cloudflare by BackBlaze.
4. **B2 detects Cloudflare source IP → egress = $0** (Bandwidth Alliance auto-applied).

You don't need to:
- ❌ Find a "Bandwidth Alliance" menu in Cloudflare (it doesn't exist as a clickable wizard)
- ❌ Set up a CNAME record (that's for PUBLIC buckets, not AlbEdu's private bucket)
- ❌ Connect B2 to Cloudflare via any dashboard wizard

### 5.1: Verify Your B2 S3 Endpoint URL (for Phase 4 Worker)

1. In B2 dashboard → **Buckets** → click `albedu-assets-systems`
2. Look for **"Endpoint"** field — it looks like: `s3.us-west-002.backblazeb2.com`
3. Note this URL — you'll add it as `B2_ENDPOINT` to Cloudflare Worker secrets in Phase 4

### 5.2: (Optional) Verify Free Egress Works

After Phase 4 (when Worker `/img/{hash}` is deployed), you can verify egress is free:

1. Upload a test image via Edge Function (Phase 2)
2. Wait 24 hours
3. Check B2 dashboard → **Account → Usage & Payments**
4. **"Bandwidth Out"** should show usage but **"Cost"** = $0.00

If you see charges here, contact BackBlaze support — the Bandwidth Alliance should apply automatically.

### 5.3: When You WOULD Need a CNAME (Not AlbEdu's Case)

A CNAME setup is only needed if you want to **directly serve B2 content via Cloudflare CDN WITHOUT a Worker** — but that requires a **PUBLIC** bucket (anyone with the URL can view images). AlbEdu uses a private bucket + Worker proxy for security, so CNAME is NOT applicable.

For reference, the CNAME approach (NOT for AlbEdu):
1. Set bucket to **Public** in B2 dashboard
2. In Cloudflare DNS, add a CNAME record:
   - **Type:** `CNAME`
   - **Name:** `b2-assets` (creates `b2-assets.albedu.id`)
   - **Target:** `s3.us-west-002.backblazeb2.com`
   - **Proxy status:** Proxied (orange cloud)
3. Add a Cloudflare Transform Rule to rewrite the URL path to include the bucket name
4. Images accessible at `https://b2-assets.albedu.id/{path}`

**AlbEdu does NOT do this.** AlbEdu keeps the bucket private and uses the Worker cache proxy (Phase 4) for both security and free egress.

---

## Step 6: Update Cloudflare Worker (Phase 4)

The Cloudflare Worker needs a new endpoint `/img/{hash}` that fetches images from B2 via S3 API and caches them at the edge.

### 6.1: Add B2 Secrets to Worker

In Cloudflare Dashboard → Workers → `edu.albyte-inc` → Settings → Variables:

| Variable | Value | Type |
|---|---|---|
| `B2_KEY_ID` | (same as Supabase) | Secret |
| `B2_APPLICATION_KEY` | (same as Supabase) | Secret |
| `B2_BUCKET_NAME` | `albedu-assets-systems` | Text |
| `B2_ENDPOINT` | `s3.us-west-002.backblazeb2.com` | Text |

### 6.2: Deploy Worker v7 (Phase 4 deliverable)

The Worker code will be updated in Phase 4 to include the `/img/{hash}` cache proxy endpoint. See `docs/asset-system/ROADMAP.md` Phase 4 for implementation details.

---

## Step 7: Test the Setup

### 7.1: Test B2 connectivity from Supabase Edge Function

Create a temporary test function or run this in Supabase SQL Editor:

```sql
-- Test: Can the service role read the B2 secrets?
SELECT 'B2_KEY_ID' as key, current_setting('app.b2_key_id', true) as is_set
WHERE current_setting('app.b2_key_id', true) IS NOT NULL;
```

> Note: Supabase Edge Function secrets are NOT accessible via SQL — this query is just to verify the pattern. Real testing happens in the Edge Function.

### 7.2: Upload a test image (after Phase 2 implementation)

Once the `asset-upload` Edge Function is deployed (Phase 2):

```bash
# Test upload via curl (replace with real JWT)
curl -X POST \
  https://your-project.supabase.co/functions/v1/asset-upload \
  -H "Authorization: Bearer YOUR_JWT" \
  -F "file=@test-image.jpg"
```

Expected response:
```json
{
  "hash": "a3f1c9...",
  "cdn_url": "https://edu.albyte-inc.workers.dev/img/a3f1c9...",
  "original_size": 10485760,
  "compressed_size": 287000
}
```

### 7.3: Verify in B2 dashboard

1. Go to B2 dashboard → Buckets → `albedu-assets-systems`
2. You should see a file at path `a3/a3f1c9...e4b2.jpg`
3. File size should be 80-300 KB (Magic Compress™ working)

### 7.4: Test image retrieval via Worker (after Phase 4)

```bash
curl -I https://edu.albyte-inc.workers.dev/img/a3f1c9...
```

Expected:
```
HTTP/2 200
content-type: image/jpeg
cache-control: public, max-age=86400
etag: "a3f1c9..."
x-cache: MISS  (first request — fetches from B2)
```

Second request should show `x-cache: HIT` (served from edge cache, no B2 call).

---

## Step 8: Monitor Free Tier Usage

### B2 Dashboard

1. **B2 dashboard → Account → Usage & Payments**
2. Monitor:
   - **Storage:** should stay under 10 GB (free tier)
   - **Class A transactions (uploads/deletes):** should stay under 2,500/day
   - **Class B transactions (downloads):** should stay under 2,500/day (Worker cache keeps this low)
   - **Bandwidth Out:** should be $0 (Bandwidth Alliance)

### Alerting (Phase 6)

After Phase 6, the `asset-alert` Edge Function will automatically alert when:
- B2 storage > 80% of 10 GB (8 GB)
- B2 Class B transactions > 2,000/day (80% of free tier)
- Any asset has `gc_fail_count >= 3`

---

## Cost Projection

| Scale | Storage | Class A/day | Class B/day | Egress | Monthly Cost |
|---|---|---|---|---|---|
| Early Access (50 siswa) | <100 MB | <50 | <100 (Worker cache) | $0 | **$0** |
| Small (10-50 sekolah) | 1-5 GB | <200 | <200 | $0 | **$0** |
| Mid (100-500 sekolah) | 30-150 GB | <500 | <200 | $0 | **~$0.84** (storage only) |
| Large (1000+ sekolah) | 300+ GB | <1000 | <500 | $0 | **~$2-5** |

**With Magic Compress™ v2 (80-300 KB per image):**
- 10 GB free tier lasts **90+ years** at current scale
- 10 GB free tier lasts **9+ years** at small scale (10-50 schools)
- 10 GB free tier lasts **~11 months** at Mid scale (then ~$1/month)

---

## Troubleshooting

### "401 Unauthorized" when Edge Function uploads to B2

- Verify `B2_KEY_ID` and `B2_APPLICATION_KEY` are set correctly in Supabase secrets
- Verify the application key has **Read and Write** access to the `albedu-assets-systems` bucket
- Check that the keyID doesn't have leading/trailing whitespace

### "403 Forbidden" when Worker fetches from B2

- Verify the S3 signature is computed correctly (AWS Signature V4)
- Verify the bucket is set to **Private** (not Public)
- Check that the Worker's B2 secrets match Supabase's B2 secrets

### Bandwidth Alliance not working (egress charges appearing)

- Verify Cloudflare proxy is enabled (orange cloud) on the CNAME record
- Verify the CNAME target is the correct B2 endpoint (e.g., `s3.us-west-002.backblazeb2.com`)
- Check B2 dashboard → Bucket Info → "Bandwidth Alliance" status

### B2 storage growing unexpectedly

- Run: `SELECT COUNT(*), SUM(CASE WHEN pending_delete THEN 1 ELSE 0 END) as pending FROM assets_manifest`
- If `pending` is high, the GC Edge Function (Phase 3) may not be running — check pg_cron
- Verify `asset-gc` Edge Function is deployed and the pg_cron job is scheduled

### MozJPEG WASM fails to load in browser

- Check browser console for CORS errors from `esm.sh`
- Verify CSP (Content Security Policy) allows `script-src` from `esm.sh`
- Magic Compress™ automatically falls back to Canvas encoder (lower quality, no progressive JPEG)

---

## Security Checklist

- [ ] B2 bucket is set to **Private** (not Public)
- [ ] Application key is scoped to only `albedu-assets-systems` bucket
- [ ] `B2_APPLICATION_KEY` is stored as Supabase **Secret** (not Text)
- [ ] `B2_APPLICATION_KEY` is stored as Cloudflare Worker **Secret** (not Text)
- [ ] Application key is NOT committed to git
- [ ] Application key is NOT in any client-side JavaScript
- [ ] Only Supabase Edge Functions and Cloudflare Worker can access B2
- [ ] Bandwidth Alliance is verified connected (free egress)
- [ ] B2 account has 2FA enabled (account settings)

---

## References

- **BackBlaze B2 docs:** https://www.backblaze.com/cloud-storage/docs
- **B2 S3-compatible API:** https://www.backblaze.com/cloud-storage/docs/s3-compatible-api
- **Cloudflare Bandwidth Alliance:** https://www.cloudflare.com/bandwidth-alliance/
- **B2 pricing:** https://www.backblaze.com/cloud-storage/pricing
- **AlbEdu asset system architecture:** [ARCHITECTURE-V2.md](./ARCHITECTURE-V2.md)
- **Migration roadmap:** [ROADMAP.md](./ROADMAP.md)
