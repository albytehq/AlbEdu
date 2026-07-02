// =============================================================================
// src/pages/index.js — Barrel export for page-specific controllers
// =============================================================================
//
// Page controllers are loaded directly by their respective HTML files via
// <script> tags. This barrel exists for discoverability — AI assistants
// can quickly see which page controllers exist.
// =============================================================================

// Page controllers are IIFEs that auto-initialize on DOMContentLoaded.
// They are NOT exported as globals — they bind to their respective pages only.

export const PAGES = [
    'buat-ujian.js',          // pages/admin/pages/buat-ujian.html
    'ujian-peserta.js',       // pages/admin/pages/ujian-peserta.html
    'daftar-nama.js',         // pages/admin/pages/daftar-nama.html
    'kerjakan-ujian.js',      // pages/ujian/kerjakan-ujian.html
    'ujian.js',               // pages/ujian/index.html
    'panel.js',               // pages/admin/index.html
];

export default PAGES;
