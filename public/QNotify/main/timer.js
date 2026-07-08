// timer.js — QNotify auto-dismiss manager.
//
// Mengurus semua timer untuk auto-dismiss notifikasi. Setiap notifikasi punya
// satu entry di Map `timers`. duration = 0 → notifikasi permanen, jangan
// panggil startTimer (skip di engine.js).

// Registry semua timer aktif — key: notificationId, value: timer entry.
const timers = new Map();

// Mulai countdown timer untuk satu notifikasi. Duration 0 = permanen, skip.
export function startTimer(id, duration, onExpire) {
    if (duration <= 0) return;

    // Pastikan tidak ada timer lama yang masih jalan untuk ID yang sama.
    clearTimer(id);

    const handle = setTimeout(() => {
        timers.delete(id);
        if (onExpire) onExpire(id);
    }, duration);

    timers.set(id, {
        handle,
        startedAt: Date.now(),
        duration,
        remaining: duration,
        paused:    false,
    });
}

// Hentikan dan hapus timer untuk satu notifikasi. Dipanggil saat user dismiss
// manual atau clearAll.
export function clearTimer(id) {
    const entry = timers.get(id);
    if (entry) {
        clearTimeout(entry.handle);
        timers.delete(id);
    }
}

// Bekukan timer sementara. Timer tidak akan fire sampai resumeTimer() dipanggil.
// Disiapkan untuk fitur hover-to-pause di masa depan — belum ada UI yang
// memanggilnya secara langsung sekarang.
export function pauseTimer(id) {
    const entry = timers.get(id);
    if (!entry || entry.paused) return;

    clearTimeout(entry.handle);

    // Simpan berapa sisa waktu — ini yang nanti dipakai saat resume.
    entry.remaining = entry.duration - (Date.now() - entry.startedAt);
    entry.paused    = true;

    timers.set(id, entry);
}

// Lanjutkan timer yang sedang di-pause. Akan fire setelah sisa waktu yang
// tersimpan habis.
export function resumeTimer(id, onExpire) {
    const entry = timers.get(id);
    if (!entry || !entry.paused) return;

    entry.paused    = false;
    entry.startedAt = Date.now();
    entry.handle    = setTimeout(() => {
        timers.delete(id);
        if (onExpire) onExpire(id);
    }, entry.remaining);

    timers.set(id, entry);
}

// Cek apakah timer untuk ID ini masih aktif.
export function hasTimer(id) {
    return timers.has(id);
}

// Hapus semua timer sekaligus. Dipanggil oleh engine.clearAll() saat semua
// notif dibersihkan.
export function clearAllTimers() {
    timers.forEach(entry => clearTimeout(entry.handle));
    timers.clear();
}
