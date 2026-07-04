// =============================================================================
// critical.js — AlbEdu Icon System · Critical Icon Registry (Layer 1)
// =============================================================================
// 16 critical icons bundled into the main icons.js. These are ALSO injected
// as an inline SVG sprite by critical-css.js so they render INSTANTLY on
// first paint (before any JS executes).
//
// Critical icons MUST satisfy ALL of these criteria:
//   1. Appears in the persistent app shell (navbar/sidebar/header/footer)
//   2. Appears on auth gates (login, register, forgot-password)
//   3. Used on EVERY page (or nearly every page)
//   4. Visible above the fold on first paint
//
// Do NOT add feature-specific icons here. Use secondary-registry.js instead.
//
// License: ISC (Lucide icons — https://lucide.dev)
// =============================================================================

window.AlbEdu = window.AlbEdu || {};
window.AlbEdu.__iconRegistryCritical = {
  'arrow_back': '<path d="m12 19-7-7 7-7" /><path d="M19 12H5" />',
  'arrow_forward': '<path d="M5 12h14" /><path d="m12 5 7 7-7 7" />',
  'chevron_left': '<path d="m15 18-6-6 6-6" />',
  'chevron_right': '<path d="m9 18 6-6-6-6" />',
  'close': '<path d="M18 6 6 18" /><path d="m6 6 12 12" />',
  'home': '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" /><path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />',
  'language': '<path d="m5 8 6 6" /><path d="m4 14 6-6 2-3" /><path d="M2 5h12" /><path d="M7 2h1" /><path d="m22 22-5-10-5 10" /><path d="M14 18h6" />',
  'login': '<path d="m10 17 5-5-5-5" /><path d="M15 12H3" /><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />',
  'logout': '<path d="m16 17 5-5-5-5" /><path d="M21 12H9" /><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />',
  'manage_accounts': '<path d="M10 15H6a4 4 0 0 0-4 4v2" /><path d="m14.305 16.53.923-.382" /><path d="m15.228 13.852-.923-.383" /><path d="m16.852 12.228-.383-.923" /><path d="m16.852 17.772-.383.924" /><path d="m19.148 12.228.383-.923" /><path d="m19.53 18.696-.382-.924" /><path d="m20.772 13.852.924-.383" /><path d="m20.772 16.148.924.383" /><circle cx="18" cy="15" r="3" /><circle cx="9" cy="7" r="4" />',
  'menu': '<path d="M4 5h16" /><path d="M4 12h16" /><path d="M4 19h16" />',
  'notifications': '<path d="M10.268 21a2 2 0 0 0 3.464 0" /><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />',
  'person': '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />',
  'person_add': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><line x1="19" x2="19" y1="8" y2="14" /><line x1="22" x2="16" y1="11" y2="11" />',
  'refresh': '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" />',
  'search': '<path d="m21 21-4.34-4.34" /><circle cx="11" cy="11" r="8" />',
};
