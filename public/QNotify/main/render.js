// render.js — QNotify DOM builders. No state lives here, just element factories.
// All user-controlled inputs (title, message, icon) pass through escapeHtml()
// from security/sanitize.js before being interpolated into innerHTML.

import { NOTIFICATION_TYPES, TEXTS, SHADOW_TINTS } from './config.js';
import { getBackdrop, Z } from './glitch.js';
import { escapeHtml } from '../security/sanitize.js';

export function getText(obj, lang) {
    if (!obj || typeof obj !== 'object') return String(obj ?? '');
    return obj[lang] ?? obj.id ?? '';
}

export function ensureContainer() {
    let container = document.getElementById('qnotify-container');
    if (!container) {
        container = document.createElement('div');
        container.id        = 'qnotify-container';
        container.className = 'qnotify-notification-container notification-container';
        // isolation:isolate creates a new stacking context without allocating a
        // new GPU layer — keeps paint from bleeding into parent stacking contexts.
        container.style.isolation = 'isolate';
        document.body.appendChild(container);
    }
    return container;
}

// Backward-compat shim — delegates to glitch.getBackdrop() which uses the
// pre-warmed element. dialog.js lockScroll() still calls this.
export function ensureBackdrop() {
    return getBackdrop();
}

// getBackdrop() returns the pre-warmed element so the GPU layer is already
// allocated — only a class toggle needed here.
//
// WHY rAF: scroll-lock and backdrop reveal must be ATOMIC. If scroll-lock
// happened sync and .active happened async, there'd be a ~16ms window where
// the page is locked but the darkened backdrop isn't visible yet.
export function showBackdrop() {
    const backdrop = getBackdrop();

    requestAnimationFrame(() => {
        backdrop.classList.add('active');
        document.body.classList.add('qnotify-no-scroll', 'no-scroll');
    });
}

export function hideBackdrop() {
    const backdrop = document.getElementById('qnotify-backdrop');
    if (backdrop) {
        backdrop.classList.remove('active');
    }
    document.body.classList.remove('qnotify-no-scroll', 'no-scroll');
}

export function applyShadowColor(element, type) {
    const tint = SHADOW_TINTS[type] || SHADOW_TINTS.info;
    element.style.setProperty('--shadow-primary-color',   tint.primary);
    element.style.setProperty('--shadow-secondary-color', tint.secondary);
}

export function applyShadowVars(element, {
    primaryY, primaryBlur, primaryOpacity,
    secondaryY, secondaryBlur, secondaryOpacity,
}) {
    element.style.setProperty('--shadow-primary-y',         primaryY);
    element.style.setProperty('--shadow-primary-blur',      primaryBlur);
    element.style.setProperty('--shadow-primary-opacity',   primaryOpacity);
    element.style.setProperty('--shadow-secondary-y',       secondaryY);
    element.style.setProperty('--shadow-secondary-blur',    secondaryBlur);
    element.style.setProperty('--shadow-secondary-opacity', secondaryOpacity);
}

export function createNotifyElement({ id, type, title, message, icon, isDesktop, duration, lang }) {
    const config       = NOTIFICATION_TYPES[type] || NOTIFICATION_TYPES.info;
    const finalTitle   = title   || getText(config.title, lang);
    const finalMessage = message || getText(config.msg,   lang);
    const finalIcon    = icon    || config.icon;

    const el = document.createElement('div');
    el.id        = id;
    el.className = `qnotify-item notification-item ${type} spawn`;

    el.setAttribute('data-notification-id', id);
    el.setAttribute('data-qn', '');

    const stagger = isDesktop ? '' : 'stagger';

    el.innerHTML = `
        <div class="notification-icon ${stagger}">
            <div class="icon-blob">
                <span class="material-icons-round">${escapeHtml(finalIcon)}</span>
            </div>
        </div>
        <div class="notification-text" style="-webkit-user-select:none;user-select:none;">
            <div class="text-small ${stagger}">${escapeHtml(finalTitle)}</div>
            <div class="text-main  ${stagger}">${escapeHtml(finalMessage)}</div>
        </div>
        <div class="progress-track">
            <div class="progress-bar" id="qnotify-progress-${id}"></div>
        </div>
    `;

    return el;
}

export function setupProgressBar(element, duration, isDesktop) {
    const bar = element.querySelector('.progress-bar');
    if (!bar || duration <= 0) return;

    bar.style.transformOrigin = isDesktop ? 'bottom' : 'left';
    const animName = isDesktop ? 'qnotify-progress-vertical' : 'qnotify-progress-horizontal';
    // animation-play-state starts paused (CSS: .spawn .progress-bar is paused).
    // When .spawn is removed by engine.js afterTwoFrames(), CSS rule kicks in
    // and sets animation-play-state:running — timer starts exactly when user sees notif.
    bar.style.animation = `${animName} ${duration}ms linear forwards`;
    bar.dataset.qnDuration = duration;
    bar.dataset.qnAnimName = animName;
}

export function updateProgressBarOrientation(element, isDesktop, duration) {
    const bar = element?.querySelector('.progress-bar');
    if (!bar || duration === 0) return;
    // Only update transformOrigin — do NOT restart animation. Restarting would
    // reset progress bar to full (looks like timer reset). Changing just
    // transformOrigin flips the visual direction while preserving elapsed %.
    bar.style.transformOrigin = isDesktop ? 'bottom' : 'left';
    const newName = isDesktop ? 'qnotify-progress-vertical' : 'qnotify-progress-horizontal';
    if (bar.dataset.qnAnimName && bar.dataset.qnAnimName !== newName) {
        // Freeze current progress, swap keyframe, continue from same progress value.
        // animation-delay is left unchanged so the browser continues from the same
        // elapsed point instead of restarting.
        const computed = window.getComputedStyle(bar);
        const delay    = computed.animationDelay;
        bar.dataset.qnAnimName  = newName;
        bar.style.animationName = newName;
    }
}


// All dialog types share the EXACT same DOM structure.
// Differences:
//   - hasLoader: includes SVG spinner inside icon-blob
//   - isHold:    yes button gets .hold-btn class + hold label + data-hold attr
// This guarantees identical layout across all dialog types.

export function createDialogElement({ id, title, message, icon, lang, intent = 'info', hasLoader = false, isHold = false }) {
    const dialogTitle = title || getText(TEXTS.dialog.confirmTitle, lang);
    const finalIcon   = icon || _getIntentIcon(intent);

    // Button labels
    const yesLabel = isHold
        ? getText(TEXTS.confirm.hold, lang)
        : getText(TEXTS.confirm.yes, lang);
    const noLabel = isHold
        ? getText(TEXTS.confirm.cancel, lang)
        : getText(TEXTS.confirm.no, lang);

    // CSS class for dialog variant (all share same base)
    const holdClass = isHold ? 'hold-confirmation' : 'confirmation';
    const asyncClass = hasLoader ? 'async-confirmation' : '';

    const el = document.createElement('div');
    el.id = id;
    el.className = [
        'qnotify-item',
        'qnotify-dialog',
        'notification-item',
        holdClass,
        asyncClass,
        intent,
        'spawn',
    ].filter(Boolean).join(' ');
    el.setAttribute('data-notification-id', id);

    // Loader SVG (only if async)
    const loaderHTML = hasLoader ? `
                <svg class="qnotify-loader premium-loader" viewBox="0 0 100 100">
                    <circle class="loader-bg"   cx="50" cy="50" r="42" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="6"/>
                    <circle class="loader-path" cx="50" cy="50" r="42" fill="none" stroke="white"               stroke-width="6" stroke-linecap="round"/>
                </svg>` : '';

    // Yes button attributes
    const holdAttrs = isHold ? ' hold-btn" data-hold' : '"';
    const btnYesClass = isHold
        ? 'qnotify-btn confirm-btn yes hold-btn'
        : 'qnotify-btn confirm-btn yes';

    el.innerHTML = `
        <div class="notification-icon">
            <div class="icon-blob stagger">
                <span class="material-icons-round">${escapeHtml(finalIcon)}</span>${loaderHTML}
            </div>
        </div>
        <div class="notification-text" style="-webkit-user-select:none;user-select:none;">
            <div class="text-small stagger">${escapeHtml(getText(TEXTS.dialog.confirmTitle, lang))}</div>
            <div class="text-main  stagger">${escapeHtml(message || '')}</div>
        </div>
        <div class="confirmation-actions stagger">
            <button class="qnotify-btn confirm-btn no">${escapeHtml(noLabel)}</button>
            <button class="${btnYesClass}"${isHold ? ' data-hold' : ''}>${escapeHtml(yesLabel)}</button>
        </div>
    `;

    return el;
}

function _getIntentIcon(intent) {
    switch (intent) {
        case 'danger':  return 'error';
        case 'warning': return 'warning';
        case 'success': return 'check_circle';
        case 'info':
        default:        return 'help';
    }
}


// Legacy aliases for createDialogElement — no longer used by dialog.js but
// kept in case external code references them.

export function createConfirmElement(opts) {
    return createDialogElement({ ...opts, hasLoader: false, isHold: false });
}

export function createAsyncConfirmElement(opts) {
    return createDialogElement({ ...opts, hasLoader: true, isHold: false });
}

export function createHoldElement(opts) {
    return createDialogElement({ ...opts, hasLoader: false, isHold: true });
}

export function createHoldAsyncElement(opts) {
    return createDialogElement({ ...opts, hasLoader: true, isHold: true });
}


export function removeElement(element) {
    if (element && element.parentNode) {
        element.parentNode.removeChild(element);
    }
}

export function appendToContainer(container, element) {
    container.appendChild(element);
}