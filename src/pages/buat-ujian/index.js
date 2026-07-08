// src/pages/buat-ujian/index.js — barrel of buat-ujian modules (for
// discoverability only). The HTML page loads each module as a separate
// <script defer> tag in dependency order; this file is not loaded at runtime.
//
// Load order:
//   1. templates.js            → window.TemplatePicker, window.BU_TEMPLATES
//   2. keyboard-shortcuts.js   → window.KeyboardShortcuts
//   3. metadata-card.js        → window.MetadataCard
//   4. soal-editor-modal.js    → window.SoalEditorModal
//   5. soal-card.js            → window.SoalCard
//   6. publish-card.js         → window.PublishCard
//   7. wizard-controller.js    → window.WizardController
//   8. list-view.js            → window.ListView
//
// Page controller (separate file): src/pages/create-assessment.js → window.CreateAssessment

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
