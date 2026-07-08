// config.js — QNotify config: types, text, springs, timing.

export const NOTIFICATION_TYPES = {
    success: {
        icon: 'check_circle',
        title: { id: 'Berhasil', en: 'Success' },
        msg:   { id: 'Operasi berhasil', en: 'Operation successful' },
    },
    error: {
        icon: 'error',
        title: { id: 'Gagal', en: 'Failed' },
        msg:   { id: 'Terjadi kesalahan', en: 'An error occurred' },
    },
    warning: {
        icon: 'warning',
        title: { id: 'Peringatan', en: 'Warning' },
        msg:   { id: 'Perhatian diperlukan', en: 'Attention needed' },
    },
    info: {
        icon: 'info',
        title: { id: 'Info', en: 'Info' },
        msg:   { id: 'Informasi', en: 'Information' },
    },
};

export const TYPE_ALIAS = {
    sukses:     'success',
    gagal:      'error',
    peringatan: 'warning',
    informasi:  'info',
};

export const TEXTS = {
    confirm: {
        yes:        { id: 'Ya',                     en: 'Yes' },
        no:         { id: 'Tidak',                  en: 'No' },
        cancel:     { id: 'Batal',                  en: 'Cancel' },
        hold:       { id: 'Tahan untuk konfirmasi', en: 'Hold to confirm' },
        processing: { id: 'Memproses...',           en: 'Processing...' },
        success:    { id: 'Berhasil!',              en: 'Success!' },
        failed:     { id: 'Gagal!',                 en: 'Failed!' },
    },
    dialog: {
        confirmTitle: { id: 'Konfirmasi', en: 'Confirmation' },
        note:         { id: 'Pesan',      en: 'Message' },
    },
};

export const SHADOW_TINTS = {
    success: { primary: '52,199,89',  secondary: '52,199,89'  },
    error:   { primary: '255,59,48',  secondary: '255,59,48'  },
    warning: { primary: '255,149,0',  secondary: '255,149,0'  },
    info:    { primary: '0,122,255',  secondary: '0,122,255'  },
};

export const SHADOW_BASE = {
    mobile: {
        primaryY: 6,   primaryBlur: 0,  primaryOpacity: 0.12,
        secondaryY: 14, secondaryBlur: 0, secondaryOpacity: 0.06,
    },
    desktop: {
        primaryY: 8,   primaryBlur: 0,  primaryOpacity: 0.14,
        secondaryY: 16, secondaryBlur: 0, secondaryOpacity: 0.08,
    },
};

export const SPRING_CONFIG = {
    stiffness: 220,
    damping:   18,
    mass:      1,
    precision: 0.01,
};

export const STACK_SPRING = {
    k: 300,
    c: 22,
    m: 1,
};

export const LIMITS = {
    MAX_DESKTOP:       8,
    MAX_MOBILE:        3,
    STACK_GAP_DESKTOP: 30,
    MOBILE_BREAKPOINT: 768,
};

export const MOBILE_STACK = {
    OVERLAP: 60,
    BASE_Y:  20,
};

export const DEFAULT_DURATION = 4000;

export const VERSION = '1.0.5';


// All setTimeout/duration values in one place — never use raw numbers.

export const TIMING = {
    // dialog.js morphTitle animation durations (matches CSS keyframe durations)
    TITLE_MORPH_OUT_MS:       280,  // CSS qnotify-title-out = 0.20s + 80ms buffer
    TITLE_MORPH_IN_MS:        380,  // CSS qnotify-title-in  = 0.30s + 80ms buffer
    BODY_MORPH_WAIT_MS:       210,  // morphBodyOut dissolve settle time

    // Post-result auto-dismiss delay (user reads success/fail message)
    RESULT_AUTODISMISS_MS:   2000,

    // Hold button default duration
    HOLD_DURATION_DEFAULT_MS: 3000,

    // motion.js: "wrong mode" fallback exit duration.
    // CSS .exit transition = 0.28s (280ms). We wait 400ms = 280ms + 120ms safety
    // margin for sub-60fps devices where the transition starts slightly late.
    // If you change the CSS exit transition, update this value too.
    CSS_EXIT_DURATION_MS:      400,
};

// Initial off-screen positions for stamp-before-insert pipeline.

export const SPAWN = {
    DESKTOP_TRANSLATE_X: 450,   // px right of viewport — slides in from right
    DESKTOP_SCALE:       0.85,  // slightly smaller at spawn
    MOBILE_TRANSLATE_Y: -130,   // px above viewport — drops from top
};
// SOLVER: 'hybrid' is enforced everywhere — Analytic handles UI animations
// (frame-rate independent, no drift), RK4 handles gesture physics (bump/drag)
// because the step-based feel is more tactile. Each patches the other's weak spot.
// The other modes are documented for historical reasons but not actually selectable
// at runtime — api/index.js forces SOLVER.mode = 'hybrid'.

export const SOLVER = {
    mode: 'hybrid',

    // Logs solver choice and timing diagnostics when true.
    debug: false,

    posEpsilon: 1e-4,
    velEpsilon: 1e-4,
};

export const BUMP_CONFIG = {
    springRotK:   320,  springRotC:   16, springRotM:   0.9,
    springScaleK: 380,  springScaleC: 18, springScaleM: 0.9,
    springTransK: 400,  springTransC: 20, springTransM: 0.9,

    maxRotation:        6,
    holdScaleX:         1.02,
    holdScaleY:         0.98,
    holdTranslateY:     3,

    tapThreshold:       150,
    tapIntensityMin:    0.5,
    tapScaleXFactor:    0.10,
    tapScaleYFactor:    0.18,
    tapTransYFactor:    8,
    tapRotFactor:       4,
    tapPressDuration:   80,
    tapReboundVelocity: 5,
};

// Theme morphing config for async dialog states
export const MORPH_THEME = {
    processing: {
        gradient:  'linear-gradient(135deg, #8e8e93, #636366)',
        shadow:    '0 8px 24px -4px rgba(142,142,147,0.30), 0 2px 6px rgba(0,0,0,0.10), inset 0 1px 0 rgba(255,255,255,0.18)',
        icon:      'hourglass_top',
        btnYesBg:  '#8e8e93',
        btnYesFloor: '#636366',
        btnYesGlow:  'rgba(142,142,147,0.22)',
    },
    success: {
        gradient:  'linear-gradient(145deg, #34c759, #1a8c2d)',
        shadow:    '0 8px 24px -4px rgba(52,199,89,0.40), 0 2px 6px rgba(0,0,0,0.10), inset 0 1px 0 rgba(255,255,255,0.22)',
        icon:      'check_circle',
        btnYesBg:  '#34c759',
        btnYesFloor: '#1a8c2d',
        btnYesGlow:  'rgba(52,199,89,0.22)',
    },
    error: {
        gradient:  'linear-gradient(145deg, #ff3b30, #b81e14)',
        shadow:    '0 8px 24px -4px rgba(255,59,48,0.40), 0 2px 6px rgba(0,0,0,0.10), inset 0 1px 0 rgba(255,255,255,0.18)',
        icon:      'error',
        btnYesBg:  '#ff3b30',
        btnYesFloor: '#b81e14',
        btnYesGlow:  'rgba(255,59,48,0.22)',
    },
};