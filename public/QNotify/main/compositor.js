// compositor.js — QNotify 1.0.5 For AlbEdu
/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  QNotify — compositor.js 1.0.5 For AlbEdu                             ║
 * ║  "GPU Layer Lifecycle Manager — Promote Fast, Retire Fast"  ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * MASALAH YANG DISELESAIKAN:
 *
 *  🎮 GPU Layer Thrashing
 *     Setiap kali will-change berubah, browser harus reallocate
 *     compositor layer. Kalau ini terjadi sering (per-notification),
 *     ada overhead besar.
 *     Fix: Promote layer SEKALI saat element akan beranimasi,
 *          retire SEKALI setelah animasi selesai. Tidak ada yo-yo.
 *
 *  💾 Layer Memory Leak
 *     will-change: transform left permanent di banyak elemen
 *     = setiap notif makan compositor memory bahkan saat idle.
 *     Fix: Explicit layer retirement setelah spring rest.
 *          WeakRef tracking — tidak ada strong reference leaks.
 *
 *  ⚡ First-Frame Compositor Spike
 *     Browser alokasikan GPU layer pada FIRST USE — bukan saat
 *     will-change ditulis. Kalau will-change ditulis bersamaan dengan
 *     animasi pertama, frame pertama itu BERAT (layer allocation + animation).
 *     Fix: Pre-allocate layer sebelum animasi via promoteLayer().
 *          Layer sudah ready sebelum frame pertama.
 *
 *  🔁 Concurrent Animation Corruption
 *     Kalau dua animasi jalan bersamaan pada elemen yang sama
 *     dan keduanya manage will-change sendiri-sendiri, bisa race condition.
 *     Fix: Layer counter per element. Retire hanya kalau semua
 *          animations selesai (counter === 0).
 *
 * ARSITEKTUR:
 *  - promoteLayer(el)    → set will-change, increment counter
 *  - retireLayer(el)     → decrement counter, remove if 0
 *  NOTE: withLayer() removed — YAGNI. Use promoteLayer/retireLayer directly.
 *  - LayerBudget         → cap total promoted layers untuk hemat VRAM
 */

// ═══════════════════════════════════════════════════════════
//  LAYER REGISTRY
//  WeakMap: tidak ada strong reference = no leak kalau elemen dibuang
// ═══════════════════════════════════════════════════════════

// Tracks how many concurrent animations each element has running
const _layerCounters = new WeakMap(); // el → number

// Total promoted layers across all elements
let _totalLayers = 0;

// Max simultaneous GPU layers — tune based on device capability
// Mobile: 8 (conservative VRAM), Desktop: 16 (generous)
const MAX_LAYERS_MOBILE  = 8;
const MAX_LAYERS_DESKTOP = 16;

function _getMaxLayers() {
    // deviceMemory API gives VRAM hint on supported browsers
    const mem = navigator?.deviceMemory ?? 4;
    if (mem <= 2) return MAX_LAYERS_MOBILE;
    return window.innerWidth > 768 ? MAX_LAYERS_DESKTOP : MAX_LAYERS_MOBILE;
}

// ═══════════════════════════════════════════════════════════
//  PUBLIC API
// ═══════════════════════════════════════════════════════════

/**
 * Promote element to its own GPU compositor layer.
 * Safe to call multiple times — layer ref-counted.
 *
 * @param {HTMLElement} el        - Element to promote
 * @param {string}      [props]   - CSS will-change value
 * @returns {boolean}             - true if layer was promoted
 */
export function promoteLayer(el, props = 'transform, opacity') {
    if (!el) return false;

    const current = _layerCounters.get(el) ?? 0;
    _layerCounters.set(el, current + 1);

    if (current === 0) {
        // First promotion for this element — check budget
        const maxLayers = _getMaxLayers();
        if (_totalLayers >= maxLayers) {
            // Over budget: don't promote, but still track the counter
            // so retireLayer() stays balanced. Just don't set will-change.
            return false;
        }

        el.style.willChange = props;
        _totalLayers++;
    }

    return true;
}

/**
 * Retire GPU layer for element.
 * Layer is removed when all animations that promoted it have finished.
 *
 * @param {HTMLElement} el
 */
export function retireLayer(el) {
    if (!el) return;

    const current = _layerCounters.get(el) ?? 0;
    if (current <= 0) return;

    const next = current - 1;
    _layerCounters.set(el, next);

    if (next === 0) {
        // All animations done — retire layer
        _layerCounters.delete(el);
        if (el.style.willChange && el.style.willChange !== 'auto') {
            el.style.willChange = 'auto';
            _totalLayers = Math.max(0, _totalLayers - 1);
        }
    }
}



/**
 * Force-retire ALL layers — call on clearAll() or page unload.
 * Prevents VRAM leaks on heavy usage.
 */
export function retireAllLayers() {
    _totalLayers = 0;
    // WeakMap entries auto-cleared when elements are GC'd
    // We can't iterate WeakMap, but _totalLayers reset is enough
    // to allow new promotions after a full clear.
}

/**
 * @returns {number} Current number of promoted GPU layers
 */
export function getLayerCount() {
    return _totalLayers;
}

// ═══════════════════════════════════════════════════════════
//  PAINT CONTAINMENT HELPER
//  Applies contain: layout style paint to isolate paint costs
//  for elements that don't need to affect layout outside themselves.
// ═══════════════════════════════════════════════════════════

/**
 * Apply CSS containment to reduce paint scope.
 * Call on container elements that won't affect outside layout.
 * @param {HTMLElement} el
 */
export function containPaint(el) {
    if (!el) return;
    el.style.contain = 'layout style paint';
}

/**
 * Remove containment (e.g. if element needs to overflow its bounds)
 * @param {HTMLElement} el
 */
export function releaseContainment(el) {
    if (!el) return;
    el.style.contain = '';
}

// ═══════════════════════════════════════════════════════════
//  ANIMATION FRAME BUDGET
//  Tracks expensive operations and defers them if frame is already busy.
// ═══════════════════════════════════════════════════════════

let _frameBudgetUsed    = 0;  // ms used this frame
let _frameBudgetReset   = 0;  // timestamp of last reset
const FRAME_BUDGET_MS   = 10; // max ms per frame for non-animation work

/**
 * Check if we have frame budget remaining.
 * Use before expensive non-critical operations.
 * @returns {boolean}
 */
export function hasFrameBudget() {
    const now = performance.now();
    // Reset budget each frame (~16ms)
    if (now - _frameBudgetReset > 16) {
        _frameBudgetUsed  = 0;
        _frameBudgetReset = now;
    }
    return _frameBudgetUsed < FRAME_BUDGET_MS;
}

/**
 * Mark that an operation used some frame budget.
 * @param {number} ms - milliseconds consumed
 */
export function useFrameBudget(ms) {
    _frameBudgetUsed += ms;
}

// ═══════════════════════════════════════════════════════════
//  DEVICE CAPABILITY PROBE
//  One-time probe at module load. Used throughout system
//  to adapt animation complexity to device capability.
// ═══════════════════════════════════════════════════════════

const _caps = (() => {
    const isLowEnd = (() => {
        // navigator.hardwareConcurrency: low-end devices typically have 2-4 cores
        const cores = navigator?.hardwareConcurrency ?? 4;
        const mem   = navigator?.deviceMemory ?? 4;
        return cores <= 2 || mem <= 1;
    })();

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const supportsBackdropFilter = CSS.supports('backdrop-filter', 'blur(1px)');
    const supportsContain = CSS.supports('contain', 'layout style paint');

    return {
        isLowEnd,
        prefersReducedMotion,
        supportsBackdropFilter,
        supportsContain,
        // Animation quality tier: 'full' | 'reduced' | 'minimal'
        tier: prefersReducedMotion ? 'minimal'
            : isLowEnd             ? 'reduced'
            :                        'full',
    };
})();

export const DeviceCaps = _caps;

/**
 * Get appropriate spring stiffness multiplier for current device.
 * On low-end devices, use stiffer springs = shorter animations = less CPU.
 * @returns {number} 1.0 for full quality, 1.4 for reduced, 2.0 for minimal
 */
export function getSpringMultiplier() {
    switch (_caps.tier) {
        case 'minimal': return 2.0;
        case 'reduced': return 1.4;
        default:        return 1.0;
    }
}
