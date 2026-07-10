# AlbEdu Monitoring Setup Guide

**Version:** v0.821.0+
**Status:** Phase S0 deliverable (SEC-D-C1)
**Time to complete:** 15 minutes

---

## Why Monitoring Matters

Without monitoring, active attacks go undetected for hours. The team learns about incidents via user reports — by then, damage is done.

This guide sets up **free** monitoring for 3 critical endpoints:
1. Cloudflare Worker (`/api/health`) — edge cache + config
2. Supabase Edge Function (`health-check`) — database liveness
3. GitHub Pages (landing page) — frontend availability

---

## Step 1: Sign up for UptimeRobot (Free)

1. Go to **https://uptimerobot.com**
2. Click **"Register for FREE"**
3. Enter email + password
4. Verify email (click confirmation link)
5. You now have 50 free monitors (5-minute intervals)

> ✅ No credit card required. Free plan is permanent.

---

## Step 2: Add 3 Monitors

### Monitor 1: Cloudflare Worker Health

| Field | Value |
|---|---|
| Monitor Type | HTTP(s) |
| Friendly Name | `AlbEdu Worker` |
| URL | `https://edu.albyte-inc.workers.dev/api/health` |
| Monitoring Interval | 5 minutes |
| Alert When | Status code is NOT `200` |
| Keyword Monitor | Optional: keyword `"ok"` in response body |

### Monitor 2: Supabase Health Check

| Field | Value |
|---|---|
| Monitor Type | HTTP(s) |
| Friendly Name | `AlbEdu Supabase` |
| URL | `https://kzsrerxhhrtsxnpnmqgl.supabase.co/functions/v1/health-check` |
| Monitoring Interval | 5 minutes |
| Alert When | Status code is NOT `200` |

### Monitor 3: GitHub Pages (Frontend)

| Field | Value |
|---|---|
| Monitor Type | HTTP(s) |
| Friendly Name | `AlbEdu Frontend` |
| URL | `https://albytehq.github.io/AlbEdu/` |
| Monitoring Interval | 5 minutes |
| Alert When | Status code is NOT `200` |

---

## Step 3: Configure Alert Contacts

1. Go to **My Settings → Alert Contacts**
2. Add your email (default)
3. (Optional) Add Slack/Discord webhook for instant alerts:
   - Create a Discord channel `#albedu-alerts`
   - Channel Settings → Integrations → Webhooks → New Webhook
   - Copy webhook URL
   - In UptimeRobot: Add Alert Contact → Webhook → Paste URL
   - Select JSON payload format

---

## Step 4: Set Up REGISTER_WORKER_SECRET (Admin Registration Gate)

The register-admin Edge Function now REQUIRES a secret. Without it, all registrations are rejected.

1. Go to **Supabase Dashboard → Project Settings → Edge Functions → Secrets**
2. Add new secret:
   - **Key:** `REGISTER_WORKER_SECRET`
   - **Value:** Choose a strong secret (32+ characters, alphanumeric)
     - Example: generate one at https://generate.random.org/
     - Or run: `python3 -c "import secrets, string; print(''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(32)))"`
3. Click **Save**
4. Redeploy `register-admin` function (Dashboard → Functions → register-admin → Redeploy)
   - Or via CLI: `supabase functions deploy register-admin`

### How to share the secret with registrants

The secret is the "Kode Registrasi" that users enter on the register-admin page.

- Share via secure channel (Signal, WhatsApp private message, verbal)
- **DO NOT** commit the secret to git
- **DO NOT** put it in any client-side JavaScript
- Rotate quarterly (generate new secret → update Supabase secret → share with new registrants)

---

## Step 5: Enable Supabase Auth CAPTCHA (for Login Turnstile)

The login form now sends a Turnstile token to Supabase Auth. For server-side verification:

1. Go to **Supabase Dashboard → Authentication → Settings**
2. Scroll to **"Bot and Abuse Protection"**
3. Enable **CAPTCHA**
4. Select **Cloudflare Turnstile** as provider
5. Enter your Turnstile site key: `0x4AAAAAADtSMQt5KNMPWBzW`
6. Enter your Turnstile secret key (from Cloudflare Dashboard → Turnstile)
7. Click **Save**

> If CAPTCHA is NOT enabled in Supabase, the Turnstile token is ignored — the login form will still show the widget but it won't be verified server-side. The client-side rate limiting (5 attempts → 15 min lockout) still works as defense-in-depth.

---

## Step 6: Verify Setup

### Test 1: UptimeRobot
```bash
# After 5 minutes, check UptimeRobot dashboard
# All 3 monitors should show "Up" (green)
```

### Test 2: Registration without secret
```bash
curl -X POST https://kzsrerxhhrtsxnpnmqgl.supabase.co/functions/v1/register-admin \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"test12345"}'
# Expected: {"success":false,"error":"Registrasi admin belum diaktifkan..."}
```

### Test 3: Registration with wrong secret
```bash
curl -X POST https://kzsrerxhhrtsxnpnmqgl.supabase.co/functions/v1/register-admin \
  -H "Content-Type: application/json" \
  -H "x-register-secret: wrong-secret" \
  -d '{"email":"test@test.com","password":"test12345"}'
# Expected: {"success":false,"error":"Kode registrasi tidak valid..."}
```

### Test 4: Login form shows Turnstile
```
1. Open https://albytehq.github.io/AlbEdu/pages/login.html
2. The email/password form should show a Turnstile widget
3. Without completing Turnstile, "Masuk" button shows error:
   "Verifikasi keamanan belum selesai. Selesaikan CAPTCHA lalu coba lagi."
```

---

## Monitoring Checklist (Post-Setup)

- [ ] UptimeRobot account created
- [ ] 3 monitors added (Worker, Supabase, Frontend)
- [ ] Alert contact configured (email or webhook)
- [ ] REGISTER_WORKER_SECRET set in Supabase secrets
- [ ] register-admin EF redeployed (to pick up secret)
- [ ] Supabase Auth CAPTCHA enabled (Turnstile)
- [ ] Test: registration without secret → rejected
- [ ] Test: login form shows Turnstile widget
- [ ] Test: 5 failed logins → 15 min lockout

---

## What This Monitors

| Metric | Detection | Alert |
|---|---|---|
| Worker down | UptimeRobot (5 min) | Email/webhook |
| Supabase DB down | UptimeRobot (5 min) | Email/webhook |
| Frontend down | UptimeRobot (5 min) | Email/webhook |
| Unauthorized registration | EF returns 403 | Check Supabase logs |
| Brute-force login | Client-side lockout | Check browser console |
| Turnstile failure | EF returns 401 | Check Supabase logs |

## What This Does NOT Monitor (Phase 6)

- RLS bypass attempts (need audit_logs monitoring — Phase 6)
- B2 storage usage alerts (need asset-alert EF — Phase 6)
- GC failure rate (need asset-gc EF + alerting — Phase 6)
- Real-time error rate (need Cloudflare Workers Analytics alerts — Phase 6)

These are documented in `docs/ROADMAP.md` Phase 6 and will be implemented after Phase 2 (assessment image upload).
