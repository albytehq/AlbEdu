// QNotify Security — sanitize.js
// Phase 12 fix (Q1-Q5): central escape/sanitize utilities for all DOM builders.
// All user-controlled input (title, message, icon, button text, URLs) MUST pass
// through escapeHtml() or sanitizeUrl() before being interpolated into innerHTML.
//
// Usage:
//   import { escapeHtml, sanitizeUrl } from '../security/sanitize.js';
//   el.innerHTML = `<span>${escapeHtml(title)}</span>`;

/**
 * Escape HTML special characters in user-controlled strings.
 * Prevents XSS when the string is later assigned to .innerHTML.
 *
 * @param {string} s - Input string (null/undefined → empty string)
 * @returns {string} Escaped string safe for innerHTML interpolation
 */
export function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Sanitize URL — whitelist only safe schemes.
 * Prevents javascript:, data:, vbscript: URLs from being injected into href/src.
 *
 * Allowed schemes:
 *   - http:, https: (absolute URLs)
 *   - mailto:, tel: (contact links)
 *   - relative URLs: /, ./, ../, #, ?
 *
 * @param {string} url - Input URL
 * @returns {string} Sanitized URL, or '' if unsafe scheme detected
 */
export function sanitizeUrl(url) {
  if (url === null || url === undefined) return '';
  const s = String(url).trim();
  // Whitelist: must start with one of these schemes/prefixes
  // Case-insensitive, allows leading whitespace already trimmed
  if (/^(https?:|mailto:|tel:|\/|\.\/|\.\.\/|#|\?)/i.test(s)) {
    return s;
  }
  // Block: javascript:, data:, vbscript:, file:, etc.
  return '';
}

/**
 * Strip all HTML tags from a string — for plain-text contexts.
 * Used when the field should NEVER contain HTML (e.g. aria-label, title attribute).
 *
 * @param {string} s - Input string
 * @returns {string} Plain text with all tags removed
 */
export function stripHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/<[^>]*>/g, '');
}
