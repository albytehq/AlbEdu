// stack.js — QNotify 1.0.5 For AlbEdu
/**
 * ╔══════════════════════════════════════════════╗
 * ║  Qnotify — stack.js                         ║
 * ║  "FluidStacked — Notification Reflow"       ║
 * ╚══════════════════════════════════════════════╝
 *
 * Sistem stacking notifikasi:
 *  - Desktop: notif bertumpuk dari bawah ke atas, ada gap antar item
 *  - Mobile:  notif overlap seperti deck kartu, yang terbaru di atas
 *
 * OPTIMASI PERFORMA:
 *  [1] Batched DOM reads — semua getBoundingClientRect dikumpulkan
 *      dalam satu pass sebelum ada operasi write apapun
 *  [6] No forced synchronous layout — reads dipisah dari writes
 *  [rAF] Reflow hanya dijalankan satu kali per frame (deduplicated)
 *
 * ATURAN:
 *  - Dialog types (confirmation, hold, hold-async, alert) dikecualikan
 *    dari sistem stack — mereka punya posisi sendiri (center screen)
 */

import { LIMITS, MOBILE_STACK } from './config.js';
import { updateElementTransform, updateMobileLayer, applyDepthShadow } from './motion.js';
// [v7.5.0] glitch.js: onResize gives throttled single-rAF resize handling
// stack.js uses it indirectly via engine.js — no direct import needed here.

// Flag untuk mencegah reflow dijalankan lebih dari satu kali per frame
let reflowScheduled = false;
let reflowPending   = false;

/**
 * Minta reflow stack — bisa immediate atau di-defer ke frame berikutnya.
 *
 * @param {Map} notifications  - Map semua notifikasi aktif
 * @param {boolean} immediate  - true = jalankan sekarang, false = defer ke rAF
 */
export function requestStackingUpdate(notifications, immediate = false) {
    if (immediate) {
        _performReflow(notifications);
        reflowPending   = false;
        reflowScheduled = false;
        return;
    }
    // Kalau sudah ada reflow yang di-schedule, skip — tunggu yang itu saja
    if (reflowScheduled) return;
    reflowScheduled = true;
    requestAnimationFrame(() => {
        _performReflow(notifications);
        reflowScheduled = false;
        reflowPending   = false;
    });
}

/**
 * Ukur ulang tinggi semua notifikasi.
 * [1] Semua reads dikumpulkan dulu, baru writes — hindari layout thrashing.
 *
 * @param {Map} notifications
 */
export function recalcAllHeights(notifications) {
    // PHASE 1: READ — kumpulkan semua tinggi dalam satu pass
    const reads = [];
    notifications.forEach(n => {
        // [v7.5.0] Skip dead/exiting notifications — their element may be detaching
        if (n.element && n.element.isConnected && !n.isDead && n.state !== 'exit') {
            reads.push({ n, h: n.element.getBoundingClientRect().height });
        }
    });

    // PHASE 2: WRITE — update height property, flag reflow kalau ada perubahan
    for (const { n, h } of reads) {
        if (n.height !== h) {
            n.height      = h;
            reflowPending = true;
        }
    }

    if (reflowPending) {
        requestStackingUpdate(notifications);
        reflowPending = false;
    }
}

// Tipe-tipe ini dikecualikan dari sistem stack — mereka modal overlay
const STACK_EXCLUDED_TYPES = new Set(['confirmation', 'hold', 'hold-async', 'alert']);

// Kalkulasi dan terapkan posisi semua notifikasi
function _performReflow(notifications) {
    const isDesktop = window.innerWidth > LIMITS.MOBILE_BREAKPOINT;

    // Ambil notifikasi aktif yang perlu di-stack, sort dari terbaru ke terlama
    const activeNotifs = Array.from(notifications.values())
        .filter(n =>
            !n.isDead &&
            n.state !== 'exit' &&
            !STACK_EXCLUDED_TYPES.has(n.type)
        )
        .sort((a, b) => b.createdAt - a.createdAt);

    // [1] PHASE 1: Batch read — ukur tinggi yang belum diketahui
    for (const n of activeNotifs) {
        if (!n.height && n.element) {
            n.height = n.element.getBoundingClientRect().height;
        }
    }

    // [6] PHASE 2: Semua writes setelah semua reads selesai
    if (isDesktop) {
        _reflowDesktop(activeNotifs);
    } else {
        _reflowMobile(activeNotifs);
    }
}

// Desktop: susun dari bawah ke atas dengan gap antar item
// [v7.5.0 Layout Thrash Fix] All reads (height) done in engine recalcAllHeights().
// Here we only write: spring target, zIndex, depthFactor, shadow.
// No getBoundingClientRect() inside this loop = zero layout thrashing.
function _reflowDesktop(notifs) {
    let offset = 0;
    // PHASE 1: Compute all targets (pure math, no DOM reads)
    // [BUG FIX v7.5.1] offset HARUS diadvance di dalam loop, bukan setelah map.
    // Sebelumnya semua item membaca offset=0 (closure capture sebelum advance),
    // sehingga semua targetY = -0 = 0 → semua notifikasi overlap di posisi yang sama.
    const targets = notifs.map((n, index) => {
        const targetY     = -offset;
        const zIndex      = 100 - index;
        const depthFactor = Math.max(0.3, 1 - index * 0.15);
        offset           += (n.height || 145) + LIMITS.STACK_GAP_DESKTOP; // advance immediately
        return { n, targetY, zIndex, depthFactor };
    });

    // PHASE 2: All writes (no reads mixed in)
    targets.forEach(({ n, targetY, zIndex, depthFactor }) => {
        if (n.stackSpring) {
            n.stackSpring.to(targetY, {
                onUpdate: () => { if (!n.isDead) updateElementTransform(n); },
            });
        }
        n.element.style.zIndex = zIndex;
        n.depthFactor          = depthFactor;
        applyDepthShadow(n);
    });
}

// Mobile: Dynamic Peek Effect — notif bertumpuk dengan real-time height tracking
// [v2.0 Dynamic Peek Effect] Sistem baru:
//   - Notif depan (idx 0) full height, notif belakang peek dari bawah
//   - Offset belakang = tinggi notif depan + gap (bukan overlap kaku)
//   - Notif belakang di-clamp ke tinggi notif depan + overflow:hidden
//   - Tap front notif → expand semua ke list vertikal (spring animation)
//   - Tap lagi → collapse kembali ke peek mode
//   - Max 3 visible (front + 2 peek)
const PEEK_GAP = 6;           // px gap antara notif depan dan peek
const PEEK_SCALE = [1.0, 0.92, 0.85];  // scale per layer
const PEEK_OPACITY = [1.0, 0.65, 0.35]; // opacity per layer
const PEEK_PEEK_HEIGHT = 8;   // px ujung yang terlihat mengintip

// State: apakah stack sedang di-expand (list mode)?
let _mobileExpanded = false;

function _reflowMobile(notifs) {
    const baseY = MOBILE_STACK.BASE_Y;

    // Limit to 3 visible
    const visible = notifs.slice(0, 3);

    if (_mobileExpanded) {
        _reflowMobileExpanded(visible, baseY);
    } else {
        _reflowMobilePeek(visible, baseY);
    }
}

// Peek mode: notif depan full, belakang peek dengan dynamic height tracking
function _reflowMobilePeek(notifs, baseY) {
    // PHASE 1: Compute targets (pure math)
    const targets = [];
    let cumulY = baseY;

    for (let idx = 0; idx < notifs.length; idx++) {
        const n = notifs[idx];
        const targetY = cumulY;
        const layerClass = idx === 0 ? 'active' : idx === 1 ? 'layer-1' : 'layer-2';
        const depthFactor = PEEK_SCALE[idx] || 0.8;
        const opacity = PEEK_OPACITY[idx] || 0.3;

        if (idx === 0) {
            // Front notif: full height, no clamp
            n._clamped = false;
            cumulY += (n.height || 78) + PEEK_GAP;
        } else {
            // Back notif: clamp height to front notif height + peek height
            const frontHeight = notifs[0].height || 78;
            const clampHeight = frontHeight + PEEK_PEEK_HEIGHT;
            n._clamped = true;
            n._clampHeight = clampHeight;
            cumulY += PEEK_PEEK_HEIGHT + PEEK_GAP;
        }

        targets.push({ n, idx, targetY, layerClass, depthFactor, opacity });
    }

    // PHASE 2: All writes
    targets.forEach(({ n, idx, targetY, layerClass, depthFactor, opacity }) => {
        if (n.mobileStack) {
            n.mobileStack.to(targetY, {
                onUpdate: () => { if (!n.isDead) updateElementTransform(n); },
            });
        }

        const el = n.element;
        el.classList.remove('active', 'layer-1', 'layer-2', 'layer-3', 'layer-4', 'layer-5',
                           'rn-peek-expanded', 'rn-peek-clamped');
        if (layerClass) el.classList.add(layerClass);

        // [Dynamic Peek] Clamp back notifs
        if (n._clamped && n._clampHeight) {
            el.classList.add('rn-peek-clamped');
            el.style.maxHeight = n._clampHeight + 'px';
            el.style.overflow = 'hidden';
        } else {
            el.style.maxHeight = '';
            el.style.overflow = '';
        }

        el.style.zIndex = 100 - idx;
        el.style.opacity = String(opacity);
        n.depthFactor = depthFactor;
        applyDepthShadow(n);
        updateMobileLayer(n, idx);
    });
}

// Expanded mode: semua notif di-expand ke list vertikal, no clamp
function _reflowMobileExpanded(notifs, baseY) {
    let cumulY = baseY;
    const EXPANDED_GAP = 8;

    for (let idx = 0; idx < notifs.length; idx++) {
        const n = notifs[idx];
        const targetY = cumulY;

        if (n.mobileStack) {
            n.mobileStack.to(targetY, {
                onUpdate: () => { if (!n.isDead) updateElementTransform(n); },
            });
        }

        const el = n.element;
        el.classList.remove('active', 'layer-1', 'layer-2', 'layer-3', 'layer-4', 'layer-5',
                           'rn-peek-clamped');
        el.classList.add('active', 'rn-peek-expanded');

        // Release clamp
        el.style.maxHeight = '';
        el.style.overflow = '';
        el.style.opacity = '1';
        el.style.zIndex = 100 - idx;
        n.depthFactor = 1.0;
        applyDepthShadow(n);
        updateMobileLayer(n, 0); // all at full depth when expanded

        cumulY += (n.height || 78) + EXPANDED_GAP;
    }
}

// Toggle expand/collapse — called by tap on front notif
export function toggleMobileExpand(notifications) {
    _mobileExpanded = !_mobileExpanded;
    requestStackingUpdate(notifications, true);
}

// Check if currently expanded
export function isMobileExpanded() {
    return _mobileExpanded;
}

/**
 * Paksa hapus notifikasi paling lama kalau melebihi batas maksimum.
 * Dipanggil setelah setiap show() baru.
 *
 * @param {Map}      notifications
 * @param {boolean}  isDesktop
 * @param {Function} dismissCallback - engine.dismiss() reference
 */
export function enforceStackLimits(notifications, isDesktop, dismissCallback) {
    const max    = isDesktop ? LIMITS.MAX_DESKTOP : LIMITS.MAX_MOBILE;
    const active = Array.from(notifications.values())
        .filter(n =>
            !n.isDead &&
            n.state !== 'exit' &&
            n.isDesktop === isDesktop &&
            !STACK_EXCLUDED_TYPES.has(n.type)
        )
        .sort((a, b) => a.createdAt - b.createdAt); // terlama pertama

    // Buang yang paling lama sampai jumlah sesuai limit
    if (active.length > max) {
        active.slice(0, active.length - max).forEach(n => dismissCallback(n.id));
    }
}

/**
 * Update class container dan trigger immediate reflow.
 * Dipanggil saat mode desktop/mobile berubah (resize).
 *
 * @param {HTMLElement} container
 * @param {Map}         notifications
 * @returns {boolean} isDesktop
 */
export function updateContainerMode(container, notifications) {
    if (!container) return false;
    const isDesktop     = window.innerWidth > LIMITS.MOBILE_BREAKPOINT;
    container.className = `qnotify-notification-container notification-container ${isDesktop ? 'desktop-mode' : 'mobile-mode'}`;
    requestStackingUpdate(notifications, true);
    return isDesktop;
}
