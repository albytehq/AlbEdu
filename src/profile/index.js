// =============================================================================
// src/profile/index.js — Barrel export for profile feature
// =============================================================================
//
// All external consumers should import from this file, not from submodules.
// =============================================================================

export const OptionProfile       = window.OptionProfile;
export const ProfileEditorPanel  = window.ProfileEditorPanel;

export default {
    OptionProfile,
    ProfileEditorPanel,
};
