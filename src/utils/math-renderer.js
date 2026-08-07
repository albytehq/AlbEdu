// MathRenderer.js — KaTeX auto-render for math expressions + RTL/Arab/CJK
// auto-detect with CSS class injection.
//
// Load this AFTER KaTeX CDN scripts. Both functions are idempotent — safe to
// call multiple times on the same container (for example, after pagination).

/**
 * Render all math expressions inside a container element using KaTeX auto-render.
 * Safe to call before KaTeX has loaded — schedules render on 'katex-ready' event.
 * Safe to call multiple times — KaTeX auto-render is idempotent on already-rendered spans.
 *
 * Supported delimiters:
 *   $$...$$ → display block (centered, own line)
 *   $...$   → inline math
 *   \(...\) → inline math (LaTeX standard)
 *   \[...\] → display block (LaTeX standard)
 *
 * @param {Element|null} containerEl - The DOM element to search for math
 */
window.renderMathIn = function(containerEl) {
  if (!containerEl) return;

  function _doRender() {
    if (typeof renderMathInElement !== 'function') return;
    try {
      renderMathInElement(containerEl, {
        delimiters: [
          { left: '$$',  right: '$$',  display: true  },
          { left: '$',   right: '$',   display: false },
          { left: '\\(', right: '\\)', display: false },
          { left: '\\[', right: '\\]', display: true  },
        ],
        throwOnError: false,  // keep rendering even if one expression is malformed
        errorColor:   '#e53e3e',
        strict:       false,  // tolerate unknown commands — teachers may paste them
      });
    } catch (_) {
      // Fail silently — a bad expression must not crash the whole exam page
    }
  }

  if (window.__katexReady) {
    _doRender();
  } else {
    // KaTeX scripts are defer-loaded — wait for the ready signal, then render
    window.addEventListener('katex-ready', _doRender, { once: true });
  }
};

/**
 * Scan text nodes inside a container for non-LTR scripts.
 * Adds .lang-ar or .lang-cjk CSS class to matching elements.
 * Does NOT modify elements that already have these classes (idempotent).
 *
 * Selectors targeted: question text, option values, catatan, detail text, previews.
 * Extend the selector list if new content areas are added to the UI.
 *
 * @param {Element|null} el - The root element to scan
 */
window.applyLangClass = function(el) {
  if (!el) return;

  const TARGETS_SELECTOR = [
    '.question-text',
    '.option-value',
    '.soal-card-body',
    '.detail-pertanyaan',
    '.catatan-text',
    '.modal-body p',
    '.preview-soal-text',
    '.hj-chip',
  ].join(', ');

  // Unicode ranges for script detection
  // Arab/Persia/Urdu: U+0600–U+06FF, U+0750–U+077F, U+FB50–U+FDFF, U+FE70–U+FEFF
  const ARABIC_RE  = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
  // Hebrew: U+0590–U+05FF
  const HEBREW_RE  = /[\u0590-\u05FF]/;
  // CJK Unified: Mandarin, Japanese, Korean
  const CJK_RE     = /[\u4E00-\u9FFF\u3400-\u4DBF\u3040-\u30FF\uAC00-\uD7AF]/;

  const targets = el.querySelectorAll(TARGETS_SELECTOR);

  targets.forEach(t => {
    // Skip if already classified — avoids flicker on re-renders
    if (t.classList.contains('lang-ar') || t.classList.contains('lang-cjk')) return;

    const text = t.textContent || '';
    if (!text.trim()) return;

    if (ARABIC_RE.test(text) || HEBREW_RE.test(text)) {
      t.classList.add('lang-ar');
      // Let CSS handle direction via unicode-bidi: plaintext — don't force dir attr
      // as it would override mixed-script paragraphs incorrectly.
    } else if (CJK_RE.test(text)) {
      t.classList.add('lang-cjk');
    }
  });
};
