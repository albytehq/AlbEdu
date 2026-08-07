// notify.js — QNotify shorthand wrappers for engine.show().
//
// File ini cuma berisi fungsi shortcut: success/error/warning/info + alias
// bahasa Indonesia (sukses/gagal/peringatan/informasi). Semua fungsi hanya
// meneruskan ke engine.show() — tidak ada logika sendiri di sini.

import { DEFAULT_DURATION } from './config.js';

// Buat kumpulan shorthand method dari engine yang diberikan.
export function createNotifyShorthands(engine) {
    return {

        // Bahasa Inggris

        success(title, message, duration = DEFAULT_DURATION) {
            return engine.show({ type: 'success', title, message, duration });
        },

        error(title, message, duration = DEFAULT_DURATION) {
            return engine.show({ type: 'error', title, message, duration });
        },

        warning(title, message, duration = DEFAULT_DURATION) {
            return engine.show({ type: 'warning', title, message, duration });
        },

        info(title, message, duration = DEFAULT_DURATION) {
            return engine.show({ type: 'info', title, message, duration });
        },

        // Alias Bahasa Indonesia — sama persis dengan versi Inggris di atas.

        sukses(title, message, duration = DEFAULT_DURATION) {
            return engine.show({ type: 'success', title, message, duration });
        },

        gagal(title, message, duration = DEFAULT_DURATION) {
            return engine.show({ type: 'error', title, message, duration });
        },

        peringatan(title, message, duration = DEFAULT_DURATION) {
            return engine.show({ type: 'warning', title, message, duration });
        },

        informasi(title, message, duration = DEFAULT_DURATION) {
            return engine.show({ type: 'info', title, message, duration });
        },
    };
}
