# Cloudflare Worker — AlbEdu Asset Storage

Worker untuk image upload/delete + cron sweep expired assessments.

## URLs

- **Production:** `https://edu.albyte-inc.workers.dev`

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/supabase-config` | Return Supabase URL + anon key (cached 1 hour) |
| GET | `/api/health` | Uptime monitoring endpoint |
| POST | `/upload` | Image upload (multipart/form-data, max 10MB, JPEG/PNG/WebP) |
| POST | `/release` | Image delete by SHA-256 hash (ref count decrement) |

## Cron Trigger

```
*/15 * * * *  (every 15 minutes)
```

Runs `sweepExpiredAssessments()` — deletes assessments that have been finished for >1 hour (grace period).

## Environment Variables (Cloudflare Dashboard → Settings → Variables)

| Variable | Required | Example |
|---|---|---|
| `GITHUB_TOKEN` | Yes | `ghp_xxxxxxxxxxxx` |
| `GITHUB_USERNAME` | Yes | `DBBYTE` |
| `SUPABASE_URL` | Yes | `https://kzsrerxhhrtsxnpnmqgl.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | `sb_secret_xxxxxxxx` |
| `SUPABASE_ANON_KEY` | Yes | `sb_publishable_xxxxxxxx` |
| `AUTH_TOKEN` | Optional | Custom bearer token for upload/release auth |

## Deploy

### Option A: Cloudflare Dashboard (manual)

1. Copy `worker-v6.js` content
2. Go to Cloudflare Dashboard → Workers → edu.albyte-inc → Edit
3. Paste code → Save and Deploy
4. Verify env vars in Settings → Variables

### Option B: Wrangler CLI

```bash
npm install -g wrangler
wrangler login
cd cloudflare-worker/
wrangler deploy worker-v6.js --name edu --compatibility-date 2024-01-01
```

### Verify deployment

```bash
curl https://edu.albyte-inc.workers.dev/api/health
# Expected: {"status":"ok","version":"6.0.0","timestamp":"...","supabase_configured":true,"github_configured":true}
```

## GitHub Repos (image sharding)

Worker uses 20 GitHub repos for image storage (sharding by hash prefix):
- `DBBYTE/assets-1` through `DBBYTE/assets-20`

CDN URLs: `https://cdn.jsdelivr.net/gh/DBBYTE/assets-{1-20}@main/{folder}/{hash}.{ext}`

**Action required:** Create repos `assets-1` through `assets-20` under `DBBYTE` org. Update `GITHUB_USERNAME` env var to `DBBYTE`.
