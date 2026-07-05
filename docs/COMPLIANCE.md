# COMPLIANCE — UU PDP (Indonesia) Implementation

> AlbEdu v0.746.0 basic compliance with UU No. 27/2022 (Perlindungan Data Pribadi)
> Status: Basic implementation in Phase 1-3. Advanced features defer to Phase 9.

---

## 1. Data Collected

| Data | Source | Purpose | Retention | Legal Basis |
|---|---|---|---|---|
| Email Google | Supabase Auth | Login, identifikasi | Selama akun aktif | Consent (OAuth) |
| Nama | User input (identity form) | Identitas saat assessment | Selama akun aktif | Consent |
| Device fingerprint (device_id, browser_hash) | DeviceFingerprint.js | Anti-fraud, rate limit | 1 tahun | Legitimate interest (anti-cheat) |
| IP address | HTTP headers | Audit log, anti-fraud | 90 hari raw, lalu SHA-256 hash | Legitimate interest |
| User agent | HTTP headers | Audit log, compatibility | 90 hari | Legitimate interest |
| Jawaban assessment | User input (assessment runtime) | Scoring, history | 3 tahun (Q10) | Contract (assessment completion) |
| Violation events | Guardian.js + Edge Functions | Forensic, anti-cheat | 90 hari (Q10) | Legitimate interest (anti-cheat) |
| Heartbeat data (progress, current question) | Heartbeat Edge Function | Proctoring | Auto-purge after assessment selesai | Legitimate interest (proctoring) |
| Audit logs | All admin/peserta actions | Forensic, compliance | 1 tahun (Q10) | Legal obligation |
| Consent records | Consent popup | Proof of consent | Selamanya (immutable history) | Legal obligation |

---

## 2. Basic Compliance Measures (Phase 1-3)

### 2.1 Consent Popup

**When:** Pertama kali peserta login (atau pertama kali input token).

**UI:**
```
┌─ Pemberitahuan Privasi AlbEdu ───────────────┐
│                                                │
│  AlbEdu mengumpulkan data berikut saat Anda    │
│  mengerjakan assessment:                       │
│  • Email Google Anda                           │
│  • Nama yang Anda input                        │
│  • Jawaban Anda                                │
│  • Aktivitas selama ujian (untuk anti-cheat)   │
│  • Alamat IP dan perangkat                     │
│                                                │
│  Data ini digunakan untuk:                     │
│  • Menyimpan dan menilai jawaban Anda          │
│  • Mencegah kecurangan                         │
│  • Audit keamanan                              │
│                                                │
│  Data disimpan sesuai kebijakan retensi.       │
│  Anda bisa request akses/hapus data kapan saja.│
│                                                │
│  [Baca Privacy Policy]  [Setuju]  [Tidak Setuju]│
└────────────────────────────────────────────────┘
```

**Behavior:**
- "Tidak Setuju" → logout, tidak bisa lanjut
- "Setuju" → record ke tabel `consents` (timestamp, IP, user_agent, version)
- Re-consent required saat privacy policy update (version change)

### 2.2 Privacy Policy Page

**File:** `pages/privacy-policy.html`

**Content:**
1. Data yang dikumpulkan (tabel di §1)
2. Untuk apa data dipakai
3. Berapa lama disimpan (retention policy)
4. Hak peserta (akses, hapus, koreksi, portabilitas)
5. Kontak admin/DPO
6. Version-controlled (update jika ada perubahan kebijakan)

### 2.3 Audit Log

**Table:** `audit_logs` (Q9 tier B)

**Events tracked (~25 types):**
- Auth: LOGIN, LOGOUT, LOGIN_FAILED, REGISTER_ADMIN, REGISTER_PESERTA
- Assessment lifecycle: CREATE, PUBLISH, ARCHIVE, DELETE, EDIT, START, PAUSE, RESUME, FINISH
- Session/participant: BLOCK, UNBLOCK, FORCE_SUBMIT, START_SESSION, END_SESSION
- Submission: SUBMIT_ASSESSMENT
- Compliance: CONSENT_GRANTED, CONSENT_REVOKED, DSR_REQUEST, DSR_RESOLVED, DATA_EXPORT, ACCOUNT_DELETE
- Violations: VIOLATION_DETECTED, MAX_VIOLATIONS_REACHED
- System: CONFIG_CHANGE, WORKER_DEPLOY

**Forensics:** IP + user_agent stored for each event. IP anonymized (SHA-256 hash) after 90 days.

### 2.4 Data Retention Policy

**Implementation:** pg_cron jobs (migration `013_pg_cron_retention.sql`)

| Data | Retention | Action | Schedule |
|---|---|---|---|
| registration_attempts | 30 days | DELETE | Daily 03:00 UTC |
| violation_events | 90 days | DELETE | Daily 03:15 UTC |
| audit_logs | 365 days | DELETE | Daily 03:30 UTC |
| assessment_sessions (stale) | 5 min no heartbeat | UPDATE status='disconnected' | Every 1 min |
| assessment_sessions (expired) | ac_end passed | UPDATE status='expired' | Every 1 min |
| IP addresses (raw) | 90 days | UPDATE to SHA-256 hash | Daily 04:00 UTC |
| assessments (old) | 1 year | UPDATE status='archived' | Daily 04:15 UTC |
| submissions | 3 years | (Future: archive to cold storage) | Manual Phase 9 |
| consents | Forever | (Immutable history, no purge) | N/A |

### 2.5 Data Subject Request (DSR) Mechanism

**Table:** `data_subject_requests`

**Request types:**
- `access` — "Saya mau lihat semua data saya"
- `correct` — "Saya mau koreksi data saya"
- `delete` — "Hapus akun saya dan semua data"
- `portability` — "Export data saya dalam format machine-readable"
- `restrict` — "Stop processing my data" (future)

**Flow:**
1. Peserta submit DSR via email to support@albedu.id (no self-service portal yet — see privacy policy Section 15.7)
2. DSR inserted ke `data_subject_requests` dengan status='pending'
3. Admin lihat DSR queue di `profile.html` (DSR requests appear in admin notification panel)
4. Admin review + resolve (status → 'processing' → 'completed' atau 'rejected')
5. Untuk `delete`: soft delete user (set `deleted_at`), 30 hari grace period, lalu hard delete + cascade

### 2.6 Data Export (Self-Service)

**Edge Function:** `data-export`

**Flow:**
1. Peserta click "Download My Data" di profile
2. Edge Function collect:
   - User profile (email, nama, peran, created_at)
   - All submissions (assessment_id, score, answers, submitted_at)
   - All violation_events (last 90 days)
   - All audit_logs (own, last 1 year)
   - All consents
3. Generate JSON
4. Return as download

**Format:**
```json
{
  "exported_at": "2026-07-01T10:00:00Z",
  "user": { "id": "...", "email": "...", "nama": "...", "peran": "..." },
  "submissions": [...],
  "violations": [...],
  "audit_logs": [...],
  "consents": [...]
}
```

---

## 3. Soft Delete for Account Deletion

**Implementation:** `users.deleted_at TIMESTAMPTZ`

**Flow:**
1. Peserta request DSR `delete`
2. Admin approve → `UPDATE users SET deleted_at = now() WHERE id = ?`
3. User immediately logged out (auth-logout event)
4. RLS policies hide soft-deleted users (`WHERE deleted_at IS NULL`)
5. 30 hari grace period (user can cancel deletion via admin)
6. After 30 days: pg_cron job hard-deletes user + cascade (submissions, sessions, violations, audit_logs where actor_id = user)

---

## 4. Advanced Compliance (Deferred to Phase 9)

| Feature | Priority | Complexity |
|---|---|---|
| DPO Dashboard (if >100K records) | Low | Medium |
| Breach notification automation (72-hour alert) | Medium | High |
| Data anonymization pipeline (for analytics) | Medium | Medium |
| GDPR-specific (EU residents) | Low | Medium |
| FERPA (US market) | Low | Low |
| Data residency (region pinning) | Low | High |
| Right to be forgotten (full cascade delete) | Medium | Already implemented (soft delete + 30-day cascade) |

---

## 5. Legal References

- **UU No. 27/2022 (UU PDP)** — Indonesia Personal Data Protection Law
  - Article 5-13: Data subject rights (access, correct, delete, portability)
  - Article 20-22: Consent requirements
  - Article 36: Data retention limits
  - Article 46: Breach notification (72 hours)
- **GDPR** (EU) — General Data Protection Regulation (reference, not strictly required for Indonesia-only)
- **FERPA** (US) — Family Educational Rights and Privacy Act (only if entering US market)

---

## 6. Compliance Checklist

- [x] Consent popup UI (Phase 1 schema, Phase 4 UI)
- [x] Privacy Policy page (Phase 3)
- [x] Audit log table (Phase 1 — `audit_logs`)
- [x] Data retention pg_cron jobs (Phase 1 — migration 013)
- [x] DSR table (Phase 1 — `data_subject_requests`)
- [x] DSR form (Phase 4 — student side)
- [x] DSR admin review UI (Phase 3)
- [x] Data export Edge Function (Phase 2)
- [x] Soft delete for users (Phase 1 — `deleted_at` column)
- [x] IP anonymization after 90 days (Phase 1 — pg_cron job)
- [ ] DPO dashboard (Phase 9)
- [ ] Breach notification automation (Phase 9)
- [ ] Data anonymization pipeline (Phase 9)

---

**Document version:** 1.0.0
**Last updated:** 2026-06-30
**Owner:** Albi Fahriza (albytehq)
