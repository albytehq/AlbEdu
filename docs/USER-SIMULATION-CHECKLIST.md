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
- [ ] **19. Image upload 50MB** — Upload image 50MB ke profile avatar. Validation harus reject dengan message jelas, tidak crash browser. (Note: Bank Soal feature removed in v0.746.0.)

### Browser Edge Cases

- [ ] **20. Private mode** — Buka di private/incognito mode. localStorage mungkin disabled. Auth session harus tetap work (persistSession: true menggunakan memory fallback).

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
