// notify.js — QNotify 1.0.5 For AlbEdu
/**
 * ╔════════════════════════════════════════════╗
 * ║  QNotify — notify.js 1.0.5 For AlbEdu ║
 * ║  "Shorthand wrapper. Bukan logika."        ║
 * ╚════════════════════════════════════════════╝
 *
 * File ini cuma berisi fungsi shortcut:
 *   success(), error(), warning(), info()
 *   + alias bahasa Indonesia
 *
 * Semua fungsi ini hanya meneruskan ke engine.show().
 * Tidak ada logika sendiri di sini — murni wrapper tipis.
 *
 * CARA PAKAI:
 *   const shorthands = createNotifyShorthands(engine);
 *   shorthands.success('Judul', 'Pesan', 3000);
 */

import { DEFAULT_DURATION } from './config.js';

/**
 * Buat kumpulan shorthand method dari engine yang diberikan.
 * @param {import('./engine.js').QNotifyEngine} engine
 * @returns {Object} Object berisi semua method shorthand
 */
export function createNotifyShorthands(engine) {
    return {

        // ── Bahasa Inggris ───────────────────────────────────────

        /** Notifikasi hijau — operasi berhasil */
        success(title, message, duration = DEFAULT_DURATION) {
            return engine.show({ type: 'success', title, message, duration });
        },

        /** Notifikasi merah — operasi gagal / terjadi error */
        error(title, message, duration = DEFAULT_DURATION) {
            return engine.show({ type: 'error', title, message, duration });
        },

        /** Notifikasi kuning — perlu perhatian tapi bukan error kritis */
        warning(title, message, duration = DEFAULT_DURATION) {
            return engine.show({ type: 'warning', title, message, duration });
        },

        /** Notifikasi biru — info netral */
        info(title, message, duration = DEFAULT_DURATION) {
            return engine.show({ type: 'info', title, message, duration });
        },

        // ── Alias Bahasa Indonesia ───────────────────────────────
        // Sama persis dengan versi Inggris di atas, cuma namanya beda

        /** Alias → success() */
        sukses(title, message, duration = DEFAULT_DURATION) {
            return engine.show({ type: 'success', title, message, duration });
        },

        /** Alias → error() */
        gagal(title, message, duration = DEFAULT_DURATION) {
            return engine.show({ type: 'error', title, message, duration });
        },

        /** Alias → warning() */
        peringatan(title, message, duration = DEFAULT_DURATION) {
            return engine.show({ type: 'warning', title, message, duration });
        },

        /** Alias → info() */
        informasi(title, message, duration = DEFAULT_DURATION) {
            return engine.show({ type: 'info', title, message, duration });
        },
    };
}
