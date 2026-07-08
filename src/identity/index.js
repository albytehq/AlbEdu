// src/identity/index.js — Barrel export for identity feature.
// External consumers should import from this file, not from submodules.

export const IdentityFormBuilder  = window.IdentityFormBuilder;
export const IdentityFormRenderer = window.IdentityFormRenderer;
export const IdentityProvider     = window.IdentityProvider;

export default {
    IdentityFormBuilder,
    IdentityFormRenderer,
    IdentityProvider,
};
