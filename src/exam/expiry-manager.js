// =============================================================
//  assets/js/ExamExpiryManager.js
//  AlbEdu · Exam Expiry UI Helper  (v2 — UI only, no delete)
//
//  ARSITEKTUR v2:
//    Penghapusan ujian expired SEPENUHNYA dilakukan oleh
//    Cloudflare Worker Cron Trigger (worker.js → sweepExpiredExams)
//    yang jalan setiap jam, 24/7, tanpa butuh browser terbuka.
//
//    File ini HANYA bertugas:
//      1. Mendeteksi status expired di sisi UI (badge, warna)
//      2. Menghitung countdown "hapus otomatis dalam X menit"
//      3. Memberi tahu UI ketika exam real-time update datang
//         dan statusnya FINISHED (untuk trigger badge refresh)
//
//  TIDAK ADA logic delete di file ini.
//  TIDAK ADA polling Firestore/Supabase di file ini.
//  Semua delete → worker.js cron.
//
//  Usage:
//    // Cek apakah satu exam sudah expired grace period
//    ExamExpiryManager.isExpired(examData)          → boolean
//
//    // Berapa milidetik sampai dihapus Worker
//    ExamExpiryManager.msUntilDelete(examData)      → number
//
//    // Format teks user-friendly: "Dihapus dalam 45 menit"
//    ExamExpiryManager.deleteCountdownText(examData) → string
//
//    // Status tier untuk badge/warna UI
//    ExamExpiryManager.expiryTier(examData)
//      → 'active' | 'warning' | 'expired' | 'deleted-soon'
// =============================================================

const ExamExpiryManager = (() => {

    // Harus sama persis dengan EXPIRY_GRACE_MS di worker.js
    const GRACE_MS = 60 * 60 * 1000; // 1 jam

    // ── Date coercion (sama dengan exam-admin-controller._coerceDate) ──────
    function _coerceDate(val) {
        if (!val) return null;
        if (val instanceof Date) return val;
        if (typeof val === 'string') { const d = new Date(val); return isNaN(d) ? null : d; }
        if (typeof val === 'object') {
            if (typeof val.toDate   === 'function') return val.toDate();
            if (typeof val.seconds  === 'number')   return new Date(val.seconds * 1000);
        }
        return null;
    }

    // ── Derive when exam finished ──────────────────────────────────────────
    function _finishedAt(access_control) {
        if (!access_control) return null;
        const { mode, manual_status, end, remaining_time, override, scheduled } = access_control;

        if (mode === 'manual') {
            // WHY cek override: jika admin set override=true, ujian sengaja dibiarkan terbuka
            // meskipun end sudah lewat. Jangan anggap finished — admin yang akan close manual.
            if (manual_status === 'open' && end && !override) {
                const d = _coerceDate(end);
                // Hanya finished jika end sudah benar-benar lewat (bukan ujian yang masih running)
                return (d && d < new Date()) ? d : null;
            }
            // manual_status='closed' dengan remaining_time=0 dan ada end → ujian sudah selesai
            // remaining_time > 0 = PAUSED, bukan finished
            if (manual_status === 'closed' && !remaining_time && end) {
                return _coerceDate(end);
            }
        } else if (mode === 'scheduled') {
            if (scheduled?.active && scheduled?.end) {
                const d = _coerceDate(scheduled.end);
                return (d && d < new Date()) ? d : null;
            }
        }
        return null;
    }

    // ── Public API ────────────────────────────────────────────────────────

    /**
     * Apakah ujian sudah melewati grace period → Worker akan menghapusnya
     * di cron run berikutnya.
     * @param   {object} examData  — exam record dari Supabase
     * @returns {boolean}
     */
    function isExpired(examData) {
        const finishedAt = _finishedAt(examData?.access_control);
        if (!finishedAt) return false;
        return (Date.now() - finishedAt.getTime()) >= GRACE_MS;
    }

    /**
     * Berapa milidetik tersisa sebelum Worker menghapus ujian ini.
     * Returns 0 jika sudah expired atau tidak ada tanggal selesai.
     * @param   {object} examData
     * @returns {number}  ms
     */
    function msUntilDelete(examData) {
        const finishedAt = _finishedAt(examData?.access_control);
        if (!finishedAt) return 0;
        const elapsed = Date.now() - finishedAt.getTime();
        return Math.max(0, GRACE_MS - elapsed);
    }

    /**
     * Teks countdown yang readable untuk ditampilkan di UI.
     * Contoh: "Dihapus otomatis dalam 45 menit"
     *         "Dihapus otomatis dalam kurang dari 1 menit"
     *         "Akan dihapus otomatis segera"
     * @param   {object} examData
     * @returns {string | null}  null jika ujian belum selesai
     */
    function     deleteCountdownText(examData) {
        const finishedAt = _finishedAt(examData?.access_control);
        if (!finishedAt) return null;

        const ms = msUntilDelete(examData);
        if (ms <= 0) return 'Akan dihapus otomatis segera';
        if (ms < 60_000) return 'Dihapus otomatis dalam kurang dari 1 menit';

        const minutes = Math.ceil(ms / 60_000);
        if (minutes === 1) return 'Dihapus otomatis dalam 1 menit';
        if (minutes < 60) return `Dihapus otomatis dalam ${minutes} menit`;

        const hours = Math.floor(minutes / 60);
        const mins  = minutes % 60;
        return mins > 0
            ? `Dihapus otomatis dalam ${hours} jam ${mins} menit`
            : `Dihapus otomatis dalam ${hours} jam`;
    }

    /**
     * Tier status expiry untuk warna badge / highlight di UI.
     *
     * Returns:
     *   'active'       — ujian belum selesai, tidak perlu warning
     *   'warning'      — ujian selesai, masih dalam grace period (< 30 menit tersisa)
     *   'deleted-soon' — grace period hampir habis (< 5 menit)
     *   'expired'      — grace period habis, Worker akan hapus di cron berikutnya
     *
     * @param   {object} examData
     * @returns {'active'|'warning'|'deleted-soon'|'expired'}
     */
    function expiryTier(examData) {
        const finishedAt = _finishedAt(examData?.access_control);
        if (!finishedAt) return 'active';

        const ms = msUntilDelete(examData);
        if (ms <= 0)             return 'expired';
        if (ms < 5 * 60_000)    return 'deleted-soon';
        if (ms < 30 * 60_000)   return 'warning';
        return 'active';
    }

    // Tidak ada init(), stop(), atau sweep() — semua itu tugas Worker cron.
    return { isExpired, msUntilDelete, deleteCountdownText, expiryTier };
})();