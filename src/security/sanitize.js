// =============================================================================
// sanitize.js — AlbEdu Security Layer · DOM sanitization
// =============================================================================
// Single responsibility: provide safe DOM insertion helpers that consumers
// use instead of raw innerHTML. All user-controlled content MUST go through
// these helpers.
//
// Strategy:
//   1. escapeHtml(str) — pure text escaping. Use for text content.
//   2. sanitizeHtml(str, allowedTags) — DOMPurify-style allowlist filtering.
//      Falls back to a tag-stripping allowlist if DOMPurify isn't loaded.
//   3. setText(el, str) — sets textContent safely.
//   4. setHTML(el, str, allowedTags) — sanitizes then sets innerHTML.
//
// Consumers MUST call these instead of `el.innerHTML = userInput`.
// =============================================================================

(function () {
  'use strict';

  const HTML_ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
  }

  // Default allowlist — conservative. Callers can extend for specific use cases.
  const DEFAULT_ALLOWED_TAGS = new Set([
    'b', 'i', 'em', 'strong', 'br', 'p', 'ul', 'ol', 'li',
    'span', 'sub', 'sup', 'u', 's', 'ruby', 'rt', 'rp', 'bdi', 'bdo', 'mark',
    'code', 'pre', 'blockquote',
  ]);

  const DEFAULT_ALLOWED_ATTRS = new Set([
    'class', 'lang', 'dir',
  ]);

  // Tag-stripping sanitizer — fallback when DOMPurify is not available.
  // Walks the DOM, removes any tag not in the allowlist, drops all attributes
  // except those in the attrs allowlist.
  function _fallbackSanitize(html, allowedTags = DEFAULT_ALLOWED_TAGS, allowedAttrs = DEFAULT_ALLOWED_ATTRS) {
    if (!html) return '';
    const template = document.createElement('template');
    template.innerHTML = String(html);

    const _walk = (node) => {
      // Remove comments, processing instructions
      if (node.nodeType === Node.COMMENT_NODE || node.nodeType === Node.PROCESSING_INSTRUCTION_NODE) {
        node.parentNode?.removeChild(node);
        return;
      }
      // Script/style/iframe/marquee — remove entirely
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName.toLowerCase();
        const dangerous = ['script', 'style', 'iframe', 'object', 'embed', 'marquee', 'meta', 'link', 'base', 'form', 'input', 'button'];
        if (dangerous.includes(tag)) {
          node.parentNode?.removeChild(node);
          return;
        }
        if (!allowedTags.has(tag)) {
          // Replace element with its children (don't lose content)
          const parent = node.parentNode;
          while (node.firstChild) parent?.insertBefore(node.firstChild, node);
          parent?.removeChild(node);
          return;
        }
        // Strip non-allowlisted attributes
        for (const attr of Array.from(node.attributes)) {
          const name = attr.name.toLowerCase();
          if (!allowedAttrs.has(name)) {
            node.removeAttribute(attr.name);
          } else if (name === 'href' || name === 'src') {
            // Block javascript: URLs
            const val = attr.value.trim().toLowerCase();
            if (val.startsWith('javascript:') || val.startsWith('data:text/html')) {
              node.removeAttribute(attr.name);
            }
          }
        }
      }
      // Recurse
      if (node.childNodes) {
        for (const child of Array.from(node.childNodes)) _walk(child);
      }
    };

    _walk(template.content);
    return template.innerHTML;
  }

  function sanitizeHtml(html, opts = {}) {
    const allowedTags = opts.allowedTags
      ? new Set(opts.allowedTags)
      : DEFAULT_ALLOWED_TAGS;
    const allowedAttrs = opts.allowedAttrs
      ? new Set(opts.allowedAttrs)
      : DEFAULT_ALLOWED_ATTRS;

    // If DOMPurify is loaded, prefer it — it has stronger XSS protection.
    if (typeof window.DOMPurify !== 'undefined' && window.DOMPurify.sanitize) {
      return window.DOMPurify.sanitize(html, {
        ALLOWED_TAGS: Array.from(allowedTags),
        ALLOWED_ATTR: Array.from(allowedAttrs),
        ALLOW_DATA_ATTR: false,
      });
    }
    return _fallbackSanitize(html, allowedTags, allowedAttrs);
  }

  function setText(el, str) {
    if (!el) return;
    el.textContent = str == null ? '' : String(str);
  }

  function setHTML(el, html, opts) {
    if (!el) return;
    el.innerHTML = sanitizeHtml(html, opts);
  }

  // ── Public surface ─────────────────────────────────────────────────────
  if (!window.AlbEdu) window.AlbEdu = {};
  window.AlbEdu.sanitize = {
    escapeHtml,
    sanitizeHtml,
    setText,
    setHTML,
    DEFAULT_ALLOWED_TAGS,
    DEFAULT_ALLOWED_ATTRS,
  };

  // Convenience globals (used by existing code that calls escapeHTML directly)
  window.escapeHTML = escapeHtml;
})();
