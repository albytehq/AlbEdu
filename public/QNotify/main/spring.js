// spring.js — QNotify spring solvers for UI animation and gesture physics.
//
// AnalyticSpring solves the damped harmonic oscillator equation analytically:
//   m·x'' + c·x' + k·x = k·target
// Rewritten with displacement u = x - target: m·u'' + c·u' + k·u = 0.
// Three damping regimes (ζ = c / (2√(km))):
//   ζ < 1  → underdamped   (oscillates with decay envelope)
//   ζ = 1  → critically damped  (fastest settle without overshoot)
//   ζ > 1  → overdamped    (exponential decay, no oscillation)
//
// Why analytic over RK4: frame-rate independent by design (time-based, not
// step-based), zero numerical drift (exact solution at any t), identical
// animation feel at 30/60/120/240 fps, cheaper per-frame (6-10 ops vs ~30
// for RK4), and supports getValue(t) for scrubbing/prediction/interruption.
// RK4 is kept for hybrid mode where the step-based feel is preferred for
// gesture physics (bump/drag).

export class AnalyticSpring {
    constructor({ k = 180, c = 22, m = 1 } = {}) {
        this._k = k;
        this._c = c;
        this._m = m;

        // Current state
        this.x      = 0;   // current position
        this.v      = 0;   // current velocity
        this.target = 0;

        // Time tracking for analytic evaluation
        this._startTime = 0;
        this._x0        = 0;   // displacement at start (x0 - target)
        this._v0        = 0;   // velocity at start

        // Precomputed solver coefficients (invalidated on reconfigure)
        this._omega0  = 0;  // natural frequency
        this._zeta    = 0;  // damping ratio
        this._regime  = ''; // 'under' | 'critical' | 'over'
        this._precomputed = false;

        // Animation state
        this._running   = false;
        this._onUpdate  = null;
        this._onRest    = null;
        this._raf       = null;  // legacy compat only

        this._precompute();
    }

    _configure({ k = 180, c = 22, m = 1 } = {}) {
        this._k = k;
        this._c = c;
        this._m = m;
        this.x = 0; this.v = 0; this.target = 0;
        this._running   = false;
        this._onUpdate  = null;
        this._onRest    = null;
        this._raf       = null;
        this._precompute();
    }

    _reset() {
        this.stop();
        this.x = 0; this.v = 0; this.target = 0;
        this._onUpdate = null;
        this._onRest   = null;
    }

    // Precompute regime + natural frequency — called once on config change.
    // All downstream evaluations reuse these cached values.
    _precompute() {
        const k = this._k, c = this._c, m = this._m;

        // ω₀ = √(k/m)
        this._omega0 = Math.sqrt(k / m);
        // ζ = c / (2√(km))
        this._zeta   = c / (2 * Math.sqrt(k * m));

        if (Math.abs(this._zeta - 1) < 1e-6) {
            this._regime = 'critical';
        } else if (this._zeta < 1) {
            this._regime = 'under';
            // ωd = ω₀√(1-ζ²)  — damped frequency
            this._omegaD = this._omega0 * Math.sqrt(1 - this._zeta * this._zeta);
        } else {
            this._regime = 'over';
            // r1,r2 = -ζω₀ ± ω₀√(ζ²-1)
            const sq     = this._omega0 * Math.sqrt(this._zeta * this._zeta - 1);
            this._r1     = -this._zeta * this._omega0 + sq;
            this._r2     = -this._zeta * this._omega0 - sq;
        }

        this._precomputed = true;
    }

    // Core analytic evaluator — returns exact position + velocity at elapsed
    // time t (seconds). Uses initial conditions stored when to()/jump() was called.
    _evaluate(t) {
        const u0 = this._x0;   // initial displacement from target
        const v0 = this._v0;   // initial velocity

        if (t <= 0) return { pos: this.target + u0, vel: v0 };

        switch (this._regime) {
            case 'under': {
                const wd   = this._omegaD;
                const zw0  = this._zeta * this._omega0;
                const env  = Math.exp(-zw0 * t);
                // u(t) = e^{-ζω₀t}[u₀cos(ωd·t) + ((v₀+ζω₀u₀)/ωd)sin(ωd·t)]
                const A    = u0;
                const B    = (v0 + zw0 * u0) / wd;
                const cos_ = Math.cos(wd * t);
                const sin_ = Math.sin(wd * t);
                const u    = env * (A * cos_ + B * sin_);
                // u'(t) = -ζω₀·u(t) + e^{-ζω₀t}[-A·ωd·sin + B·ωd·cos]
                const du   = -zw0 * u + env * wd * (-A * sin_ + B * cos_);
                return { pos: this.target + u, vel: du };
            }

            case 'critical': {
                const w0  = this._omega0;
                const env = Math.exp(-w0 * t);
                // u(t) = (u₀ + (v₀ + ω₀u₀)t) · e^{-ω₀t}
                const C   = u0;
                const D   = v0 + w0 * u0;
                const u   = env * (C + D * t);
                const du  = env * (D - w0 * (C + D * t));
                return { pos: this.target + u, vel: du };
            }

            case 'over': {
                const r1  = this._r1, r2 = this._r2;
                // C1 = (v₀ - r₂u₀)/(r₁-r₂),  C2 = u₀ - C1
                const C1  = (v0 - r2 * u0) / (r1 - r2);
                const C2  = u0 - C1;
                const e1  = Math.exp(r1 * t);
                const e2  = Math.exp(r2 * t);
                const u   = C1 * e1 + C2 * e2;
                const du  = C1 * r1 * e1 + C2 * r2 * e2;
                return { pos: this.target + u, vel: du };
            }
        }
    }

    // Public animation API — mirrors RK4Spring exactly.

    // Set target and begin animating toward it. Captures current position +
    // velocity as initial conditions.
    to(target, { v, onUpdate, onRest } = {}) {
        this.target = target;

        // Initial conditions = current state at moment of retarget
        this._x0 = this.x - target;
        this._v0 = (v !== undefined) ? v : this.v;

        this._startTime = performance.now();

        if (onUpdate !== undefined) this._onUpdate = onUpdate;
        if (onRest   !== undefined) this._onRest   = onRest;

        if (!this._running) {
            this._running = true;
            _activeSprings.add(this);
            _scheduleLoop();
        }

        return this;
    }

    // Jump to value instantly — no animation, preserves zero velocity.
    jump(value) {
        this.stop();
        this.x      = value;
        this.v      = 0;
        this.target = value;
        this._x0    = 0;
        this._v0    = 0;
    }

    stop() {
        this._running = false;
        _activeSprings.delete(this);
        if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    }

    // Global tick — called by the shared RAF loop.
    // dt is provided for API compatibility but not used — analytic solver
    // uses absolute elapsed time for correctness.
    _tickGlobal(_dt) {
        if (!this._running) return;

        const elapsed = (performance.now() - this._startTime) / 1000;
        const { pos, vel } = this._evaluate(elapsed);

        this.x = pos;
        this.v = vel;

        if (this._onUpdate) this._onUpdate(this.x, this.v);

        // Completion check — both position and velocity below epsilon
        const posErr = Math.abs(this.x - this.target);
        const velAbs = Math.abs(this.v);
        if (posErr < 1e-4 && velAbs < 1e-4) {
            this.x = this.target;
            this.v = 0;
            if (this._onUpdate) this._onUpdate(this.x, 0);
            const cb      = this._onRest;
            this._running = false;
            _activeSprings.delete(this);
            this._onRest  = null;
            if (cb) cb();
        }
    }

    // Legacy individual tick — backward compat.
    _tick() {
        if (!this._running) return;
        this._tickGlobal(1 / 60);
        if (this._running) {
            this._raf = requestAnimationFrame(() => this._tick());
        }
    }

    get val() { return this.x; }
}


// RK4 SPRING — preserved for hybrid mode / interactive physics.

export class RK4Spring {
    constructor({ k = 180, c = 22, m = 1 } = {}) {
        this._k = k; this._c = c; this._m = m;
        this._im = 1 / m;
        this.k = k; this.c = c; this.m = m;
        this.x = 0; this.v = 0; this.target = 0;
        this._running   = false;
        this._onUpdate  = null;
        this._onRest    = null;
        this._raf       = null;
    }

    _configure({ k = 180, c = 22, m = 1 } = {}) {
        this._k = k; this._c = c; this._m = m;
        this._im = 1 / m;
        this.k = k; this.c = c; this.m = m;
        this.x = 0; this.v = 0; this.target = 0;
        this._running  = false;
        this._onUpdate = null;
        this._onRest   = null;
        this._raf      = null;
    }

    _reset() {
        this.stop();
        this.x = 0; this.v = 0; this.target = 0;
        this._onUpdate = null;
        this._onRest   = null;
    }

    to(target, { v, onUpdate, onRest } = {}) {
        this.target = target;
        if (v        !== undefined) this.v        = v;
        if (onUpdate !== undefined) this._onUpdate = onUpdate;
        if (onRest   !== undefined) this._onRest   = onRest;
        if (!this._running) {
            this._running = true;
            _activeSprings.add(this);
            _scheduleLoop();
        }
        return this;
    }

    _tickGlobal(dt) {
        if (!this._running) return;

        const k = this._k, c = this._c, im = this._im;
        const tgt = this.target;
        let x = this.x, v = this.v;

        const a1 = (-k * (x - tgt) - c * v) * im;
        const k1x = v, k1v = a1;

        const x2 = x + k1x * dt * 0.5, v2 = v + k1v * dt * 0.5;
        const a2 = (-k * (x2 - tgt) - c * v2) * im;
        const k2x = v2, k2v = a2;

        const x3 = x + k2x * dt * 0.5, v3 = v + k2v * dt * 0.5;
        const a3 = (-k * (x3 - tgt) - c * v3) * im;
        const k3x = v3, k3v = a3;

        const x4 = x + k3x * dt, v4 = v + k3v * dt;
        const a4 = (-k * (x4 - tgt) - c * v4) * im;

        this.x = x + (k1x + 2 * k2x + 2 * k3x + v4) * dt / 6;
        this.v = v + (k1v + 2 * k2v + 2 * k3v + a4)  * dt / 6;

        if (this._onUpdate) this._onUpdate(this.x, this.v);

        const done = Math.abs(this.v) < 1e-4 && Math.abs(this.x - this.target) < 1e-4;
        if (done) {
            this.x = this.target; this.v = 0;
            if (this._onUpdate) this._onUpdate(this.x, 0);
            const cb      = this._onRest;
            this._running = false;
            _activeSprings.delete(this);
            this._onRest  = null;
            if (cb) cb();
        }
    }

    _tick() {
        if (!this._running) return;
        this._tickGlobal(1 / 60);
        if (this._running) {
            this._raf = requestAnimationFrame(() => this._tick());
        }
    }

    stop() {
        this._running = false;
        _activeSprings.delete(this);
        if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    }

    jump(value) {
        this.stop();
        this.x = value; this.v = 0; this.target = value;
    }

    get val() { return this.x; }
}


// GLOBAL RAF LOOP — shared by both solver types.

export const _activeSprings = new Set();
let _rafHandle   = null;
let _lastTime    = 0;
let _loopRunning = false;

function _globalTick(now) {
    _rafHandle = null;

    if (document.visibilityState === 'hidden') {
        _loopRunning = false;
        return;
    }

    // dt clamped to 64ms (2 frames at 30fps) — tighter than old 100ms. 64ms
    // prevents springs jumping visibly after tab switch, while still allowing
    // graceful catch-up on slow devices.
    const raw = now - _lastTime;
    const dt  = Math.min(raw > 0 ? raw / 1000 : 1 / 60, 0.064);
    _lastTime  = now;

    for (const spring of _activeSprings) {
        spring._tickGlobal(dt);
    }

    if (_activeSprings.size > 0) {
        _rafHandle = requestAnimationFrame(_globalTick);
    } else {
        _loopRunning = false;
    }
}

export function _scheduleLoop() {
    if (_loopRunning) return;
    _loopRunning = true;
    _lastTime    = performance.now();
    _rafHandle   = requestAnimationFrame(_globalTick);
}

// Handle both visibilitychange (desktop) and pagehide/pageshow (mobile).
// Mobile browsers freeze rAF on pagehide — springs must resync on resume or
// they'll teleport to final position instead of animating from current pos.
function _onPageVisible() {
    if (_activeSprings.size === 0) return;

    const now = performance.now();
    for (const spring of _activeSprings) {
        if (spring instanceof AnalyticSpring && spring._running) {
            // Snapshot current analytic state as new initial conditions.
            // This prevents springs "jumping" after the freeze period.
            const elapsed = (now - spring._startTime) / 1000;
            const { pos, vel } = spring._evaluate(elapsed);
            spring.x          = pos;
            spring.v          = vel;
            spring._x0        = pos - spring.target;
            spring._v0        = vel;
            spring._startTime = now;
        }
    }
    _lastTime = now;
    _scheduleLoop();
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') _onPageVisible();
});

// Mobile: pageshow fires when page is restored from bfcache.
window.addEventListener('pageshow', (e) => {
    if (e.persisted) _onPageVisible();
}, { passive: true });


// SPRING OBJECT POOL

const _analyticPool = [];
const _rk4Pool      = [];

// Pool size cap — prevents unbounded memory growth.
// 40 analytic (UI springs) + 20 RK4 (bump/gesture) is generous for any UI.
const POOL_MAX_ANALYTIC = 40;
const POOL_MAX_RK4      = 20;

// Acquire a spring from the pool — or create a new one.
export function acquireSpring(config, solver = 'analytic') {
    const pool = solver === 'rk4' ? _rk4Pool : _analyticPool;
    const Cls  = solver === 'rk4' ? RK4Spring : AnalyticSpring;
    const s    = pool.length > 0 ? pool.pop() : new Cls();
    s._configure(config);
    return s;
}

export function releaseSpring(spring) {
    spring._reset();
    if (spring instanceof AnalyticSpring) {
        if (_analyticPool.length < POOL_MAX_ANALYTIC) _analyticPool.push(spring);
        // else: let GC collect it — pool is at capacity.
    } else {
        if (_rk4Pool.length < POOL_MAX_RK4) _rk4Pool.push(spring);
    }
}
