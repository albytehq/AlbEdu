// =============================================================================
// src/exam/index.js — Barrel export for exam feature
// =============================================================================
//
// All external consumers should import from this file, not from submodules.
// Internal files use IIFE pattern with window globals, so this barrel
// re-exports the window globals for ESM consumers.
// =============================================================================

export const ExamData               = window.ExamData;
export const ExamExpiryManager      = window.ExamExpiryManager;
export const ExamGuardian           = window.ExamGuardian;
export const ExamIdentitySeparator  = window.ExamIdentitySeparator;
export const ExamLogic              = window.ExamLogic;
export const ExamViewer             = window.ExamViewer;
export const ExamAdminController    = window.ExamAdminController;

export default {
    ExamData,
    ExamExpiryManager,
    ExamGuardian,
    ExamIdentitySeparator,
    ExamLogic,
    ExamViewer,
    ExamAdminController,
};
