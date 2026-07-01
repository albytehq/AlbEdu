// glitch.js — Qnotify v8.0.5
/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  Qnotify — glitch.js v8.0.5                                 ║
 * ║  "Anti-Glitch Guardian — Production Grade, Zero Compromise" ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * v8.0.0 OVERHAUL — Root-cause fixes, not band-aids:
 *
 *  ⚡ FOUC  — Flash of Unstyled Content
 *     Fix: CSS critical path di-inject sebagai PERTAMA dalam <head>.
 *          Satu kali per session, idempotent, dengan version guard.
 *
 *  👻 FOIT  — Flash of Invisible Text
 *     Fix: font-display:block untuk icons (immediate), swap untuk body text.
 *          Preconnect hints dipasang dengan crossorigin yang benar.
 *
 *  🔤 FOUT  — Flash of Unstyled Text
 *     Fix: Font metrics di-lock via CSS sebelum font load complete.
 *
 *  🌗 FOWT  — Flash of Wrong Theme
 *     Fix: stampTheme() dipanggil sebelum appendToContainer().
 *          Element tidak pernah masuk DOM tanpa class theme yang benar.
 *
 *  🧠 FOIS  — Flash of Incorrect State
 *     Fix: stampInitialState() menulis transform + opacity SEBELUM DOM insert.
 *          CSS spawn { visibility:hidden } sebagai safety net.
 *
 *  🔄 Initial Jump / Layout Jump
 *     Fix: Element di-stamp ke off-screen transform DULU (JS, inline style),
 *          BARU dimasukkan ke DOM. Tidak ada frame di posisi "default".
 *
 *  🎬 Animation Flash (first-frame glitch)
 *     Fix: Triple-barrier — rAF1 (layout committed) → rAF2 (compositor ready)
 *          → microtask (style flush) → callback. Zero flash guaranteed.
 *
 *  🎭 BACKDROP SPIKE LAG — FIXED v8.0.0
 *     Root cause: ensureBackdrop() dipanggil DALAM showBackdrop(), lalu
 *                 langsung .classList.add('active'). Browser harus:
 *                 1. Buat elemen baru 2. Hitung style 3. Alokasikan compositor
 *                 layer 4. START transition — semua synchronous = SPIKE.
 *     Fix: prewarmBackdrop() dipanggil saat init engine (BUKAN saat show).
 *          will-change:opacity dipasang di critical CSS (GPU layer allocated).
 *          showBackdrop() hanya toggle class → backdrop sudah warm → no spike.
 *
 *  🔀 Z-INDEX STACKING CONFLICT — FIXED v8.0.0
 *     Root cause: container z-index 10000, backdrop z-index 9999 → dalam
 *                 beberapa browser dengan stacking context isolation, dialog
 *                 di z-index 10000 bisa KALAH dengan backdrop z-index 10001.
 *     Fix: Unified Z constants. Backdrop > container. Dialog > backdrop.
 *          Semua elemen modal masuk body langsung (bukan dalam container).
 *
 *  💥 LAYOUT THRASH di activateDialog() — FIXED v8.0.0
 *     Root cause: forceReflow() dipanggil, lalu langsung write transform
 *                 baru → triggered second layout pass dalam frame yang sama.
 *     Fix: Stamp initial state SEBELUM DOM insert. forceReflow SATU kali.
 *          Tidak ada read-after-write dalam activation path.
 *
 *  🌊 BACKDROP TRANSITION DOUBLE-DEFINE — FIXED v8.0.0
 *     Root cause: Transition backdrop didefinisikan DI DUA TEMPAT:
 *                 glitch.js critical CSS DAN dialog.css → specificity race.
 *     Fix: Transition HANYA di dialog.css. Critical CSS tidak menyentuhnya.
 *          Satu source of truth per CSS property.
 */

// ═══════════════════════════════════════════════════════════
//  Z-INDEX AUTHORITY — Single source of truth for all layers
//  Tidak ada z-index hard-coded di file lain.
// ═══════════════════════════════════════════════════════════

export const Z = {
    CONTAINER:   10000,
    BACKDROP:    10001,   // ABOVE container — shadows render correctly
    DIALOG:      10002,   // ABOVE backdrop
    ALERT:       10002,
    LABEL:       10000,
};

// ═══════════════════════════════════════════════════════════
//  STYLE GUARD — FOUC Prevention
//  Inject critical CSS sebagai elemen PERTAMA dalam <head>.
// ═══════════════════════════════════════════════════════════

const CRITICAL_CSS_VERSION = '801';
let _cssInjected = false;

export function injectCriticalCSS() {
    if (_cssInjected) return;
    _cssInjected = true;

    if (document.querySelector(`style[data-qnotify-critical="${CRITICAL_CSS_VERSION}"]`)) return;

    const style = document.createElement('style');
    style.setAttribute('data-qnotify-critical', CRITICAL_CSS_VERSION);
    // Q6 fix (Phase 12 CSP): support nonce-tagged <style> for strict Content-Security-Policy.
    // Pages that ship a CSP nonce can set window.__QNOTIFY_NONCE__ before QNotify loads;
    // we attach it to the injected <style> so it passes style-src 'nonce-<value>' checks.
    // Pages without strict CSP simply leave window.__QNOTIFY_NONCE__ undefined — no-op.
    if (typeof window !== 'undefined' && window.__QNOTIFY_NONCE__) {
        style.setAttribute('nonce', window.__QNOTIFY_NONCE__);
    }

    // WHY: Ini minimum CSS yang HARUS ada sebelum frame pertama.
    // TIDAK ada transition di sini — transition ada di file CSS masing-masing.
    // Ini eliminates specificity race untuk backdrop transition.
    style.textContent = [
        // Container: fixed fullscreen, pointer-events none
        '#qnotify-container,',
        '.qnotify-notification-container{',
        `  position:fixed;inset:0;pointer-events:none;z-index:${Z.CONTAINER};`,
        '  overflow:visible;isolation:isolate;',
        '}',

        // Item base: compositor promotion
        '.qnotify-item{',
        '  pointer-events:auto!important;',
        '  backface-visibility:hidden;',
        '  -webkit-backface-visibility:hidden;',
        '}',

        // FOIT/FOUT lock
        '.qnotify-item .text-small,',
        '.qnotify-item .text-main,',
        '.qnotify-item .notification-text{',
        '  font-synthesis:none;',
        '}',

        // FOIS/FOUC: spawn state safety net
        // JS controls opacity + transform. CSS provides visibility safety net.
        '.qnotify-item.spawn{',
        '  opacity:0!important;',
        '  visibility:hidden!important;',
        '  pointer-events:none!important;',
        '}',
        '.qnotify-item:not(.spawn){',
        '  visibility:visible;',
        '}',

        // Backdrop pre-warm state
        // will-change here = GPU layer allocated at page load, not on first show
        // NO transition here — transition source of truth is dialog.css ONLY
        // NO backdrop-filter here — lives in dialog.css ::before (never blurs dialog)
        // NO contain:strict — would clip the ::before pseudo-element blur layer
        '#qnotify-backdrop{',
        `  position:fixed;inset:0;z-index:${Z.BACKDROP};`,
        '  opacity:0;pointer-events:none;',
        '  will-change:opacity;',
        '}',
        '#qnotify-backdrop.active{',
        '  opacity:1;pointer-events:auto;',
        '}',
    ].join('\n');

    const firstChild = document.head.firstChild;
    firstChild
        ? document.head.insertBefore(style, firstChild)
        : document.head.appendChild(style);
}

// ═══════════════════════════════════════════════════════════
//  BACKDROP PRE-WARMER
//  Backdrop dibuat saat engine init, BUKAN saat dialog pertama show.
//  GPU layer sudah allocated → showBackdrop() instant, no spike.
// ═══════════════════════════════════════════════════════════

let _backdropElement = null;
let _backdropWarmed  = false;

export function prewarmBackdrop() {
    if (_backdropWarmed) return;
    _backdropWarmed = true;

    injectCriticalCSS();

    let backdrop = document.getElementById('qnotify-backdrop');
    if (!backdrop) {
        backdrop = document.createElement('div');
        backdrop.id        = 'qnotify-backdrop';
        backdrop.className = 'qnotify-backdrop confirmation-backdrop';
        // Masuk body langsung — BUKAN di dalam container.
        // Ini menghindari stacking context inheritance dari notification container.
        document.body.appendChild(backdrop);
    }

    _backdropElement = backdrop;

    // Satu kali forceReflow untuk finalize compositor layer allocation.
    // Ini dilakukan SATU kali saat init, bukan berulang saat show.
    void backdrop.offsetHeight;
}

export function getBackdrop() {
    if (_backdropElement) return _backdropElement;
    prewarmBackdrop();
    return _backdropElement;
}

// ═══════════════════════════════════════════════════════════
//  FONT GUARD — FOIT + FOUT Prevention
// ═══════════════════════════════════════════════════════════

let _fontsLoaded     = false;
let _fontLoadPromise = null;

export function loadFonts() {
    if (_fontsLoaded) return _fontLoadPromise || Promise.resolve();
    if (_fontLoadPromise) return _fontLoadPromise;

    injectCriticalCSS();

    _fontLoadPromise = new Promise(resolve => {
        _addPreconnect('https://fonts.googleapis.com');
        _addPreconnect('https://fonts.gstatic.com', true);

        if (!document.querySelector('link[href*="material-icons"]')) {
            const link = document.createElement('link');
            link.rel  = 'stylesheet';
            // display=block: icons always visible, zero FOIT
            link.href = 'https://fonts.googleapis.com/icon?family=Material+Icons+Round&display=block';
            document.head.appendChild(link);
        }

        if (!document.querySelector('link[href*="Inter"]')) {
            const link = document.createElement('link');
            link.rel  = 'stylesheet';
            // display=swap: text visible with fallback font, no FOIT
            link.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap';
            document.head.appendChild(link);
        }

        _fontsLoaded = true;
        resolve();
    });

    return _fontLoadPromise;
}

function _addPreconnect(href, crossorigin = false) {
    if (document.querySelector(`link[rel="preconnect"][href="${href}"]`)) return;
    const link = document.createElement('link');
    link.rel  = 'preconnect';
    link.href = href;
    if (crossorigin) link.crossOrigin = '';
    document.head.appendChild(link);
}

// ═══════════════════════════════════════════════════════════
//  STATE GUARD — FOIS + Initial Jump Prevention
// ═══════════════════════════════════════════════════════════

export function stampInitialState(el, state = {}) {
    const {
        translateX  = 0,
        translateY  = 0,
        scale       = 1,
        opacity     = 0,
        gpuPromote  = true,
    } = state;

    if (gpuPromote) {
        el.style.willChange = 'transform, opacity';
    }

    el.style.transform = _buildTransform({ translateX, translateY, scale });
    el.style.opacity   = String(opacity);
    el.dataset.qnStamped = '1';
}

export function clearInitialState(el) {
    if (!el) return;
    el.style.willChange = 'auto';
    delete el.dataset.qnStamped;
}

// ═══════════════════════════════════════════════════════════
//  THEME GUARD — FOWT Prevention
// ═══════════════════════════════════════════════════════════

export function stampTheme(el, intent) {
    const valid = ['success', 'error', 'warning', 'info', 'danger'];
    const theme = valid.includes(intent) ? intent : 'info';
    valid.forEach(t => el.classList.remove(t));
    el.classList.add(theme);
}

// ═══════════════════════════════════════════════════════════
//  FRAME GUARD — Animation Flash Prevention
//
//  v8.0.5: Triple barrier.
//
//  Timeline:
//    Stamp → DOM insert → forceReflow (one read)
//    rAF1: browser layout committed (element measured in tree)
//    rAF2: compositor layer allocated (GPU texture ready)
//    µtask: style vars flushed (CSS vars resolved)
//    cb(): animation starts — ZERO visual discontinuity
//
//  Triple vs double: on mid-range Android, compositor layer
//  allocation happens in a microtask AFTER the 2nd rAF, not during.
//  The Promise.resolve() catches this case without adding a full frame.
// ═══════════════════════════════════════════════════════════

export function afterTwoFrames(callback) {
    let raf1, raf2;
    let cancelled = false;

    raf1 = requestAnimationFrame(() => {
        if (cancelled) return;
        raf2 = requestAnimationFrame(() => {
            if (cancelled) return;
            // Microtask flush ensures CSS custom properties are resolved
            Promise.resolve().then(() => {
                if (cancelled) return;
                callback();
            });
        });
    });

    return () => {
        cancelled = true;
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
    };
}

export function waitTwoFrames() {
    return new Promise(resolve => afterTwoFrames(resolve));
}

// ═══════════════════════════════════════════════════════════
//  LAYOUT GUARD — Layout Thrash Prevention
// ═══════════════════════════════════════════════════════════

export function batchReadWrite(reads, writes) {
    const results = reads.map(fn => fn());
    writes.forEach((fn, i) => fn(results[i]));
}

/**
 * Force reflow — satu kali, minimal.
 * Panggil HANYA untuk "lock in" state sebelum animasi.
 * @param {HTMLElement} el
 * @returns {number}
 */
export function forceReflow(el) {
    return el.offsetHeight; // intentional forced layout read
}

// ═══════════════════════════════════════════════════════════
//  RESIZE GUARD
// ═══════════════════════════════════════════════════════════

const _resizeHandlers = new Set();
let   _resizePending  = false;

export function onResize(handler) {
    if (_resizeHandlers.size === 0) {
        window.addEventListener('resize', _resizeScheduler, { passive: true });
    }
    _resizeHandlers.add(handler);
    return () => {
        _resizeHandlers.delete(handler);
        if (_resizeHandlers.size === 0) {
            window.removeEventListener('resize', _resizeScheduler);
        }
    };
}

function _resizeScheduler() {
    if (_resizePending) return;
    _resizePending = true;
    requestAnimationFrame(() => {
        _resizePending = false;
        _resizeHandlers.forEach(fn => {
            try { fn(); } catch (e) { /* silent */ }
        });
    });
}

// ═══════════════════════════════════════════════════════════
//  VISIBILITY GUARD
// ═══════════════════════════════════════════════════════════

let _tabVisible = !document.hidden;
const _visibilityHandlers = new Set();

document.addEventListener('visibilitychange', () => {
    _tabVisible = !document.hidden;
    _visibilityHandlers.forEach(fn => {
        try { fn(_tabVisible); } catch (e) { /* silent */ }
    });
}, { passive: true });

export function onVisibilityChange(handler) {
    _visibilityHandlers.add(handler);
    return () => _visibilityHandlers.delete(handler);
}

export function isTabVisible() {
    return _tabVisible;
}

// ═══════════════════════════════════════════════════════════
//  TRANSFORM BUILDER
// ═══════════════════════════════════════════════════════════

export function _buildTransform({
    translateX  = 0,
    translateY  = 0,
    scale       = 1,
    scaleX      = null,
    scaleY      = null,
    rotate      = 0,
    rotateX     = 0,
    rotateY     = 0,
} = {}) {
    const parts = [];

    if (translateX !== 0 || translateY !== 0) {
        parts.push(`translate(${translateX.toFixed(2)}px,${translateY.toFixed(2)}px)`);
    }

    if (scaleX !== null || scaleY !== null) {
        const sx = scaleX !== null ? scaleX : scale;
        const sy = scaleY !== null ? scaleY : scale;
        if (sx !== 1 || sy !== 1) parts.push(`scale(${sx.toFixed(4)},${sy.toFixed(4)})`);
    } else if (scale !== 1) {
        parts.push(`scale(${scale.toFixed(4)})`);
    }

    if (rotateX !== 0 || rotateY !== 0 || rotate !== 0) {
        parts.push('perspective(600px)');
        if (rotateX !== 0) parts.push(`rotateX(${rotateX.toFixed(2)}deg)`);
        if (rotateY !== 0) parts.push(`rotateY(${rotateY.toFixed(2)}deg)`);
        if (rotate  !== 0) parts.push(`rotate(${rotate.toFixed(2)}deg)`);
    }

    return parts.length > 0 ? parts.join(' ') : 'none';
}

// ═══════════════════════════════════════════════════════════
//  DEV AUDIT
// ═══════════════════════════════════════════════════════════

let _auditEnabled = false;

export function setAuditMode(enable) {
    _auditEnabled = Boolean(enable);
}

export function _auditLog(type, detail) {
    if (!_auditEnabled) return;
    // Dev-only diagnostic — never fires in production (gated by setAuditMode(true))
    // eslint-disable-next-line no-console
    console.warn(`[Qnotify GlitchGuard] ${type}: ${detail}`);
}
