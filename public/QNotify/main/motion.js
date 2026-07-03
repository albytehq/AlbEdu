// motion.js — Qnotify v8.0.5
/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  Qnotify — motion.js                                        ║
 * ║  "Physics Engine — Analytic Spring + Hybrid Solver"         ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * All animation physics live here: enter, exit, morph, bump, shadow.
 *
 * v7.3.0 MIGRATION: RK4 → Analytic Spring
 *  ✓  AnalyticSpring used for all UI animations by default
 *  ✓  RK4Spring preserved via SOLVER.mode = 'rk4' | 'hybrid'
 *  ✓  Hybrid mode: analytic for enter/exit/hover, RK4 for bump
 *  ✓  Frame-rate independent — identical feel at 60 / 120 / 240 Hz
 *  ✓  Zero numerical drift — exact closed-form solution
 *
 * SOLVER MODES (set SOLVER.mode in config.js before init):
 *   'analytic' → All springs analytic  (default)
 *   'rk4'      → All springs RK4       (legacy)
 *   'hybrid'   → UI analytic, bump RK4
 *
 * OPTIMIZATIONS PRESERVED:
 *  [2]  Global RAF loop
 *  [3]  Time-based evaluation — safe at any refresh rate
 *  [4]  Visibility API — RAF pause, analytic springs resync on resume
 *  [8]  will-change cleared after animation
 *  [9]  Spring object pool
 *  [11] Early-exit on epsilon threshold
 *  [13] Zero array alloc in RK4 path
 *  [14] Spring constants precomputed
 *  [15] WeakMap for DOM shadow refs
 *  [18] Registry cleared on cancel
 *  [20] pointermove throttled
 *  [21] Bump events detached before exit
 */

import { SPRING_CONFIG, SHADOW_BASE, BUMP_CONFIG, STACK_SPRING, MOBILE_STACK, SOLVER, TIMING } from './config.js';
import { AnalyticSpring, RK4Spring, acquireSpring } from './spring.js';
import { applyShadowVars } from './render.js';
// [Phase B a11y] Reduced motion detection — skip springs when user prefers reduced motion
import { prefersReducedMotion } from './glitch.js';

// ════════════════════════════════════════════════════════════
//  SOLVER FACTORY
//
//  Hybrid Architecture (architecture spec):
//    _spring()         → UI animations (enter/exit/hover/stack/morph)
//                        Always analytic in 'hybrid' and 'analytic' modes.
//                        Only RK4 when explicitly set to mode='rk4'.
//
//    _interactSpring() → Gesture-driven motion (bump/drag/tilt)
//                        Always RK4 in 'hybrid' mode.
//                        Follows global mode otherwise.
// ════════════════════════════════════════════════════════════

function _spring(config) {
    // UI springs: analytic unless legacy rk4 mode is explicitly set
    const mode = (SOLVER.mode === 'rk4') ? 'rk4' : 'analytic';
    if (SOLVER.debug) console.debug('[Qnotify spring] UI mode=' + mode, config);
    return acquireSpring(config, mode);
}

function _interactSpring(config) {
    // Gesture/bump springs: always RK4 in hybrid mode (fast interactive response)
    const mode = (SOLVER.mode === 'hybrid' || SOLVER.mode === 'rk4') ? 'rk4' : 'analytic';
    if (SOLVER.debug) console.debug('[Qnotify spring] interact mode=' + mode, config);
    return acquireSpring(config, mode);
}

// ════════════════════════════════════════════════════════════
//  SPRING REGISTRY  [Opt #18]
// ════════════════════════════════════════════════════════════

const _registry = new Map();

function _reg(id, ...springs) {
    if (!_registry.has(id)) _registry.set(id, new Set());
    const set = _registry.get(id);
    springs.forEach(s => set.add(s));
}

// ════════════════════════════════════════════════════════════
//  MOBILE MORPH — circle → pill animation
// ════════════════════════════════════════════════════════════

const MORPH = {
    collapsedW:  70,
    collapsedH:  70,
    collapsedBR: 100,
    expandedH:   78,
    expandedBR:  22,
};

const _eo    = t => 1 - Math.pow(1 - Math.min(Math.max(t, 0), 1), 3);
const _ss    = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
const _clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function applyMobileMorph(notification, t, vel = 0) {
    const el = notification.element;
    const te = _eo(t);

    const maxW = window.innerWidth * 0.90;
    const expW = Math.min(370, maxW);

    const w  = MORPH.collapsedW + (expW - MORPH.collapsedW) * te;
    const h  = MORPH.collapsedH + (MORPH.expandedH - MORPH.collapsedH) * te;
    const br = MORPH.collapsedBR + (MORPH.expandedBR - MORPH.collapsedBR) * te;

    const sq = _clamp(vel * 0.04, -0.2, 0.2);
    notification.morphScaleX = 1 + sq;
    notification.morphScaleY = 1 - sq * 0.7;

    el.style.width        = w.toFixed(1) + 'px';
    el.style.height       = h.toFixed(1) + 'px';
    el.style.borderRadius = br.toFixed(1) + 'px';

    const textA  = _clamp((t - 0.3) / 0.5, 0, 1);
    const textTx = 8 * (1 - _ss(0.3, 1, t));
    el.querySelectorAll('.notification-text .stagger').forEach(se => {
        se.style.opacity   = textA.toFixed(3);
        se.style.transform = 'translateX(' + textTx.toFixed(1) + 'px)';
    });

    notification.morphT = t;
    updateElementTransform(notification);
}

// ════════════════════════════════════════════════════════════
//  INIT MOBILE STATE
// ════════════════════════════════════════════════════════════

function _initMobileState(notification) {
    const slideSpring  = _spring({ k: 220, c: 22, m: 1.0 });
    const stackSpring  = _spring(STACK_SPRING);
    const expandSpring = _spring({ k: 160, c: 20, m: 1.2 });

    slideSpring.jump(-130);
    stackSpring.jump(MOBILE_STACK.BASE_Y);
    expandSpring.jump(0);

    notification.mobileSlide  = slideSpring;
    notification.mobileStack  = stackSpring;
    notification.mobileExpand = expandSpring;
    notification.morphT       = 0;
    notification.morphScaleX  = 1;
    notification.morphScaleY  = 1;
    notification.depthScale   = 1;

    _reg(notification.id, slideSpring, stackSpring, expandSpring);

    // [v7.5.0 FOIS Fix] DOM writes for opacity/transition removed.
    // glitch.js stampInitialState() already sets opacity:0 + off-screen transform
    // BEFORE the element enters the DOM. Writing opacity:'0' here again would:
    //   a) create a redundant write (harmless but wasteful)
    //   b) fight with the stamped transform if timing differs
    // We only set morph geometry (width/height/borderRadius) — these are
    // intentional layout properties for the pill morphing animation,
    // NOT initial state that stampInitialState handles.
    const el = notification.element;

    // Morph geometry initial state — pill starts as circle
    el.style.width        = MORPH.collapsedW + 'px';
    el.style.height       = MORPH.collapsedH + 'px';
    el.style.borderRadius = MORPH.collapsedBR + 'px';
    // opacity is already 0 from glitch.stampInitialState() — do NOT override

    // Icon: visible, reset transform — it never hides during mobile morph
    const iconEl = el.querySelector('.notification-icon');
    if (iconEl) {
        iconEl.style.opacity   = '1';
        iconEl.style.transform = 'none';
    }

    // Text stagger: starts hidden, revealed during expand animation
    el.querySelectorAll('.notification-text .stagger').forEach(se => {
        se.style.opacity   = '0';
        se.style.transform = 'translateX(8px)';
    });
}

// ════════════════════════════════════════════════════════════
//  INIT BUMP STATE
// ════════════════════════════════════════════════════════════

export function initBumpState(notification) {
    if (['confirmation', 'hold', 'hold-async', 'alert'].includes(notification.type)) return;

    const cfg = BUMP_CONFIG;

    const rotX   = _interactSpring({ k: cfg.springRotK,   c: cfg.springRotC,   m: cfg.springRotM });
    const rotY   = _interactSpring({ k: cfg.springRotK,   c: cfg.springRotC,   m: cfg.springRotM });
    const scX    = _interactSpring({ k: cfg.springScaleK, c: cfg.springScaleC, m: cfg.springScaleM });
    const scY    = _interactSpring({ k: cfg.springScaleK, c: cfg.springScaleC, m: cfg.springScaleM });
    const transY = _interactSpring({ k: cfg.springTransK, c: cfg.springTransC, m: cfg.springTransM });

    scX.jump(1); scY.jump(1); rotX.jump(0); rotY.jump(0); transY.jump(0);

    notification.bump = {
        rotateX:    rotX,   rotateY:    rotY,
        scaleX:     scX,    scaleY:     scY,
        translateY: transY,
        pointerDown:    false,
        pointerId:      null,
        downTime:       0,
        downDx:         0,
        downDy:         0,
        lastMoveX:      null,
        lastMoveY:      null,
        reboundTimeout: null,
        handlers:       null,
    };

    _reg(notification.id, rotX, rotY, scX, scY, transY);

    if (!notification.isDesktop) {
        _initMobileState(notification);
    } else {
        notification.stackSpring = _spring(STACK_SPRING);
        notification.stackSpring.jump(notification.currentStackOffset || 0);
        _reg(notification.id, notification.stackSpring);
    }

    updateElementTransform(notification);
}

// ════════════════════════════════════════════════════════════
//  UNIFIED TRANSFORM SYSTEM
// ════════════════════════════════════════════════════════════

export function updateElementTransform(notification) {
    const el = notification.element;
    if (!el) return;
    // [v8.1.0] GUARD FIX: replaced isDead+state='exit' check with el.isConnected.
    //
    // OLD (WRONG): if (notification.isDead && notification.state === 'exit') return;
    // BUG: dismiss() sets isDead=true + state='exit' BEFORE calling animateDesktopExit.
    // Result: every upd() call from txSpring/scSpring hit this guard and returned early.
    // Transform was never written. Only opacity worked (it writes el.style.opacity directly).
    // Animation looked like a pure fade-out because the slide was silently blocked.
    //
    // NEW (CORRECT): skip only when element is truly detached from the DOM.
    // el.isConnected = false AFTER removeElement() in _cleanup — correct timing.
    // el.isConnected = true DURING exit animation — transform updates proceed normally.
    if (!el.isConnected) return;
    if (['confirmation', 'hold', 'hold-async', 'alert'].includes(notification.type)) return;

    const bump = notification.bump;
    const bRX  = bump ? bump.rotateX.val    : 0;
    const bRY  = bump ? bump.rotateY.val    : 0;
    const bSX  = bump ? bump.scaleX.val     : 1;
    const bSY  = bump ? bump.scaleY.val     : 1;
    const bTY  = bump ? bump.translateY.val : 0;

    if (notification.isDesktop) {
        const tX = notification.currentTranslateX || 0;
        const tY = (notification.stackSpring
            ? notification.stackSpring.val
            : notification.currentStackOffset || 0) + bTY;
        const sc = notification.currentScale || 1;

        el.style.transform =
            'translateX(' + tX + 'px) ' +
            'translateY(' + tY.toFixed(3) + 'px) ' +
            'perspective(600px) ' +
            'rotateX(' + bRX.toFixed(4) + 'deg) ' +
            'rotateY(' + bRY.toFixed(4) + 'deg) ' +
            'scaleX(' + (sc * bSX).toFixed(5) + ') ' +
            'scaleY(' + (sc * bSY).toFixed(5) + ')';

    } else {
        const slideY = notification.mobileSlide ? notification.mobileSlide.val : MOBILE_STACK.BASE_Y;
        const stackY = notification.mobileStack ? notification.mobileStack.val : MOBILE_STACK.BASE_Y;
        const depth  = notification.depthScale  || 1;
        const mSX    = notification.morphScaleX || 1;
        const mSY    = notification.morphScaleY || 1;

        const totalY  = slideY + (stackY - MOBILE_STACK.BASE_Y) + bTY;
        const totalSX = mSX * depth * bSX;
        const totalSY = mSY * depth * bSY;

        el.style.transform =
            'translateX(-50%) ' +
            'translateY(' + totalY.toFixed(3) + 'px) ' +
            'perspective(600px) ' +
            'rotateX(' + bRX.toFixed(4) + 'deg) ' +
            'rotateY(' + bRY.toFixed(4) + 'deg) ' +
            'scaleX(' + totalSX.toFixed(5) + ') ' +
            'scaleY(' + totalSY.toFixed(5) + ')';
    }
}

// ════════════════════════════════════════════════════════════
//  MOBILE LAYER
// ════════════════════════════════════════════════════════════

const _DEPTHS = [1, 0.95, 0.90, 0.85];

export function updateMobileLayer(notification, layerIndex) {
    if (notification.isDesktop || !notification.mobileStack || notification.isDead) return;
    const idx = Math.min(layerIndex, _DEPTHS.length - 1);
    notification.depthScale = _DEPTHS[idx];
    updateElementTransform(notification);
}

// ════════════════════════════════════════════════════════════
//  MOBILE ENTER
// ════════════════════════════════════════════════════════════

export function animateMobileEnter(notification) {
    if (notification.isDesktop) return;
    const el  = notification.element;
    const upd = () => updateElementTransform(notification);

    // [Phase B a11y] Reduced motion: skip springs, set final state immediately
    if (prefersReducedMotion()) {
        el.style.opacity = '1';
        applyMobileMorph(notification, 1, 0);
        el.classList.add('active');
        notification.state = 'active';
        notification.height = el.getBoundingClientRect().height;
        updateElementTransform(notification);
        return;
    }

    // [BUG FIX v7.5.1] Element harus terlihat SEKARANG saat slide spring mulai.
    // stampInitialState() menyetel opacity:0 sebelum append — ini benar untuk FOUC guard.
    // Tapi setelah .spawn dihapus dan animasi dimulai, opacity harus jadi 1 agar
    // circle terlihat saat slide masuk dari atas. Sebelumnya opacity tetap 0 sampai
    // expand spring onRest (150ms+ kemudian) — notifikasi tidak terlihat sama sekali.
    el.style.opacity = '1';

    notification.mobileSlide.to(MOBILE_STACK.BASE_Y, { onUpdate: upd });

    const expandTimeout = setTimeout(() => {
        if (notification.isDead) return;
        notification.mobileExpand.jump(0);
        notification.mobileExpand.to(1, {
            onUpdate: (t, vel) => {
                applyMobileMorph(notification, _clamp(t, 0, 1.06), vel);
            },
            onRest: () => {
                applyMobileMorph(notification, 1, 0);
                el.style.opacity = '';
                el.classList.add('active');
                notification.height = el.getBoundingClientRect().height;
                window.dispatchEvent(new CustomEvent('qnotify:morph-complete', {
                    detail: { id: notification.id },
                }));
            },
        });
    }, 150);

    notification._enterTimeout = expandTimeout;
}

// ════════════════════════════════════════════════════════════
//  MOBILE EXIT — 3-phase rAF (pill → icon → gone)
// ════════════════════════════════════════════════════════════

export function animateMobileExit(notification, onDone) {
    if (notification.isDesktop) {
        notification.element.classList.add('exit');
        // CSS .exit transition = 280ms + 120ms safety margin (see TIMING.CSS_EXIT_DURATION_MS)
        setTimeout(onDone, TIMING.CSS_EXIT_DURATION_MS);
        return;
    }

    // [Phase B a11y] Reduced motion: skip 3-phase rAF exit, use CSS + timeout
    if (prefersReducedMotion()) {
        notification.element.classList.add('exit');
        notification.element.style.opacity = '0';
        setTimeout(onDone, TIMING.CSS_EXIT_DURATION_MS);
        return;
    }

    const el = notification.element;

    if (notification._enterTimeout) {
        clearTimeout(notification._enterTimeout);
        notification._enterTimeout = null;
    }
    if (notification.mobileSlide)  notification.mobileSlide.stop();
    if (notification.mobileStack)  notification.mobileStack.stop();
    if (notification.mobileExpand) notification.mobileExpand.stop();

    const m0     = notification.morphT || 1;
    const slideY = notification.mobileSlide ? notification.mobileSlide.val : MOBILE_STACK.BASE_Y;
    const stackY = notification.mobileStack ? notification.mobileStack.val : MOBILE_STACK.BASE_Y;
    const y0     = slideY + (stackY - MOBILE_STACK.BASE_Y);
    const sc0    = notification.depthScale || 1;
    const yExit  = -150;

    const DURATION = 360;
    const t0 = performance.now();
    let raf  = null;

    const _eioQ     = t => t < 0.5 ? 8 * t ** 4 : 1 - 8 * (--t) ** 4;
    const _eiC      = t => t ** 3;
    const _easeOutQ = t => 1 - (1 - t) ** 2;
    const _sub      = (t, s, e) => _clamp((t - s) / (e - s), 0, 1);

    function frame(now) {
        const raw = Math.min((now - t0) / DURATION, 1);

        const shrinkT  = _sub(raw, 0.00, 0.85);
        const morphNow = m0 * (1 - _eioQ(shrinkT));

        const moveT = _sub(raw, 0.15, 1.00);
        const yNow  = y0 + (yExit - y0) * _eiC(moveT);

        const fadeT  = _sub(raw, 0.20, 0.90);
        let   opNow  = Math.max(0, Math.min(1, 1 - _easeOutQ(fadeT)));
        if (raw >= 0.95) opNow = 0;

        applyMobileMorph(notification, _clamp(morphNow, 0, 1), 0);

        const mSX = (notification.morphScaleX || 1) * sc0;
        const mSY = (notification.morphScaleY || 1) * sc0;
        el.style.transform =
            'translateX(-50%) ' +
            'translateY(' + yNow.toFixed(2) + 'px) ' +
            'scaleX(' + mSX.toFixed(5) + ') ' +
            'scaleY(' + mSY.toFixed(5) + ')';

        el.style.opacity = opNow.toFixed(3);

        if (raw < 1) {
            raf = requestAnimationFrame(frame);
        } else {
            el.style.opacity = '0';
            cancelAnimationFrame(raf);
            onDone();
        }
    }

    raf = requestAnimationFrame(frame);
}

// ════════════════════════════════════════════════════════════
//  DESKTOP ENTER / EXIT
// ════════════════════════════════════════════════════════════

export function animateDesktopEnter(notification) {
    if (!notification.isDesktop) return;
    if (['confirmation', 'hold', 'hold-async', 'alert'].includes(notification.type)) return;

    // [Phase B a11y] Reduced motion: skip springs, set final state immediately
    if (prefersReducedMotion()) {
        notification.currentTranslateX = 0;
        notification.currentScale      = 1;
        notification.element.style.opacity = '1';
        updateElementTransform(notification);
        notification.state = 'active';
        notification.height = notification.element.getBoundingClientRect().height;
        return;
    }

    const upd = () => updateElementTransform(notification);

    const txSpring = _spring({ k: 220, c: 20, m: 1 });
    txSpring.x = notification.currentTranslateX || 450;
    txSpring.to(0, { onUpdate: v => { notification.currentTranslateX = v; upd(); } });

    const scSpring = _spring({ k: 240, c: 17, m: 1 });
    scSpring.x = notification.currentScale || 0.85;
    scSpring.to(1.0, { onUpdate: v => { notification.currentScale = v; upd(); } });

    _reg(notification.id, txSpring, scSpring);

    const icon = notification.element.querySelector('.notification-icon');
    if (icon) {
        icon.style.opacity   = '0';
        icon.style.transform = 'translateX(20px)';
        // [v8.0.1] Store handle so animateDesktopExit can cancel before it fires.
        // OLD: anonymous setTimeout — exit had no way to prevent ghost springs.
        notification._enterIconTimeout = setTimeout(() => {
            notification._enterIconTimeout = null;
            if (notification.isDead) return;
            const s1 = _spring({ k: 200, c: 16, m: 1 });
            const s2 = _spring({ k: 220, c: 18, m: 1 });
            s1.x = 20; s2.x = 0;
            s1.to(0, { onUpdate: v => { icon.style.transform = 'translateX(' + v + 'px)'; } });
            s2.to(1, {
                onUpdate: v => { icon.style.opacity = v; },
                onRest:   () => { icon.style.willChange = 'auto'; },
            });
            _reg(notification.id, s1, s2);
        }, 60);
    }

    const text = notification.element.querySelector('.notification-text');
    if (text) {
        text.style.opacity   = '0';
        text.style.transform = 'translateX(15px)';
        // [v8.0.1] Same cancel-safety pattern as icon timeout above.
        notification._enterTextTimeout = setTimeout(() => {
            notification._enterTextTimeout = null;
            if (notification.isDead) return;
            const s1 = _spring({ k: 180, c: 16, m: 1 });
            const s2 = _spring({ k: 200, c: 18, m: 1 });
            s1.x = 15; s2.x = 0;
            s1.to(0, { onUpdate: v => { text.style.transform = 'translateX(' + v + 'px)'; } });
            s2.to(1, {
                onUpdate: v => { text.style.opacity = v; },
                onRest:   () => { text.style.willChange = 'auto'; },
            });
            _reg(notification.id, s1, s2);
        }, 120);
    }
}

export function animateDesktopExit(notification, onDone) {
    if (!notification.isDesktop) {
        notification.element.classList.add('exit');
        // CSS .exit transition = 280ms + 120ms safety margin (see TIMING.CSS_EXIT_DURATION_MS)
        setTimeout(onDone, TIMING.CSS_EXIT_DURATION_MS);
        return;
    }

    // [Phase B a11y] Reduced motion: skip springs, use CSS exit + timeout
    if (prefersReducedMotion()) {
        notification.element.classList.add('exit');
        notification.element.style.opacity = '0';
        setTimeout(onDone, TIMING.CSS_EXIT_DURATION_MS);
        return;
    }

    // [v8.0.1] GHOST SPRING FIX — cancel pending enter stagger timeouts FIRST.
    // If exit fires before the 60ms/120ms icon+text enter timeouts, those callbacks
    // would have created new springs that fight the exit (icon going opacity:0→1
    // while exit drives card opacity:1→0). By cancelling here and cleaning up
    // inline styles, we guarantee a clean exit regardless of timing.
    if (notification._enterIconTimeout) {
        clearTimeout(notification._enterIconTimeout);
        notification._enterIconTimeout = null;
        // Clean up any inline styles the enter animation set before it was cancelled
        const icon = notification.element.querySelector('.notification-icon');
        if (icon) { icon.style.opacity = ''; icon.style.transform = ''; }
    }
    if (notification._enterTextTimeout) {
        clearTimeout(notification._enterTextTimeout);
        notification._enterTextTimeout = null;
        const text = notification.element.querySelector('.notification-text');
        if (text) { text.style.opacity = ''; text.style.transform = ''; }
    }

    cancelNotificationSprings(notification.id);

    const upd = () => updateElementTransform(notification);

    // [v8.0.1] DYNAMIC EXIT DIRECTION — calculate exit X from element's actual width.
    // OLD: hardcoded 380px — could leave card partially visible on narrow screens,
    //      and didn't reflect "each notification exits from its own position".
    // NEW: exit to (element width + right anchor offset + 32px safety buffer).
    //      Notification is right:40px anchored, so exitX = elWidth + 40 + 32 = fully offscreen.
    //      This gives each notification a clean sweep off its own right edge.
    const elWidth  = notification.element.offsetWidth || 390;
    const exitX    = elWidth + 72; // 40px right anchor + 32px safety

    // [v8.1.0] PHASED EXIT — Slide-right IS the primary motion. Opacity trails.
    //
    // ROOT CAUSE (v7.6.0 bug): opacity spring (k=200,c=22) and tx spring (k=240,c=24)
    // shared nearly identical damping ratios (~0.78). Since opacity travels 1→0 (short)
    // while tx travels 0→exitX (~460px, long), opacity hit near-zero in ~180ms while the
    // card had barely moved ~50px. Card disappeared before the slide was visible.
    // onRest was wired to opSpring → cleanup fired before card was off-screen.
    //
    // FIX STRATEGY:
    //   1. txSpring OWNS onDone — cleanup only after card is actually off-screen.
    //   2. Opacity spring starts DELAYED (130ms) — slide is clearly visible first.
    //   3. txSpring is snappier (k=300, ζ=0.58) — decisive flick-to-right feel.
    //   4. opSpring is slower (k=140) — graceful fade trailing the slide.

    // Phase 1: SLIDE — snappy, slightly underdamped for a satisfying exit flick.
    // ζ = 20/(2√300) ≈ 0.577 — underdamped, will overshoot exitX by ~5-8% before settling.
    // Overshoot is off-screen so it's invisible; net effect is a crisp, elastic snap-out.
    const txSpring = _spring({ k: 300, c: 20, m: 1 });
    txSpring.x = notification.currentTranslateX || 0;
    txSpring.to(exitX, {
        onUpdate: v => { notification.currentTranslateX = v; upd(); },
        // WHY onRest here, not on opacity: card is fully off-screen when tx settles.
        // Removing the element at that point is invisible and correct.
        onRest: onDone,
    });

    // Phase 2: SCALE — card compresses slightly as it exits, like being absorbed by edge.
    // Matches tx spring stiffness so both settle together.
    const scSpring = _spring({ k: 280, c: 22, m: 1 });
    scSpring.x = notification.currentScale || 1;
    scSpring.to(0.90, { onUpdate: v => { notification.currentScale = v; upd(); } });

    _reg(notification.id, txSpring, scSpring);

    // Phase 3: OPACITY — deliberately delayed so the slide has 130ms head start.
    // The user sees the card visibly moving right before any fade begins.
    // Slower spring (k=140, ζ=0.76) = gradual dissolve trailing the slide.
    // No onRest needed here — cleanup is handled by txSpring above.
    notification._exitOpTimeout = setTimeout(() => {
        notification._exitOpTimeout = null;
        // Guard: if cleanup already ran (edge case), don't write to detached element
        if (!notification.element || notification.element.style.display === 'none') return;
        const opSpring = _spring({ k: 140, c: 18, m: 1 });
        opSpring.x = parseFloat(notification.element.style.opacity) || 1;
        opSpring.to(0, {
            onUpdate: v => { if (notification.element) notification.element.style.opacity = v.toFixed(3); },
        });
        _reg(notification.id, opSpring);
    }, 130);
}

// ════════════════════════════════════════════════════════════
//  DYNAMIC BUMP  [Opt #20, #21]
// ════════════════════════════════════════════════════════════

export function attachBumpEvents(notification) {
    if (['confirmation', 'hold', 'hold-async', 'alert'].includes(notification.type)) return;
    if (!notification.bump) return;
    if (notification.isDead || notification.state === 'exit') return;

    const el   = notification.element;
    const bump = notification.bump;
    const cfg  = BUMP_CONFIG;
    const upd  = () => { if (!notification.isDead) updateElementTransform(notification); };

    const onDown = e => {
        if (notification.isDead) return;
        e.preventDefault();

        bump.pointerDown = true;
        bump.pointerId   = e.pointerId;
        bump.downTime    = Date.now();
        bump.lastMoveX   = e.clientX;
        bump.lastMoveY   = e.clientY;

        if (bump.reboundTimeout) { clearTimeout(bump.reboundTimeout); bump.reboundTimeout = null; }

        const rect = el.getBoundingClientRect();
        const dx = _clamp((e.clientX - (rect.left + rect.width  / 2)) / (rect.width  / 2), -1, 1);
        const dy = _clamp((e.clientY - (rect.top  + rect.height / 2)) / (rect.height / 2), -1, 1);
        bump.downDx = dx; bump.downDy = dy;

        // Jangan langsung set rotasi dari posisi klik —
        // rotasi diperbarui real-time lewat onMove agar arah
        // langsung responsif tanpa delay persepsi.
        bump.scaleX.to(cfg.holdScaleX,         { onUpdate: upd });
        bump.scaleY.to(cfg.holdScaleY,         { onUpdate: upd });
        bump.translateY.to(cfg.holdTranslateY, { onUpdate: upd });

        el.setPointerCapture(e.pointerId);
    };

    const onMove = e => {
        if (!bump.pointerDown || notification.isDead || e.pointerId !== bump.pointerId) return;
        e.preventDefault();

        // [20] Throttle: skip if delta < 3px (max 3px sesuai spesifikasi)
        const dx2 = e.clientX - (bump.lastMoveX != null ? bump.lastMoveX : e.clientX);
        const dy2 = e.clientY - (bump.lastMoveY != null ? bump.lastMoveY : e.clientY);
        if (dx2 * dx2 + dy2 * dy2 < 9) return;  // 3² = 9 — lebih responsif
        bump.lastMoveX = e.clientX;
        bump.lastMoveY = e.clientY;

        const rect = el.getBoundingClientRect();
        const dx = _clamp((e.clientX - (rect.left + rect.width  / 2)) / (rect.width  / 2), -1, 1);
        const dy = _clamp((e.clientY - (rect.top  + rect.height / 2)) / (rect.height / 2), -1, 1);

        // Arah dideteksi langsung dari pointer position — tidak ada delay
        bump.rotateX.to(dy * cfg.maxRotation, { onUpdate: upd });
        bump.rotateY.to(dx * cfg.maxRotation, { onUpdate: upd });

        const dist          = Math.sqrt(dx * dx + dy * dy);
        const dynamicScaleX = cfg.holdScaleX + dist * 0.02;
        const dynamicScaleY = cfg.holdScaleY - dist * 0.02;
        const dynamicY      = cfg.holdTranslateY + dist * 1.5;

        bump.scaleX.to(dynamicScaleX, { onUpdate: upd });
        bump.scaleY.to(dynamicScaleY, { onUpdate: upd });
        bump.translateY.to(dynamicY,  { onUpdate: upd });
    };

    const onUp = e => {
        if (!bump.pointerDown || notification.isDead || e.pointerId !== bump.pointerId) return;
        e.preventDefault();
        const duration   = Date.now() - bump.downTime;
        bump.pointerDown = false;
        bump.pointerId   = null;
        bump.lastMoveX   = null;
        bump.lastMoveY   = null;

        if (duration < cfg.tapThreshold) {
            _startTap(notification, duration, bump.downDx, bump.downDy, upd);
        } else {
            bump.rotateX.to(0,    { v: 8, onUpdate: upd });
            bump.rotateY.to(0,    { v: 8, onUpdate: upd });
            bump.scaleX.to(1,     { v: 6, onUpdate: upd });
            bump.scaleY.to(1,     { v: 6, onUpdate: upd });
            bump.translateY.to(0, { v: 8, onUpdate: upd });
        }
    };

    const onCancel = e => { if (e.pointerId === bump.pointerId) onUp(e); };
    const onLeave  = e => { if (bump.pointerDown && e.pointerId === bump.pointerId) onUp(e); };

    el.addEventListener('pointerdown',   onDown,  { passive: false });
    el.addEventListener('pointermove',   onMove,  { passive: false });
    el.addEventListener('pointerup',     onUp,    { passive: false });
    el.addEventListener('pointercancel', onCancel);
    el.addEventListener('pointerleave',  onLeave);

    bump.handlers = { onDown, onMove, onUp, onCancel, onLeave };
}

export function detachBumpEvents(notification) {
    if (!notification.bump || !notification.bump.handlers) return;
    const el = notification.element;
    const h  = notification.bump.handlers;
    if (el) {
        el.removeEventListener('pointerdown',   h.onDown);
        el.removeEventListener('pointermove',   h.onMove);
        el.removeEventListener('pointerup',     h.onUp);
        el.removeEventListener('pointercancel', h.onCancel);
        el.removeEventListener('pointerleave',  h.onLeave);
    }
    if (notification.bump.reboundTimeout) {
        clearTimeout(notification.bump.reboundTimeout);
        notification.bump.reboundTimeout = null;
    }
    notification.bump.handlers = null;
}

function _startTap(notification, duration, dx, dy, upd) {
    if (notification.isDead) return;
    const bump = notification.bump;
    const cfg  = BUMP_CONFIG;

    if (bump.reboundTimeout) { clearTimeout(bump.reboundTimeout); bump.reboundTimeout = null; }

    const intensity = _clamp((cfg.tapThreshold - duration) / cfg.tapThreshold, cfg.tapIntensityMin, 1);

    bump.rotateX.to(dy * cfg.tapRotFactor * intensity,   { onUpdate: upd });
    bump.rotateY.to(dx * cfg.tapRotFactor * intensity,   { onUpdate: upd });
    bump.scaleX.to(1 - cfg.tapScaleXFactor * intensity,  { onUpdate: upd });
    bump.scaleY.to(1 - cfg.tapScaleYFactor * intensity,  { onUpdate: upd });
    bump.translateY.to(cfg.tapTransYFactor * intensity,  { onUpdate: upd });

    bump.reboundTimeout = setTimeout(() => {
        if (notification.isDead) return;
        const rv = cfg.tapReboundVelocity;
        bump.rotateX.to(0,    { v: rv, onUpdate: upd });
        bump.rotateY.to(0,    { v: rv, onUpdate: upd });
        bump.scaleX.to(1,     { v: rv, onUpdate: upd });
        bump.scaleY.to(1,     { v: rv, onUpdate: upd });
        bump.translateY.to(0, { v: rv, onUpdate: upd });
        bump.reboundTimeout = null;
    }, cfg.tapPressDuration);
}

// ════════════════════════════════════════════════════════════
//  HOVER SHADOW SYSTEM
// ════════════════════════════════════════════════════════════
//
//  Always analytic — pure UI, not interactive physics.
//  Retargets (does not restart) on rapid hover in/out: no jitter,
//  no CSS transition queue, continuous motion.

const _HOVER_DEPTH_IN   = 1.6;
const _HOVER_DEPTH_OUT  = 1.0;
const _HOVER_SPRING_CFG = { k: 280, c: 22, m: 1 };

export function attachHoverShadow(notification) {
    if (['confirmation', 'hold', 'hold-async', 'alert'].includes(notification.type)) return;
    if (!notification.shadowBase) return;

    const el = notification.element;

    // Always analytic for shadow — visual only
    const depthSpring = acquireSpring(_HOVER_SPRING_CFG, 'analytic');
    depthSpring.jump(notification.depthFactor || 1.0);
    notification._hoverDepthSpring = depthSpring;
    _reg(notification.id, depthSpring);

    const onEnter = () => {
        if (notification.isDead) return;
        depthSpring.to(_HOVER_DEPTH_IN, {
            onUpdate: d => {
                if (notification.isDead) return;
                notification.depthFactor = d;
                applyDepthShadow(notification);
            },
        });
    };

    const onLeave = () => {
        if (notification.isDead) return;
        depthSpring.to(_HOVER_DEPTH_OUT, {
            onUpdate: d => {
                if (notification.isDead) return;
                notification.depthFactor = d;
                applyDepthShadow(notification);
            },
        });
    };

    el.addEventListener('pointerenter', onEnter);
    el.addEventListener('pointerleave', onLeave);

    notification._hoverHandlers = { onEnter, onLeave };
}

export function detachHoverShadow(notification) {
    if (!notification._hoverHandlers) return;
    const el = notification.element;
    if (el) {
        el.removeEventListener('pointerenter', notification._hoverHandlers.onEnter);
        el.removeEventListener('pointerleave', notification._hoverHandlers.onLeave);
    }
    notification._hoverHandlers    = null;
    notification._hoverDepthSpring = null;
}

// ════════════════════════════════════════════════════════════
//  CANCEL ALL SPRINGS  [Opt #18]
// ════════════════════════════════════════════════════════════

export function cancelNotificationSprings(notificationId) {
    const springs = _registry.get(notificationId);
    if (springs) {
        springs.forEach(s => s.stop());
        springs.clear();
        _registry.delete(notificationId);
    }
}

// ════════════════════════════════════════════════════════════
//  SHADOW FUNCTIONS  [Opt #15]
// ════════════════════════════════════════════════════════════

export function applySpawnShadow(notification) {
    const b = notification.shadowBase;
    applyShadowVars(notification.element, {
        primaryY:         b.primaryY * 1.2,
        primaryBlur:      (b.primaryBlur || 0) + 8,
        primaryOpacity:   b.primaryOpacity * 1.5,
        secondaryY:       b.secondaryY * 1.2,
        secondaryBlur:    (b.secondaryBlur || 0) + 8,
        secondaryOpacity: b.secondaryOpacity * 1.5,
    });
}

export function applyDepthShadow(notification) {
    const b = notification.shadowBase;
    const d = notification.depthFactor || 1;
    applyShadowVars(notification.element, {
        primaryY:         b.primaryY * d,
        primaryBlur:      b.primaryBlur || 0,
        primaryOpacity:   b.primaryOpacity * d * 1.2,
        secondaryY:       b.secondaryY * d,
        secondaryBlur:    b.secondaryBlur || 0,
        secondaryOpacity: b.secondaryOpacity * d * 1.2,
    });
}

export function applyExitShadow(notification) {
    const b = notification.shadowBase;
    applyShadowVars(notification.element, {
        primaryY:         b.primaryY * 0.3,    primaryBlur:      12,
        primaryOpacity:   b.primaryOpacity * 0.3,
        secondaryY:       b.secondaryY * 0.3,  secondaryBlur:    16,
        secondaryOpacity: b.secondaryOpacity * 0.3,
    });
}

export function makeShadowBase(isDesktop) {
    return { ...SHADOW_BASE[isDesktop ? 'desktop' : 'mobile'] };
}

// animateSpring — helper for animating a single property via spring
export function animateSpring(notification, property, fromValue, toValue, onComplete, config = {}, delay = 0) {
    const { stiffness = 160, damping = 16, mass = 1 } = { ...SPRING_CONFIG, ...config };
    const spring = _spring({ k: stiffness, c: damping, m: mass });
    spring.x = fromValue;
    _reg(notification.id, spring);

    const applyVal = value => {
        const el   = notification.element;
        const icon = el ? el.querySelector('.notification-icon') : null;
        const text = el ? el.querySelector('.notification-text') : null;
        switch (property) {
            case 'translateX':   notification.currentTranslateX = value; updateElementTransform(notification); break;
            case 'scale':        notification.currentScale      = value; updateElementTransform(notification); break;
            case 'opacity':      if (el)   el.style.opacity             = value; break;
            case 'iconX':        if (icon) icon.style.transform         = 'translateX(' + value + 'px)'; break;
            case 'iconOpacity':  if (icon) icon.style.opacity           = value; break;
            case 'textX':        if (text) text.style.transform         = 'translateX(' + value + 'px)'; break;
            case 'textOpacity':  if (text) text.style.opacity           = value; break;
        }
    };

    const start = () => spring.to(toValue, {
        onUpdate: applyVal,
        onRest:   () => { applyVal(toValue); if (onComplete) onComplete(); },
    });

    if (delay > 0) setTimeout(start, delay); else start();
}

// ════════════════════════════════════════════════════════════
//  [v2.0] SWIPE TO DISMISS — mobile + desktop
//  Swipe left/right to dismiss notification. Uses pointer events
//  (works with touch + mouse). Threshold: 80px horizontal travel.
// ════════════════════════════════════════════════════════════

const SWIPE_THRESHOLD = 80;     // px — dismiss if swipe past this
const SWIPE_VELOCITY = 0.5;     // px/ms — dismiss if fast flick

export function attachSwipeDismiss(notification, dismissFn) {
    if (['confirmation', 'hold', 'hold-async', 'alert', 'readnote'].includes(notification.type)) return;
    if (notification.isDead) return;

    const el = notification.element;
    let startX = 0, startY = 0;
    let currentX = 0;
    let swiping = false;
    let startTime = 0;
    let pointerId = null;

    const onDown = (e) => {
        if (notification.isDead) return;
        // Don't interfere with bump events (they check pointerdown too)
        // Only start swipe if the user moves horizontally > vertical
        swiping = false;
        startX = e.clientX;
        startY = e.clientY;
        currentX = 0;
        startTime = Date.now();
        pointerId = e.pointerId;
    };

    const onMove = (e) => {
        if (notification.isDead || e.pointerId !== pointerId) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        // Determine if this is a horizontal swipe (not vertical scroll)
        if (!swiping && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            swiping = true;
            el.style.transition = 'none';
            el.style.willChange = 'transform, opacity';
        }

        if (swiping) {
            e.preventDefault();
            currentX = dx;
            // Apply transform: follow finger + fade based on distance
            const opacity = Math.max(0.3, 1 - Math.abs(dx) / 300);
            if (notification.isDesktop) {
                const baseTx = notification.currentTranslateX || 0;
                el.style.transform = `translateX(${(baseTx + dx).toFixed(1)}px) translateY(${(notification.stackSpring?.val || 0).toFixed(1)}px) scale(${notification.currentScale || 1})`;
            } else {
                el.style.transform = `translateX(calc(-50% + ${dx.toFixed(1)}px)) translateY(${(notification.mobileStack?.val || 0).toFixed(1)}px) scale(${(notification.morphScaleX || 1) * (notification.depthScale || 1)})`;
            }
            el.style.opacity = String(opacity);
        }
    };

    const onUp = (e) => {
        if (notification.isDead || e.pointerId !== pointerId) return;
        pointerId = null;

        if (!swiping) return;
        swiping = false;

        const dx = currentX;
        const dt = Date.now() - startTime;
        const velocity = Math.abs(dx) / Math.max(dt, 1);

        el.style.transition = '';

        if (Math.abs(dx) > SWIPE_THRESHOLD || velocity > SWIPE_VELOCITY) {
            // Dismiss — animate out in swipe direction
            const exitX = dx > 0 ? 500 : -500;
            el.style.transition = 'transform 0.25s ease-out, opacity 0.25s ease-out';

            if (notification.isDesktop) {
                el.style.transform = `translateX(${exitX}px) scale(0.9)`;
            } else {
                el.style.transform = `translateX(calc(-50% + ${exitX}px)) scale(0.9)`;
            }
            el.style.opacity = '0';

            setTimeout(() => {
                if (!notification.isDead) dismissFn(notification.id);
            }, 250);
        } else {
            // Snap back — spring to original position
            el.style.transition = 'transform 0.2s cubic-bezier(0.2, 0.9, 0.3, 1.1), opacity 0.2s ease';
            el.style.opacity = '';
            // Let the spring system take over again — clear inline transform
            // so updateElementTransform can write the correct value
            setTimeout(() => {
                el.style.transition = '';
                updateElementTransform(notification);
            }, 200);
        }

        currentX = 0;
    };

    el.addEventListener('pointerdown', onDown, { passive: true });
    el.addEventListener('pointermove', onMove, { passive: false });
    el.addEventListener('pointerup', onUp, { passive: true });
    el.addEventListener('pointercancel', onUp, { passive: true });

    notification._swipeHandlers = { onDown, onMove, onUp };
}

export function detachSwipeDismiss(notification) {
    if (!notification._swipeHandlers) return;
    const el = notification.element;
    const h = notification._swipeHandlers;
    if (el) {
        el.removeEventListener('pointerdown', h.onDown);
        el.removeEventListener('pointermove', h.onMove);
        el.removeEventListener('pointerup', h.onUp);
        el.removeEventListener('pointercancel', h.onUp);
    }
    notification._swipeHandlers = null;
}


// ════════════════════════════════════════════════════════════
//  BACKWARD COMPAT — re-export RK4Spring for external consumers
// ════════════════════════════════════════════════════════════

export { RK4Spring } from './spring.js';
