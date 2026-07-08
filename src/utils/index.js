// src/utils/index.js — barrel export for shared utilities.
// All external consumers should import from this file, not from submodules.

export const UI                       = window.UI;
export const Navigasi                 = window.Navigasi;
export const ErrorManager             = window.ErrorManager;
export const MathRenderer             = window.MathRenderer;
export const MathPasteConverter       = window.MathPasteConverter;
export const imageCompress            = window.imageCompress;
export const imageCleanup             = window.imageCleanup;
export const SelfStorage              = window.SelfStorage;
export const AdminNotificationCenter  = window.AdminNotificationCenter;

// Native platform accessors — preferred over any legacy global.
export const SupabaseApi = {
    /** Native Supabase client (escape hatch). */
    get sb()       { return window.AlbEdu?.supabase?.client; },
    /** Native auth service. */
    get auth()     { return window.AlbEdu?.supabase?.auth; },
    /** Native repository (typed table access). */
    get repo()     { return window.AlbEdu?.repository; },
    /** Native realtime service. */
    get realtime() { return window.AlbEdu?.supabase?.realtime; },
    /** Native RPC service (Edge Function invocation). */
    get rpc()      { return window.AlbEdu?.supabase?.rpc; },
    /** True when the platform layer has bootstrapped. */
    get ready()    { return !!window.AlbEdu?.supabase?.isReady?.(); },
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
