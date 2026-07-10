# AlbEdu Incident Response Plan

**Version:** v0.821.0+
**Last Updated:** 2026-07-10
**Audience:** All team members with production access
**Status:** Active

---

## Quick Reference (Print This)

### 🚨 If You Suspect a Security Incident

1. **Don't panic. Don't delete anything.**
2. **Page the on-call** (see contact list below)
3. **Start the incident log** (time, what happened, what you did)
4. **Do NOT rotate keys yet** (wait for on-call decision — preserves forensic evidence)

### Contact List

| Role | Name | Contact | Availability |
|---|---|---|---|
| Primary on-call | _[fill in]_ | _[phone]_ | 24/7 |
| Secondary on-call | _[fill in]_ | _[phone]_ | 24/7 |
| Engineering lead | _[fill in]_ | _[phone]_ | Business hours |
| Supabase support | support@supabase.com | Dashboard → Support | Business hours |

### Severity Levels

| Level | Definition | Response Time | Example |
|---|---|---|---|
| **SEV-1** | Active data breach, system compromise, data loss | <15 min | Peserta escalated to admin, DB dropped, RLS bypassed |
| **SEV-2** | Security vulnerability with active exploitation | <1 hour | XSS being used to steal JWTs, brute-force in progress |
| **SEV-3** | Vulnerability found, no active exploitation | <24 hours | New CVE in dependency, misconfiguration found |
| **SEV-4** | Hardening opportunity, no immediate risk | <1 week | CSP not set, monitoring gap, missing backup test |

---

## Incident Response Phases

### Phase 1: Detect (0-5 minutes)

**Sources of detection:**
- UptimeRobot alert (downtime or error rate spike)
- User report (email, Discord, in-app)
- Cloudflare Workers Analytics (5xx spike)
- Supabase Dashboard (DB connection spike, error logs)
- Manual discovery (developer notices something odd)

**First responder actions:**
1. Acknowledge the alert (don't let it timeout)
2. Open the incident log (create a new file: `incidents/YYYY-MM-DD-incident-N.md`)
3. Determine severity (SEV-1 through SEV-4)
4. If SEV-1 or SEV-2: page on-call immediately

### Phase 2: Assess (5-30 minutes)

**Questions to answer:**
- What is happening? (Describe in 1-2 sentences)
- When did it start? (Check logs, UptimeRobot history)
- What is the scope? (Which users/data/systems affected?)
- Is it still ongoing? (Active attack vs. past event)
- What is the attacker's goal? (Data theft, disruption, escalation?)

**Actions:**
1. Check Cloudflare Workers logs (Dashboard → Workers → Logs)
2. Check Supabase logs (Dashboard → Logs → Postgres/Auth/Storage)
3. Check `audit_logs` table for suspicious activity:
   ```sql
   SELECT * FROM audit_logs
   WHERE created_at > now() - interval '24 hours'
   AND action IN ('DSR_REQUEST', 'ARCHIVE_ASSESSMENT', 'ASSET_RELEASE')
   ORDER BY created_at DESC;
   ```
4. Check auth logs for suspicious logins:
   ```sql
   SELECT * FROM audit_logs
   WHERE action LIKE '%LOGIN%' OR action LIKE '%AUTH%'
   ORDER BY created_at DESC LIMIT 50;
   ```

### Phase 3: Contain (30 min - 2 hours)

**Containment options (choose based on severity):**

#### Option A: Disable compromised account
```sql
-- Soft-delete the compromised user (prevents login)
UPDATE users SET deleted_at = now() WHERE id = '[compromised-user-id]';
-- Revoke all active sessions
-- (Supabase Dashboard → Auth → Users → [user] → Sign out all sessions)
```

#### Option B: Rotate Supabase service role key
1. Supabase Dashboard → Project Settings → API
2. Click "Reset service role key"
3. Update all Edge Functions (Supabase CLI: `supabase secrets set SUPABASE_SERVICE_ROLE_KEY=new_key`)
4. Update Cloudflare Worker env var
5. Redeploy all Edge Functions + Worker

**⚠️ WARNING:** Rotating the service role key invalidates ALL active sessions. Only do this for SEV-1.

#### Option C: Disable Edge Function
```bash
# Temporarily disable an Edge Function by setting verify_jwt=true
# (if it was false) and redeploying
supabase functions deploy [function-name] --no-verify-jwt=false
```

#### Option D: Block IP at Cloudflare
1. Cloudflare Dashboard → Security → WAF
2. Create rule: Block IP `[attacker-ip]`
3. Set duration: 1 hour (review before extending)

#### Option E: Enable Supabase Maintenance Mode
1. Supabase Dashboard → Project Settings → Maintenance
2. Enable maintenance mode (blocks all DB access)
3. Only use for SEV-1 data breach

### Phase 4: Eradicate (2-4 hours)

**After containment, fix the root cause:**

1. Identify the vulnerability (use audit findings, logs, code review)
2. Develop a fix (patch, config change, RLS update)
3. Test the fix in staging (if time permits)
4. Deploy the fix to production
5. Verify the fix works (re-test the attack vector)

### Phase 5: Recover (4-24 hours)

**Restore normal operations:**
1. Remove containment measures (unblock IPs, re-enable functions)
2. Monitor for recurrence (watch logs for 24 hours)
3. Notify affected users (if data was breached)
4. Restore data from backup (if data was lost/corrupted)

### Phase 6: Post-Mortem (1-7 days)

**Within 7 days of incident resolution:**

1. Write a post-mortem document: `incidents/YYYY-MM-DD-incident-N-postmortem.md`
2. Include:
   - Timeline (detect → contain → eradicate → recover)
   - Root cause analysis (what went wrong, why)
   - Impact assessment (users affected, data exposed, downtime)
   - What went well (detection, response, communication)
   - What went wrong (delays, mistakes, gaps)
   - Action items (preventive measures, assignees, deadlines)
3. Review with the team
4. Create issues for action items
5. Update this IR plan with lessons learned

---

## Key Rotation Runbook

### Supabase Service Role Key

**When to rotate:**
- Suspected compromise (SEV-1)
- Quarterly (preventive)
- After personnel change (developer leaves team)

**Steps (estimated time: 30 minutes):**

1. **Generate new key:**
   ```bash
   # Via Supabase CLI
   supabase projects api-keys --project-ref kzsrerxhhrtsxnpnmqgl
   # Or via Dashboard → Project Settings → API → Reset service role key
   ```

2. **Update Supabase Edge Function secrets:**
   ```bash
   cd AlbEdu-main/supabase
   supabase secrets set SUPABASE_SERVICE_ROLE_KEY=[new-key]
   # Redeploy all functions that use service_role:
   supabase functions deploy dsr-handler
   supabase functions deploy register-admin
   supabase functions deploy user-auth-preflight
   supabase functions deploy user-auth-complete
   supabase functions deploy heartbeat
   supabase functions deploy submit-assessment
   supabase functions deploy block-participant
   supabase functions deploy assessment-lifecycle
   supabase functions deploy cleanup-assessment
   supabase functions deploy access-code-attempt
   supabase functions deploy health-check
   supabase functions deploy data-export
   ```

3. **Update Cloudflare Worker:**
   - Cloudflare Dashboard → Workers → edu.albyte-inc → Settings → Variables
   - Update `SUPABASE_SERVICE_ROLE_KEY` (Secret type)
   - Save

4. **Verify:**
   ```bash
   # Test health endpoint
   curl https://edu.albyte-inc.workers.dev/api/health
   # Test an Edge Function
   curl https://kzsrerxhhrtsxnpnmqgl.supabase.co/functions/v1/health-check
   ```

5. **Invalidate old key:**
   - The old key is automatically invalidated when you reset it
   - No additional action needed

### BackBlaze B2 Application Key

**When to rotate:**
- Suspected compromise
- Annually (preventive)

**Steps (estimated time: 15 minutes):**

1. **Create new application key:**
   - BackBlaze Dashboard → App Keys → Add New Application Key
   - Name: `albedu-supabase-edge-v2`
   - Scope: Read and Write on `albedu-assets-systems` bucket only
   - Copy `keyID` and `applicationKey` immediately

2. **Update Supabase Edge Function secrets:**
   ```bash
   supabase secrets set \
     B2_KEY_ID=[new-key-id] \
     B2_APPLICATION_KEY=[new-app-key]
   ```

3. **Update Cloudflare Worker:**
   - Dashboard → Workers → edu.albyte-inc → Settings → Variables
   - Update `B2_KEY_ID` and `B2_APPLICATION_KEY`
   - Save

4. **Delete old application key:**
   - BackBlaze Dashboard → App Keys → [old key] → Delete

5. **Verify:**
   - Test `/img/{hash}` endpoint (should fetch from B2 with new key)

### Cloudflare Worker AUTH_TOKEN (legacy, unused in v7)

Skip — not used in current architecture.

### Supabase Anon Key

**When to rotate:**
- Suspected compromise
- The anon key is public (embedded in client JS), so rotation is less critical

**Steps:**
1. Supabase Dashboard → Project Settings → API → Reset anon key
2. Update Cloudflare Worker env var `SUPABASE_ANON_KEY`
3. Hard refresh all clients (old anon key in cached JS will fail)

---

## Disaster Recovery

### Database Restore (Supabase)

**Scenario:** DB corruption, destructive migration, accidental data deletion

**Steps:**
1. Supabase Dashboard → Database → Backups
2. Select the most recent backup (daily snapshots, 7-day retention)
3. Click "Restore"
4. Wait for restore to complete (5-30 minutes depending on data size)
5. Verify data integrity:
   ```sql
   SELECT COUNT(*) FROM users;
   SELECT COUNT(*) FROM assessments;
   SELECT COUNT(*) FROM submissions;
   ```
6. If PITR is enabled (Pro plan): restore to specific timestamp

**RTO:** 30 minutes
**RPO:** 24 hours (free plan) / 0 (Pro plan with PITR)

### Storage Restore (Avatars Bucket)

**Scenario:** Avatar files deleted or corrupted

**Steps:**
1. Supabase Storage doesn't have native backup on free plan
2. If avatars were also in B2 (Phase 2+): restore from B2
3. If not: avatars are lost — users must re-upload
4. Update `users.avatar_url` to NULL for affected users:
   ```sql
   UPDATE users SET avatar_url = NULL
   WHERE avatar_url LIKE '%missing-file%';
   ```

**RTO:** N/A (users re-upload)
**RPO:** Permanent (no backup on free plan)

### B2 Asset Restore

**Scenario:** B2 bucket deleted, files corrupted

**Steps:**
1. If B2 versioning is enabled (Phase S1): restore previous version
2. If not: files are permanently lost
3. Rebuild `assets_manifest` from B2 bucket listing:
   ```bash
   # List all objects in B2 bucket
   b2 ls --recursive albedu-assets-systems
   # For each object: compute hash, INSERT into assets_manifest
   ```
4. Broken image URLs in assessments: users see placeholder

**RTO:** 4 hours (manual rebuild)
**RPO:** Permanent (no versioning until Phase S1)

---

## Communication Templates

### User Notification (Data Breach)

```
Subject: Pemberitahuan Insiden Keamanan — AlbEdu

Yth. Pengguna AlbEdu,

Pada [tanggal], kami mendeteksi adanya akses tidak sah ke sistem AlbEdu 
yang berpotensi mengakibatkan kebocoran data pribadi Anda.

Data yang berpotensi terpengaruh:
- [daftar data: nama, email, avatar, dll.]

Tindakan yang telah kami ambil:
1. [tindakan kontainment]
2. [tindakan eradikasi]
3. [tindakan pencegahan]

Yang perlu Anda lakukan:
1. Ubah kata sandi AlbEdu Anda di [link]
2. Waspadai email phishing yang menyamar sebagai AlbEdu
3. Hubungi kami di security@albedu.id jika ada pertanyaan

Kami memohon maaf atas insiden ini dan berkomitmen untuk memperkuat 
keamanan sistem kami.

Hormat kami,
Tim AlbEdu
```

### Internal Status Update

```
[INCIDENT-YYYY-MM-DD-N] Status Update #N

Time: [timestamp]
Severity: SEV-[1-4]
Status: [Detected | Contained | Eradicated | Recovered | Closed]

Summary:
[1-2 sentence summary]

Current impact:
- [users affected]
- [downtime]
- [data exposed]

Actions taken:
1. [action]
2. [action]

Next steps:
1. [step]
2. [step]

Owner: [name]
```

---

## Security Hardening Checklist (Post-Incident)

After any SEV-1 or SEV-2 incident, complete this checklist:

- [ ] Root cause identified and documented
- [ ] Fix deployed and verified
- [ ] Similar vulnerabilities audited (check other code paths)
- [ ] Monitoring added for this attack pattern
- [ ] Post-mortem written and reviewed
- [ ] Action items created with assignees and deadlines
- [ ] IR plan updated with lessons learned
- [ ] Team debrief held
- [ ] Users notified (if data was affected)
- [ ] Regulatory notification (if UU PDP applies — within 72 hours of breach discovery)

---

## References

- **Security Roadmap:** `docs/security/SECURITY-ROADMAP.md`
- **UU PDP (Indonesian PDPL):** https://jdih.kominfo.go.id/produk_hukum/view/id/864
- **OWASP Incident Response:** https://owasp.org/www-community/Incident_Response
- **Supabase Status:** https://status.supabase.com/
- **Cloudflare Status:** https://www.cloudflare.com/status/
- **BackBlaze Status:** https://status.backblaze.com/
