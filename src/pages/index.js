// =============================================================================
// src/pages/index.js — Barrel export for page-specific controllers (v1.0.0)
// =============================================================================
//
// Page controllers are loaded directly by their respective HTML files via
// <script> tags. This barrel exists for discoverability — AI assistants
// can quickly see which page controllers exist.
//
// v1.0.0: Removed legacy entries (buat-ujian.js, ujian-peserta.js,
//         kerjakan-ujian.js, ujian.js) — replaced by create-assessment.js,
//         active-assessments.js, take-assessment.js, assessment-entry.js.
// =============================================================================

// Page controllers are IIFEs that auto-initialize on DOMContentLoaded.
// They are NOT exported as globals — they bind to their respective pages only.

export const PAGES = [
    'create-assessment.js',   // pages/admin/create-assessment.html
    'active-assessments.js',  // pages/admin/active-assessments.html
    'results-analytics.js',   // pages/admin/results-analytics.html
    'assessment-entry.js',    // pages/assessment/index.html
    'take-assessment.js',     // pages/assessment/take.html
    'daftar-nama.js',         // pages/admin/daftar-nama.html
    'panel.js',               // pages/admin/index.html
];

export default PAGES;
