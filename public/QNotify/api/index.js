// api/index.js — QNotify 1.0.5 For AlbEdu
/**
 * 1.0.5 ADDITIONS (AlbEdu rebrand):
 *  show.setGlitchAudit(true)   — enable glitch audit logging (dev)
 *  show.enablePerfMonitor()    — enable FPS drop warnings (dev)
 *  show.getFPS()               — read current animation FPS
 *  window.QnotifyVersion       — version string for runtime checks
 */
/**
 * ╔══════════════════════════════════════════════════════╗
 * ║  QNotify — api/index.js 1.0.5 For AlbEdu ║
 * ║  "Satu pintu masuk. Tidak ada yang lain."           ║
 * ╚══════════════════════════════════════════════════════╝
 *
 * Ini adalah satu-satunya file yang boleh di-import pengguna.
 * Semua logika ada di dalam, file ini hanya jadi "kasir"-nya.
 *
 * CARA PAKAI:
 *   import show from './api/index.js';
 *
 *   show.notify.success('Berhasil', 'Data tersimpan');
 *   show.notify.error('Gagal', 'Koneksi terputus');
 *   show.dialog.confirm({ message: 'Yakin hapus?', onYes: () => deleteItem() });
 *   show.dialog.hold({ message: 'Tahan untuk hapus', onConfirm: () => deleteItem() });
 *   show.label.alert({ title: 'Info', message: 'Update tersedia!' });
 *
 * ATURAN:
 *   - Jangan import engine.js langsung dari luar
 *   - Jangan tambahkan logika bisnis ke file ini
 *   - File ini hanya boleh berisi routing ke engine/shorthands
 */

import { QNotifyEngine } from '../main/engine.js';
import { createNotifyShorthands } from '../main/notify.js';
import { SOLVER } from '../main/config.js';
import { setAuditMode } from '../main/glitch.js';
import { enablePerfMonitor, getCurrentFPS } from '../main/perf.js';
import { getLayerCount, DeviceCaps } from '../main/compositor.js';

// Satu instance engine untuk seluruh aplikasi (singleton)
// Semua notifikasi dikelola engine yang sama
const engine     = new QNotifyEngine();
const shorthands = createNotifyShorthands(engine);

// ══════════════════════════════════════════════════════════════
//  PUBLIC API — show.{family}.{action}(...)
// ══════════════════════════════════════════════════════════════
const show = {

    // ── Notifikasi toast (auto-dismiss) ─────────────────────
    notify: {
        /** Notif sukses — hijau */
        success:   (title, message, duration) => shorthands.success(title, message, duration),
        /** Notif error — merah */
        error:     (title, message, duration) => shorthands.error(title, message, duration),
        /** Notif peringatan — kuning/oranye */
        warning:   (title, message, duration) => shorthands.warning(title, message, duration),
        /** Notif informasi — biru */
        info:      (title, message, duration) => shorthands.info(title, message, duration),

        // Alias Bahasa Indonesia
        /** Alias → success() */
        sukses:    (title, message, duration) => shorthands.sukses(title, message, duration),
        /** Alias → error() */
        gagal:     (title, message, duration) => shorthands.gagal(title, message, duration),
        /** Alias → warning() */
        peringatan:(title, message, duration) => shorthands.peringatan(title, message, duration),
        /** Alias → info() */
        informasi: (title, message, duration) => shorthands.informasi(title, message, duration),
    },

    // ── Dialog interaktif (modal, perlu aksi user) ───────────
    dialog: {
        /**
         * Dialog Ya / Tidak biasa.
         * @param {{ title?, message, icon?, onYes?, onNo?, intent? }} options
         */
        confirm: (options) => engine.confirm(options),

        /**
         * Dialog dengan async callback + loading state.
         * Tombol Ya akan menampilkan spinner selama proses berjalan.
         * @param {{ title?, message, icon?, onAsyncYes?, onAsyncNo?, intent? }} options
         */
        async: (options) => engine.asyncConfirm(options),

        /**
         * Dialog tahan tombol — user harus hold button selama holdDuration ms.
         * Cocok untuk aksi berbahaya (hapus data, dll).
         * @param {{ title?, message, icon?, holdDuration?, onConfirm?, onCancel?, intent? }} options
         */
        hold: (options) => engine.holdConfirm(options),

        /**
         * Gabungan hold + async — tahan tombol lalu proses async.
         * @param {{ title?, message, icon?, holdDuration?, onAsyncConfirm?, onCancel?, intent? }} options
         */
        holdAsync: (options) => engine.holdConfirmAsync(options),

        // ── Factory shortcuts — intent determines mechanic automatically ──
        /**
         * Danger dialog — auto-selects hold-async mechanic (intent: 'danger').
         * @param {{ message?, title?, onAsyncConfirm?, onCancel? }} options
         */
        danger:  (options) => engine.dialogDanger(options),

        /**
         * Warning dialog — uses standard confirm mechanic (intent: 'warning').
         * @param {{ message?, title?, onYes?, onNo? }} options
         */
        warning: (options) => engine.dialogWarning(options),

        /**
         * Info dialog — uses standard confirm mechanic (intent: 'info').
         * @param {{ message?, title?, onYes?, onNo? }} options
         */
        info:    (options) => engine.dialogInfo(options),
    },

    // ── Label alert (modal informatif, satu tombol OK) ───────
    label: {
        /**
         * Alert satu tombol — tidak ada pilihan, hanya informasi.
         * @param {{ title?, message, icon?, intent?, okText?, onOk? }|string} options
         */
        alert: (options) => engine.alert(options),

        /**
         * ReadNote — card instruksi / informasi hampir fullscreen.
         * Tema selalu biru. Dua mode: 'default' (logo+judul) | 'text_only' (judul+subjudul).
         *
         * @param {{
         *   title:         string,
         *   subtitle?:     string,
         *   logoSrc?:      string,
         *   logoIcon?:     string,
         *   uiType?:       'default' | 'text_only',
         *   readType?:     'required' | 'optional',
         *   progress?:     number,
         *   closeText?:    string,
         *   continueText?: string,
         *   onClose?:      Function,
         *   onContinue?:   Function,
         * }} options
         * @returns {string} notification ID
         */
        readNote: (options) => engine.readNote(options),
    },

    // ── Utilitas ─────────────────────────────────────────────

    /**
     * Tampilkan notifikasi dengan opsi custom penuh.
     * @param {{ type?, title?, message?, duration?, icon? }} options
     * @returns {string} notification ID
     */
    show: (options) => engine.show(options),

    /**
     * Dismiss (sembunyikan) satu notifikasi berdasarkan ID.
     * ID didapat dari return value show/notify/dialog.
     * @param {string} id
     */
    dismiss: (id) => engine.dismiss(id),

    /**
     * Dismiss ReadNote dengan animasi exit.
     * @param {string} id
     */
    dismissReadNote: (id) => engine.dismissReadNote(id),

    /**
     * Update progress bar ReadNote yang sedang tampil (0–100).
     * @param {string} id
     * @param {number} percent
     */
    setReadNoteProgress: (id, percent) => engine.setReadNoteProgress(id, percent),

    /** Dismiss semua notifikasi yang sedang tampil sekaligus */
    clearAll: () => engine.clearAll(),

    /**
     * Ganti bahasa UI saat runtime tanpa reload.
     * @param {'id'|'en'} lang
     */
    setLanguage: (lang) => engine.setLanguage(lang),

    /**
     * v7.5.0: Solver is always HYBRID.
     * Analytic handles UI animations (enter/exit/stack/morph) — frame-rate independent, exact.
     * RK4 handles gesture physics (bump/drag) — step-based, tactile feel.
     * Each solver patches the other's weaknesses. setSolver() kept for backward compat only.
     */
    setSolver: (mode) => {
        // Always hybrid — analytic excels at UI, RK4 excels at gesture handling
        SOLVER.mode = 'hybrid';
        if (mode !== 'hybrid') {
            console.info('[QNotify 1.0.5 For AlbEdu] Hybrid solver enforced. Analytic handles UI animations, RK4 handles gesture physics.');
        }
        // Solver selected: hybrid (Analytic+RK4). No console output in production.
    },

    /**
     * Enable or disable debug logging for the spring solver.
     * When enabled, logs solver mode and config for every spring created.
     * @param {boolean} enabled
     */
    setSolverDebug: (enabled) => { SOLVER.debug = Boolean(enabled); },

    /**
     * Read current solver configuration.
     * @returns {{ mode: string, debug: boolean }}
     */
    getSolverConfig: () => ({ mode: SOLVER.mode, debug: SOLVER.debug }),

    // ── 1.0.5 Dev Tools ────────────────────────────────────────

    /**
     * Enable glitch audit mode — logs suspected flash/glitch events to console.
     * Use in development only. Auto-disabled in production.
     * @param {boolean} enabled
     */
    setGlitchAudit: (enabled) => { setAuditMode(Boolean(enabled)); },

    /**
     * Enable performance monitor — logs FPS warnings to console if below 30fps.
     * Use in development only.
     */
    enablePerfMonitor: () => { enablePerfMonitor(); },

    /**
     * Get current animation FPS from global RAF loop.
     * @returns {number} frames per second (0 if no animation running)
     */
    getFPS: () => getCurrentFPS(),

    /**
     * 1.0.5: Get current GPU compositor layer count.
     * Use to monitor memory pressure during heavy animation.
     * @returns {number}
     */
    getLayerCount: () => getLayerCount(),

    /**
     * 1.0.5: Get device capability tier.
     * 'full' | 'reduced' | 'minimal'
     * @returns {Object} DeviceCaps
     */
    getDeviceCaps: () => DeviceCaps,
};

// ── Export untuk ES Module ───────────────────────────────────
export default show;

// ── Pasang ke window untuk penggunaan tanpa bundler (script tag) ─
// Phase 11 cleanup (Q8): dropped unused globals — QnotifyShow, Qnotify (lowercase),
// Notifications, QnotifySolver, QnotifyVersion. Verified zero AlbEdu callers.
// Kept: window.show (used as || fallback in 5 spots) + window.QNotify (set by HTML bridge).
if (typeof window !== 'undefined') {
    window.show          = show;
}
