// MathPasteConverter.js — v0.3.0
// Feature 6: Smart Paste — intercept clipboard paste events in admin textarea/input
// elements and auto-convert Unicode math symbols to LaTeX ($...$) syntax.
//
// Supports paste from: Word, Google Docs, WhatsApp, plaintext editors.
// Does NOT process PDF clipboard content (encoding too inconsistent).
//
// Usage:
//   MathPasteConverter.attachTo(el)        — attach to a single element
//   MathPasteConverter.attachToAll(sel)    — attach to all matching selector
//   MathPasteConverter.convert(rawText)    — convert string, return LaTeX string
//
// Load this AFTER MathRenderer.js (KaTeX must be available for preview rendering).

window.MathPasteConverter = (() => {

  // ── Unicode → LaTeX character map ──────────────────────────────────────────
  // Keys: single Unicode characters.
  // Values: LaTeX replacement (math symbols wrapped in $...$).
  // Characters NOT in this map are passed through unchanged.
  const UNICODE_TO_LATEX_MAP = {
    // Basic math operators
    '÷': '$\\div$',
    '×': '$\\times$',
    '±': '$\\pm$',
    '∓': '$\\mp$',
    '≠': '$\\neq$',
    '≤': '$\\leq$',
    '≥': '$\\geq$',
    '≈': '$\\approx$',
    '≡': '$\\equiv$',
    '∞': '$\\infty$',
    '°': '$^{\\circ}$',
    // Roots
    '√': '$\\sqrt{}$',   // NOTE: content after √ becomes {} argument — acceptable minimum
    '∛': '$\\sqrt[3]{}$',
    '∜': '$\\sqrt[4]{}$',
    // Superscripts
    '²': '$^{2}$',
    '³': '$^{3}$',
    '⁴': '$^{4}$',
    '⁵': '$^{5}$',
    '⁶': '$^{6}$',
    '⁷': '$^{7}$',
    '⁸': '$^{8}$',
    '⁹': '$^{9}$',
    '⁰': '$^{0}$',
    '⁻': '$^{-}$',
    '⁺': '$^{+}$',
    // Subscripts
    '₀': '$_{0}$',
    '₁': '$_{1}$',
    '₂': '$_{2}$',
    '₃': '$_{3}$',
    '₄': '$_{4}$',
    '₅': '$_{5}$',
    '₆': '$_{6}$',
    '₇': '$_{7}$',
    '₈': '$_{8}$',
    '₉': '$_{9}$',
    // Fractions
    '½': '$\\frac{1}{2}$',
    '⅓': '$\\frac{1}{3}$',
    '⅔': '$\\frac{2}{3}$',
    '¼': '$\\frac{1}{4}$',
    '¾': '$\\frac{3}{4}$',
    '⅕': '$\\frac{1}{5}$',
    '⅖': '$\\frac{2}{5}$',
    '⅗': '$\\frac{3}{5}$',
    '⅘': '$\\frac{4}{5}$',
    '⅙': '$\\frac{1}{6}$',
    '⅚': '$\\frac{5}{6}$',
    '⅛': '$\\frac{1}{8}$',
    '⅜': '$\\frac{3}{8}$',
    '⅝': '$\\frac{5}{8}$',
    '⅞': '$\\frac{7}{8}$',
    // Calculus / analysis
    '∑': '$\\sum$',
    '∏': '$\\prod$',
    '∫': '$\\int$',
    '∂': '$\\partial$',
    '∇': '$\\nabla$',
    '∆': '$\\Delta$',
    // Greek lowercase
    'α': '$\\alpha$',
    'β': '$\\beta$',
    'γ': '$\\gamma$',
    'δ': '$\\delta$',
    'ε': '$\\epsilon$',
    'ζ': '$\\zeta$',
    'η': '$\\eta$',
    'θ': '$\\theta$',
    'ι': '$\\iota$',
    'κ': '$\\kappa$',
    'λ': '$\\lambda$',
    'μ': '$\\mu$',
    'ν': '$\\nu$',
    'ξ': '$\\xi$',
    'ο': 'o',        // omicron looks like 'o' — don't convert, leave as Latin
    'π': '$\\pi$',
    'ρ': '$\\rho$',
    'σ': '$\\sigma$',
    'τ': '$\\tau$',
    'υ': '$\\upsilon$',
    'φ': '$\\phi$',
    'χ': '$\\chi$',
    'ψ': '$\\psi$',
    'ω': '$\\omega$',
    // Greek uppercase
    'Γ': '$\\Gamma$',
    'Δ': '$\\Delta$',
    'Θ': '$\\Theta$',
    'Λ': '$\\Lambda$',
    'Ξ': '$\\Xi$',
    'Π': '$\\Pi$',
    'Σ': '$\\Sigma$',
    'Υ': '$\\Upsilon$',
    'Φ': '$\\Phi$',
    'Ψ': '$\\Psi$',
    'Ω': '$\\Omega$',
    // Geometry & logic
    '∠': '$\\angle$',
    '△': '$\\triangle$',
    '⊥': '$\\perp$',
    '∥': '$\\parallel$',
    '→': '$\\rightarrow$',
    '←': '$\\leftarrow$',
    '↔': '$\\leftrightarrow$',
    '⇒': '$\\Rightarrow$',
    '⇐': '$\\Leftarrow$',
    '⇔': '$\\Leftrightarrow$',
    '↑': '$\\uparrow$',
    '↓': '$\\downarrow$',
    // Set theory
    '∈': '$\\in$',
    '∉': '$\\notin$',
    '⊂': '$\\subset$',
    '⊃': '$\\supset$',
    '⊆': '$\\subseteq$',
    '⊇': '$\\supseteq$',
    '∪': '$\\cup$',
    '∩': '$\\cap$',
    '∅': '$\\emptyset$',
    '∀': '$\\forall$',
    '∃': '$\\exists$',
    '¬': '$\\neg$',
    '∧': '$\\wedge$',
    '∨': '$\\vee$',
    // Misc math
    '∝': '$\\propto$',
    '∼': '$\\sim$',
    '∴': '$\\therefore$',
    '∵': '$\\because$',
    '⌊': '$\\lfloor$',
    '⌋': '$\\rfloor$',
    '⌈': '$\\lceil$',
    '⌉': '$\\rceil$',
    // WHY no '%': percent sign is NOT a math symbol in LaTeX context — leave as-is
    // WHY no Arab/CJK: those are handled by MathRenderer.js RTL support — don't touch
  };

  // ── Pattern-based replacements (multi-char) ──────────────────────────────
  // Applied AFTER character-by-character substitution.
  // Patterns are ordered from most specific to most general.
  const PATTERN_REPLACEMENTS = [
    // "integer/integer" → \frac{}{} — only when surrounded by word boundaries
    // Guards: not in a URL (no http:// prefix), both sides pure digits.
    // WHY: "3/4 dari" → "$\frac{3}{4}$ dari" — very common in Indonesian math problems
    {
      re: /(?<![/:.\w])(\d+)\/(\d+)(?![\w/])/g,
      fn: (_, n, d) => `$\\frac{${n}}{${d}}$`,
    },
  ];

  // ── Smart Merge: split on existing $...$ delimiters ─────────────────────
  // Segments inside existing LaTeX blocks are preserved exactly.
  // Only segments OUTSIDE $...$ get converted.
  //
  // Handles: $...$  $$...$$  \(...\)  \[...\]
  // WHY regex split: simple, predictable, handles nested delimiters correctly
  // for teacher input (which will not have absurdly nested math).
  const MATH_BLOCK_RE = /(\$\$[\s\S]*?\$\$|\$[^$\n]+?\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\))/g;

  function _splitByExistingMath(text) {
    // Returns array of { text, isMath } segments
    const segments = [];
    let lastIdx = 0;
    let m;
    MATH_BLOCK_RE.lastIndex = 0;
    while ((m = MATH_BLOCK_RE.exec(text)) !== null) {
      if (m.index > lastIdx) {
        segments.push({ text: text.slice(lastIdx, m.index), isMath: false });
      }
      segments.push({ text: m[0], isMath: true });
      lastIdx = m.index + m[0].length;
    }
    if (lastIdx < text.length) {
      segments.push({ text: text.slice(lastIdx), isMath: false });
    }
    return segments;
  }

  function _convertSegment(rawText) {
    if (!rawText) return rawText;

    // Step 1: character-by-character substitution from the lookup table
    let result = '';
    for (const char of rawText) {
      result += UNICODE_TO_LATEX_MAP[char] ?? char;
    }

    // Step 2: multi-char pattern replacements
    for (const { re, fn } of PATTERN_REPLACEMENTS) {
      re.lastIndex = 0;
      result = result.replace(re, fn);
    }

    return result;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Convert a raw text string, replacing Unicode math symbols with LaTeX.
   * Segments already inside $...$ or \(...\) are left untouched.
   *
   * @param {string} rawText
   * @returns {string} text with LaTeX substitutions
   */
  function convert(rawText) {
    if (!rawText || !rawText.trim()) return rawText || '';

    const segments = _splitByExistingMath(rawText);
    return segments
      .map(seg => seg.isMath ? seg.text : _convertSegment(seg.text))
      .join('');
  }

  /**
   * Extract text from clipboard HTML (strips formatting, preserves content + newlines).
   * Word/GDocs paste arrives as HTML — we extract text, discarding layout noise.
   */
  function _extractFromHtml(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;

    // Preserve newlines from block-level tags before stripping markup
    tmp.querySelectorAll('p, div, tr, li, br').forEach(el => {
      el.insertAdjacentText('afterend', '\n');
    });
    tmp.querySelectorAll('td, th').forEach(el => {
      el.insertAdjacentText('afterend', '\t');
    });

    return tmp.textContent || tmp.innerText || '';
  }

  /**
   * Insert text at the current cursor position in a textarea or input.
   * Replaces current selection if any.
   * Dispatches 'input' event so Vue/React watchers and preview handlers are notified.
   */
  function _insertAtCursor(el, text) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const start = el.selectionStart ?? 0;
      const end   = el.selectionEnd   ?? 0;
      const val   = el.value;
      el.value = val.slice(0, start) + text + val.slice(end);
      const newCaret = start + text.length;
      el.selectionStart = newCaret;
      el.selectionEnd   = newCaret;
      // Notify listeners (preview renderers, character counters, etc.)
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (el.contentEditable === 'true') {
      // execCommand is deprecated but still the best way to get undo-able inserts
      document.execCommand('insertText', false, text);
    }
  }

  /**
   * Attach a smart-paste interceptor to a single form element.
   * Safe to call multiple times on the same element (uses a data flag to prevent double-attach).
   *
   * @param {HTMLElement} el - textarea or input[type=text] element
   */
  function attachTo(el) {
    if (!el || el.dataset.mathPasteAttached) return;
    el.dataset.mathPasteAttached = 'true';

    el.addEventListener('paste', (e) => {
      e.preventDefault();

      const html  = e.clipboardData?.getData('text/html')  || '';
      const plain = e.clipboardData?.getData('text/plain') || '';

      // Prioritize HTML if available (richer content from Word/GDocs)
      // but extract only text — we don't want formatting artifacts
      let raw = '';
      if (html && html.trim().length > 0) {
        raw = _extractFromHtml(html);
      } else {
        raw = plain;
      }

      // Handle absurdly long pastes gracefully — convert but warn
      const MAX_CONVERT_LEN = 10_000;
      if (raw.length > MAX_CONVERT_LEN) {
        console.warn('[MathPasteConverter] Paste content is very long (', raw.length, 'chars). Converting anyway.');
      }

      const converted = convert(raw);
      _insertAtCursor(el, converted);

      // F4 integration: trigger KaTeX preview if there's a preview container nearby.
      // Preview containers should have data-preview-for attribute pointing to the input id.
      // This is a best-effort — no crash if preview element isn't found.
      _triggerPreview(el);
    });
  }

  /**
   * Attach paste interceptor to all elements matching a CSS selector.
   * Useful for static form elements. For dynamically rendered elements,
   * call attachTo(el) directly after each DOM insertion.
   *
   * @param {string} selector - CSS selector string
   * @param {Element} [root=document] - Optional root element to query within
   */
  function attachToAll(selector, root) {
    const parent = root || document;
    parent.querySelectorAll(selector).forEach(attachTo);
  }

  /**
   * Trigger KaTeX preview re-render for an input element.
   * Looks for a preview container: [data-preview-for="<el.id>"] or .preview-soal-text sibling.
   * Debounced at 300ms to avoid thrashing during rapid keystrokes.
   */
  const _previewTimers = new WeakMap();

  function _triggerPreview(el) {
    if (typeof window.renderMathIn !== 'function') return;

    // Clear pending debounce for this element
    if (_previewTimers.has(el)) clearTimeout(_previewTimers.get(el));

    const timer = setTimeout(() => {
      // Try explicit data-preview-for link first
      const id = el.id;
      const previewEl = id
        ? document.querySelector(`[data-preview-for="${id}"]`)
        : null;

      // Fallback: nearest .preview-soal-text in the same form group
      const target = previewEl
        || el.closest('.soal-input-group')?.querySelector('.preview-soal-text')
        || el.closest('.wizard-step')?.querySelector('.preview-soal-text');

      if (target) {
        // Mirror textarea content to preview container (sanitized)
        const content = el.value || '';
        // Truncate preview for very long input — rendering 10k chars of KaTeX is slow
        const PREVIEW_MAX = 500;
        if (content.length > PREVIEW_MAX) {
          target.textContent = content.slice(0, PREVIEW_MAX) + '…';
          const hint = target.nextElementSibling;
          if (hint?.classList.contains('preview-truncated-hint')) {
            hint.hidden = false;
          }
        } else {
          target.innerHTML = content;
          const hint = target.nextElementSibling;
          if (hint?.classList.contains('preview-truncated-hint')) {
            hint.hidden = true;
          }
        }
        window.renderMathIn(target);
        if (typeof window.applyLangClass === 'function') window.applyLangClass(target);
      }
      _previewTimers.delete(el);
    }, 300);

    _previewTimers.set(el, timer);
  }

  return { convert, attachTo, attachToAll };
})();
