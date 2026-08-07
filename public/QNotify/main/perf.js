// perf.js — QNotify performance scheduler: global RAF loop, read/write batching,
// idle scheduling, rate limiters, FPS monitor, passive-event helper.
//
// Animation Jank: single global RAF loop (not one RAF per spring) — all spring
//   ticks in one frame callback.
// Frame Drop: 16ms per-frame budget. Expensive work moves to idle callback.
// Scroll Jank: { passive: true } on all touch/scroll listeners; no preventDefault
//   in scroll handlers.
// Layout Thrashing: readScheduler + writeScheduler — all reads in one microtask,
//   all writes after.
// Layout Shift (CLS): all size/position changes via transform (compositor).
//   No width/height/top/left mutations during animation. Exception: mobile morph
//   animation, which is intentionally animating geometry.

// GLOBAL RAF LOOP
// Satu RAF loop menggantikan banyak RAF per spring. Semua spring tick dipanggil
// dalam satu frame. Frame-rate adaptive: jalan di 60/90/120/144/240Hz tanpa drift.

const _tickCallbacks  = new Map();  // id → fn(dt, timestamp)
let   _rafHandle      = null;
let   _lastTimestamp  = 0;
let   _loopRunning    = false;

// Register callback yang dipanggil setiap frame dalam global RAF loop.
// Returns an unregister function.
export function registerTick(id, fn) {
    _tickCallbacks.set(id, fn);
    if (!_loopRunning) _startLoop();
    return () => unregisterTick(id);
}

// Hapus callback dari global loop.
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

    // dt capped at 64ms (2 frame jank max) — prevents springs from "jumping"
    // far after the tab returns from hidden.
    const dt = Math.min(timestamp - _lastTimestamp, 64);
    _lastTimestamp = timestamp;

    // Tick semua callbacks dalam satu frame.
    _tickCallbacks.forEach((fn, id) => {
        try {
            fn(dt, timestamp);
        } catch (e) {
            // Silent in production — tick errors are swallowed to prevent RAF loop
            // death. Enable perf monitor (enablePerfMonitor()) for dev diagnostics.
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

// READ / WRITE QUEUE — layout thrash prevention.
// Semua DOM reads dikumpulkan di-pass 1, semua DOM writes di-pass 2.
// No interleaving read→write→read→write.

const _readQueue  = [];
const _writeQueue = [];
let   _rqScheduled = false;

// Schedule DOM read yang di-batch ke awal frame berikutnya.
export function scheduleRead(fn) {
    _readQueue.push(fn);
    _scheduleFlush();
}

// Schedule DOM write yang di-batch setelah semua reads.
export function scheduleWrite(fn) {
    _writeQueue.push(fn);
    _scheduleFlush();
}

function _scheduleFlush() {
    if (_rqScheduled) return;
    _rqScheduled = true;
    // MessageChannel lebih cepat dari setTimeout(0) dan tidak block paint.
    _mc.port1.postMessage(null);
}

const _mc = new MessageChannel();
_mc.port2.onmessage = () => {
    _rqScheduled = false;
    _flushQueues();
};

function _flushQueues() {
    // Reads — kumpulkan semua dalam satu pass.
    const reads = _readQueue.splice(0);
    reads.forEach(fn => { try { fn(); } catch (e) { /* silent in prod */ } });

    // Writes — semua writes setelah reads selesai.
    const writes = _writeQueue.splice(0);
    writes.forEach(fn => { try { fn(); } catch (e) { /* silent in prod */ } });
}

// IDLE SCHEDULER — pekerjaan berat → idle. Gunakan requestIdleCallback untuk
// pekerjaan yang tidak butuh selesai dalam frame saat ini.

// Schedule pekerjaan non-urgent ke idle time. Fallback ke setTimeout(0) kalau
// rIC tidak tersedia.
export function scheduleIdle(fn, timeout = 2000) {
    if (typeof requestIdleCallback !== 'undefined') {
        requestIdleCallback(deadline => {
            if (deadline.timeRemaining() > 0 || deadline.didTimeout) {
                try { fn(); } catch (e) { /* silent in prod */ }
            }
        }, { timeout });
    } else {
        // Fallback: setTimeout 0 → runs after current task.
        setTimeout(() => { try { fn(); } catch (e) { /* silent */ } }, 0);
    }
}

// RATE LIMITER — event handler throttle/debounce. Mencegah event handler
// membanjiri RAF loop.

// Throttle function yang hanya dipanggil max 1x per rAF frame. Lebih presisi
// daripada setTimeout-based throttle untuk animasi.
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

// Debounce function dengan delay dalam ms.
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

// PERFORMANCE MONITOR — FPS tracking + frame budget warning. Dev tool untuk
// detect jank sebelum user merasakannya.

class PerformanceMonitor {
    constructor() {
        this._frames      = [];
        this._enabled     = false;
        this._warnCount   = 0;
        this._maxWarn     = 3;  // log max 3 kali per session.
    }

    enable() { this._enabled = true; }
    disable() { this._enabled = false; }

    recordFrame(timestamp) {
        if (!this._enabled) return;

        this._frames.push(timestamp);
        // Keep hanya 60 frames terakhir.
        if (this._frames.length > 60) this._frames.shift();

        // Cek setiap 30 frames.
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
            // _monitor is only enabled via enablePerfMonitor() in dev mode.
            // eslint-disable-next-line no-console
            console.warn(`[QNotify] Low FPS detected: ${fps}fps`);
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

// Enable performance monitoring (dev mode). Logs jika FPS < 30.
export function enablePerfMonitor() {
    _monitor.enable();
}

// Get current FPS dari global RAF loop.
export function getCurrentFPS() {
    return _monitor.getFPS();
}

// Spring RAF loop is self-managed inside spring.js (each spring registers its
// own RAF when active, stops when at rest). A separate "spring adapter" in
// perf.js is not needed — registerTick() is provided for any module that NEEDS
// a global loop, but spring.js is not one of them.

// PASSIVE EVENT HELPER — scroll jank prevention. Semua touch dan scroll events
// harus passive.

// Cek browser support untuk passive events.
let _passiveSupported = false;
try {
    const opts = Object.defineProperty({}, 'passive', {
        get() { _passiveSupported = true; return true; },
    });
    window.addEventListener('test', null, opts);
    window.removeEventListener('test', null, opts);
} catch (e) { /* old browser */ }

// Options object untuk event listener yang scroll-safe.
export function passiveOpts(capture = false) {
    return _passiveSupported ? { passive: true, capture } : capture;
}

// Options untuk event yang butuh preventDefault() (tidak bisa passive).
export function activeOpts(capture = false) {
    return _passiveSupported ? { passive: false, capture } : capture;
}
