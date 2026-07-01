// =============================================================================
// src/pages/buat-ujian/index.js — Barrel file for Buat Ujian v0.2.0 modules
// =============================================================================
// The HTML page (pages/admin/buat-ujian.html) loads each module as a
// separate <script defer> tag in dependency order. This barrel exists for
// discoverability — it documents the modules that compose the Buat Ujian
// page. It is NOT loaded as a runtime <script>; it's a pure ES module for
// documentation/external tooling only.
//
// Module dependency graph (load order matters):
//   1. templates.js            → window.TemplatePicker, window.BU_TEMPLATES
//   2. keyboard-shortcuts.js   → window.KeyboardShortcuts  (depends on BuatUjian, WizardController, PublishCard, SoalEditorModal)
//   3. metadata-card.js        → window.MetadataCard       (depends on BuatUjian)
//   4. soal-editor-modal.js    → window.SoalEditorModal    (depends on BuatUjian, notify)
//   5. soal-card.js            → window.SoalCard           (depends on BuatUjian, SoalEditorModal, TemplatePicker)
//   6. publish-card.js         → window.PublishCard        (depends on BuatUjian, UI, Auth, WizardController)
//   7. wizard-controller.js    → window.WizardController   (depends on BuatUjian, PublishCard, ListView)
//   8. list-view.js            → window.ListView           (depends on firebaseDb, firebaseAuth)
//
// Page controller (separate file): src/pages/create-assessment.js → window.CreateAssessment
//
// v0.2.0 changes:
//   - Removed settings-card.js (Pengaturan Lanjutan card deleted)
//   - Removed draft-storage.js (localStorage draft system removed)
//   - Added wizard-controller.js (step navigation)
//   - Added list-view.js (exam list with Supabase live updates)
// =============================================================================

export const BUAT_UJIAN_MODULES = [
  { name: 'TemplatePicker',    path: './templates.js' },
  { name: 'KeyboardShortcuts', path: './keyboard-shortcuts.js' },
  { name: 'MetadataCard',      path: './metadata-card.js' },
  { name: 'SoalEditorModal',   path: './soal-editor-modal.js' },
  { name: 'SoalCard',          path: './soal-card.js' },
  { name: 'PublishCard',       path: './publish-card.js' },
  { name: 'WizardController',  path: './wizard-controller.js' },
  { name: 'ListView',          path: './list-view.js' },
];

export default BUAT_UJIAN_MODULES;
