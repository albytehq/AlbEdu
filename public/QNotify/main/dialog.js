// dialog.js — Qnotify v8.0.5
/**
 * ╔══════════════════════════════════════════════════╗
 * ║  Qnotify — dialog.js                            ║
 * ║  \"Interactive Dialog Controller\"                ║
 * ╚══════════════════════════════════════════════════╝
 *
 * v7.4.0 CHANGES:
 *  - FIX: Async no longer stuck — dual-pattern support:
 *      (a) Callback: onAsyncYes(resolve => resolve(true/false))  [legacy]
 *      (b) Promise:  onAsyncYes(async () => { ... return true }) [new]
 *      Both patterns auto-detected via fn.length === 0 heuristic.
 *  - NEW: Satisfying morph transition — dialog height smoothly
 *    animates when switching from idle → processing → result states.
 *  - NEW: Icon blob gets a spring-driven scale bounce on theme morph.
 *  - NEW: Buttons dissolve out with staggered opacity + translateY
 *    before processing state, reappear on result (if re-enabled).
 *  - IMPROVED: morphTitle uses vertical slide + blur (filter) for
 *    a premium feel matching iOS/macOS system dialogs.
 *  - IMPROVED: Processing state hides message text with fade+slide,
 *    not just opacity — more intentional spatial motion.
 */

import { SHADOW_TINTS, TEXTS, MORPH_THEME, TIMING } from './config.js';
import {
    getText, ensureBackdrop, applyShadowColor,
    createDialogElement, appendToContainer,
    showBackdrop, hideBackdrop,
} from './render.js';
import { applySpawnShadow, applyDepthShadow } from './motion.js';
import { acquireSpring } from './spring.js';
// [v8.0.0] Anti-glitch: triple-barrier + pre-stamped initial state
import { afterTwoFrames, forceReflow, clearInitialState } from './glitch.js';

// Always analytic for dialog UI — Hybrid Architecture
function _aSpring(cfg) { return acquireSpring(cfg, 'analytic'); }

// [v8.0.0] Stamp dialog initial state BEFORE DOM insert
// Dialog uses position:fixed + left:50% + top:50% centering.
// Initial transform includes the centering translate so springs
// start from the correct world-space position.
function _stampDialogInitial(el) {
    el.style.willChange = 'transform, opacity';
    el.style.opacity    = '0';
    // Springs start at: scale=0.88, translateY=14px (from centering origin)
    // Springs target:   scale=1.0,  translateY=0px
    el.style.transform  = 'translate(-50%, -50%) scale(0.88) translateY(14px)';
    el.dataset.qnStamped = '1';
}

// Track active dialog enter animations so rapid open/close can abort them
const _dialogEnterCancels = new Map();


// ── Build base state object used by engine.js and motion.js ──────────────────
function makeDialogNotification({ id, element, isDesktop, type, tintKey }) {
    return {
        id,
        element,
        isDead:     false,
        isDesktop,
        createdAt:  Date.now(),
        expiresAt:  Infinity,
        duration:   0,
        type,
        state:      'spawn',
        depthFactor: 1,
        shadowBase: {
            primaryY: 8,    primaryBlur: 0,   primaryOpacity: 0.14,
            secondaryY: 16, secondaryBlur: 0, secondaryOpacity: 0.08,
        },
        tint:    SHADOW_TINTS[tintKey] || SHADOW_TINTS.info,
        handlers: null,
        height:   null,
        currentTranslateX:  0,
        currentScale:       1,
        currentStackOffset: 0,
    };
}


/* ════════════════════════════════════════════════════════════════
   ASYNC RESOLVER — Dual-pattern: callback OR async Promise
   ════════════════════════════════════════════════════════════════
   Detects which pattern the user passed:
     fn.length === 0 → async fn, no params → await it, read return value
     fn.length >= 1  → callback fn         → pass resolve callback

   This fixes the "stuck in processing" bug where an async function
   was passed but the internal Promise never resolved because the
   callback was never called.
   ════════════════════════════════════════════════════════════════ */

async function _runAsyncFn(fn) {
    if (!fn) return true;

    // Pattern A: user passed async () => { ... return boolean }
    // fn.length === 0 means no parameters expected — treat as direct async fn
    if (fn.length === 0) {
        const result = await fn();
        return result !== false; // undefined/true → success; false → error
    }

    // Pattern B: user passed (resolve) => { resolve(true/false) }
    return new Promise((resolvePromise) => {
        fn((success) => {
            resolvePromise(success !== false);
        });
    });
}


/* ════════════════════════════════════════════════════════════════
   TITLE MORPH SYSTEM — v7.4.0 premium slide + blur
   ════════════════════════════════════════════════════════════════
   Out: slide up + blur out. In: slide from below + blur in.
   Blur filter gives a "focus shift" depth illusion.
   ════════════════════════════════════════════════════════════════ */

function morphTitle(element, newText, newColor) {
    const titleEl = element.querySelector('.text-main');
    if (!titleEl) return Promise.resolve();

    return new Promise(resolve => {
        // Clear any inline opacity/transform left by stagger spring.
        // If element is opacity:0 from stagger-init, animationend may fire
        // instantly on a hidden element — or browser skips the animation entirely.
        titleEl.style.opacity    = '';
        titleEl.style.transform  = '';
        titleEl.style.transition = 'none'; // prevent transition fighting animation
        void titleEl.offsetWidth;          // flush style before class change

        titleEl.classList.add('morphing-out');

        // Fallback: if animationend never fires (reduced-motion, hidden, browser quirk)
        // resolve after CSS duration + buffer (qnotify-title-out = 0.20s)
        let outDone = false;
        const onOutEnd = () => {
            if (outDone) return;
            outDone = true;
            clearTimeout(outTimer);
            titleEl.removeEventListener('animationend', onOutEnd);
            titleEl.classList.remove('morphing-out');

            titleEl.textContent = newText;
            if (newColor) titleEl.style.color = newColor;

            void titleEl.offsetWidth; // flush before morph-in

            titleEl.classList.add('morphing-in');

            let inDone = false;
            const onInEnd = () => {
                if (inDone) return;
                inDone = true;
                clearTimeout(inTimer);
                titleEl.removeEventListener('animationend', onInEnd);
                titleEl.classList.remove('morphing-in');
                // Guarantee visibility after animation — no residual inline styles
                titleEl.style.opacity   = '';
                titleEl.style.transform = '';
                titleEl.style.filter    = '';
                resolve();
            };
            const inTimer = setTimeout(onInEnd, TIMING.TITLE_MORPH_IN_MS);
            titleEl.addEventListener('animationend', onInEnd, { once: true });
        };
        const outTimer = setTimeout(onOutEnd, TIMING.TITLE_MORPH_OUT_MS);
        titleEl.addEventListener('animationend', onOutEnd, { once: true });
    });
}


/* ════════════════════════════════════════════════════════════════
   BODY MORPH — message + buttons fade/slide during state changes
   ════════════════════════════════════════════════════════════════
   Dialog DOM structure (from render.js createDialogElement):
     .text-small  → subtitle label ("Konfirmasi")
     .text-main   → user message body  ← NOT the title element here
     .confirmation-actions → button row

   IMPORTANT: .text-main is ALSO the element morphTitle() animates.
   morphBodyOut/In must NOT set opacity/transform on .text-main —
   morphTitle() owns that element entirely. Only .text-small and
   .confirmation-actions are safe to dissolve here.
   ════════════════════════════════════════════════════════════════ */

function morphBodyOut(element) {
    // .text-small = "Konfirmasi" subtitle label — fade + slide up
    const textSmall = element.querySelector('.text-small');
    // .confirmation-actions = Yes/No button row — slide down + fade
    const actions   = element.querySelector('.confirmation-actions');

    // NOTE: intentionally skip .text-main — morphTitle() owns it

    if (textSmall) {
        textSmall.style.transition = 'opacity 0.20s ease, transform 0.20s ease';
        textSmall.style.opacity    = '0';
        textSmall.style.transform  = 'translateY(-5px)';
    }

    if (actions) {
        actions.style.transition = 'opacity 0.18s ease, transform 0.18s ease';
        actions.style.opacity    = '0';
        actions.style.transform  = 'translateY(8px)';
    }

    // Wait for dissolve before caller proceeds
    return new Promise(r => setTimeout(r, TIMING.BODY_MORPH_WAIT_MS));
}

function morphBodyIn(element) {
    const textSmall = element.querySelector('.text-small');
    const actions   = element.querySelector('.confirmation-actions');

    const easeOut = 'cubic-bezier(0.22, 1, 0.36, 1)';

    if (textSmall) {
        textSmall.style.transition = `opacity 0.32s ${easeOut}, transform 0.32s ${easeOut}`;
        textSmall.style.opacity    = '';
        textSmall.style.transform  = '';
    }
    if (actions) {
        setTimeout(() => {
            actions.style.transition = `opacity 0.36s ${easeOut}, transform 0.36s ${easeOut}`;
            actions.style.opacity    = '';
            actions.style.transform  = '';
        }, 80);
    }
}


/* ════════════════════════════════════════════════════════════════
   THEME MORPH — icon blob + button color with spring scale bounce
   ════════════════════════════════════════════════════════════════ */

function morphTheme(element, themeKey) {
    const theme    = MORPH_THEME[themeKey];
    if (!theme) return;

    const iconBlob = element.querySelector('.icon-blob');
    const iconSpan = element.querySelector('.icon-blob .material-icons-round');
    const btnYes   = element.querySelector('.confirm-btn.yes');

    // Icon blob — CSS transition handles color, JS spring handles scale bounce
    if (iconBlob) {
        iconBlob.style.background = theme.gradient;
        iconBlob.style.boxShadow  = theme.shadow;

        // Spring-driven scale bounce for satisfying morph feel
        const blobSc = _aSpring({ k: 420, c: 18, m: 0.85 });
        blobSc.jump(0.82);
        blobSc.to(1, {
            onUpdate: v => { iconBlob.style.transform = `scale(${v.toFixed(5)})`; },
            onRest:   () => { iconBlob.style.transform = ''; },
        });
    }

    // Icon glyph — fade out → swap → fade in with upward motion
    if (iconSpan && theme.icon) {
        iconSpan.style.transition = 'opacity 0.15s ease, transform 0.15s ease';
        iconSpan.style.opacity    = '0';
        iconSpan.style.transform  = 'scale(0.6) translateY(-4px)';

        setTimeout(() => {
            iconSpan.textContent = theme.icon;
            iconSpan.style.transition = 'opacity 0.28s cubic-bezier(0.34,1.4,0.64,1), transform 0.28s cubic-bezier(0.34,1.4,0.64,1)';
            iconSpan.style.opacity    = '1';
            iconSpan.style.transform  = 'scale(1) translateY(0)';
        }, 160);
    }

    // Button color morph — CSS custom properties + transition
    if (btnYes) {
        btnYes.style.setProperty('--btn-bg',    theme.btnYesBg);
        btnYes.style.setProperty('--btn-floor',  theme.btnYesFloor);
        btnYes.style.setProperty('--btn-glow',   theme.btnYesGlow);
        btnYes.style.background = theme.btnYesBg;
        btnYes.style.boxShadow  =
            `0 5px 0 ${theme.btnYesFloor}, ` +
            `0 8px 22px ${theme.btnYesGlow}, ` +
            `inset 0 1px 0 rgba(255,255,255,0.22)`;
    }
}


/* ════════════════════════════════════════════════════════════════
   HOLD FILL — Dynamic Progress System (unchanged)
   ════════════════════════════════════════════════════════════════ */

function _parseRGB(colorStr) {
    const m = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return null;
    return { r: +m[1], g: +m[2], b: +m[3] };
}

function _lighten(ch, f) {
    return Math.round(ch + (255 - ch) * f);
}

function createHoldFill(btnYes, holdDuration) {
    let track = btnYes.querySelector('.hold-fill-track');
    if (!track) {
        track = document.createElement('span');
        track.className = 'hold-fill-track';
        btnYes.insertBefore(track, btnYes.firstChild);
    }

    const computed = window.getComputedStyle(btnYes).backgroundColor;
    const rgb = _parseRGB(computed);
    if (rgb) {
        const sR = _lighten(rgb.r, 0.48), sG = _lighten(rgb.g, 0.48), sB = _lighten(rgb.b, 0.48);
        const eR = _lighten(rgb.r, 0.72), eG = _lighten(rgb.g, 0.72), eB = _lighten(rgb.b, 0.72);
        track.style.background =
            `linear-gradient(90deg, rgba(${sR},${sG},${sB},0.84) 0%, rgba(${eR},${eG},${eB},0.96) 100%)`;
    } else {
        track.style.background = 'linear-gradient(90deg, rgba(255,255,255,0.60), rgba(255,255,255,0.92))';
    }

    let progress   = 0;
    let holding    = false;
    let rafId      = null;
    let lastTime   = null;
    let completed  = false;
    let onComplete = null;

    const RESET_SPEED = 3.2;

    function _applyProgress(p) {
        track.style.transform = `scaleX(${p.toFixed(5)})`;
    }

    function _tick(now) {
        if (completed) return;

        if (lastTime === null) lastTime = now;
        const dt = Math.min((now - lastTime) / 1000, 0.1);
        lastTime = now;

        if (holding) {
            progress += dt / (holdDuration / 1000);

            if (progress >= 1.0) {
                progress = 1.0;
                _applyProgress(1.0);
                completed = true;
                rafId = null;
                if (onComplete) onComplete();
                return;
            }
        } else {
            if (progress <= 0) {
                progress = 0;
                _applyProgress(0);
                rafId = null;
                lastTime = null;
                return;
            }
            const speed = RESET_SPEED * (0.28 + 0.72 * Math.sqrt(progress));
            progress -= dt * speed;
            if (progress < 0) progress = 0;
        }

        _applyProgress(progress);
        rafId = requestAnimationFrame(_tick);
    }

    function _ensureLoop() {
        if (!rafId && !completed) {
            lastTime = null;
            rafId = requestAnimationFrame(_tick);
        }
    }

    return {
        start(cb) {
            if (completed) return;
            onComplete = cb;
            holding = true;
            _ensureLoop();
        },
        stop() {
            holding = false;
            _ensureLoop();
        },
        cancel() {
            completed = true;
            if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
            _applyProgress(0);
        },
        get progress() { return progress; },
    };
}


// ── Transition from spawn → active state ─────────────────────────────────────
// [v8.0.0] LAYOUT THRASH FIX:
//   Old flow: appendToContainer → stampInitialState → forceReflow → afterTwoFrames
//             = READ (reflow) → WRITE (transform) → READ (reflow) = 2x layout!
//
//   New flow: stampInitialState → appendToContainer → forceReflow (1x) → afterTwoFrames
//             = WRITE (before DOM) → insert → READ (1x) → animate
//
//   This matches the same pipeline as show() in engine.js.
//   The stamp happens in createConfirmDialog BEFORE this function is called.
//   activateDialog only needs to kick off the animation sequence.
function activateDialog(notification, focusElement) {
    const el = notification.element;

    if (_dialogEnterCancels.has(el)) {
        _dialogEnterCancels.get(el)();
        _dialogEnterCancels.delete(el);
    }

    // [v8.0.0] Initial state is ALREADY stamped by caller before DOM insert.
    // We only set will-change here (compositor hint — not a layout trigger).
    // Then one clean forceReflow to lock in the stamped state.
    el.style.willChange = 'transform, opacity';

    // Single reflow — AFTER DOM insert, reads committed state once.
    // No second write after this read → no layout thrash.
    forceReflow(el);

    // [Animation Flash] Triple barrier: rAF1 → rAF2 → microtask → animate
    const cancelFrames = afterTwoFrames(() => {
        if (notification.isDead) {
            _dialogEnterCancels.delete(el);
            return;
        }
        el.classList.remove('spawn');
        el.classList.add('active');
        notification.state  = 'active';
        notification.height = el.getBoundingClientRect().height;
        applyDepthShadow(notification);

        if (el._dlgAnimating) return;
        el._dlgAnimating = true;

        let cancelled = false;
        const staggerTimeouts = [];

        const cancelEnter = () => {
            cancelled = true;
            staggerTimeouts.forEach(t => clearTimeout(t));
            staggerTimeouts.length = 0;
            scSpring.stop(); tySpring.stop(); opSpring.stop();
            el.style.opacity   = '1';
            el.style.transform = 'translate(-50%,-50%) scale(1)';
            el.style.willChange = 'auto';
            el._dlgAnimating   = false;
            el.querySelectorAll('.stagger').forEach(item => {
                item.style.opacity   = '';
                item.style.transform = '';
                item.style.willChange = 'auto';
            });
            _dialogEnterCancels.delete(el);
        };
        _dialogEnterCancels.set(el, cancelEnter);

        // Expressive spring enter: low damping = satisfying overshoot
        // Scale starts at 0.88 (more travel) → springs past 1.0 briefly → settles.
        // Matches the "pop" feel of iOS alerts/sheets.
        const scSpring = _aSpring({ k: 280, c: 18, m: 0.9 });
        const tySpring = _aSpring({ k: 300, c: 22, m: 0.9 });
        const opSpring = _aSpring({ k: 260, c: 20, m: 1.0 });
        scSpring.jump(0.88); tySpring.jump(14); opSpring.jump(0);

        let cardDone = 0;
        const onCardPart = () => {
            if (cancelled) return;
            cardDone++;
            if (cardDone >= 3) {
                // [v8.0.1] DIALOG TEXT CENTERING FIX.
                // Spring rests at target ± float epsilon (e.g. scale=0.99997, ty=0.02).
                // Inline `transform: translate(-50%,-50%) scale(0.99997) translateY(0.02px)`
                // technically overrides CSS, and sub-pixel scale differences can cause
                // text to appear fractionally off-center (especially noticeable on HiDPI).
                // Setting the exact CSS rest state eliminates float drift entirely.
                el.style.transform  = 'translate(-50%,-50%)';
                el.style.opacity    = '';  // let CSS / default control opacity at rest
                el.style.willChange = 'auto';
                el._dlgAnimating = false;
                _dialogEnterCancels.delete(el);
                if (focusElement) focusElement.focus();
            }
        };

        const applyCard = () => {
            if (cancelled) return;
            el.style.transform = `translate(-50%,-50%) scale(${scSpring.x.toFixed(5)}) translateY(${tySpring.x.toFixed(2)}px)`;
        };

        scSpring.to(1, { onUpdate: applyCard, onRest: onCardPart });
        tySpring.to(0, { onUpdate: applyCard, onRest: onCardPart });
        opSpring.to(1, { onUpdate: v => { if (!cancelled) el.style.opacity = v.toFixed(3); }, onRest: onCardPart });

        const staggerItems = Array.from(el.querySelectorAll('.stagger'));
        staggerItems.forEach((item, i) => {
            item.classList.add('stagger-init');
            item.style.transition = 'none';

            const t = setTimeout(() => {
                if (cancelled) {
                    item.classList.remove('stagger-init');
                    item.style.opacity   = '';
                    item.style.transform = '';
                    return;
                }
                item.classList.remove('stagger-init');
                item.style.willChange = 'transform, opacity';
                const sTy = _aSpring({ k: 260, c: 20, m: 1.0 });
                const sOp = _aSpring({ k: 260, c: 20, m: 1.0 });
                sTy.jump(12); sOp.jump(0);

                let sd = 0;
                const onSPart = () => {
                    if (cancelled) return;
                    sd++;
                    if (sd >= 2) {
                        item.style.willChange = 'auto';
                        item.style.transform  = '';
                        item.style.opacity    = '';
                    }
                };
                sTy.to(0, { onUpdate: v => { if (!cancelled) item.style.transform = `translateY(${v.toFixed(2)}px)`; }, onRest: onSPart });
                sOp.to(1, { onUpdate: v => { if (!cancelled) item.style.opacity = v.toFixed(3); }, onRest: onSPart });
            }, 60 + i * 50);
            staggerTimeouts.push(t);
        });
    });

    notification._cancelFrames = cancelFrames;
}

// ── Dialog spring exit ────────────────────────────────────────────────────────
export function animateDialogExit(element, onDone) {
    if (_dialogEnterCancels.has(element)) {
        _dialogEnterCancels.get(element)();
        _dialogEnterCancels.delete(element);
    }

    element.style.willChange = 'transform, opacity';

    // Crisper exit springs — overdamped so no bounce on exit
    const scSpring = _aSpring({ k: 380, c: 30, m: 0.9 });
    const tySpring = _aSpring({ k: 360, c: 28, m: 0.9 });
    const opSpring = _aSpring({ k: 340, c: 28, m: 1.0 });
    scSpring.jump(1); tySpring.jump(0); opSpring.jump(1);

    // [v8.0.0] Backdrop exit: spring to 0, let CSS transition handle cleanup.
    // We DON'T call backdrop.classList.remove('active') here because
    // engine._cleanup() calls hideBackdrop() after this — avoid double removal.
    const backdrop = document.getElementById('qnotify-backdrop');
    if (backdrop && backdrop.classList.contains('active')) {
        // Spring-driven backdrop exit synced with dialog exit
        const bdSpring = _aSpring({ k: 300, c: 24, m: 1.0 });
        const curOpacity = parseFloat(backdrop.style.opacity) || 1;
        bdSpring.jump(curOpacity);
        bdSpring.to(0, {
            onUpdate: v => {
                if (backdrop) backdrop.style.opacity = v.toFixed(3);
            },
            onRest: () => {
                // Restore to CSS-controlled state after spring finishes
                if (backdrop) backdrop.style.opacity = '';
            },
        });
    }

    const applyExit = () => {
        element.style.transform = `translate(-50%,-50%) scale(${scSpring.x.toFixed(5)}) translateY(${tySpring.x.toFixed(2)}px)`;
    };

    // Clean modern exit: gentle sink + fade — iOS/macOS dismiss pattern
    scSpring.to(0.95, { onUpdate: applyExit });
    tySpring.to(16,   { onUpdate: applyExit });
    opSpring.to(0, {
        onUpdate: v => { element.style.opacity = v.toFixed(3); },
        onRest: () => {
            // [v8.0.1] Finalize opacity to exact 0 and clear willChange.
            // Avoids any sub-pixel opacity bleed (e.g. 0.0014) on the last frame.
            element.style.opacity   = '0';
            element.style.willChange = 'auto';
            clearInitialState(element);
            if (onDone) onDone();
        },
    });
}


// Scroll lock + backdrop reveal delegated entirely to render.showBackdrop().
// Single source of truth: render.js owns the backdrop lifecycle.
// Eliminates duplication that caused timing divergence in previous versions.
const lockScroll   = showBackdrop;
const unlockScroll = hideBackdrop;


/* ══════════════════════════════════════════════════════════════════════════════
   [Phase B a11y] KEYBOARD ACCESSIBILITY — ESC + Focus Trap + Enter
   ══════════════════════════════════════════════════════════════════════════════
   Shared keyboard handler for all dialog types (confirm, async, hold, hold-async).
   - ESC: cancel dialog (trigger handleNo)
   - Tab: cycle between Yes/No buttons (focus trap)
   - Shift+Tab: reverse cycle
   - Enter: activate focused button (or default to No for safety)
   ══════════════════════════════════════════════════════════════════════════════ */
function _attachDialogKeyboard(notification, element, btnYes, btnNo, onNo) {
    let _keyPending = false;

    const handleKeydown = (e) => {
        if (notification.isDead) return;
        if (_keyPending) return;
        _keyPending = true;
        requestAnimationFrame(() => { _keyPending = false; });

        // ESC → cancel
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onNo();
            return;
        }

        // Tab → focus trap (cycle between Yes and No only)
        if (e.key === 'Tab') {
            e.preventDefault();
            if (e.shiftKey) {
                // Shift+Tab → go to Yes (or stay on Yes → go to No)
                if (document.activeElement === btnYes) btnNo?.focus();
                else btnYes?.focus();
            } else {
                // Tab → go to No (or stay on No → go to Yes)
                if (document.activeElement === btnNo) btnYes?.focus();
                else btnNo?.focus();
            }
            return;
        }

        // Enter → activate focused button
        if (e.key === 'Enter') {
            // Don't trigger hold buttons via Enter — hold requires pointer
            if (btnYes && btnYes.classList.contains('hold-btn')) return;
            e.preventDefault();
            const focused = document.activeElement;
            if (focused === btnYes && !btnYes?.disabled) {
                btnYes.click();
            } else if (focused === btnNo && !btnNo?.disabled) {
                btnNo.click();
            }
            return;
        }
    };

    document.addEventListener('keydown', handleKeydown);

    // Return cleanup function to remove listener on dialog dismiss
    return () => {
        document.removeEventListener('keydown', handleKeydown);
    };
}


/* ══════════════════════════════════════════════════════════════════════════════
   ASYNC STATE HANDLERS — Unified morphing v7.4.0
   ══════════════════════════════════════════════════════════════════════════════ */

async function _enterProcessingState(element, lang) {
    const loader     = element.querySelector('.qnotify-loader');
    const loaderPath = loader?.querySelector('.loader-path');
    const iconSpan   = element.querySelector('.icon-blob .material-icons-round');

    element.classList.add('processing');

    // Dissolve body content out before morphing
    await morphBodyOut(element);

    // Theme morph to neutral gray
    morphTheme(element, 'processing');

    // Title morph to "Processing..."
    await morphTitle(element, getText(TEXTS.confirm.processing, lang));

    // Show loader after icon glyph has faded
    if (iconSpan) {
        iconSpan.style.opacity   = '0';
        iconSpan.style.transform = 'scale(0.5)';
    }
    if (loader) loader.classList.add('visible');
    if (loaderPath) {
        loaderPath.style.animation = 'qnotify-dash 1.5s ease-in-out infinite, qnotify-rotate 2s linear infinite';
    }
}

async function _enterSuccessState(element, lang) {
    const loader     = element.querySelector('.qnotify-loader');
    const loaderPath = loader?.querySelector('.loader-path');

    element.classList.remove('processing');
    element.classList.add('result-success');

    // Hide loader
    if (loader) loader.classList.remove('visible');
    if (loaderPath) loaderPath.style.animation = 'none';

    // Theme morph to success green with spring bounce
    morphTheme(element, 'success');

    // Title morph to "Success!"
    await morphTitle(element, getText(TEXTS.confirm.success, lang), '#34c759');

    // Restore body context
    morphBodyIn(element);
}

async function _enterErrorState(element, lang) {
    const loader     = element.querySelector('.qnotify-loader');
    const loaderPath = loader?.querySelector('.loader-path');

    element.classList.remove('processing');
    element.classList.add('result-error');

    // Hide loader
    if (loader) loader.classList.remove('visible');
    if (loaderPath) loaderPath.style.animation = 'none';

    // Theme morph to error red
    morphTheme(element, 'error');

    // Title morph to "Failed!"
    await morphTitle(element, getText(TEXTS.confirm.failed, lang), '#ff3b30');

    // Restore body context
    morphBodyIn(element);
}


/* ══════════════════════════════════════════════════════════════════════════════
   CONFIRM DIALOG — Standard Yes / No
   ══════════════════════════════════════════════════════════════════════════════ */
export function createConfirmDialog({
    id, container, lang, isDesktop,
    title, message, icon, onYes, onNo, dismissFn, intent = 'info',
}) {
    const element  = createDialogElement({ id, title, message, icon, lang, intent, hasLoader: false, isHold: false });
    const tintKey  = intent === 'danger' ? 'error' : intent === 'warning' ? 'warning' : 'info';
    const notification = makeDialogNotification({ id, element, isDesktop, type: 'confirmation', tintKey });

    applyShadowColor(element, tintKey);
    applySpawnShadow(notification);

    const yesBtn = element.querySelector('.confirm-btn.yes');
    const noBtn  = element.querySelector('.confirm-btn.no');

    const handleYes = (e) => {
        e.stopPropagation();
        if (notification.isDead) return;
        if (onYes) onYes();
        dismissFn(id);
    };
    const handleNo = (e) => {
        e.stopPropagation();
        if (notification.isDead) return;
        if (onNo) onNo();
        dismissFn(id);
    };

    yesBtn.addEventListener('click', handleYes);
    noBtn.addEventListener('click',  handleNo);

    notification.handlers = {
        events: [
            { el: yesBtn, type: 'click', fn: handleYes },
            { el: noBtn,  type: 'click', fn: handleNo  },
        ],
    };

    // [Phase B a11y] Keyboard accessibility — ESC, Tab trap, Enter
    const _cleanupKeyboard = _attachDialogKeyboard(notification, element, yesBtn, noBtn, handleNo);
    notification._cleanupKeyboard = _cleanupKeyboard;

    // [v8.0.0] Stamp BEFORE DOM insert — eliminates layout thrash in activateDialog()
    _stampDialogInitial(element);
    appendToContainer(container, element);
    lockScroll();
    activateDialog(notification, noBtn);

    return notification;
}


/* ══════════════════════════════════════════════════════════════════════════════
   ASYNC CONFIRM DIALOG — Confirm + async callback + morphing states
   ══════════════════════════════════════════════════════════════════════════════
   v7.4.0: Dual-pattern async — supports both:
     onAsyncYes: async () => { await doWork(); return true; }        // Promise pattern
     onAsyncYes: (resolve) => { doWork().then(() => resolve(true)); } // Callback pattern
   ══════════════════════════════════════════════════════════════════════════════ */
export function createAsyncConfirmDialog({
    id, container, lang, isDesktop,
    title, message, icon, onAsyncYes, onAsyncNo, dismissFn, intent = 'info',
}) {
    const element  = createDialogElement({ id, title, message, icon, lang, intent, hasLoader: true, isHold: false });
    const tintKey  = intent === 'danger' ? 'error' : intent === 'warning' ? 'warning' : 'info';
    const notification = makeDialogNotification({ id, element, isDesktop, type: 'confirmation', tintKey });

    applyShadowColor(element, tintKey);
    applySpawnShadow(notification);

    const yesBtn = element.querySelector('.confirm-btn.yes');
    const noBtn  = element.querySelector('.confirm-btn.no');

    const handleYes = async (e) => {
        e.stopPropagation();
        if (notification.isDead) return;

        // Lock UI
        yesBtn.disabled = true;
        noBtn.disabled  = true;
        yesBtn.style.pointerEvents = 'none';
        noBtn.style.pointerEvents  = 'none';

        // Enter processing — body dissolves, title morphs, spinner appears
        await _enterProcessingState(element, lang);

        // Yield one frame before running async work
        await new Promise(r => requestAnimationFrame(r));

        try {
            // _runAsyncFn handles both Promise and callback patterns
            const resolved = await _runAsyncFn(onAsyncYes);

            if (resolved) {
                await _enterSuccessState(element, lang);
            } else {
                await _enterErrorState(element, lang);
            }
            setTimeout(() => { if (!notification.isDead) dismissFn(id); }, TIMING.RESULT_AUTODISMISS_MS);
        } catch (err) {
            await _enterErrorState(element, lang);
            setTimeout(() => { if (!notification.isDead) dismissFn(id); }, TIMING.RESULT_AUTODISMISS_MS);
            // onAsyncConfirm rejection — silently dismissed. Caller's responsibility to handle.
        }
    };

    const handleNo = (e) => {
        e.stopPropagation();
        if (notification.isDead) return;
        if (onAsyncNo) onAsyncNo();
        dismissFn(id);
    };

    yesBtn.addEventListener('click', handleYes);
    noBtn.addEventListener('click',  handleNo);

    notification.handlers = {
        events: [
            { el: yesBtn, type: 'click', fn: handleYes },
            { el: noBtn,  type: 'click', fn: handleNo  },
        ],
    };

    // [Phase B a11y] Keyboard accessibility — ESC, Tab trap, Enter
    const _cleanupKb = _attachDialogKeyboard(notification, element, yesBtn, noBtn, handleNo);
    notification._cleanupKeyboard = _cleanupKb;

    // [v8.0.0] Stamp BEFORE DOM insert — eliminates layout thrash in activateDialog()
    _stampDialogInitial(element);
    appendToContainer(container, element);
    lockScroll();
    activateDialog(notification, noBtn);

    return notification;
}


/* ══════════════════════════════════════════════════════════════════════════════
   HOLD CONFIRM DIALOG — Must hold button for holdDuration ms
   ══════════════════════════════════════════════════════════════════════════════ */
export function createHoldConfirmDialog({
    id, container, lang, isDesktop,
    title, message, icon, holdDuration = TIMING.HOLD_DURATION_DEFAULT_MS,
    onConfirm, onCancel, dismissFn, intent = 'warning',
}) {
    const element  = createDialogElement({ id, title, message, icon, lang, intent, hasLoader: false, isHold: true });
    const tintKey  = intent === 'danger' ? 'error' : 'warning';
    const notification = makeDialogNotification({ id, element, isDesktop, type: 'hold', tintKey });

    applyShadowColor(element, tintKey);
    applySpawnShadow(notification);

    const btnNo  = element.querySelector('.confirm-btn.no');
    const btnYes = element.querySelector('.confirm-btn.yes');

    let fill      = null;
    let holdTimer = null;
    let isDone    = false;

    const startHold = (e) => {
        e.preventDefault();
        if (isDone || btnYes.disabled || !fill) return;

        btnYes.classList.add('holding');

        fill.start(() => {
            isDone = true;
            clearTimeout(holdTimer);
            btnYes.classList.remove('holding');
            if (onConfirm) onConfirm();
            dismissFn(id);
        });

        holdTimer = setTimeout(() => {
            if (isDone) return;
            isDone = true;
            btnYes.classList.remove('holding');
            fill.stop();
            if (onConfirm) onConfirm();
            dismissFn(id);
        }, holdDuration);
    };

    const cancelHold = () => {
        if (isDone) return;
        clearTimeout(holdTimer);
        holdTimer = null;
        btnYes.classList.remove('holding');
        fill && fill.stop();
    };

    const handleNo = (e) => {
        e.stopPropagation();
        if (notification.isDead) return;
        cancelHold();
        if (onCancel) onCancel();
        dismissFn(id);
    };

    const events = [
        { el: btnYes, type: 'pointerdown',   fn: startHold,  options: { passive: false } },
        { el: btnYes, type: 'pointerup',     fn: cancelHold },
        { el: btnYes, type: 'pointerleave',  fn: cancelHold },
        { el: btnYes, type: 'pointercancel', fn: cancelHold },
        { el: btnNo,  type: 'click',         fn: handleNo   },
    ];

    events.forEach(({ el, type, fn, options }) => el.addEventListener(type, fn, options));
    notification.handlers = { events };

    // [Phase B a11y] Keyboard accessibility — ESC, Tab trap (Enter disabled for hold)
    const _cleanupKb = _attachDialogKeyboard(notification, element, btnYes, btnNo, handleNo);
    notification._cleanupKeyboard = _cleanupKb;

    // [v8.0.0] Stamp BEFORE DOM insert — eliminates layout thrash
    _stampDialogInitial(element);
    appendToContainer(container, element);
    lockScroll();

    requestAnimationFrame(() => {
        fill = createHoldFill(btnYes, holdDuration);
    });

    activateDialog(notification, btnNo);
    return notification;
}


/* ══════════════════════════════════════════════════════════════════════════════
   HOLD ASYNC CONFIRM DIALOG — Hold + async loader after hold completes
   ══════════════════════════════════════════════════════════════════════════════
   v7.4.0: Same dual-pattern async fix applied here.
   ══════════════════════════════════════════════════════════════════════════════ */
export function createHoldAsyncConfirmDialog({
    id, container, lang, isDesktop,
    title, message, icon, holdDuration = TIMING.HOLD_DURATION_DEFAULT_MS,
    onAsyncConfirm, onCancel, dismissFn, intent = 'warning',
}) {
    const element  = createDialogElement({ id, title, message, icon, lang, intent, hasLoader: true, isHold: true });
    const tintKey  = intent === 'danger' ? 'error' : 'warning';
    const notification = makeDialogNotification({ id, element, isDesktop, type: 'hold-async', tintKey });

    applyShadowColor(element, tintKey);
    applySpawnShadow(notification);

    const btnNo  = element.querySelector('.confirm-btn.no');
    const btnYes = element.querySelector('.confirm-btn.yes');

    let fill       = null;
    let holdTimer  = null;
    let isDone     = false;
    let processing = false;

    const startProcessing = async () => {
        if (processing) return;
        processing = true;

        btnYes.disabled = true;
        btnNo.disabled  = true;
        btnYes.classList.remove('holding');
        btnYes.style.pointerEvents = 'none';
        btnNo.style.pointerEvents  = 'none';

        // Enter processing with full dissolve + morph
        await _enterProcessingState(element, lang);

        // Yield one frame
        await new Promise(r => requestAnimationFrame(r));

        try {
            const resolved = await _runAsyncFn(onAsyncConfirm);

            if (resolved) {
                await _enterSuccessState(element, lang);
            } else {
                await _enterErrorState(element, lang);
            }
            setTimeout(() => { if (!notification.isDead) dismissFn(id); }, TIMING.RESULT_AUTODISMISS_MS);
        } catch (err) {
            await _enterErrorState(element, lang);
            setTimeout(() => { if (!notification.isDead) dismissFn(id); }, TIMING.RESULT_AUTODISMISS_MS);
            // onAsyncConfirm rejection — silently dismissed. Caller's responsibility to handle.
        }
    };

    const startHold = (e) => {
        e.preventDefault();
        if (isDone || processing || btnYes.disabled || !fill) return;

        btnYes.classList.add('holding');

        fill.start(() => {
            isDone = true;
            clearTimeout(holdTimer);
            btnYes.classList.remove('holding');
            startProcessing();
        });

        holdTimer = setTimeout(() => {
            if (isDone) return;
            isDone = true;
            btnYes.classList.remove('holding');
            fill.stop();
            startProcessing();
        }, holdDuration);
    };

    const cancelHold = () => {
        if (isDone || processing) return;
        clearTimeout(holdTimer);
        holdTimer = null;
        btnYes.classList.remove('holding');
        fill && fill.stop();
    };

    const handleNo = (e) => {
        e.stopPropagation();
        if (notification.isDead) return;
        cancelHold();
        if (onCancel) onCancel();
        dismissFn(id);
    };

    const events = [
        { el: btnYes, type: 'pointerdown',   fn: startHold,  options: { passive: false } },
        { el: btnYes, type: 'pointerup',     fn: cancelHold },
        { el: btnYes, type: 'pointerleave',  fn: cancelHold },
        { el: btnYes, type: 'pointercancel', fn: cancelHold },
        { el: btnNo,  type: 'click',         fn: handleNo   },
    ];

    events.forEach(({ el, type, fn, options }) => el.addEventListener(type, fn, options));
    notification.handlers = { events };

    // [Phase B a11y] Keyboard accessibility — ESC, Tab trap (Enter disabled for hold)
    const _cleanupKb = _attachDialogKeyboard(notification, element, btnYes, btnNo, handleNo);
    notification._cleanupKeyboard = _cleanupKb;

    // [v8.0.0] Stamp BEFORE DOM insert — eliminates layout thrash
    _stampDialogInitial(element);
    appendToContainer(container, element);
    lockScroll();

    requestAnimationFrame(() => {
        fill = createHoldFill(btnYes, holdDuration);
    });

    activateDialog(notification, btnNo);
    return notification;
}
