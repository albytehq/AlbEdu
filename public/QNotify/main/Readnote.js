// Readnote.js — Qnotify v8.0.5
/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  Qnotify — Readnote.js  [v7.4.0 UPGRADE]                   ║
 * ║  "Label Family — ReadNote Factory"                          ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * CHANGES v7.4.0:
 *
 *  [U1] REMOVED 40ms setTimeout delay before content reveal.
 *       Content items now animate in immediately when card springs settle.
 *       onPartRest fires _animateContentIn_Testing directly — zero gap.
 *
 *  [U2] Easing stagger — item delays accelerate (55→40→28ms) rather
 *       than flat 55ms per item. First item is always instant (0ms).
 *       Formula: delay[i] = sum of gaps[0..i-1], gaps shrink by 0.72x each step.
 *
 *  [U3] Shadow spring on card enter — card box-shadow "rises" from
 *       near-zero to full as card scales in. Compositor-safe: uses
 *       a single CSS custom property (--rn-shadow-lift, 0→1) that
 *       drives a CSS interpolation via inline style. Cleared after rest.
 *
 *  [U4] Close button deferred enter animation — rn-close-btn is hidden
 *       (opacity:0, translateX:14px) until ALL content items finish
 *       revealing. Then fades in from the right via spring.
 *       Prevents accidental tap before user has seen the content.
 *
 *  [U5] Continue button jiggly-bounce on unlock — single physics bounce
 *       (scale 0.88 → 1.12 → 1.0) via underdamped spring, fires once.
 *       No pulse, no repeat. Replaces old scale-pop.
 *
 *  [U6] Multi-step ReadNote — optional steps[] array.
 *       - steps: [{ title, body }]  — if provided, enables paginated mode.
 *       - Footer shows "Lanjut 1/3 →" / "Continue 1/3 →", last step → "Selesai/Done".
 *       - Step transition: current content exits left (translateX -32px + fade),
 *         next content enters right (translateX +32px + fade). Spring driven.
 *       - Progress bar auto-advances per step.
 *       - scroll-progress re-wired per step if readType === 'required'.
 *       - single-step (no steps[] or steps.length===1) → behavior identical to v7.3.
 *
 *  [UNCHANGED] All Family-other files (label.js, dialog.js, motion.js,
 *       notify.css, label.css) are not touched.
 *       spring.js is only consumed, never modified.
 *       engine.js: one targeted addition in readNote() for steps[] passthrough.
 */

import { acquireSpring } from './spring.js';
import { escapeHtml, sanitizeUrl } from '../security/sanitize.js';
// [v7.5.0] glitch.js: stampInitialState already ran before DOM insert (from engine.js).
// animateReadNoteEnter must NOT re-write card opacity/transform — it conflicts.
// clearInitialState is called on exit to release GPU compositor layer.
import { clearInitialState } from './glitch.js';

// ════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════

const _clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function _aSpring(cfg) {
    return acquireSpring(cfg, 'analytic');
}

// ════════════════════════════════════════════════════════════
//  EASING STAGGER  [U2]
//  Gaps shrink by 0.72x each step: 55, 39, 28, 20, 14 …
//  First item always instant (delay=0).
// ════════════════════════════════════════════════════════════

function _buildStaggerDelays(count) {
    const delays = [];
    let acc  = 0;
    let gap  = 55;
    for (let i = 0; i < count; i++) {
        delays.push(Math.round(acc));
        acc += gap;
        gap  = Math.max(gap * 0.72, 12); // floor at 12ms
    }
    return delays;
}

// ════════════════════════════════════════════════════════════
//  SHADOW SPRING UTILS  [U3]
//  We interpolate between two shadow strings using a 0-1 scalar.
//  Only opacity/blur values shift — no layout properties.
// ════════════════════════════════════════════════════════════

function _applyShadowLift(card, t) {
    // t: 0 (card just appeared) → 1 (fully settled)
    const t2 = _clamp(t, 0, 1);
    // Layer 1: ambient — always present but lighter at start
    const a1 = (0.02 + 0.04 * t2).toFixed(3);
    // Layer 2: blue mid — scale blur from 8 to 24
    const blur2 = (8 + 16 * t2).toFixed(1);
    const a2    = (0.06 + 0.08 * t2).toFixed(3);
    // Layer 3: blue deep — scale blur from 20 to 64
    const blur3 = (20 + 44 * t2).toFixed(1);
    const a3    = (0.04 + 0.06 * t2).toFixed(3);
    card.style.boxShadow = [
        `0 2px 6px rgba(0,0,0,${a1})`,
        `0 8px ${blur2}px rgba(0,100,220,${a2})`,
        `0 24px ${blur3}px rgba(0,80,200,${a3})`,
        `inset 0 1px 0 rgba(255,255,255,0.95)`,
    ].join(', ');
}

function _clearShadowLift(card) {
    // Remove inline shadow so CSS var takes over again
    card.style.boxShadow = '';
}

// ════════════════════════════════════════════════════════════
//  MARKDOWN PARSER  (lightweight, no dependencies)
// ════════════════════════════════════════════════════════════

/**
 * Sanitize raw string — escapes HTML special chars to prevent injection.
 * Applied to every text node before any markdown transformation.
 */
function _sanitizeHTML(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Parse a subset of Markdown into safe HTML.
 *
 * Supported syntax:
 *   Block:
 *     # H1  ## H2  ### H3  #### H4
 *     > blockquote
 *     --- / *** / ___  → <hr>
 *     ```code block```
 *     - item / * item / + item   → <ul>
 *     1. item                    → <ol>
 *     blank line                 → paragraph break
 *   Inline:
 *     **bold** / __bold__
 *     *italic* / _italic_
 *     ~~strikethrough~~
 *     `inline code`
 *     [text](url)
 *
 * Text wrapping: long words are naturally broken by CSS (word-break: break-word).
 * No horizontal scroll is produced — overflow-x: hidden on .rn-content.
 *
 * @param {string} raw  — raw user-supplied string (may contain markdown)
 * @returns {string}    — safe HTML string
 */
function _parseMarkdown(raw) {
    if (!raw || typeof raw !== 'string') return '';

    const lines  = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const out    = [];
    let i        = 0;
    let inList   = null;   // 'ul' | 'ol' | null
    let inPara   = false;

    const closePara = () => {
        if (inPara) { out.push('</p>'); inPara = false; }
    };
    const closeList = () => {
        if (inList) { out.push(`</${inList}>`); inList = null; }
    };
    const flushBlock = () => { closePara(); closeList(); };

    // Inline transformer — runs after block structure is parsed
    const inline = (text) => {
        // 1. Sanitize first
        let s = _sanitizeHTML(text);
        // 2. Links  [text](url)
        // Q5 fix: replaced blacklist (only stripped javascript:) with whitelist
        // sanitizer — blocks data:, vbscript:, file:, tab-prefixed variants too.
        s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => {
            const safeU = sanitizeUrl(u);
            if (!safeU) return ''; // drop unsafe URL entirely
            return `<a href="${safeU}" target="_blank" rel="noopener noreferrer">${t}</a>`;
        });
        // 3. Bold **text** or __text__
        s = s.replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => `<strong>${a || b}</strong>`);
        // 4. Italic *text* or _text_ (single, not double)
        s = s.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)|(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g,
            (_, a, b) => `<em>${a || b}</em>`);
        // 5. Strikethrough ~~text~~
        s = s.replace(/~~(.+?)~~/g, (_, a) => `<s>${a}</s>`);
        // 6. Inline code `code`
        s = s.replace(/`([^`]+)`/g, (_, a) => `<code>${a}</code>`);
        return s;
    };

    while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();

        // ── Code block (``` ... ```) ─────────────────────────
        if (trimmed.startsWith('```')) {
            flushBlock();
            const lang = trimmed.slice(3).trim();
            const codeLines = [];
            i++;
            while (i < lines.length && !lines[i].trim().startsWith('```')) {
                codeLines.push(_sanitizeHTML(lines[i]));
                i++;
            }
            out.push(`<pre><code${lang ? ` class="lang-${lang}"` : ''}>${codeLines.join('\n')}</code></pre>`);
            i++;
            continue;
        }

        // ── HR ───────────────────────────────────────────────
        if (/^(---+|\*\*\*+|___+)$/.test(trimmed)) {
            flushBlock();
            out.push('<hr>');
            i++;
            continue;
        }

        // ── Headings ─────────────────────────────────────────
        const hMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
        if (hMatch) {
            flushBlock();
            const level = Math.min(hMatch[1].length, 4);
            out.push(`<h${level}>${inline(hMatch[2])}</h${level}>`);
            i++;
            continue;
        }

        // ── Blockquote ───────────────────────────────────────
        if (trimmed.startsWith('> ') || trimmed === '>') {
            flushBlock();
            const bqText = trimmed.replace(/^>\s?/, '');
            out.push(`<blockquote>${inline(bqText)}</blockquote>`);
            i++;
            continue;
        }

        // ── Unordered list ───────────────────────────────────
        const ulMatch = trimmed.match(/^[-*+]\s+(.+)$/);
        if (ulMatch) {
            closePara();
            if (inList !== 'ul') { closeList(); out.push('<ul>'); inList = 'ul'; }
            out.push(`<li>${inline(ulMatch[1])}</li>`);
            i++;
            continue;
        }

        // ── Ordered list ─────────────────────────────────────
        const olMatch = trimmed.match(/^\d+\.\s+(.+)$/);
        if (olMatch) {
            closePara();
            if (inList !== 'ol') { closeList(); out.push('<ol>'); inList = 'ol'; }
            out.push(`<li>${inline(olMatch[1])}</li>`);
            i++;
            continue;
        }

        // ── Blank line → paragraph break ─────────────────────
        if (trimmed === '') {
            flushBlock();
            i++;
            continue;
        }

        // ── Normal text → paragraph ──────────────────────────
        closeList();
        if (!inPara) { out.push('<p>'); inPara = true; }
        else         { out.push('<br>'); }  // soft line break within paragraph
        out.push(inline(trimmed));
        i++;
    }

    flushBlock();
    return out.join('');
}

// ════════════════════════════════════════════════════════════
//  DOM BUILDER
// ════════════════════════════════════════════════════════════

const NO_SELECT = [
    '-webkit-user-select:none',
    '-moz-user-select:none',
    '-ms-user-select:none',
    'user-select:none',
    '-webkit-touch-callout:none',
].join(';');

export function createReadNoteElement({
    id,
    title,
    subtitle,
    bodyText,
    logoSrc,
    logoIcon  = 'article',
    uiType    = 'default',
    readType  = 'required',
    progress,
    lang      = 'id',
    closeText,
    continueText,
    steps,           // [U6] optional array of { title, body }
}) {
    const finalUiType   = ['default', 'text_only'].includes(uiType)   ? uiType   : 'default';
    const finalReadType = ['required', 'optional'].includes(readType) ? readType : 'required';
    const hasProgress   = typeof progress === 'number' && progress >= 0;

    // [U6] Multi-step detection
    const hasSteps      = Array.isArray(steps) && steps.length > 1;
    const stepCount     = hasSteps ? steps.length : 1;

    // In step mode, first step's content is the initial render
    const activeTitle   = hasSteps ? steps[0].title   : title;
    const activeBody    = hasSteps ? steps[0].body     : bodyText;

    // scroll-progress only on required + bodyText (first step or single)
    const hasScrollProgress = finalReadType === 'required' && !!activeBody && !hasSteps;

    const el = document.createElement('div');
    el.id        = id;
    el.className = `qnotify-item qnotify-label notification-item label-readnote rn-ui-${finalUiType} rn-type-${finalReadType}`;

    el.setAttribute('data-notification-id', id);
    el.setAttribute('role',             'dialog');
    el.setAttribute('aria-modal',       'true');
    el.setAttribute('aria-labelledby',  `${id}-title`);
    if (subtitle) el.setAttribute('aria-describedby', `${id}-subtitle`);

    el.oncopy        = e => e.preventDefault();
    el.onselectstart = e => e.preventDefault();
    el.oncontextmenu = e => e.preventDefault();

    const innerContent = finalUiType === 'default'
        ? _buildDefaultContent(id, activeTitle, logoSrc, logoIcon, activeBody)
        : _buildTextOnlyContent(id, activeTitle, subtitle, activeBody);

    const closeLabel    = closeText    || (lang === 'en' ? 'Close'    : 'Tutup');

    // [U6] Footer label for steps vs single
    const continueLabel = hasSteps
        ? _stepBtnLabel(1, stepCount, lang)
        : (continueText || (lang === 'en' ? 'Continue' : 'Lanjutkan'));

    const showFooter = hasSteps || finalReadType === 'optional' || hasScrollProgress;
    const btnLocked  = !hasSteps && hasScrollProgress;

    // [U4] Close button starts hidden — revealed after content anim
    // Q4 fix (Phase 12 Security L2): escape all user-controlled text fields
    el.innerHTML = `
        <div class="rn-backdrop"></div>
        <div class="rn-card" id="${id}-card">
            <button class="rn-close-btn rn-close-hidden" type="button" aria-label="${escapeHtml(closeLabel)}" style="${NO_SELECT}">
                <span class="material-icons-round" style="${NO_SELECT}">close</span>
            </button>
            <div class="rn-content" id="${id}-content">
                ${innerContent}
            </div>
            ${hasProgress ? `
            <div class="rn-progress-wrap">
                <div class="rn-progress-track">
                    <div class="rn-progress-bar" id="${id}-pbar" style="width:${_clamp(progress, 0, 100)}%"></div>
                </div>
            </div>` : ''}
            ${hasScrollProgress ? `
            <div class="rn-read-progress-wrap">
                <div class="rn-read-progress-track">
                    <div class="rn-read-progress-bar" id="${id}-rpbar" style="width:0%"></div>
                </div>
                <span class="rn-read-label" id="${id}-rlabel">${lang === 'en' ? 'Scroll to read' : 'Scroll untuk membaca'}</span>
            </div>` : ''}
            ${hasSteps ? `
            <div class="rn-step-dots" id="${id}-dots" aria-hidden="true">
                ${Array.from({ length: stepCount }, (_, i) =>
                    `<span class="rn-dot${i === 0 ? ' rn-dot-active' : ''}" data-step="${i}"></span>`
                ).join('')}
            </div>` : ''}
            ${showFooter ? `
            <div class="rn-footer">
                <button class="rn-continue-btn${btnLocked ? ' rn-btn-locked' : ''}"
                        type="button"
                        ${btnLocked ? 'disabled aria-disabled="true"' : ''}
                        ${hasSteps ? `data-step="0" data-step-count="${stepCount}"` : ''}
                        style="${NO_SELECT}">${escapeHtml(continueLabel)}</button>
            </div>` : ''}
        </div>
    `;

    el.querySelectorAll('*').forEach(child => {
        child.oncopy        = e => e.preventDefault();
        child.onselectstart = e => e.preventDefault();
    });

    // Store steps data on element for step-transition access
    if (hasSteps) {
        el._rnSteps    = steps;
        el._rnStepIdx  = 0;
        el._rnUiType   = finalUiType;
        el._rnReadType = finalReadType;
        el._rnLang     = lang;
    }

    return el;
}

// [U6] Step button label helper
function _stepBtnLabel(currentStep, total, lang) {
    if (currentStep >= total) {
        return lang === 'en' ? 'Done' : 'Selesai';
    }
    const arrow = '→';
    return lang === 'en'
        ? `Continue ${currentStep}/${total} ${arrow}`
        : `Lanjut ${currentStep}/${total} ${arrow}`;
}

function _buildDefaultContent(id, title, logoSrc, logoIcon, bodyText) {
    // Q4 fix: sanitize logoSrc URL (block javascript:, data: schemes), escape title/logoIcon
    const safeLogoSrc = sanitizeUrl(logoSrc);
    const logoHTML = safeLogoSrc
        ? `<img class="rn-logo-img rn-anim-item" src="${safeLogoSrc}" alt="logo" />`
        : `<div class="rn-logo-icon rn-anim-item">
               <span class="material-icons-round">${escapeHtml(logoIcon)}</span>
           </div>`;

    return `
        <div class="rn-logo-wrap">
            ${logoHTML}
        </div>
        <div class="rn-title rn-anim-item" id="${id}-title">${escapeHtml(title)}</div>
        ${bodyText ? `<div class="rn-divider rn-anim-item"></div>
        <div class="rn-body-text rn-anim-item" id="${id}-body">${_parseMarkdown(bodyText)}</div>` : ''}
    `;
}

function _buildTextOnlyContent(id, title, subtitle, bodyText) {
    // Q4 fix: escape user-controlled title + subtitle
    return `
        <div class="rn-title rn-anim-item" id="${id}-title">${escapeHtml(title)}</div>
        ${subtitle ? `<div class="rn-subtitle rn-anim-item" id="${id}-subtitle">${escapeHtml(subtitle)}</div>` : ''}
        ${bodyText ? `<div class="rn-divider rn-anim-item"></div>
        <div class="rn-body-text rn-anim-item" id="${id}-body">${_parseMarkdown(bodyText)}</div>` : ''}
    `;
}

// ════════════════════════════════════════════════════════════
//  ANIMATION ENGINE
// ════════════════════════════════════════════════════════════

export function animateReadNoteEnter(el, uiType, onReady) {
    const card     = el.querySelector('.rn-card');
    const backdrop = el.querySelector('.rn-backdrop');
    if (!card) return { cancel: () => {} };

    if (el._rnAnimating) return { cancel: () => {} };
    el._rnAnimating = true;

    // [v8.0.1] Element-level cancel flag — shared with setTimeout callbacks inside
    // _animateContentIn / _animateCloseBtnIn. Prevents ghost springs from running
    // after animateReadNoteExit fires while stagger timeouts are still pending.
    el._rnAnimCancelled = false;

    let cancelled = false;

    // Card enter
    // [v7.5.0 FOIS Fix — ReadNote]
    // engine.js does NOT call stampInitialState (it breaks translate(-50%,-50%) centering).
    // CSS .label-readnote.spawn .rn-card { visibility:hidden } = FOUC guard.
    // We write the full initial state HERE with correct centering transform included.
    // Springs start from these values → zero discontinuity on first frame.
    card.style.willChange = 'transform, opacity';
    card.style.opacity    = '0';
    // [v8.0.1] Reduced initial translateY: 28px instead of 60px.
    // 60px caused a visible "position spike" on first frame — browser had to paint the
    // card far off its resting position, triggering a layout stutter. 28px gives a clear
    // "rising into place" feel without the jarring initial position.
    card.style.transform  = 'translate(-50%, -50%) scale(0.97) translateY(28px)';
    card.style.height     = '';
    card.style.overflow   = '';

    // [U3] Shadow starts near-zero
    _applyShadowLift(card, 0);

    _hideContentItems(el);

    const scaleSpring   = _aSpring({ k: 300, c: 24, m: 0.9 });
    const txYSpring     = _aSpring({ k: 280, c: 22, m: 0.9 });
    // [FIX] Same params as bdSpring → card opacity + backdrop perfectly synced
    const opacitySpring = _aSpring({ k: 240, c: 20, m: 1.0 });
    // [U3] Shadow decoupled — never gates anything else
    const shadowSpring  = _aSpring({ k: 180, c: 22, m: 1.0 });

    // [v8.0.1] Jump values match inline style above.
    // txYSpring now starts at 28 (was 60) — consistent with card.style.transform.
    scaleSpring.jump(0.97);
    txYSpring.jump(28);
    opacitySpring.jump(0);
    shadowSpring.jump(0);

    // [FIX][v7.5.0] Backdrop: identical spring to opacitySpring, initialized here.
    // Note: backdrop visibility:hidden is controlled by .label-readnote.spawn CSS.
    // After .spawn is removed by afterTwoFrames(), visibility becomes visible,
    // and the spring drives opacity from 0→1.
    if (backdrop) {
        backdrop.style.opacity    = '0';
        backdrop.style.willChange = 'opacity';
    }
    const bdSpring = _aSpring({ k: 240, c: 20, m: 1.0 });
    bdSpring.jump(0);
    bdSpring.to(1, {
        onUpdate: v => {
            if (cancelled || !backdrop) return;
            backdrop.style.opacity = v.toFixed(3);
        },
        onRest: () => {
            if (backdrop) backdrop.style.willChange = 'auto';
        },
    });

    // [v8.0.1] CONTENT TIMING OVERHAUL — fixes content delay + "blank card" glitch.
    //
    // OLD: wait for ALL 3 card springs to rest (~550-620ms), then start content.
    //      → Card visible but empty for >500ms. Users saw a blank card appear.
    //      → setTimeout-based stagger had no cancel guard → ghost springs after exit.
    //
    // NEW: trigger content once opacity crosses 0.72 threshold (~160ms into animation).
    //      → Card clearly visible, springs still settling → content flows in AS card lands.
    //      → Feels alive, not dead. Zero blank-card period.
    //      → onRest is a guaranteed safety fallback if threshold is never crossed.
    let contentTriggered = false;
    const triggerContent = () => {
        if (contentTriggered || cancelled) return;
        contentTriggered = true;
        card.style.willChange = 'auto';
        _animateContentIn(el, uiType, () => {
            el._rnAnimating = false;
            if (!cancelled && onReady) onReady();
        });
    };

    const applyCardTransform = () => {
        if (cancelled) return;
        const sc = scaleSpring.x;
        const ty = txYSpring.x;
        card.style.transform = `translate(-50%,-50%) scale(${sc.toFixed(5)}) translateY(${ty.toFixed(2)}px)`;
    };

    // Scale and txY springs no longer gate content — they run freely.
    scaleSpring.to(1, { onUpdate: applyCardTransform });
    txYSpring.to(0,   { onUpdate: applyCardTransform });

    opacitySpring.to(1, {
        onUpdate: v => {
            if (!cancelled) {
                card.style.opacity = v.toFixed(3);
                // Threshold: 72% opacity → card feels solid, springs still settling.
                // Content starts revealing while card is still in motion — looks dynamic.
                if (v >= 0.72) triggerContent();
            }
        },
        // Safety fallback — always fires even if threshold somehow missed.
        onRest: () => triggerContent(),
    });

    // [U3] Shadow: independent, clears inline style on rest
    shadowSpring.to(1, {
        onUpdate: v => { if (!cancelled) _applyShadowLift(card, v); },
        onRest:   () => { if (!cancelled) _clearShadowLift(card); },
    });

    const cancelHandle = {
        cancel: () => {
            cancelled = true;
            // Mark element so all pending setTimeout callbacks bail immediately.
            // This is the critical fix for ghost springs after rapid open→close.
            contentTriggered   = true;
            el._rnAnimCancelled = true;
            scaleSpring.stop();
            txYSpring.stop();
            opacitySpring.stop();
            bdSpring.stop();
            shadowSpring.stop();
            _clearShadowLift(card);
            el._rnAnimating = false;
        },
    };

    el._rnAnimCancel = cancelHandle.cancel;
    return cancelHandle;
}

function _hideContentItems(el) {
    el.querySelectorAll('.rn-anim-item').forEach(t => {
        t.style.opacity   = '0';
        t.style.transform = 'translateY(12px) scale(0.97)';
    });
    // [U4] Close button hidden until content done
    const closeBtn = el.querySelector('.rn-close-btn');
    if (closeBtn) {
        closeBtn.style.opacity   = '0';
        closeBtn.style.transform = 'translateX(14px)';
    }
}

/**
 * Content reveal — easing stagger [U2], close button deferred [U4].
 */
function _animateContentIn(el, uiType, onDone) {
    const items = Array.from(el.querySelectorAll('.rn-anim-item'));
    if (items.length === 0) {
        _animateCloseBtnIn(el, onDone);
        return;
    }

    // [U2] Easing stagger delays
    const delays  = _buildStaggerDelays(items.length);
    let doneCount = 0;

    items.forEach((item, i) => {
        const delay = delays[i];

        const run = () => {
            // [v8.0.1] Check element-level cancel flag. If exit animation fired while
            // stagger timeouts were pending, bail immediately — no ghost springs.
            if (el._rnAnimCancelled) return;

            const ySpring  = _aSpring({ k: 220, c: 18, m: 1.0 });
            const scSpring = _aSpring({ k: 280, c: 22, m: 0.9 });
            const opSpring = _aSpring({ k: 260, c: 20, m: 0.9 });

            ySpring.jump(12);
            scSpring.jump(0.97);
            opSpring.jump(0);

            item.style.willChange = 'transform, opacity';

            const applyItemTransform = () => {
                const y  = ySpring.x;
                const sc = scSpring.x;
                item.style.transform = `translateY(${y.toFixed(3)}px) scale(${sc.toFixed(5)})`;
            };

            let partsDone = 0;
            const onPart = () => {
                partsDone++;
                if (partsDone < 3) return;
                item.style.willChange = 'auto';
                item.style.transform  = '';
                item.style.opacity    = '';
                doneCount++;
                if (doneCount >= items.length) {
                    // [U4] All content done — now reveal close button
                    _animateCloseBtnIn(el, onDone);
                }
            };

            ySpring.to(0,  { onUpdate: applyItemTransform, onRest: onPart });
            scSpring.to(1, { onUpdate: applyItemTransform, onRest: onPart });
            opSpring.to(1, {
                onUpdate: v => { item.style.opacity = v.toFixed(3); },
                onRest:   onPart,
            });
        };

        if (delay === 0) run();
        else setTimeout(run, delay);
    });
}

/**
 * [U4] Close button enter — slides in from right after content settles.
 */
function _animateCloseBtnIn(el, onDone) {
    // [v8.0.1] Guard: if exit fired while content stagger was in flight, skip btn animation.
    if (el._rnAnimCancelled) { if (onDone) onDone(); return; }

    const closeBtn = el.querySelector('.rn-close-btn');
    if (!closeBtn) {
        if (onDone) onDone();
        return;
    }

    closeBtn.style.willChange = 'transform, opacity';

    const txSpring = _aSpring({ k: 320, c: 24, m: 0.9 });
    const opSpring = _aSpring({ k: 280, c: 22, m: 1.0 });

    txSpring.jump(14);
    opSpring.jump(0);

    let parts = 0;
    const onPart = () => {
        parts++;
        if (parts < 2) return;
        closeBtn.style.willChange = 'auto';
        closeBtn.style.transform  = '';
        closeBtn.style.opacity    = '';
        closeBtn.classList.remove('rn-close-hidden');
        if (onDone) onDone();
    };

    txSpring.to(0, {
        onUpdate: v => { closeBtn.style.transform = `translateX(${v.toFixed(2)}px)`; },
        onRest:   onPart,
    });
    opSpring.to(1, {
        onUpdate: v => { closeBtn.style.opacity = v.toFixed(3); },
        onRest:   onPart,
    });
}

// ════════════════════════════════════════════════════════════
//  EXIT ANIMATION
// ════════════════════════════════════════════════════════════

export function animateReadNoteExit(el, onDone) {
    const card     = el.querySelector('.rn-card');
    const backdrop = el.querySelector('.rn-backdrop');
    if (!card) { if (onDone) onDone(); return; }

    if (el._rnAnimCancel) { el._rnAnimCancel(); el._rnAnimCancel = null; }
    el._rnAnimating = false;

    el.querySelectorAll('.rn-anim-item, .rn-footer, .rn-close-btn, .rn-step-dots').forEach(c => {
        c.style.transition = 'opacity 0.10s ease';
        c.style.opacity    = '0';
    });

    if (backdrop) {
        backdrop.style.willChange = 'opacity';
        // [FIX] Always jump from 1 — avoids desync if inline opacity is mid-animation.
        // Same spring params as card opacity → backdrop and card fade out in lockstep.
        const bdSpring = _aSpring({ k: 260, c: 22, m: 1.0 });
        bdSpring.jump(1);
        backdrop.style.opacity = '1';
        bdSpring.to(0, {
            onUpdate: v => { backdrop.style.opacity = v.toFixed(3); },
            onRest:   () => { backdrop.style.willChange = 'auto'; },
        });
    }

    card.style.willChange = 'transform, opacity';

    const scaleSpring   = _aSpring({ k: 320, c: 24, m: 0.9 });
    const opacitySpring = _aSpring({ k: 260, c: 22, m: 1.0 }); // same k/c as bdSpring

    scaleSpring.jump(1);
    opacitySpring.jump(1);

    scaleSpring.to(0.92, {
        onUpdate: v => {
            card.style.transform = `translate(-50%,-50%) scale(${v.toFixed(5)})`;
        },
    });

    opacitySpring.to(0, {
        onUpdate: v => { card.style.opacity = v.toFixed(3); },
        onRest: () => {
            card.style.willChange = 'auto';
            // [v7.5.0] Release compositor layer stamped by glitch.js
            clearInitialState(el);
            if (onDone) onDone();
        },
    });
}

// ════════════════════════════════════════════════════════════
//  PROGRESS BAR UPDATER
// ════════════════════════════════════════════════════════════

export function updateReadNoteProgress(notificationId, targetPercent) {
    const el   = document.getElementById(notificationId);
    const pbar = el ? el.querySelector('.rn-progress-bar') : null;
    if (!pbar) return;

    const currentW   = parseFloat(pbar.style.width) || 0;
    const progSpring = _aSpring({ k: 120, c: 18, m: 1.0 });
    progSpring.jump(currentW);
    progSpring.to(_clamp(targetPercent, 0, 100), {
        onUpdate: v => { pbar.style.width = v.toFixed(2) + '%'; },
    });
}

// ════════════════════════════════════════════════════════════
//  SCROLL-PROGRESS SYSTEM
// ════════════════════════════════════════════════════════════

export function wireScrollProgress(notificationId, lang, onUnlock) {
    const el = document.getElementById(notificationId);
    if (!el) return () => {};

    const content     = el.querySelector('.rn-content');
    const rpbar       = el.querySelector('.rn-read-progress-bar');
    const rlabel      = el.querySelector('.rn-read-label');
    const continueBtn = el.querySelector('.rn-continue-btn');

    if (!content || !rpbar) return () => {};

    let reached    = false;
    let rafPending = false;

    const onScroll = () => {
        if (reached || rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => {
            rafPending = false;
            const { scrollTop, scrollHeight, clientHeight } = content;
            const max = Math.max(0, scrollHeight - clientHeight);
            const pct = max > 0 ? _clamp((scrollTop / max) * 100, 0, 100) : 100;

            rpbar.style.width = pct.toFixed(1) + '%';

            if (pct >= 98 && !reached) {
                reached = true;
                rpbar.style.width = '100%';
                rpbar.classList.add('rn-read-done');

                if (rlabel) {
                    rlabel.textContent = lang === 'en' ? 'Read ✓' : 'Selesai dibaca ✓';
                    rlabel.classList.add('rn-read-done-label');
                }

                if (continueBtn) {
                    continueBtn.disabled = false;
                    continueBtn.removeAttribute('aria-disabled');
                    continueBtn.classList.remove('rn-btn-locked');

                    // [U5] Jiggly bounce — single underdamped spring, fires once
                    _bounceUnlock(continueBtn);
                }

                if (onUnlock) onUnlock();
            }
        });
    };

    const checkImmediate = () => {
        const { scrollHeight, clientHeight } = content;
        if (scrollHeight <= clientHeight + 2) {
            onScroll();
        }
    };

    content.addEventListener('scroll', onScroll, { passive: true });
    requestAnimationFrame(checkImmediate);

    return () => {
        content.removeEventListener('scroll', onScroll);
    };
}

/**
 * [U5] Jiggly bounce on continue button unlock.
 * Single underdamped spring: scale 0.88 → 1.12 → ~1.0 (overshoots once).
 * Low damping = one natural bounce, settles cleanly. No pulse, no repeat.
 */
function _bounceUnlock(btn) {
    // k=500 (stiff), c=12 (low damp) → overshoot ~1.12 then settle
    const spring = _aSpring({ k: 500, c: 12, m: 0.9 });
    spring.jump(0.88);
    btn.style.willChange = 'transform';
    spring.to(1, {
        onUpdate: v => { btn.style.transform = `scale(${v.toFixed(5)})`; },
        onRest:   () => {
            btn.style.transform  = '';
            btn.style.willChange = 'auto';
        },
    });
}

// ════════════════════════════════════════════════════════════
//  MULTI-STEP SYSTEM  [U6]
// ════════════════════════════════════════════════════════════

/**
 * Advance ReadNote to the next step.
 * Called by engine.js when continue button is clicked in step mode.
 *
 * @param {HTMLElement} el          — the readnote element
 * @param {number}      nextIdx     — index of the step to show
 * @param {Function}    [onDismiss] — called when last step is confirmed
 */
export function advanceReadNoteStep(el, nextIdx, onDismiss) {
    const steps    = el._rnSteps;
    const uiType   = el._rnUiType   || 'default';
    const readType = el._rnReadType || 'required';
    const lang     = el._rnLang     || 'id';
    const total    = steps.length;

    if (!steps) return;

    // Last step confirmed → dismiss
    if (nextIdx >= total) {
        if (onDismiss) onDismiss();
        return;
    }

    const id      = el.id;
    const content = el.querySelector('.rn-content');
    const contBtn = el.querySelector('.rn-continue-btn');
    const dots    = el.querySelectorAll('.rn-dot');
    if (!content) return;

    // Update dots
    dots.forEach((d, i) => {
        d.classList.toggle('rn-dot-active', i === nextIdx);
    });

    // Progress bar auto-advance
    const pbar = el.querySelector('.rn-progress-bar');
    if (pbar) {
        const pct = Math.round((nextIdx / (total - 1)) * 100);
        updateReadNoteProgress(id, pct);
    }

    // Current content exits LEFT
    const exitItems = Array.from(content.querySelectorAll('.rn-anim-item'));
    exitItems.forEach(item => {
        item.style.willChange = 'transform, opacity';
        const opSp = _aSpring({ k: 340, c: 24, m: 1.0 });
        const txSp = _aSpring({ k: 340, c: 24, m: 1.0 });
        opSp.jump(1);
        txSp.jump(0);
        opSp.to(0, { onUpdate: v => { item.style.opacity = v.toFixed(3); } });
        txSp.to(-32, { onUpdate: v => { item.style.transform = `translateX(${v.toFixed(2)}px)`; } });
    });

    // Swap content after exit (~160ms)
    setTimeout(() => {
        // [v8.0.1] Safety: if readnote was dismissed during step transition, bail.
        if (el._rnAnimCancelled) return;

        const step = steps[nextIdx];

        // Update title + body content regardless of uiType
        // WHY: both 'default' and 'text_only' share the same id-based title/body elements.
        // The original if/else had identical branches — collapsed to avoid dead code.
        const titleEl = content.querySelector(`#${id}-title`);
        const bodyEl  = content.querySelector(`#${id}-body`);
        if (titleEl) titleEl.textContent = step.title;
        if (bodyEl && step.body)  bodyEl.innerHTML = _parseMarkdown(step.body);
        if (bodyEl && !step.body) bodyEl.innerHTML = '';

        // Update button label
        if (contBtn) {
            contBtn.textContent     = _stepBtnLabel(nextIdx + 1, total, lang);
            contBtn.dataset.step    = String(nextIdx);
            contBtn.disabled        = false;
            contBtn.removeAttribute('aria-disabled');
            contBtn.classList.remove('rn-btn-locked');
        }

        el._rnStepIdx = nextIdx;

        // Re-wire scroll progress for required steps with body
        if (readType === 'required' && step.body) {
            if (el._rnCleanupScroll) { el._rnCleanupScroll(); el._rnCleanupScroll = null; }
            // Lock button until scrolled
            if (contBtn) {
                contBtn.disabled = true;
                contBtn.setAttribute('aria-disabled', 'true');
                contBtn.classList.add('rn-btn-locked');
            }
            requestAnimationFrame(() => {
                el._rnCleanupScroll = wireScrollProgress(id, lang, () => {
                    // unlock handled inside wireScrollProgress via _bounceUnlock
                });
            });
        }

        // New content enters from RIGHT
        const newItems = Array.from(content.querySelectorAll('.rn-anim-item'));
        newItems.forEach(item => {
            item.style.opacity   = '0';
            item.style.transform = 'translateX(32px) scale(0.97)';
        });

        const delays = _buildStaggerDelays(newItems.length);
        newItems.forEach((item, i) => {
            const run = () => {
                // [v8.0.1] Check cancel before creating springs in stagger
                if (el._rnAnimCancelled) return;

                item.style.willChange = 'transform, opacity';
                const txSp = _aSpring({ k: 300, c: 24, m: 0.9 });
                const scSp = _aSpring({ k: 300, c: 24, m: 0.9 });
                const opSp = _aSpring({ k: 280, c: 22, m: 1.0 });

                txSp.jump(32);
                scSp.jump(0.97);
                opSp.jump(0);

                let done = 0;
                const onP = () => {
                    done++;
                    if (done < 3) return;
                    item.style.willChange = 'auto';
                    item.style.transform  = '';
                    item.style.opacity    = '';
                };

                const applyT = () => {
                    item.style.transform = `translateX(${txSp.x.toFixed(2)}px) scale(${scSp.x.toFixed(5)})`;
                };

                txSp.to(0, { onUpdate: applyT, onRest: onP });
                scSp.to(1, { onUpdate: applyT, onRest: onP });
                opSp.to(1, {
                    onUpdate: v => { item.style.opacity = v.toFixed(3); },
                    onRest:   onP,
                });
            };
            if (delays[i] === 0) run();
            else setTimeout(run, delays[i]);
        });

    }, 160);
}
