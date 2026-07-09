# AlbEdu Production Hardening — User Simulation Checklist

## The Surgeon's 20 Adversarial User Scenarios

Test setiap skenario secara manual di browser. Centang jika pass.

### Network Edge Cases

- [ ] **1. Offline saat exam** — Buka DevTools → Network → Offline. Jawab soal, lalu online lagi. Draft answers harus tersimpan lokal dan sync saat online.
- [ ] **2. Slow 3G saat submit** — DevTools → Network → Slow 3G. Klik submit. Timer 30s timeout harus fire. Retry harus otomatis.
- [ ] **3. Network putus saat heartbeat** — Offline di tengah exam. Heartbeat harus backoff, tidak spam. Saat online, heartbeat resume.
- [ ] **4. Supabase 500 error** — (Butuh mock) Kalau Edge Function return 500, circuit breaker harus trip setelah 3 failures. UI tetap usable.

### State Edge Cases

- [ ] **5. Double-click submit** — Klik tombol submit 5x dalam 1 detik. Hanya 1 submit yang execute (idempotency guard).
- [ ] **6. Concurrent tabs** — Buka 2 tab dengan assessment yang sama. Tab kedua harus show "sudah ada sesi aktif" atau resume sesi.
- [ ] **7. Refresh saat loading** — Refresh 10x berturut-turut saat halaman loading. Tidak ada crash, tidak ada zombie listeners.
- [ ] **8. Session expired saat exam** — Token expired tepat saat klik submit. Submit harus fail gracefully, tidak kehilangan jawaban.
- [ ] **9. Back button saat exam** — Tekan Back saat exam. bfcache bust harus force reload, tidak restore stale state.
- [ ] **10. Logout dari tab lain** — Buka 2 tab, logout dari tab A. Tab B harus detect auth state change dan redirect.

### Data Edge Cases

- [ ] **11. 10.000 karakter esai** — Paste 10.000 karakter ke field esai. Tidak ada crash, text ter-truncate atau wrap gracefully.
- [ ] **12. Emoji + RTL text** — Masukkan emoji + teks Arab ke field nama. Tidak ada encoding error, display correct.
- [ ] **13. Malformed JSON import** — Import file JSON yang corrupt ke Daftar Nama (max 3 daftar). Error message jelas, tidak crash.

### Timing Edge Cases

- [ ] **14. Rapid navigation** — Navigasi antar halaman cepat (5 klik dalam 2 detik). AbortController harus cancel pending fetches. Tidak ada ghost callbacks.
- [ ] **15. Visibility change saat exam** — Switch tab 50x. Anti-cheat harus count violations. ExamGuardian tidak crash.
- [ ] **16. Rotate device 10x** — Rotate device 10x saat exam. Layout recalculation tidak cause crash. QNotify resize handler throttle working.

### Resource Edge Cases

- [ ] **17. Low-end device (1GB RAM)** — Buka exam di device dengan 1GB RAM. Springs tidak cause OOM. will-change di-clean up.
- [ ] **18. localStorage quota exceeded** — Fill localStorage sampai quota. QNotify draft save harus catch error, tidak crash.
- [ ] **19. Image upload 50MB** — Upload image 50MB ke profile avatar. Validation harus reject dengan message jelas, tidak crash browser. (Note: Bank Soal feature removed.)

### Browser Edge Cases

- [ ] **20. Private mode** — Buka di private/incognito mode. localStorage mungkin disabled. Auth session harus tetap work (persistSession: true menggunakan memory fallback).

---

## v0.818.2 Hardening Verified

The following edge cases were uncovered by the v0.818.2 stability audit and are now handled. Each one was a real bug that would have manifested in production under specific user conditions — they are NOT hypothetical. Re-verify each after any refactor that touches the listed file.

### Submit / publish races

- **Double-click publish → guarded.** `src/pages/buat-ujian/publish-card.js` disables the publish button on first click (sets `disabled` attribute + adds `is-publishing` class for visual feedback) and re-enables on error response. Prevents duplicate assessment rows when the user double-clicks "Publish" before the first request returns. Without this guard, a slow network would create 2-3 duplicate assessments per double-click.
- **Multiple tabs same exam → UNIQUE constraint + idempotent submit RPC.** `submissions(session_id)` has a UNIQUE constraint, and the atomic `submit_assessment()` RPC is idempotent — a second submit for the same session returns the first submit's result instead of throwing. The second tab's UI shows "submitted" without error.

### Browser quirks

- **Safari Private Mode localStorage → in-memory fallback.** `src/utils/self-storage.js` catches `QuotaExceededError` on `localStorage.setItem()` and falls back to a `Map` for the session. Auth session still works because Supabase's `persistSession: true` was already using memory fallback — but our own QNotify draft-save was crashing on Safari Private Mode.
- **Heartbeat backoff timer leak → tracked + cleared in `stop()`.** `src/security/heartbeat.js` now stores `this._backoffTimer` (the setTimeout handle for the next retry) and clears it alongside `this._interval` (the regular heartbeat) inside `stop()`. The old code left the backoff timer running after `signOut()`, so the next sign-in would cause double-heartbeats that competed for the same session row.
- **DevTools console.log monkey-patch → restored in `_restoreConsoleTrap()`.** `src/security/devtools-detector.js` was overriding `console.log` permanently (for the console.log getter detection method). The override was never restored, which broke any third-party library that relied on `console.log` returning its return value. `_restoreConsoleTrap()` is now called on `stop()` and on `pagehide`.
- **Block-listener `_onSubmitted` → now wired.** `src/security/block-listener.js` was subscribing to realtime updates on `assessment_sessions` but the `_onSubmitted` callback that locks the UI on `status='blocked'` was never connected (the callback existed but wasn't passed to `subscribe()`). Peserta would continue answering for ~15s until the next heartbeat poll caught the block. Now wired via the 4-arg `subscribe(name, table, callback, filter)` form.

### Deployment / runtime

- **Service worker subfolder deploy → `BASE_PATH` computed.** `public/service-worker.js` now derives its `CACHE_VERSION` scope from `registration.scope` instead of hardcoding `/`. The service worker now works correctly whether deployed at root (localhost) or under `/AlbEdu/` on GitHub Pages. Previously, the SW was caching assets under `/styles/...` when the actual path was `/AlbEdu/styles/...`, causing 404s on every cached request.
- **Boot platform timeout → 30s, resolves optimistically for degraded mode.** `AlbEdu.boot.ready` now resolves `true` after a 30s timeout even if the `albedu:platform-ready` event never fires. A slow or degraded Supabase region no longer freezes the UI indefinitely — the user sees the page shell after 30s with a "retry" banner, instead of an infinite spinner.

### Security edge cases

- **Consent `previousVersion` XSS → escaped.** `src/security/consent.js` was rendering `previousVersion` as raw `innerHTML` (to show "you previously agreed to v3.0.0"). A tampered consent record with `previousVersion: '<img src=x onerror=alert(1)>'` would execute. Now uses `AlbEdu.sanitize.setText()` which escapes via `textContent`.
- **ipify timeout → 5s `AbortController`.** The ipify.com IP lookup (used for audit logs) was hanging indefinitely on slow networks, blocking the entire consent flow. Now wraps the `fetch()` in a 5s `AbortController`; on timeout, the audit log records `ip: null` instead of blocking.

### Image / asset upload

- **Image upload timeout → 10s per call.** `src/utils/image-compress.js` wraps each `fetch()` to the Cloudflare Worker in a 10s `AbortController`. Previously, a hung GitHub response on the Worker side would block the image upload UI forever — the user would stare at a spinner with no recovery path.
- **Image cleanup timeouts → 10s per call.** `src/utils/image-cleanup.js` (the orphaned-asset GC) now wraps each cleanup call in a 10s `AbortController` so a hung GitHub response doesn't block the cleanup queue. Without this, one bad cleanup call would block the entire GC loop indefinitely.

### Realtime

- **ANC thundering herd → filter + 200ms debounce.** `src/utils/admin-notification-center.js` was subscribing to ALL violation events on ALL sessions (3-arg `subscribe` form). When 50+ peserta triggered violations simultaneously (e.g. a new section opened and they all switched tabs), the admin dashboard would receive 50+ callbacks in <1s and re-render the notification list 50 times — visible jank + CPU spike. Now uses the 4-arg `subscribe(name, table, callback, filter)` form (filtered to the active assessment) and debounces the callback by 200ms so rapid-fire events coalesce into one re-render.

---

## Pass Criteria

- **0 crash** — Tidak ada unhandled exception yang menyebabkan blank screen
- **0 data loss** — Jawaban peserta tidak hilang dalam skenario apapun
- **0 stuck state** — User selalu bisa recover (retry, refresh, atau navigate)
- **Graceful error messages** — Setiap error menampilkan pesan yang informatif tapi tidak leak internals

## How to Run

1. Buka AlbEdu di Chrome/Edge
2. Buka DevTools (F12)
3. Untuk network scenarios: Network tab → throttle/offline
4. Untuk memory scenarios: Performance tab → record memory timeline
5. Untuk concurrent tabs: buka 2 tab dengan URL yang sama
6. Catat hasil di checklist di atas
