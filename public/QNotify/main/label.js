// label.js — QNotify alert DOM builder + spring-driven enter/exit animations.
//
// All Family enter/exit animations are JS spring-driven (AnalyticSpring), not CSS
// @keyframes. Springs are interruption-safe (any spring can be stopped mid-flight),
// frame-rate independent, and avoid the animationend race conditions that plague
// CSS-driven staggered enter. Box-shadow animations are avoided entirely because
// they trigger paint instead of compositor — the alert ring uses a static shadow.

import { TEXTS } from './config.js';
import { getText, applyShadowColor } from './render.js';
import { acquireSpring } from './spring.js';
import { escapeHtml } from '../security/sanitize.js';
// glitch.js owns the pre-DOM-insert stamp; we only clear will-change on exit.
import { clearInitialState } from './glitch.js';

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

export function createAlertElement({ id, title, message, icon, lang, intent = 'info', okText }) {
    const finalIntent   = ['danger', 'warning', 'success', 'info'].includes(intent) ? intent : 'info';
    const defaultOkText = getText(TEXTS.confirm.yes, lang);
    const finalOkText   = okText || defaultOkText;
    const iconName      = icon || INTENT_ICONS[finalIntent];
    const accentColor   = INTENT_COLORS[finalIntent];

    const el = document.createElement('div');
    el.id = id;

    // 'spawn' class sets initial hidden state via CSS. 'active' is set later
    // by the engine; it no longer triggers a CSS animation — JS spring handles it.
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

// HYBRID ANIMATION — ENTER
//
// Replaces CSS @keyframes laCardIn + staggered child animations. Same spring-
// overshoot feel, but JS-driven so it's interruption-safe and deterministic.
// Spring params are tuned to match the original CSS cubic-bezier intent:
//   Card:   k=300, c=22 → slight overshoot
//   Icon:   k=340, c=18 → snappy pop
//   Text:   k=260, c=20 → smooth ease-out
//   Btn:    k=320, c=16 → poppy spring
export function animateAlertEnter(el, onReady) {
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

    // Card initial state: centering transform comes from the spawn stamp in
    // engine.js (CSS .spawn { visibility:hidden } = FOUC guard). We write the
    // full initial state here too so springs start from exact values → zero
    // discontinuity on the first frame. Children have never been visible, so
    // writing opacity/transform on them is safe.
    card.style.willChange = 'transform, opacity';
    card.style.opacity    = '0';
    card.style.transform  = 'translate(-50%,-50%) scale(0.88) translateY(18px)';

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

    if (icon) {
        _register(); _register(); // scale + opacity
        const iconSc  = _aSpring({ k: 340, c: 18, m: 0.9 });
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

    if (glyph) {
        _register(); _register();
        const glSc  = _aSpring({ k: 360, c: 18, m: 0.85 });
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

    if (btn) {
        _register(); _register(); _register();
        const bTy = _aSpring({ k: 320, c: 16, m: 0.9 });
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

// HYBRID ANIMATION — EXIT
// Children are reset instantly before the card animates out, so they don't
// fragment against the collapsing card. Backdrop fade is synced with card exit
// (was delay-hiding before, causing a visible gap).
export function animateAlertExit(el, onDone) {
    // Abort any in-progress enter.
    el._laAnimating = false;

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

    // Reset children instantly — no individual animations during exit.
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
            clearInitialState(el);
            if (onDone) onDone();
        },
    });
}
