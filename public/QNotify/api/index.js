// api/index.js — Public entry point for QNotify.
//
// Usage:
//   import show from './api/index.js';
//
//   show.notify.success('Berhasil', 'Data tersimpan');
//   show.notify.error('Gagal', 'Koneksi terputus');
//   show.dialog.confirm({ message: 'Yakin hapus?', onYes: () => deleteItem() });
//   show.dialog.hold({ message: 'Tahan untuk hapus', onConfirm: () => deleteItem() });
//   show.label.alert({ title: 'Info', message: 'Update tersedia!' });
//
// Rules: don't import engine.js directly from outside this file; don't add
// business logic here — this file only routes to engine/shorthands.

import { QNotifyEngine } from '../main/engine.js';
import { createNotifyShorthands } from '../main/notify.js';
import { SOLVER } from '../main/config.js';
import { setAuditMode } from '../main/glitch.js';
import { enablePerfMonitor, getCurrentFPS } from '../main/perf.js';
import { getLayerCount, DeviceCaps } from '../main/compositor.js';

// Singleton engine instance shared across the whole app.
const engine     = new QNotifyEngine();
const shorthands = createNotifyShorthands(engine);

const show = {

    // Toast notifications (auto-dismiss)
    notify: {
        success:   (title, message, duration) => shorthands.success(title, message, duration),
        error:     (title, message, duration) => shorthands.error(title, message, duration),
        warning:   (title, message, duration) => shorthands.warning(title, message, duration),
        info:      (title, message, duration) => shorthands.info(title, message, duration),

        // Bahasa Indonesia aliases
        sukses:    (title, message, duration) => shorthands.sukses(title, message, duration),
        gagal:     (title, message, duration) => shorthands.gagal(title, message, duration),
        peringatan:(title, message, duration) => shorthands.peringatan(title, message, duration),
        informasi: (title, message, duration) => shorthands.informasi(title, message, duration),
    },

    // Interactive dialogs (modal, user action required)
    dialog: {
        confirm: (options) => engine.confirm(options),
        async: (options) => engine.asyncConfirm(options),
        hold: (options) => engine.holdConfirm(options),
        holdAsync: (options) => engine.holdConfirmAsync(options),

        // Intent-based factories — the intent selects the mechanic.
        danger:  (options) => engine.dialogDanger(options),
        warning: (options) => engine.dialogWarning(options),
        info:    (options) => engine.dialogInfo(options),
    },

    // Label alerts (single-button OK modal)
    label: {
        alert: (options) => engine.alert(options),
        readNote: (options) => engine.readNote(options),
    },

    // Utilities

    show: (options) => engine.show(options),
    dismiss: (id) => engine.dismiss(id),
    dismissReadNote: (id) => engine.dismissReadNote(id),
    setReadNoteProgress: (id, percent) => engine.setReadNoteProgress(id, percent),
    clearAll: () => engine.clearAll(),
    setLanguage: (lang) => engine.setLanguage(lang),

    // Solver is always HYBRID: analytic springs handle UI animations
    // (enter/exit/stack/morph, frame-rate independent, exact); RK4 handles
    // gesture physics (bump/drag, step-based, tactile feel). Each solver
    // patches the other's weaknesses. setSolver() kept for backward compat.
    setSolver: (mode) => {
        SOLVER.mode = 'hybrid';
        if (mode !== 'hybrid') {
            console.info('[QNotify] Hybrid solver enforced. Analytic handles UI animations, RK4 handles gesture physics.');
        }
    },

    setSolverDebug: (enabled) => { SOLVER.debug = Boolean(enabled); },
    getSolverConfig: () => ({ mode: SOLVER.mode, debug: SOLVER.debug }),

    // Dev tools — log-only, no production effect.
    setGlitchAudit: (enabled) => { setAuditMode(Boolean(enabled)); },
    enablePerfMonitor: () => { enablePerfMonitor(); },
    getFPS: () => getCurrentFPS(),
    getLayerCount: () => getLayerCount(),
    getDeviceCaps: () => DeviceCaps,
};

export default show;

// Expose on window for script-tag consumers. Kept narrow on purpose — the
// HTML bridge also sets window.QNotify, and 5 callers fall back to window.show.
if (typeof window !== 'undefined') {
    window.show          = show;
}
