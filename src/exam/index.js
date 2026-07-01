// =============================================================================
// src/exam/index.js — Barrel export for exam feature (v1.0.0)
// =============================================================================
//
// All external consumers should import from this file, not from submodules.
// Internal files use IIFE pattern with window globals, so this barrel
// re-exports the window globals for ESM consumers.
//
// v1.0.0 CLEANUP: Removed re-exports for deleted legacy modules —
//   ExamData, ExamExpiryManager, ExamIdentitySeparator, ExamLogic,
//   ExamViewer, ExamAdminController.
// Only ExamGuardian remains (used by the AntiCheat orchestrator).
// =============================================================================

export const ExamGuardian = window.ExamGuardian;

export default {
    ExamGuardian,
};
