# MIGRATION DECISIONS — AlbEdu v1.0.0 Enterprise

> **Single source of truth** for all architectural decisions in v1.0.0 migration.
> Owner: Albi Fahriza (albytehq)
> Date: 2026-06-30
> Status: COMPLETE — ALL 8 PHASES DONE (v0.741.5)

---

## 0. Context

AlbEdu v0.2.0 had these critical issues (from comprehensive audit):

1. **Hasil ujian tidak ter-record di server** — `ExamLogic.submitUjian()` hanya `markSubmitted` ke violations table, tidak menulis skor. `exam.hasil_peserta` JSONB (dibaca admin) tidak diisi oleh kode manapun.
2. **Embedded JSONB anti-pattern** — `hasil_peserta` + `violations` di row `ujian`. Untuk 100 peserta, 1 row = ratusan KB JSONB.
3. **Scoring 100% client-side** — peserta bisa DevTools override `ExamLogic.getHasil()` return 100.
4. **No multi-tenant isolation** — admin A bisa hapus ujian admin B.
5. **No server-side validation access_control** — admin bisa inject field apapun via dot-notation update.
6. **Anti-cheat 100% client-side** — Guardian.js bisa di-disable via DevTools menu.
7. **No audit trail** — siapa start/stop/delete/block? Tidak tercatat.

v1.0.0 is a full enterprise redesign addressing all issues.

---

## 1. Decision Matrix (23 items)

| # | Topic | Decision | Rationale |
|---|---|---|---|
| 1 | Q1 Multi-tenant | **C (Hybrid)**, prioritize Single-Tenant | Schema siap `organization_id` nullable. SCloud organization system = Phase 9 (future). |
| 2 | Q2 Ownership | **B (Collaborative)** | Siswa bisa lihat semua assessment dari admin di sekolah yang sama. Admin bisa SELECT semua, creator yang edit/delete. |
| 3 | Siswa browse | **B** — siswa tetap input token, tidak browse | Status quo, lebih controlled. |
| 4 | Q3 Peserta identity | **Google Only** | Fast access untuk gaptek. Status quo. |
| 5 | Q4 Cross-device | **A (Yes, sync ke server)** | Heartbeat 15s sync jawaban. Survive HP mati / ganti device. |
| 6 | Q5 Scoring | **A (100% server-side)** | Non-negotiable for enterprise. Peserta tidak bisa fake score. |
| 7 | Q6 Esai grading | **Skip dulu** | Field `graded_by` nullable. UI grading Phase 9. |
| 8 | Q7 Realtime | **Hybrid** — critical events realtime, polling untuk lainnya | Optimasi Free Plan (200 concurrent connections limit). |
| 9 | Q8 Rebranding | **A (AlbEdu — Assessment Platform)** | Clear positioning, achievable. |
| 10 | Q9 Audit trail | **B (Standard)** — ~25 event types | Login/logout + create/delete + start/pause/resume/finish + block/unblock + violation + compliance events. |
| 11 | Q10 Data retention | **B** — archive 1 year, submissions 3 years, violations 90 days | Auto-purge via pg_cron. |
| 12 | Q11 Concurrent capacity | **B (200 per assessment, 2000 total)** — wajib Free Plan | Code scalable to 2000+, default config Free-safe. |
| 13 | Q12 Proctoring | **B (event + heartbeat)** + DevTools detection + instant block | Stabil untuk ratusan peserta. |
| 14 | Q13 Theme scope | **A (per-assessment)** — Google Form-like simplicity | 8 quick-pick warna + color picker custom + auto-derive. |
| 15 | Q14 Question bank | **A (per-admin private)** | Phase 7 feature. |
| 16 | Q15 Integration | **None** | Standalone for now. |
| 17 | Q16 Mobile | **Responsive Web + PWA, no native** | Phase 8. |
| 18 | Q17 Compliance | **Basic di Phase 1-3, advanced defer Phase 9** | UU PDP Indonesia: consent popup, privacy policy, audit log, data retention, DSR mechanism, data export. |
| 19 | Q18 Backup | **A (Daily automated)** | Supabase Free built-in. PITR defer to Phase 9 (needs Pro Plan). |
| 20 | Q19 Offline mode | **PWA resilient mode** | Survive koneksi putus 1-5 menit. Not full offline. |
| 21 | Q20 i18n | **Wajib, 5 bahasa** | Indonesia (default), English, Russia, Spanyol, Mandarin. |
| 22 | Table names | **Plural** | Postgres convention. |
| 23 | Access code | **6-digit + Turnstile** | 1,000,000 combinations. Brute-force safe with rate limit + Turnstile. |

---

## 2. Additional Confirmed Decisions

| # | Topic | Decision |
|---|---|---|
| 24 | GitHub username | `albedu-id` → **`albytehq`** (owner renamed) |
| 25 | Worker URL | `https://albedu.examjuniorhighschool.workers.dev` → **`https://edu.albyte-inc.workers.dev`** |
| 26 | Feature toggle "Boleh ulang?" | `allow_retake BOOLEAN DEFAULT FALSE` di assessments table. Default one-shot. |
| 27 | Theme system approach | Google Form-like: 1 primary color + auto-derive (hover/muted). NOT per-field manual picker. |
| 28 | Supabase Free Plan constraints | Max 200 concurrent peserta. Code scalable to 2000+ with Pro Plan upgrade. |
| 29 | Sample data | DB kosong (no production data yet). Migration script (014) is no-op but kept for future use. |

---

## 3. Phase Plan

| Phase | Goal | Duration | Status |
|---|---|---|---|
| 0 | Sign-off & Prep | 1-2 days | ✅ Complete |
| 1 | Schema Migration (15 SQL files) | 4-5 days | 🔄 In Progress |
| 2 | Edge Functions (7 new + 4 refactor) | 5-6 days | Pending |
| 3 | Admin Client Rewrite | 7-8 days | Pending |
| 4 | Student Client Rewrite | 5-6 days | Pending |
| 5 | Anti-Cheat Hardening | 3-4 days | Pending |
| 6 | Theme System Rollout | 2-3 days | Pending (parallel) |
| 7 | Question Bank + Analytics | 5-6 days | Pending (parallel) |
| 8 | PWA + i18n + Testing | 5-6 days | Pending |
| **Total** | | **33-40 days (7-8 weeks)** | |

---

## 4. Critical Architecture Decisions

### 4.1 Server-Side Scoring (Q5)

**Problem:** v0.2.0 scoring 100% client-side via `ExamLogic.getHasil()`. Peserta bisa DevTools override.

**Solution:** `submit-assessment` Edge Function receives answers, re-scores PG server-side:
```typescript
// Pseudo-code
const assessment = await fetchAssessment(access_code);
const sections = assessment.sections;
let correctCount = 0;
for (const section of sections) {
  for (const q of section.questions) {
    if (q.type_question === 'PG') {
      const pesertaAnswer = answers[sectionIdx][q.idq];
      if (pesertaAnswer === q.jawaban_benar) correctCount++;
    }
  }
}
const score = Math.round((correctCount / totalQuestions) * 100);
await insertSubmission({ score, answers, ... });
```

**Security:** Peserta cannot fake score. Even if they modify client-side `getHasil()`, server re-scores independently.

### 4.2 Hybrid Realtime (Q7)

**Problem:** Supabase Free Plan = 200 concurrent realtime connections. Full realtime for 200 peserta = jebol.

**Solution:**
| Event Type | Transport | Why |
|---|---|---|
| Admin block peserta | Realtime | Critical, instant (<500ms) |
| Peserta submit assessment | Realtime | Critical, admin perlu tahu |
| Violation event (cheat) | Realtime | Critical, admin perlu tahu |
| Assessment start/pause/resume | Polling 15s | 15s delay OK |
| Peserta progress (heartbeat) | Polling 15s | 15s delay OK |
| New assessment created | Polling 30s | Not critical |

**Result:** 200 peserta + 5 admin = 5-10 active realtime channels (per assessment per admin). Safe for Free Plan.

### 4.3 Cross-Device Resume (Q4)

**Problem:** v0.2.0 jawaban di localStorage. Ganti device = mulai dari awal.

**Solution:** `draft_answers` JSONB di `assessment_sessions` table. Heartbeat Edge Function sync setiap 15s:
```
Peserta jawab soal 30
  → localStorage draft (instant, survive refresh)
  → debounce 2s → heartbeat Edge Function → update assessment_sessions.draft_answers
  → server now has latest draft

Peserta ganti device, login, input token
  → Edge Function check active session → found
  → return session + draft_answers
  → client restore jawaban dari server
```

### 4.4 Instant Block (Q12)

**Problem:** v0.2.0 block user tidak real-time. Peserta bisa lanjut sampai submit.

**Solution:** Realtime channel `session-{session_id}`:
```
Admin click "Block" di Proctoring Dashboard
  → Edge Function block-participant
  → Update assessment_sessions.status = 'blocked'
  → Broadcast Realtime channel session-{session_id}
  → Peserta's BlockListener receive event (<500ms)
  → UI lock + redirect to "blocked.html" with reason
```

### 4.5 Theme System — Google Form-Like (Q13)

**Problem:** v0.2.0 had 3 manual color pickers (CU/HJ/TW). Owner said "gak super ribet, kayak Google Form".

**Solution:** 1 primary color input → auto-derive everything:
```
Admin picks primary = #2563eb
  → system auto-derive:
    primary_hover = darken 10% = #1d4ed8
    primary_muted = lighten 90% = #eff6ff
    heading = #0f172a (fixed, professional)
    body = #475569 (fixed, readable)
    surface = #ffffff (fixed)
    border = #e2e8f0 (fixed)
  → WCAG AA auto-check (warning if contrast < 4.5:1)
  → live preview
  → save as theme_config JSONB
```

**Total admin clicks:** 3-4 (preset / color / preview / save). 30 seconds.

### 4.6 6-Digit Access Code (§4.5)

**Problem:** v0.2.0 5-digit = 100,000 combinations. Brute-force risk.

**Solution:** 6-digit = 1,000,000 combinations + Turnstile di token entry:
- Rate limit: 10 attempts/IP/jam, 10 attempts/device/jam (server-side, unbypassable)
- Turnstile: anti-bot challenge
- Combined: brute-force would take ~100,000 hours even with rate limit bypass

### 4.7 UU PDP Basic Compliance (Q17)

**6 basic implementations in Phase 1-3:**
1. Consent popup (saat login pertama)
2. Privacy Policy page
3. Audit log (Q9)
4. Data retention policy (auto-purge via pg_cron)
5. DSR mechanism (form + admin review)
6. Data export button di profile peserta

**Deferred to Phase 9:** DPO dashboard, breach notification automation, data anonymization, GDPR/FERPA specifics.

---

## 5. File Inventory

### 5.1 New SQL Migration Files (15)
```
supabase/migrations/
├── 20260701_001_create_organizations.sql
├── 20260701_002_alter_users_snake_case.sql
├── 20260701_003_create_assessments.sql
├── 20260701_004_create_assessment_sessions.sql
├── 20260701_005_create_submissions.sql
├── 20260701_006_create_violation_events.sql
├── 20260701_007_create_question_bank.sql
├── 20260701_008_create_audit_logs.sql
├── 20260701_009_create_consents.sql
├── 20260701_010_create_data_subject_requests.sql
├── 20260701_011_create_view_assessment_peserta.sql
├── 20260701_012_helper_functions.sql
├── 20260701_013_pg_cron_retention.sql
├── 20260701_014_migrate_legacy_ujian.sql
└── 20260701_015_drop_legacy_tables.sql
```

### 5.2 New Edge Functions (Phase 2)
```
supabase/functions/
├── submit-assessment/index.ts        # NEW — server-side scoring
├── heartbeat/index.ts                # NEW — 15s progress sync
├── block-participant/index.ts        # NEW — instant block via realtime
├── assessment-lifecycle/index.ts     # NEW — start/pause/resume/finish
├── cleanup-assessment/index.ts       # NEW — pre-delete check
├── data-export/index.ts              # NEW — DSR self-service export
├── dsr-handler/index.ts              # NEW — DSR request handler
├── register-admin/index.ts           # REFACTOR
├── user-auth-preflight/index.ts      # REFACTOR
├── user-auth-complete/index.ts       # REFACTOR
├── access-code-attempt/index.ts      # RENAME from exam-token-attempt + Turnstile
└── _shared/
    ├── auth.ts
    ├── audit.ts
    ├── rls.ts
    └── realtime.ts
```

### 5.3 New Client Modules (Phase 3-8)
```
src/
├── theme-system/           # NEW — Google Form-like theme system
│   ├── index.js
│   ├── presets.js
│   ├── derive.js
│   ├── validate.js
│   └── injector.js
├── i18n/                   # NEW — 5 languages (id, en, ru, es, zh)
│   ├── index.js
│   ├── detector.js
│   └── locales/
│       ├── id.json
│       ├── en.json
│       ├── ru.json
│       ├── es.json
│       └── zh.json
├── security/               # NEW — anti-cheat hardening
│   ├── heartbeat.js
│   ├── block-listener.js
│   ├── devtools-detector.js
│   ├── consent-gate.js
│   └── audit-trail.js
├── pages/
│   ├── create-assessment.js       # RENAMED from buat-ujian.js
│   ├── create-assessment/         # RENAMED from buat-ujian/
│   ├── active-assessments.js      # RENAMED from ujian-peserta.js
│   ├── question-bank.js           # NEW
│   ├── proctoring.js              # NEW
│   ├── analytics.js               # NEW
│   ├── assessment-entry.js        # RENAMED from ujian.js
│   └── take-assessment.js         # RENAMED from kerjakan-ujian.js
└── pwa/                    # NEW — Phase 8
    ├── manifest.json
    ├── service-worker.js
    └── offline.html
```

### 5.4 Documentation Updates (10 files)
- `README.md` — Update
- `rule-url-albedu.md` — Update (v1.0.0 changelog, new paths)
- `docs/AI-CONTEXT.md` — Update lookup table
- `docs/ARCHITECTURE.md` — Rewrite (new schema, ERD)
- `docs/CONTRIBUTING.md` — Update (theme/i18n/edge function guidelines)
- `docs/MIGRATION.md` — Rewrite (v0.2.0 → v1.0.0 guide)
- `docs/UPDATE-GUIDE.md` — Update (v1.0.0 changes)
- `docs/MIGRATION-DECISIONS.md` — NEW (this file)
- `docs/COMPLIANCE.md` — NEW (UU PDP details)
- `docs/SCALING.md` — NEW (Supabase Free Plan limits + upgrade path)
- `docs/I18N.md` — NEW (how to add locale)
- `docs/SECURITY.md` — NEW (anti-cheat architecture)
- `docs/THEME-SYSTEM.md` — NEW (theme schema + presets)
- `supabase/README.md` — NEW (migration run instructions)

---

## 6. Rollback Plan

**Per Phase:**
| Phase | Rollback Strategy |
|---|---|
| 1 (Schema) | Restore Supabase backup pre-migration. Git revert. |
| 2 (Edge Functions) | Keep old functions as `*-legacy`, redirect if new fails |
| 3 (Admin UI) | Keep old HTML files as `*-legacy.html`, conditional redirect |
| 4 (Student UI) | Same as Phase 3 |
| 5-8 | Feature flags, disable if break |

**Full rollback:** `git revert` to commit `v0.2.0-baseline` + restore Supabase backup. Maximum downtime: 2 hours.

---

## 7. Contacts

- **Owner:** Albi Fahriza (albytehq)
- **GitHub:** https://github.com/albytehq
- **Worker URL:** https://edu.albyte-inc.workers.dev
- **Supabase Project:** https://kzsrerxhhrtsxnpnmqgl.supabase.co

---

**This document is the authoritative source for all v1.0.0 architectural decisions. Any code change that contradicts this document must update this document first.**
