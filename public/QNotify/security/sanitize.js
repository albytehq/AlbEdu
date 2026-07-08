// QNotify Security — sanitize.js
// Central escape/sanitize utilities for all DOM builders. All user-controlled
// input (title, message, icon, button text, URLs) MUST pass through escapeHtml()
// or sanitizeUrl() before being interpolated into innerHTML.
//
// Usage:
//   import { escapeHtml, sanitizeUrl } from '../security/sanitize.js';
//   el.innerHTML = `<span>${escapeHtml(title)}</span>`;

// Escape HTML special characters in user-controlled strings. Prevents XSS when
// the string is later assigned to .innerHTML.
export function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Sanitize URL via scheme whitelist — blocks javascript:, data:, vbscript:,
// file: from being injected into href/src.
//
// Allowed: http:, https:, mailto:, tel:, and relative URLs (/, ./, ../, #, ?).
// Returns '' for anything else.
export function sanitizeUrl(url) {
  if (url === null || url === undefined) return '';
  const s = String(url).trim();
  // Case-insensitive match against the safe-scheme whitelist.
  if (/^(https?:|mailto:|tel:|\/|\.\/|\.\.\/|#|\?)/i.test(s)) {
    return s;
  }
  return '';
}

// Strip all HTML tags from a string — for plain-text contexts where the field
// should NEVER contain HTML (for example aria-label, title attribute).
export function stripHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/<[^>]*>/g, '');
}
