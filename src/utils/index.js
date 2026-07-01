// =============================================================================
// src/utils/index.js — Barrel export for shared utilities
// =============================================================================
//
// All external consumers should import from this file, not from submodules.
// =============================================================================

export const UI                       = window.UI;
export const Navigasi                 = window.Navigasi;
export const ErrorManager             = window.ErrorManager;
export const MathRenderer             = window.MathRenderer;
export const MathPasteConverter       = window.MathPasteConverter;
export const imageCompress            = window.imageCompress;
export const imageCleanup             = window.imageCleanup;
export const SelfStorage              = window.SelfStorage;
export const AdminNotificationCenter  = window.AdminNotificationCenter;

// SupabaseApi.js exposes window.sb (Supabase client) + window.firebaseAuth/firebaseDb shims.
// It doesn't expose a single object — consumers use window.sb directly.
export const SupabaseApi = {
    get sb()           { return window.sb; },
    get firebaseAuth() { return window.firebaseAuth; },
    get firebaseDb()   { return window.firebaseDb; },
};

export default {
    UI,
    Navigasi,
    ErrorManager,
    MathRenderer,
    MathPasteConverter,
    imageCompress,
    imageCleanup,
    SelfStorage,
    AdminNotificationCenter,
    SupabaseApi,
};
