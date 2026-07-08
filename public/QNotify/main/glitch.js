// glitch.js — QNotify anti-glitch utilities: critical CSS injection, backdrop
// pre-warming, font loading, state stamping, frame barriers, resize throttling.
//
// Each helper here exists because of a specific class of glitch the engine
// ran into at some point — the WHY is documented per-section below:
//
// FOUC (Flash of Unstyled Content): critical CSS injected as the FIRST <head>
//   element, idempotent with version guard. injectCriticalCSS().
// FOIT / FOUT (Flash of Invisible/Unstyled Text): font-display:block for icons,
//   swap for body text, preconnect hints with correct crossorigin. loadFonts().
// FOWT (Flash of Wrong Theme): stampTheme() runs before appendToContainer()
//   so the element never enters the DOM without its theme class. stampTheme().
// FOIS (Flash of Incorrect State): stampInitialState() writes transform +
//   opacity BEFORE DOM insert; CSS .spawn { visibility:hidden } is the safety
//   net. stampInitialState().
// Initial Jump / Layout Jump: element is stamped to an off-screen transform
//   (inline style) BEFORE DOM insert — never a frame at the "default" position.
// Animation Flash (first-frame glitch): triple-barrier rAF1→rAF2→µtask→cb.
//   afterTwoFrames().
// Backdrop spike lag: backdrop element + compositor layer allocated at engine
//   init, not on first dialog show. prewarmBackdrop().
// Z-index stacking conflict: unified Z constants — backdrop > container, dialog
//   > backdrop. All modal elements go directly on body, not inside the container.
// Layout thrash in activateDialog(): stamp initial state BEFORE DOM insert,
//   forceReflow once, no read-after-write in the activation path.
// Backdrop transition double-define: transition lives in dialog.css ONLY,
//   critical CSS never touches transition properties.

// Z-INDEX AUTHORITY — single source of truth for all layers.
// No z-index should be hard-coded in other files.

export const Z = {
    CONTAINER:   10000,
    BACKDROP:    10001,   // ABOVE container — shadows render correctly
    DIALOG:      10002,   // ABOVE backdrop
    ALERT:       10002,
    LABEL:       10000,
};

// STYLE GUARD — FOUC prevention. Inject critical CSS as the FIRST <head> element.

const CRITICAL_CSS_VERSION = '105';
let _cssInjected = false;

export function injectCriticalCSS() {
    if (_cssInjected) return;
    _cssInjected = true;

    if (document.querySelector(`style[data-qnotify-critical="${CRITICAL_CSS_VERSION}"]`)) return;

    const style = document.createElement('style');
    style.setAttribute('data-qnotify-critical', CRITICAL_CSS_VERSION);
    // Support nonce-tagged <style> for strict Content-Security-Policy. Pages that
    // ship a CSP nonce can set window.__QNOTIFY_NONCE__ before QNotify loads; we
    // attach it to the injected <style> so it passes style-src 'nonce-<value>' checks.
    // Pages without strict CSP leave the global undefined — no-op.
    if (typeof window !== 'undefined' && window.__QNOTIFY_NONCE__) {
        style.setAttribute('nonce', window.__QNOTIFY_NONCE__);
    }

    // WHY: minimum CSS yang HARUS ada sebelum frame pertama. TIDAK ada transition
    // di sini — transition ada di file CSS masing-masing. Eliminates specificity
    // race untuk backdrop transition.
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

        // FOIS/FOUC: spawn state safety net. JS controls opacity + transform;
        // CSS provides the visibility safety net.
        '.qnotify-item.spawn{',
        '  opacity:0!important;',
        '  visibility:hidden!important;',
        '  pointer-events:none!important;',
        '}',
        '.qnotify-item:not(.spawn){',
        '  visibility:visible;',
        '}',

        // Backdrop pre-warm state.
        // will-change here = GPU layer allocated at page load, not on first show.
        // NO transition here — transition source of truth is dialog.css ONLY.
        // NO backdrop-filter here — lives in dialog.css ::before (never blurs dialog).
        // NO contain:strict — would clip the ::before pseudo-element blur layer.
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

// BACKDROP PRE-WARMER
// Backdrop dibuat saat engine init, BUKAN saat dialog pertama show.
// GPU layer sudah ter-alokasi → showBackdrop() instant, no spike.

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
        // Masuk body langsung — BUKAN di dalam container. Menghindari stacking
        // context inheritance dari notification container.
        document.body.appendChild(backdrop);
    }

    _backdropElement = backdrop;

    // Satu kali forceReflow untuk finalize compositor layer allocation.
    // Dilakukan SATU kali saat init, bukan berulang saat show.
    void backdrop.offsetHeight;
}

export function getBackdrop() {
    if (_backdropElement) return _backdropElement;
    prewarmBackdrop();
    return _backdropElement;
}

// FONT GUARD — FOIT + FOUT prevention.

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
            // display=block: icons always visible, zero FOIT.
            link.href = 'https://fonts.googleapis.com/icon?family=Material+Icons+Round&display=block';
            document.head.appendChild(link);
        }

        if (!document.querySelector('link[href*="Inter"]')) {
            const link = document.createElement('link');
            link.rel  = 'stylesheet';
            // display=swap: text visible with fallback font, no FOIT.
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

// STATE GUARD — FOIS + initial jump prevention.

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

// THEME GUARD — FOWT prevention.

export function stampTheme(el, intent) {
    const valid = ['success', 'error', 'warning', 'info', 'danger'];
    const theme = valid.includes(intent) ? intent : 'info';
    valid.forEach(t => el.classList.remove(t));
    el.classList.add(theme);
}

// FRAME GUARD — animation flash prevention via triple barrier.
//
// Timeline:
//   Stamp → DOM insert → forceReflow (one read)
//   rAF1: browser layout committed (element measured in tree)
//   rAF2: compositor layer allocated (GPU texture ready)
//   µtask: style vars flushed (CSS vars resolved)
//   cb(): animation starts — ZERO visual discontinuity
//
// Triple vs double: on mid-range Android, compositor layer allocation happens
// in a microtask AFTER the 2nd rAF, not during. The Promise.resolve() catches
// this case without adding a full frame.

export function afterTwoFrames(callback) {
    let raf1, raf2;
    let cancelled = false;

    raf1 = requestAnimationFrame(() => {
        if (cancelled) return;
        raf2 = requestAnimationFrame(() => {
            if (cancelled) return;
            // Microtask flush ensures CSS custom properties are resolved.
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

// LAYOUT GUARD — layout thrash prevention.

export function batchReadWrite(reads, writes) {
    const results = reads.map(fn => fn());
    writes.forEach((fn, i) => fn(results[i]));
}

// Force reflow — panggil HANYA untuk "lock in" state sebelum animasi.
export function forceReflow(el) {
    return el.offsetHeight; // intentional forced layout read
}

// RESIZE GUARD — throttled to one rAF per resize burst.

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

// VISIBILITY GUARD — pause animations when tab is hidden.

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

// TRANSFORM BUILDER

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

// DEV AUDIT — log-only diagnostic for tracing glitch guard invocations.

let _auditEnabled = false;

export function setAuditMode(enable) {
    _auditEnabled = Boolean(enable);
}

export function _auditLog(type, detail) {
    if (!_auditEnabled) return;
    // Dev-only diagnostic — never fires in production (gated by setAuditMode(true)).
    // eslint-disable-next-line no-console
    console.warn(`[QNotify GlitchGuard] ${type}: ${detail}`);
}
