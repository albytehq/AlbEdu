// =============================================================================
// src/wizard/index.js — Barrel export for wizard feature
// =============================================================================
//
// All external consumers should import from this file, not from submodules.
// Internal files use IIFE pattern with window globals, so this barrel
// re-exports the window globals for ESM consumers.
//
// Usage (ESM):
//   import { WizardController, WizardDOM, WizardState, WizardValidation } from '../wizard/index.js';
//
// Usage (classic script):
//   WizardController, WizardDOM, WizardState, WizardValidation are available as window globals.
// =============================================================================

export const WizardController = window.WizardController;
export const WizardDOM        = window.WizardDOM;
export const WizardState      = window.WizardState;
export const WizardValidation = window.WizardValidation;

export default {
    WizardController,
    WizardDOM,
    WizardState,
    WizardValidation,
};
