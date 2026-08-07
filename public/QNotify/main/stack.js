// stack.js — QNotify notification reflow.
//
// Desktop: notif bertumpuk dari bawah ke atas, ada gap antar item.
// Mobile:  notif overlap seperti deck kartu, yang terbaru di atas.
//
// Performance: all getBoundingClientRect reads are batched in one pass before
// any write; positional changes go via spring/transform only (no top/left);
// reflow is deduplicated to one call per rAF. Dialog types (confirmation, hold,
// hold-async, alert) dikecualikan dari sistem stack — modal overlay punya posisi sendiri.

import { LIMITS, MOBILE_STACK } from './config.js';
import { updateElementTransform, updateMobileLayer, applyDepthShadow } from './motion.js';

// Mencegah reflow dijalankan lebih dari satu kali per frame.
let reflowScheduled = false;
let reflowPending   = false;

// Minta reflow stack — bisa immediate atau di-defer ke frame berikutnya.
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

// Ukur ulang tinggi semua notifikasi. Reads dikumpulkan dulu, baru writes —
// hindari layout thrashing.
export function recalcAllHeights(notifications) {
    // READ — kumpulkan semua tinggi dalam satu pass.
    const reads = [];
    notifications.forEach(n => {
        // Skip dead/exiting notifications — element-nya mungkin sedang detaching.
        if (n.element && n.element.isConnected && !n.isDead && n.state !== 'exit') {
            reads.push({ n, h: n.element.getBoundingClientRect().height });
        }
    });

    // WRITE — update height property, flag reflow kalau ada perubahan.
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

// Tipe-tipe ini dikecualikan dari sistem stack — modal overlay.
const STACK_EXCLUDED_TYPES = new Set(['confirmation', 'hold', 'hold-async', 'alert']);

// Kalkulasi dan terapkan posisi semua notifikasi.
function _performReflow(notifications) {
    const isDesktop = window.innerWidth > LIMITS.MOBILE_BREAKPOINT;

    // Ambil notifikasi aktif yang perlu di-stack, sort dari terbaru ke terlama.
    const activeNotifs = Array.from(notifications.values())
        .filter(n =>
            !n.isDead &&
            n.state !== 'exit' &&
            !STACK_EXCLUDED_TYPES.has(n.type)
        )
        .sort((a, b) => b.createdAt - a.createdAt);

    // Batch read — ukur tinggi yang belum diketahui.
    for (const n of activeNotifs) {
        if (!n.height && n.element) {
            n.height = n.element.getBoundingClientRect().height;
        }
    }

    // Semua writes setelah semua reads selesai.
    if (isDesktop) {
        _reflowDesktop(activeNotifs);
    } else {
        _reflowMobile(activeNotifs);
    }
}

// Desktop: susun dari bawah ke atas dengan gap antar item.
// Reads (height) sudah dilakukan di engine.recalcAllHeights(); di sini kita
// hanya write: spring target, zIndex, depthFactor, shadow. Tidak ada
// getBoundingClientRect() di dalam loop = zero layout thrashing.
function _reflowDesktop(notifs) {
    let offset = 0;
    // Compute all targets (pure math, no DOM reads).
    //
    // offset HARUS diadvance di dalam loop, bukan setelah map. Kalau diadvance
    // setelah map, semua item membaca offset=0 (closure capture sebelum advance),
    // sehingga semua targetY = 0 → semua notifikasi overlap di posisi yang sama.
    const targets = notifs.map((n, index) => {
        const targetY     = -offset;
        const zIndex      = 100 - index;
        const depthFactor = Math.max(0.3, 1 - index * 0.15);
        offset           += (n.height || 145) + LIMITS.STACK_GAP_DESKTOP; // advance immediately
        return { n, targetY, zIndex, depthFactor };
    });

    // All writes (no reads mixed in).
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

// Mobile: overlap seperti deck kartu, terbaru di depan.
// All positional changes via spring/transform only — no top/left. Compute
// targets first (no DOM reads), then write.
function _reflowMobile(notifs) {
    const overlap = MOBILE_STACK.OVERLAP;
    const baseY   = MOBILE_STACK.BASE_Y;
    let   cumulY  = baseY;

    // Compute all targets (pure math — zero DOM reads).
    const targets = notifs.map((n, idx) => {
        const targetY     = cumulY;
        const layerClass  = idx === 0 ? 'active' : idx === 1 ? 'layer-1' : idx === 2 ? 'layer-2' : null;
        const depthFactor = idx === 0 ? 1.0 : idx === 1 ? 0.7 : idx === 2 ? 0.5 : 0.3;
        const effH        = Math.max(0, (n.height || 78) - overlap);
        cumulY += effH;
        return { n, idx, targetY, layerClass, depthFactor };
    });

    // All writes (zero reads in this pass).
    targets.forEach(({ n, idx, targetY, layerClass, depthFactor }) => {
        if (n.mobileStack) {
            n.mobileStack.to(targetY, {
                onUpdate: () => { if (!n.isDead) updateElementTransform(n); },
            });
        }

        const el = n.element;
        el.classList.remove('active', 'layer-1', 'layer-2', 'layer-3', 'layer-4', 'layer-5');
        if (layerClass) el.classList.add(layerClass);

        el.style.zIndex = 100 - idx;
        n.depthFactor   = depthFactor;
        applyDepthShadow(n);
        updateMobileLayer(n, idx);
    });
}

// Paksa hapus notifikasi paling lama kalau melebihi batas maksimum.
// Dipanggil setelah setiap show() baru.
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

    // Buang yang paling lama sampai jumlah sesuai limit.
    if (active.length > max) {
        active.slice(0, active.length - max).forEach(n => dismissCallback(n.id));
    }
}

// Update class container dan trigger immediate reflow.
// Dipanggil saat mode desktop/mobile berubah (resize).
export function updateContainerMode(container, notifications) {
    if (!container) return false;
    const isDesktop     = window.innerWidth > LIMITS.MOBILE_BREAKPOINT;
    container.className = `qnotify-notification-container notification-container ${isDesktop ? 'desktop-mode' : 'mobile-mode'}`;
    requestStackingUpdate(notifications, true);
    return isDesktop;
}
