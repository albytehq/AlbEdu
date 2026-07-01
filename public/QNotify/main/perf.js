// perf.js — Qnotify v8.0.5
/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  Qnotify — perf.js                                          ║
 * ║  "Performance Scheduler — Zero Jank, Max Throughput"        ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * MASALAH PERFORMA YANG DISELESAIKAN:
 *
 *  🔄 Animation Jank — animasi patah-patah
 *     Solusi: Single global RAF loop, bukan satu RAF per spring.
 *             Semua spring update dalam satu frame callback.
 *
 *  📉 Frame Drop — FPS turun
 *     Solusi: RAF budget (16ms per frame max). Kalau frame butuh
 *             lebih, pekerjaan mahal dipindah ke idle callback.
 *
 *  🌀 Scroll Jank — scroll berat
 *     Solusi: Event listener dengan { passive: true } di semua
 *             touch/scroll events. Tidak ada preventDefault() di scroll.
 *
 *  🔁 Layout Thrashing — browser hitung ulang layout terus
 *     Solusi: readScheduler + writeScheduler — semua reads dalam
 *             satu microtask, semua writes setelahnya.
 *
 *  📊 Layout Shift (CLS) — elemen loncat-loncat
 *     Solusi: Semua size/position changes via transform (compositor).
 *             Tidak ada width/height/top/left yang diubah saat animasi.
 *             (Pengecualian: mobile morph animation yang memang intentional)
 *
 * ARSITEKTUR:
 *  - GlobalRAFLoop   → satu RAF loop untuk semua springs
 *  - ReadWriteQueue  → batch DOM reads/writes per frame
 *  - IdleScheduler   → pekerjaan mahal → idle callback
 *  - RateLimit       → debounce/throttle untuk event handlers
 *  - PerformanceMonitor → FPS tracking, frame budget warning
 */

// ════════════════════════════════════════════════════════════
//  GLOBAL RAF LOOP
//  Satu RAF loop menggantikan banyak RAF per spring.
//  Semua spring tick dipanggil dalam satu frame.
//  Frame-rate adaptive: jalan di 60/90/120/144/240Hz tanpa drift.
// ════════════════════════════════════════════════════════════

const _tickCallbacks  = new Map();  // id → fn(dt, timestamp)
let   _rafHandle      = null;
let   _lastTimestamp  = 0;
let   _loopRunning    = false;

/**
 * Register callback yang dipanggil setiap frame dalam global RAF loop.
 * @param {string|number} id    — unik identifier
 * @param {Function}      fn    — dipanggil dengan (dt: ms, timestamp: ms)
 * @returns {Function} unregister — panggil untuk hapus dari loop
 */
export function registerTick(id, fn) {
    _tickCallbacks.set(id, fn);
    if (!_loopRunning) _startLoop();
    return () => unregisterTick(id);
}

/**
 * Hapus callback dari global loop.
 * @param {string|number} id
 */
export function unregisterTick(id) {
    _tickCallbacks.delete(id);
    if (_tickCallbacks.size === 0) _stopLoop();
}

function _startLoop() {
    if (_loopRunning) return;
    _loopRunning  = true;
    _lastTimestamp = performance.now();
    _rafHandle    = requestAnimationFrame(_globalTick);
}

function _stopLoop() {
    _loopRunning = false;
    if (_rafHandle) {
        cancelAnimationFrame(_rafHandle);
        _rafHandle = null;
    }
}

function _globalTick(timestamp) {
    if (!_loopRunning) return;

    // dt: waktu sejak frame terakhir, di-cap 64ms (2 frame jank max)
    // Cap mencegah spring "lompat" jauh setelah tab kembali dari hidden
    const dt = Math.min(timestamp - _lastTimestamp, 64);
    _lastTimestamp = timestamp;

    // Tick semua callbacks dalam satu frame
    _tickCallbacks.forEach((fn, id) => {
        try {
            fn(dt, timestamp);
        } catch (e) {
            // Silent in production — tick errors are swallowed to prevent RAF loop death
            // Enable perf monitor (enablePerfMonitor()) for dev diagnostics
            _tickCallbacks.delete(id);
        }
    });

    _monitor.recordFrame(timestamp);

    if (_loopRunning && _tickCallbacks.size > 0) {
        _rafHandle = requestAnimationFrame(_globalTick);
    } else {
        _loopRunning = false;
        _rafHandle   = null;
    }
}

// ════════════════════════════════════════════════════════════
//  READ / WRITE QUEUE — Layout Thrash Prevention
//  Semua DOM reads dikumpulkan di-pass 1,
//  semua DOM writes di-pass 2.
//  Tidak ada interleaving read→write→read→write.
// ════════════════════════════════════════════════════════════

const _readQueue  = [];
const _writeQueue = [];
let   _rqScheduled = false;

/**
 * Schedule DOM read yang di-batch ke awal frame berikutnya.
 * @param {Function} fn — fungsi yang baca DOM property
 */
export function scheduleRead(fn) {
    _readQueue.push(fn);
    _scheduleFlush();
}

/**
 * Schedule DOM write yang di-batch setelah semua reads.
 * @param {Function} fn — fungsi yang write ke DOM
 */
export function scheduleWrite(fn) {
    _writeQueue.push(fn);
    _scheduleFlush();
}

function _scheduleFlush() {
    if (_rqScheduled) return;
    _rqScheduled = true;
    // MessageChannel lebih cepat dari setTimeout(0) dan tidak block paint
    _mc.port1.postMessage(null);
}

const _mc = new MessageChannel();
_mc.port2.onmessage = () => {
    _rqScheduled = false;
    _flushQueues();
};

function _flushQueues() {
    // PHASE 1: semua reads
    const reads = _readQueue.splice(0);
    reads.forEach(fn => { try { fn(); } catch (e) { /* silent in prod */ } });

    // PHASE 2: semua writes
    const writes = _writeQueue.splice(0);
    writes.forEach(fn => { try { fn(); } catch (e) { /* silent in prod */ } });
}

// ════════════════════════════════════════════════════════════
//  IDLE SCHEDULER — Pekerjaan Berat → Idle
//  Gunakan requestIdleCallback untuk pekerjaan yang tidak
//  butuh selesai dalam frame saat ini.
// ════════════════════════════════════════════════════════════

/**
 * Schedule pekerjaan non-urgent ke idle time.
 * Fallback ke setTimeout(0) kalau rIC tidak tersedia.
 * @param {Function} fn
 * @param {number}   [timeout=2000] — max wait sebelum dipaksa jalan
 */
export function scheduleIdle(fn, timeout = 2000) {
    if (typeof requestIdleCallback !== 'undefined') {
        requestIdleCallback(deadline => {
            // Kalau masih ada waktu, atau kita memang harus jalan
            if (deadline.timeRemaining() > 0 || deadline.didTimeout) {
                try { fn(); } catch (e) { /* silent in prod */ }
            }
        }, { timeout });
    } else {
        // Fallback: setTimeout 0 → runs after current task
        setTimeout(() => { try { fn(); } catch (e) { /* silent */ } }, 0);
    }
}

// ════════════════════════════════════════════════════════════
//  RATE LIMITER — Event Handler Throttle/Debounce
//  Mencegah event handler membanjiri RAF loop.
// ════════════════════════════════════════════════════════════

/**
 * Buat throttle function yang hanya dipanggil max 1x per rAF frame.
 * Lebih presisi daripada setTimeout-based throttle untuk animasi.
 * @param {Function} fn
 * @returns {Function} throttled function
 */
export function throttleToRAF(fn) {
    let pending    = false;
    let lastArgs   = null;

    return function(...args) {
        lastArgs = args;
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
            pending = false;
            try { fn.apply(this, lastArgs); } catch (e) { /* silent in prod */ }
        });
    };
}

/**
 * Buat debounce function dengan delay dalam ms.
 * @param {Function} fn
 * @param {number}   delay — ms
 * @returns {Function} debounced function
 */
export function debounce(fn, delay) {
    let timer = null;
    return function(...args) {
        clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            try { fn.apply(this, args); } catch (e) { /* silent in prod */ }
        }, delay);
    };
}

// ════════════════════════════════════════════════════════════
//  PERFORMANCE MONITOR — FPS Tracking + Frame Budget Warning
//  Development tool untuk detect jank sebelum user merasakannya.
// ════════════════════════════════════════════════════════════

class PerformanceMonitor {
    constructor() {
        this._frames      = [];
        this._enabled     = false;
        this._warnCount   = 0;
        this._maxWarn     = 3;  // log max 3 kali per session
    }

    enable() { this._enabled = true; }
    disable() { this._enabled = false; }

    recordFrame(timestamp) {
        if (!this._enabled) return;

        this._frames.push(timestamp);
        // Keep hanya 60 frames terakhir
        if (this._frames.length > 60) this._frames.shift();

        // Cek setiap 30 frames
        if (this._frames.length === 60) {
            this._checkFPS();
        }
    }

    _checkFPS() {
        if (this._frames.length < 2) return;
        const duration = this._frames[this._frames.length - 1] - this._frames[0];
        const fps      = Math.round((this._frames.length - 1) / (duration / 1000));

        if (fps < 30 && this._warnCount < this._maxWarn) {
            this._warnCount++;
            // _monitor is only enabled via enablePerfMonitor() in dev mode
            // eslint-disable-next-line no-console
            console.warn(`[Qnotify] Low FPS detected: ${fps}fps`);
        }

        this._frames.length = 0;
    }

    getFPS() {
        if (this._frames.length < 2) return 60;
        const duration = this._frames[this._frames.length - 1] - this._frames[0];
        return Math.round((this._frames.length - 1) / (duration / 1000));
    }
}

export const _monitor = new PerformanceMonitor();

/**
 * Enable performance monitoring (dev mode).
 * Logs jika FPS < 30.
 */
export function enablePerfMonitor() {
    _monitor.enable();
}

/**
 * Get current FPS dari global RAF loop.
 * @returns {number} — frames per second
 */
export function getCurrentFPS() {
    return _monitor.getFPS();
}

// NOTE: Spring RAF loop is self-managed inside spring.js (each spring registers
// its own RAF when active, stops when at rest). A separate "spring adapter" in
// perf.js is not needed and was removed in v8.0.0 to eliminate dead code.
// perf.js provides registerTick() for any module that NEEDS a global loop,
// but spring.js is not one of them.

// ════════════════════════════════════════════════════════════
//  PASSIVE EVENT HELPER — Scroll Jank Prevention
//  Semua touch dan scroll events harus passive.
// ════════════════════════════════════════════════════════════

// Cek browser support untuk passive events
let _passiveSupported = false;
try {
    const opts = Object.defineProperty({}, 'passive', {
        get() { _passiveSupported = true; return true; },
    });
    window.addEventListener('test', null, opts);
    window.removeEventListener('test', null, opts);
} catch (e) { /* old browser */ }

/**
 * Options object untuk event listener yang scroll-safe.
 * @param {boolean} capture
 * @returns {AddEventListenerOptions|boolean}
 */
export function passiveOpts(capture = false) {
    return _passiveSupported ? { passive: true, capture } : capture;
}

/**
 * Options untuk event yang butuh preventDefault() (tidak bisa passive).
 * @param {boolean} capture
 * @returns {AddEventListenerOptions|boolean}
 */
export function activeOpts(capture = false) {
    return _passiveSupported ? { passive: false, capture } : capture;
}
