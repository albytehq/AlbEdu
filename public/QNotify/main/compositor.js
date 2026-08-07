// compositor.js — QNotify GPU layer lifecycle manager.
//
// GPU Layer Thrashing: every will-change change forces the browser to reallocate
//   a compositor layer. Per-notification thrash = big overhead. Promote ONCE
//   when the element starts animating, retire ONCE when done — no yo-yo.
// Layer Memory Leak: will-change:transform left permanently on many elements =
//   each notif eats compositor memory even at idle. Explicit retirement after
//   spring rest + WeakRef tracking (no strong reference leaks).
// First-Frame Compositor Spike: browser allocates the GPU layer on FIRST USE,
//   not when will-change is written. If will-change is written alongside the
//   first animation frame, that frame is heavy (allocation + animation).
//   Pre-allocate via promoteLayer() so the layer is ready before frame 1.
// Concurrent Animation Corruption: two animations managing will-change on the
//   same element race. Per-element layer counter — retire only when all
//   animations finish (counter === 0).
//
// Public API: promoteLayer / retireLayer / retireAllLayers / getLayerCount.
// withLayer() was removed (YAGNI). LayerBudget caps total promoted layers to
// save VRAM.

// LAYER REGISTRY
// WeakMap: tidak ada strong reference = no leak kalau elemen dibuang.

// Tracks how many concurrent animations each element has running.
const _layerCounters = new WeakMap(); // el → number

// Total promoted layers across all elements.
let _totalLayers = 0;

// Max simultaneous GPU layers — tune based on device capability.
// Mobile: 8 (conservative VRAM), Desktop: 16 (generous).
const MAX_LAYERS_MOBILE  = 8;
const MAX_LAYERS_DESKTOP = 16;

function _getMaxLayers() {
    // deviceMemory API gives VRAM hint on supported browsers.
    const mem = navigator?.deviceMemory ?? 4;
    if (mem <= 2) return MAX_LAYERS_MOBILE;
    return window.innerWidth > 768 ? MAX_LAYERS_DESKTOP : MAX_LAYERS_MOBILE;
}

// PUBLIC API

// Promote element to its own GPU compositor layer. Safe to call multiple
// times — layer is ref-counted.
export function promoteLayer(el, props = 'transform, opacity') {
    if (!el) return false;

    const current = _layerCounters.get(el) ?? 0;
    _layerCounters.set(el, current + 1);

    if (current === 0) {
        // First promotion for this element — check budget.
        const maxLayers = _getMaxLayers();
        if (_totalLayers >= maxLayers) {
            // Over budget: don't promote, but still track the counter so
            // retireLayer() stays balanced. Just don't set will-change.
            return false;
        }

        el.style.willChange = props;
        _totalLayers++;
    }

    return true;
}

// Retire GPU layer for element. Layer is removed when all animations that
// promoted it have finished.
export function retireLayer(el) {
    if (!el) return;

    const current = _layerCounters.get(el) ?? 0;
    if (current <= 0) return;

    const next = current - 1;
    _layerCounters.set(el, next);

    if (next === 0) {
        // All animations done — retire layer.
        _layerCounters.delete(el);
        if (el.style.willChange && el.style.willChange !== 'auto') {
            el.style.willChange = 'auto';
            _totalLayers = Math.max(0, _totalLayers - 1);
        }
    }
}

// Force-retire ALL layers — call on clearAll() or page unload. Prevents VRAM
// leaks on heavy usage.
export function retireAllLayers() {
    _totalLayers = 0;
    // WeakMap entries auto-cleared when elements are GC'd. We can't iterate
    // WeakMap, but the _totalLayers reset is enough to allow new promotions
    // after a full clear.
}

export function getLayerCount() {
    return _totalLayers;
}

// PAINT CONTAINMENT HELPER
// Applies contain: layout style paint to isolate paint costs for elements
// that don't need to affect layout outside themselves.

export function containPaint(el) {
    if (!el) return;
    el.style.contain = 'layout style paint';
}

export function releaseContainment(el) {
    if (!el) return;
    el.style.contain = '';
}

// ANIMATION FRAME BUDGET
// Tracks expensive operations and defers them if frame is already busy.

let _frameBudgetUsed    = 0;  // ms used this frame
let _frameBudgetReset   = 0;  // timestamp of last reset
const FRAME_BUDGET_MS   = 10; // max ms per frame for non-animation work

// Check if we have frame budget remaining. Use before expensive non-critical
// operations.
export function hasFrameBudget() {
    const now = performance.now();
    // Reset budget each frame (~16ms).
    if (now - _frameBudgetReset > 16) {
        _frameBudgetUsed  = 0;
        _frameBudgetReset = now;
    }
    return _frameBudgetUsed < FRAME_BUDGET_MS;
}

export function useFrameBudget(ms) {
    _frameBudgetUsed += ms;
}

// DEVICE CAPABILITY PROBE
// One-time probe at module load. Used throughout the system to adapt animation
// complexity to device capability.

const _caps = (() => {
    const isLowEnd = (() => {
        // navigator.hardwareConcurrency: low-end devices typically have 2-4 cores.
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
        // Animation quality tier: 'full' | 'reduced' | 'minimal'.
        tier: prefersReducedMotion ? 'minimal'
            : isLowEnd             ? 'reduced'
            :                        'full',
    };
})();

export const DeviceCaps = _caps;

// Get appropriate spring stiffness multiplier for current device. On low-end
// devices, use stiffer springs = shorter animations = less CPU.
export function getSpringMultiplier() {
    switch (_caps.tier) {
        case 'minimal': return 2.0;
        case 'reduced': return 1.4;
        default:        return 1.0;
    }
}
