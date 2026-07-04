// label.js — QNotify 1.0.5 For AlbEdu
/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  QNotify — label.js 1.0.5 For AlbEdu [PERF REWRITE]                        ║
 * ║  "Label Family — Alert DOM Builder + Hybrid Animations"     ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * PERFORMANCE CHANGES v7.3.0-perf:
 *
 *  [F1] REMOVED: All plain CSS @keyframes for Family enter/exit.
 *       laCardIn, laCardOut, laBarIn, laRingPop, laGlyphPop,
 *       laRingGlow, laFadeUp, laBtnPop — all gone from CSS.
 *       These are now driven by Hybrid Animations (AnalyticSpring).
 *
 *  [F2] NEW: animateAlertEnter() — JS spring driven enter.
 *       Card:   scale(0.88→1) + translateY(18→0) + opacity(0→1) via spring.
 *       Bar:    scaleX(0→1) via spring (delay 60ms).
 *       Icon:   scale(0.45→1) + opacity via spring (delay 80ms).
 *       Glyph:  scale(0.15→1) + opacity via spring (delay 160ms).
 *       Title:  translateY(10→0) + opacity via spring (delay 200ms).
 *       Msg:    translateY(10→0) + opacity via spring (delay 240ms).
 *       Btn:    translateY(14→0) + scale(0.92→1) + opacity via spring (delay 280ms).
 *
 *  [F3] NEW: animateAlertExit() — JS spring driven exit.
 *       Card: scale(1→0.93) + translateY(0→10) + opacity(1→0).
 *       Children reset instantly (no fragmentation).
 *       onDone callback — clean handoff to engine cleanup.
 *
 *  [F4] Architecture: all springs are AnalyticSpring.
 *       Consistent with Hybrid Animation spec:
 *         UI animations (enter/exit/hover) → analytic ✓
 *         Gesture/bump interactions → RK4 (N/A for alert)
 *       Result: "full spring behavior" through the Hybrid approach.
 *
 *  [F5] No animation: laRingGlow (box-shadow keyframe) REMOVED entirely.
 *       Animating box-shadow triggers paint — not compositor-safe.
 *       Ring has a static shadow from CSS (no animation). Visual identity preserved.
 *
 * Why this is better than CSS keyframes:
 *   - Interruption-safe: any spring can be stopped/redirected mid-flight.
 *   - No animationend race conditions (engine no longer listens for CSS events).
 *   - No stale animation state when alert is dismissed while entering.
 *   - Deterministic: frame-rate independent, exact analytic solution.
 *   - will-change set/cleared per animation — no permanent memory layers.
 */

import { TEXTS } from './config.js';
import { getText, applyShadowColor } from './render.js';
import { acquireSpring } from './spring.js';
import { escapeHtml } from '../security/sanitize.js';
// [v7.5.0] glitch.js: stampInitialState already ran before DOM insert (from engine.js).
// We only clear will-change on exit.
import { clearInitialState } from './glitch.js';

// ════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════

/** Always analytic for Family UI animations — Hybrid Architecture. */
function _aSpring(cfg) {
    return acquireSpring(cfg, 'analytic');
}

const INTENT_ICONS = {
    danger:  'error',
    warning: 'warning',
    success: 'check_circle',
    info:    'info',
};

const INTENT_COLORS = {
    danger:  '#ff3b30',
    warning: '#ff9500',
    success: '#34c759',
    info:    '#007aff',
};

const NO_SELECT = [
    '-webkit-user-select:none',
    '-moz-user-select:none',
    '-ms-user-select:none',
    'user-select:none',
    '-webkit-touch-callout:none',
].join(';');

// ════════════════════════════════════════════════════════════
//  DOM BUILDER  (unchanged structure — only class names updated)
// ════════════════════════════════════════════════════════════

/**
 * @param {Object} params
 * @param {string} params.id
 * @param {string} params.title
 * @param {string} params.message
 * @param {string} [params.icon]
 * @param {string} params.lang
 * @param {string} [params.intent]
 * @param {string} [params.okText]
 * @returns {HTMLElement}
 */
export function createAlertElement({ id, title, message, icon, lang, intent = 'info', okText }) {
    const finalIntent   = ['danger', 'warning', 'success', 'info'].includes(intent) ? intent : 'info';
    const defaultOkText = getText(TEXTS.confirm.yes, lang);
    const finalOkText   = okText || defaultOkText;
    const iconName      = icon || INTENT_ICONS[finalIntent];
    const accentColor   = INTENT_COLORS[finalIntent];

    const el = document.createElement('div');
    el.id = id;

    // [F1] 'spawn' class sets initial hidden state via CSS.
    // 'active' class no longer triggers CSS animation — JS spring handles it.
    el.className = `qnotify-item qnotify-label notification-item label-alert ${finalIntent} spawn`;

    el.setAttribute('data-notification-id', id);
    el.setAttribute('role',             'alertdialog');
    el.setAttribute('aria-modal',       'true');
    el.setAttribute('aria-labelledby',  `${id}-title`);
    el.setAttribute('aria-describedby', `${id}-msg`);

    el.style.setProperty('--la-accent', accentColor);

    el.oncopy        = (e) => e.preventDefault();
    el.onselectstart = (e) => e.preventDefault();
    el.oncontextmenu = (e) => e.preventDefault();

    el.innerHTML = `
        <div class="alert-header"></div>
        <div class="alert-content">
            <div class="alert-icon">
                <div class="alert-icon-ring">
                    <span class="material-icons-round" style="${NO_SELECT}">${escapeHtml(iconName)}</span>
                </div>
            </div>
            <div class="alert-title"
                 id="${id}-title"
                 style="${NO_SELECT}">${escapeHtml(title)}</div>
            <div class="alert-message"
                 id="${id}-msg"
                 style="${NO_SELECT}">${escapeHtml(message)}</div>
            <button class="qnotify-btn alert-btn ok"
                    type="button"
                    style="${NO_SELECT}">${escapeHtml(finalOkText)}</button>
        </div>
    `;

    el.querySelectorAll('*').forEach(child => {
        child.oncopy        = (e) => e.preventDefault();
        child.onselectstart = (e) => e.preventDefault();
    });

    applyShadowColor(el, finalIntent === 'danger' ? 'error' : finalIntent);

    return el;
}

// ════════════════════════════════════════════════════════════
//  [F2] HYBRID ANIMATION — ENTER
// ════════════════════════════════════════════════════════════

/**
 * Animate label-alert enter using Hybrid Animations (AnalyticSpring).
 *
 * Replaces: CSS @keyframes laCardIn + staggered child animations.
 * Result:   Same spring-overshoot feel, but JS-driven, interruption-safe,
 *           and deterministic at any frame rate.
 *
 * Spring parameters match original CSS cubic-bezier intent:
 *   Card:   k=300, c=22 → slight overshoot (matches laCardIn 50% keyframe)
 *   Icon:   k=340, c=18 → snappy pop (matches laRingPop/laGlyphPop)
 *   Text:   k=260, c=20 → smooth ease-out (matches laFadeUp)
 *   Btn:    k=320, c=16 → poppy spring (matches laBtnPop)
 *
 * @param {HTMLElement} el       — the .label-alert element
 * @param {Function}    [onReady] — called when all springs settle
 */
export function animateAlertEnter(el, onReady) {
    // [F4] Guard against double-trigger
    if (el._laAnimating) return;
    el._laAnimating = true;

    const card    = el;
    const header  = el.querySelector('.alert-header');
    const icon    = el.querySelector('.alert-icon');
    const ring    = el.querySelector('.alert-icon-ring');
    const glyph   = el.querySelector('.alert-icon .material-icons-round');
    const title   = el.querySelector('.alert-title');
    const msg     = el.querySelector('.alert-message');
    const btn     = el.querySelector('.alert-btn');

    // ── Initial states ─────────────────────────────────────
    // [v7.5.0] Card initial state is already stamped by glitch.stampInitialState()
    // BEFORE the element entered the DOM (in engine.js alert()).
    // afterTwoFrames() in engine.js guarantees compositor commit happened.
    // We only set will-change here (GPU layer) — DO NOT re-write opacity/transform.
    // Re-writing would cause one extra style recalc + potential 1-frame flash.
    // [v7.5.0] Card: write full initial state with centering transform.
    // CSS .spawn { visibility:hidden } = FOUC guard — card invisible before this.
    // We write here (not in engine.js) because centering requires translate(-50%,-50%).
    // Springs start from these exact values → zero discontinuity on first frame.
    card.style.willChange = 'transform, opacity';
    card.style.opacity    = '0';
    card.style.transform  = 'translate(-50%,-50%) scale(0.88) translateY(18px)';

    // Children: hidden before JS spring stagger — safe to write, never been visible.
    if (header) { header.style.transform = 'scaleX(0)'; header.style.opacity = '0.5'; header.style.transformOrigin = 'left center'; }
    if (icon)   { icon.style.opacity = '0'; icon.style.transform = 'scale(0.45) rotate(-12deg)'; }
    if (glyph)  { glyph.style.opacity = '0'; glyph.style.transform = 'scale(0.15) rotate(-22deg)'; }
    if (title)  { title.style.opacity = '0'; title.style.transform = 'translateY(10px)'; }
    if (msg)    { msg.style.opacity = '0'; msg.style.transform = 'translateY(10px)'; }
    if (btn)    { btn.style.opacity = '0'; btn.style.transform = 'translateY(14px) scale(0.92)'; }

    // Track settle for onReady callback
    let totalParts  = 0;
    let settledParts = 0;
    const _register = () => { totalParts++; };
    const _onSettle = () => {
        settledParts++;
        if (settledParts >= totalParts) {
            card.style.willChange = 'auto';
            el._laAnimating = false;
            if (onReady) onReady();
        }
    };

    // ── Card spring ────────────────────────────────────────
    _register(); _register(); _register(); // 3 parts: scale, ty, opacity

    const cardSc = _aSpring({ k: 300, c: 22, m: 0.9 });
    const cardTy = _aSpring({ k: 280, c: 22, m: 0.9 });
    const cardOp = _aSpring({ k: 240, c: 20, m: 1.0 });
    cardSc.jump(0.88); cardTy.jump(18); cardOp.jump(0);

    const _applyCard = () => {
        card.style.transform = `translate(-50%,-50%) scale(${cardSc.x.toFixed(5)}) translateY(${cardTy.x.toFixed(2)}px)`;
    };
    cardSc.to(1, { onUpdate: _applyCard, onRest: _onSettle });
    cardTy.to(0, { onUpdate: _applyCard, onRest: _onSettle });
    cardOp.to(1, { onUpdate: v => { card.style.opacity = v.toFixed(3); }, onRest: _onSettle });

    // ── Header bar ────────────────────────────────────────
    if (header) {
        _register();
        const barSc = _aSpring({ k: 260, c: 22, m: 1.0 });
        barSc.jump(0);
        setTimeout(() => {
            barSc.to(1, {
                onUpdate: v => {
                    header.style.transform = `scaleX(${v.toFixed(5)})`;
                    header.style.opacity   = (0.5 + v * 0.5).toFixed(3);
                },
                onRest: () => {
                    header.style.transform      = '';
                    header.style.opacity        = '';
                    header.style.transformOrigin = '';
                    _onSettle();
                },
            });
        }, 60);
    }

    // ── Icon ring ─────────────────────────────────────────
    if (icon) {
        _register(); _register(); // scale + opacity
        const iconSc  = _aSpring({ k: 340, c: 18, m: 0.9 }); // snappy pop
        const iconRot = _aSpring({ k: 320, c: 20, m: 0.9 });
        const iconOp  = _aSpring({ k: 280, c: 22, m: 1.0 });
        iconSc.jump(0.45); iconRot.jump(-12); iconOp.jump(0);

        setTimeout(() => {
            const _applyIcon = () => {
                icon.style.transform = `scale(${iconSc.x.toFixed(5)}) rotate(${iconRot.x.toFixed(3)}deg)`;
            };
            iconSc.to(1,  { onUpdate: _applyIcon, onRest: () => { icon.style.transform = ''; _onSettle(); } });
            iconRot.to(0, { onUpdate: _applyIcon });
            iconOp.to(1,  { onUpdate: v => { icon.style.opacity = v.toFixed(3); }, onRest: () => { icon.style.opacity = ''; _onSettle(); } });
        }, 80);
    }

    // ── Glyph ─────────────────────────────────────────────
    if (glyph) {
        _register(); _register();
        const glSc  = _aSpring({ k: 360, c: 18, m: 0.85 }); // very snappy
        const glRot = _aSpring({ k: 340, c: 20, m: 0.9 });
        const glOp  = _aSpring({ k: 300, c: 22, m: 1.0 });
        glSc.jump(0.15); glRot.jump(-22); glOp.jump(0);

        setTimeout(() => {
            const _applyGlyph = () => {
                glyph.style.transform = `scale(${glSc.x.toFixed(5)}) rotate(${glRot.x.toFixed(3)}deg)`;
            };
            glSc.to(1,  { onUpdate: _applyGlyph, onRest: () => { glyph.style.transform = ''; _onSettle(); } });
            glRot.to(0, { onUpdate: _applyGlyph });
            glOp.to(1,  { onUpdate: v => { glyph.style.opacity = v.toFixed(3); }, onRest: () => { glyph.style.opacity = ''; _onSettle(); } });
        }, 160);
    }

    // ── Title ─────────────────────────────────────────────
    if (title) {
        _register(); _register();
        const tTy = _aSpring({ k: 260, c: 20, m: 1.0 });
        const tOp = _aSpring({ k: 260, c: 20, m: 1.0 });
        tTy.jump(10); tOp.jump(0);

        setTimeout(() => {
            tTy.to(0, { onUpdate: v => { title.style.transform = `translateY(${v.toFixed(2)}px)`; }, onRest: () => { title.style.transform = ''; _onSettle(); } });
            tOp.to(1, { onUpdate: v => { title.style.opacity = v.toFixed(3); }, onRest: () => { title.style.opacity = ''; _onSettle(); } });
        }, 200);
    }

    // ── Message ───────────────────────────────────────────
    if (msg) {
        _register(); _register();
        const mTy = _aSpring({ k: 260, c: 20, m: 1.0 });
        const mOp = _aSpring({ k: 260, c: 20, m: 1.0 });
        mTy.jump(10); mOp.jump(0);

        setTimeout(() => {
            mTy.to(0, { onUpdate: v => { msg.style.transform = `translateY(${v.toFixed(2)}px)`; }, onRest: () => { msg.style.transform = ''; _onSettle(); } });
            mOp.to(1, { onUpdate: v => { msg.style.opacity = v.toFixed(3); }, onRest: () => { msg.style.opacity = ''; _onSettle(); } });
        }, 240);
    }

    // ── Button ────────────────────────────────────────────
    if (btn) {
        _register(); _register(); _register();
        const bTy = _aSpring({ k: 320, c: 16, m: 0.9 }); // lively pop
        const bSc = _aSpring({ k: 340, c: 18, m: 0.9 });
        const bOp = _aSpring({ k: 280, c: 20, m: 1.0 });
        bTy.jump(14); bSc.jump(0.92); bOp.jump(0);

        setTimeout(() => {
            const _applyBtn = () => {
                btn.style.transform = `translateY(${bTy.x.toFixed(2)}px) scale(${bSc.x.toFixed(5)})`;
            };
            bTy.to(0, { onUpdate: _applyBtn, onRest: () => { btn.style.transform = ''; _onSettle(); } });
            bSc.to(1, { onUpdate: _applyBtn, onRest: _onSettle });
            bOp.to(1, { onUpdate: v => { btn.style.opacity = v.toFixed(3); }, onRest: () => { btn.style.opacity = ''; _onSettle(); } });
        }, 280);
    }
}

// ════════════════════════════════════════════════════════════
//  [F3] HYBRID ANIMATION — EXIT
// ════════════════════════════════════════════════════════════

/**
 * Animate label-alert exit using Hybrid Animations (AnalyticSpring).
 *
 * Replaces: CSS @keyframes laCardOut + animationend listener.
 * Result:   Clean callback handoff, no race conditions.
 *
 * Children are reset instantly before card animates out.
 * This prevents visual fragmentation (child animations conflicting
 * with card collapse) — same policy as CSS .exit reset, but reliable.
 *
 * @param {HTMLElement} el
 * @param {Function}    onDone   — called when exit springs settle
 */
export function animateAlertExit(el, onDone) {
    // Abort any in-progress enter
    el._laAnimating = false;

    // FIX: Sync backdrop fade with card exit (was delay-hiding)
    const backdrop = document.getElementById('qnotify-backdrop');
    if (backdrop) {
        const curOp = parseFloat(getComputedStyle(backdrop).opacity) || 1;
        const bdSp  = _aSpring({ k: 300, c: 24, m: 1.0 });
        bdSp.jump(curOp);
        bdSp.to(0, {
            onUpdate: v => { if (backdrop) backdrop.style.opacity = v.toFixed(3); },
            onRest:   () => { if (backdrop) backdrop.style.opacity = ''; },
        });
    }

    // Reset children instantly — no individual animations during exit
    [
        '.alert-header', '.alert-icon', '.alert-icon-ring',
        '.alert-icon .material-icons-round', '.alert-title',
        '.alert-message', '.alert-btn',
    ].forEach(sel => {
        const child = el.querySelector(sel);
        if (child) {
            child.style.animation  = 'none';
            child.style.transition = 'none';
            child.style.opacity    = '1';
            child.style.transform  = 'none';
        }
    });

    el.style.willChange = 'transform, opacity';

    const exitSc = _aSpring({ k: 320, c: 24, m: 0.9 });
    const exitTy = _aSpring({ k: 300, c: 22, m: 0.9 });
    const exitOp = _aSpring({ k: 280, c: 22, m: 1.0 });

    exitSc.jump(1); exitTy.jump(0); exitOp.jump(1);

    const _applyExit = () => {
        el.style.transform = `translate(-50%,-50%) scale(${exitSc.x.toFixed(5)}) translateY(${exitTy.x.toFixed(2)}px)`;
    };

    exitSc.to(0.93, { onUpdate: _applyExit });
    exitTy.to(10,   { onUpdate: _applyExit });
    exitOp.to(0, {
        onUpdate: v => { el.style.opacity = v.toFixed(3); },
        onRest: () => {
            el.style.willChange = 'auto';
            // [v7.5.0] Clean up stamped data-qn-stamped + will-change
            clearInitialState(el);
            if (onDone) onDone();
        },
    });
}
