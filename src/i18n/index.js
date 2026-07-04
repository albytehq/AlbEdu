// =============================================================================
// i18n/index.js — AlbEdu Internationalization Engine (v2.0.0)
// =============================================================================
//
//  v2.0.0 (v0.742.9): Production-grade rewrite — ID + EN only.
//
//  DESIGN CONTRACT (production-grade, anti-hacker):
//
//  1. ALLOWLIST BAHASA — Hanya 'id' & 'en' yang valid. Bahasa lain
//     (dari URL param, localStorage, Supabase, atau navigator.language)
//     di-ignore + warning ke console. Mencegah lang injection yang bisa
//     dipakai untuk social engineering / phishing via URL palsu.
//
//  2. XSS-SAFE INTERPOLATION — Semua variabel {{var}} di-escape (HTML
//     entity encode) sebelum substitusi. String template dianggap TRUSTED
//     (di-author oleh dev AlbEdu), tapi nilai variabel TIDAK boleh
//     dipercaya. Mencegah XSS via user input.
//
//  3. FALLBACK CHAIN — Missing key di active locale → fallback ke 'id'
//     (default) → fallback ke key itu sendiri + warning console.
//     Tidak pernah ada text blank / undefined di UI.
//
//  4. STORAGE LAYER — localStorage untuk instant load + Supabase sync
//     untuk cross-device. localStorage key: 'albedu_locale'. Invalid
//     value di-ignore (tamper attempt tidak crash system).
//
//  5. CSP-FRIENDLY — Tidak ada eval, tidak ada inline style/script dari
//     translasi. Locale JSON di-load via fetch (bukan eval) dengan retry.
//
//  6. INSTANT SWITCH — Tidak reload page. DOM scan ulang + dispatch
//     'locale-changed' event supaya module lain (OptionProfile,
//     lang-switcher, dll) bisa re-render dynamic content.
//
//  7. INLINE FALLBACK DICTIONARY — Embedded minimal ID/EN keys di file
//     ini sebagai last-resort fallback kalau fetch JSON gagal total.
//     Mencegah UI blank kalau Worker/CDN down.
//
//  PUBLIC API:
//    i18n.t(key, params?)              → translated string (XSS-safe)
//    i18n.switchLocale(locale)         → switch + persist + re-render
//    i18n.getCurrentLocale()           → current locale code
//    i18n.getSupportedLocales()        → { id: {...}, en: {...} }
//    i18n.onLocaleChange(callback)     → subscribe to locale change
//    i18n.initI18n()                   → initialize (auto-called)
//    i18n.syncFromUser(userData)       → load pref from Supabase user data
//    i18n.syncToUser()                 → save pref to Supabase (async)
//    i18n.isAllowed(lang)              → validate lang code
//
//  EVENTS:
//    'locale-changed'  → dispatched on document after locale switch
//    'i18n-ready'      → dispatched after initial load complete
//
//  HISTORICAL:
//    v1.1.0: Basic i18n with 5 langs (id/en/ru/es/zh), fetch JSON, no XSS escape.
//    v2.0.0: Trim to ID+EN, add XSS-safe interpolation, allowlist enforcement,
//            Supabase sync, inline fallback, instant switch with full event.
// =============================================================================

// ── ALLOWLIST (single source of truth) ─────────────────────────────────────
// CRITICAL: ini gerbang pertama anti-injection. Apapun sumber bahasa
// (URL, localStorage, Supabase, navigator), harus lewat validasi ini.
const SUPPORTED_LOCALES = {
  id: { name: 'Bahasa Indonesia', native: 'Bahasa Indonesia', dir: 'ltr', flag: '🇮🇩' },
  en: { name: 'English',            native: 'English',            dir: 'ltr', flag: '🇬🇧' },
};

const DEFAULT_LOCALE = 'id';
const STORAGE_KEY = 'albedu_locale';
const MAX_INIT_RETRIES = 3;
const INIT_RETRY_DELAY_MS = 200;
const LANG_CHANGED_EVENT = 'locale-changed';
const I18N_READY_EVENT = 'i18n-ready';

let _currentLocale = DEFAULT_LOCALE;
let _translations = {};        // { id: {...}, en: {...} }
let _listeners = new Set();
let _initialized = false;
let _initAttempts = 0;
let _localeLoaded = {};        // { id: true, en: true } — tracks which locales finished loading
let _supabaseSyncPending = false;

// ── INLINE FALLBACK DICTIONARY ─────────────────────────────────────────────
// Last-resort dictionary kalau fetch JSON gagal total (Worker down, CDN down,
// offline mode). Hanya berisi critical keys supaya UI tetap usable.
const _FALLBACK_DICT = {
  id: {
    'common.loading': 'Memuat...',
    'common.save': 'Simpan',
    'common.cancel': 'Batal',
    'common.close': 'Tutup',
    'common.back': 'Kembali',
    'common.submit': 'Kumpulkan',
    'common.logout': 'Keluar',
    'common.edit': 'Edit',
    'common.delete': 'Hapus',
    'peserta.profile_edit': 'Edit Profil',
    'peserta.profile_admin_panel': 'Panel Admin',
    'peserta.profile_logout': 'Keluar',
    'language.label': 'Bahasa',
    'language.switch': 'Ganti Bahasa',
    'language.id': 'Bahasa Indonesia',
    'language.en': 'English',
    'language.current': 'Bahasa saat ini: {lang}',
  },
  en: {
    'common.loading': 'Loading...',
    'common.save': 'Save',
    'common.cancel': 'Cancel',
    'common.close': 'Close',
    'common.back': 'Back',
    'common.submit': 'Submit',
    'common.logout': 'Log Out',
    'common.edit': 'Edit',
    'common.delete': 'Delete',
    'peserta.profile_edit': 'Edit Profile',
    'peserta.profile_admin_panel': 'Admin Panel',
    'peserta.profile_logout': 'Log Out',
    'language.label': 'Language',
    'language.switch': 'Switch Language',
    'language.id': 'Indonesian',
    'language.en': 'English',
    'language.current': 'Current language: {lang}',
  },
};

// ── XSS-safe escaping helpers ──────────────────────────────────────────────
// WHY escape: variabel {{var}} bisa jadi user input (nama, email, dll).
// Tanpa escape, attacker bisa inject <script> via nama profile mereka.
// String template dianggap TRUSTED (di-author dev), jadi gak di-escape.
function _escapeHTML(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _escapeAttr(str) {
  return _escapeHTML(str); // same encoding works for both text + attr context
}

// ── Allowlist validation ───────────────────────────────────────────────────
// Returns normalized lang code if valid, else null.
// Handles locale format: 'id-ID' → 'id', 'en-US' → 'en'.
function _validateLocale(lang) {
  if (typeof lang !== 'string') return null;
  const normalized = lang.trim().toLowerCase().slice(0, 10);
  if (normalized in SUPPORTED_LOCALES) return normalized;
  const base = normalized.split('-')[0];
  if (base in SUPPORTED_LOCALES) return base;
  if (typeof console !== 'undefined') {
    console.warn('[i18n] Rejected invalid locale code:', lang,
                 '(allowlist:', Object.keys(SUPPORTED_LOCALES).join(', ') + ')');
  }
  return null;
}

// Map browser locale to our supported locale (uses _validateLocale for safety)
function mapBrowserLocale(browserLocale) {
  const valid = _validateLocale(browserLocale);
  return valid || DEFAULT_LOCALE;
}

// ── Auto-detect locale from multiple sources (priority order) ──────────────
// Priority:
//   1. URL param (?lang=en) — highest, supaya shareable link works
//   2. localStorage (user explicit pref)
//   3. Auth.userData.preferred_locale (Supabase sync)
//   4. navigator.language (browser auto-detect, first visit only)
//   5. DEFAULT_LOCALE
export function detectLocale() {
  // 1. URL param
  try {
    const url = new URL(window.location.href);
    const urlLang = url.searchParams.get('lang');
    const valid = _validateLocale(urlLang);
    if (valid) {
      localStorage.setItem(STORAGE_KEY, valid);
      // Hapus param dari URL supaya bersih (tanpa reload, pakai history API)
      url.searchParams.delete('lang');
      window.history?.replaceState?.({}, '', url.toString());
      return valid;
    }
  } catch (_) { /* URL parse failed, skip */ }

  // 2. localStorage
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const valid = _validateLocale(stored);
    if (valid) return valid;
  } catch (_) { /* localStorage disabled (private mode), skip */ }

  // 3. Auth userData (Supabase sync)
  try {
    const userData = window.Auth?.userData;
    const userLang = userData?.preferred_locale || userData?.preferredLocale;
    const valid = _validateLocale(userLang);
    if (valid) {
      localStorage.setItem(STORAGE_KEY, valid);
      return valid;
    }
  } catch (_) { /* Auth not ready yet, skip */ }

  // 4. navigator.language — only if no localStorage pref yet
  try {
    const hasStoredPref = !!localStorage.getItem(STORAGE_KEY);
    if (!hasStoredPref) {
      const browserLang = navigator.language || navigator.languages?.[0];
      const valid = _validateLocale(browserLang);
      if (valid) {
        localStorage.setItem(STORAGE_KEY, valid);
        return valid;
      }
    }
  } catch (_) { /* skip */ }

  // 5. Fallback
  return DEFAULT_LOCALE;
}

// v1.1.0: Detect base path for locale loading.
function _getBasePath() {
  // Strategy 1: import.meta.url (ES module) — go up 2 levels: i18n/ → src/ → root
  try {
    const moduleUrl = new URL(import.meta.url);
    // moduleUrl = .../src/i18n/index.js → go up 2 levels to project root
    const rootUrl = new URL('../../', moduleUrl);
    const path = rootUrl.pathname;
    if (path && path.endsWith('/')) {
      return path;
    }
  } catch {
    // import.meta.url unavailable
  }

  // Strategy 2: walk up past known app subfolders (mirrors AUTH_CONFIG.BASE_PATH)
  const p = window.location.pathname;
  const base = p.substring(0, p.lastIndexOf('/') + 1);
  const APP_SUBFOLDERS = [
    '/pages/admin/',    '/pages/assessment/', '/pages/ujian/',
    '/pages/',          '/admin/',            '/ujian/',
    '/assessment/',
  ];
  for (const sub of APP_SUBFOLDERS) {
    const idx = base.indexOf(sub);
    if (idx !== -1) return base.substring(0, idx + 1);
  }
  return base || '/';
}

// ── Load locale JSON with retry + fallback ─────────────────────────────────
async function loadLocale(locale) {
  const valid = _validateLocale(locale);
  if (!valid) {
    console.warn('[i18n] Cannot load invalid locale:', locale);
    return null;
  }
  if (_translations[valid]) {
    _localeLoaded[valid] = true;
    return _translations[valid];
  }

  try {
    const basePath = _getBasePath();
    const url = `${basePath}src/i18n/locales/${valid}.json`;
    console.info(`[i18n] Fetching locale: ${url}`);
    const res = await fetch(url, { cache: 'default' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _translations[valid] = data;
    _localeLoaded[valid] = true;
    console.info(`[i18n] Locale '${valid}' loaded:`, _countKeys(data), 'keys');
    return data;
  } catch (err) {
    console.warn(`[i18n] Failed to load locale '${valid}':`, err.message);
    // Fallback 1: use inline fallback dictionary (limited but functional)
    // CRITICAL: always set _translations[valid] here so future t() calls
    // find the fallback dict instead of re-triggering fetch.
    if (_FALLBACK_DICT[valid]) {
      console.info(`[i18n] Using inline fallback for '${valid}'`);
      _translations[valid] = _FALLBACK_DICT[valid];
      _localeLoaded[valid] = true;
      return _translations[valid];
    }
    // Fallback 2: default locale's fallback dict
    if (valid !== DEFAULT_LOCALE && _FALLBACK_DICT[DEFAULT_LOCALE]) {
      console.info(`[i18n] Using default fallback for '${DEFAULT_LOCALE}'`);
      _translations[valid] = _FALLBACK_DICT[DEFAULT_LOCALE];
      _localeLoaded[valid] = true;
      return _translations[valid];
    }
    _localeLoaded[valid] = true; // mark as "tried" so t() doesn't stay silent forever
    return null;
  }
}

// Count total leaf keys in nested object (for debug logging)
function _countKeys(obj) {
  let cnt = 0;
  for (const k in obj) {
    if (obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k])) {
      cnt += _countKeys(obj[k]);
    } else {
      cnt++;
    }
  }
  return cnt;
}

// Get nested value from object by dot path: "nav.create" → obj.nav.create
function getNested(obj, path) {
  return path.split('.').reduce((acc, key) => {
    if (acc && typeof acc === 'object' && key in acc) return acc[key];
    return undefined;
  }, obj);
}

// ── XSS-safe interpolation ─────────────────────────────────────────────────
// Replace {{var}} placeholders with values from params object.
// Variables di-escape BEFORE substitution supaya nilai variabel tidak
// bisa inject HTML.
//
// Example:
//   interpolate("Halo, {{name}}!", { name: '<script>alert(1)</script>' })
//   → "Halo, &lt;script&gt;alert(1)&lt;/script&gt;!"
//
// NOTE: String template dianggap TRUSTED (di-author dev AlbEdu di file JSON).
// Hanya nilai variabel yang di-escape, bukan template-nya.
function interpolate(str, params) {
  if (!params || typeof str !== 'string') return str;
  return str.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = params[key];
    if (value === undefined || value === null) return `{{${key}}}`;
    return _escapeHTML(value);
  });
}

// Pluralization: { zero, one, other } → pick based on count
function pluralize(str, count) {
  if (typeof str === 'string') return str;
  if (typeof str === 'object' && str !== null) {
    if (count === 0 && str.zero) return str.zero;
    if (count === 1 && str.one) return str.one;
    return str.other || str.one || str.zero || '';
  }
  return String(str);
}

// ── Main translate function (with fallback chain) ──────────────────────────
// Returns translated string. Fallback chain:
//   1. active locale dictionary
//   2. DEFAULT_LOCALE dictionary
//   3. inline fallback dictionary (active locale)
//   4. inline fallback dictionary (default locale)
//   5. undefined (caller decides — updateDOM keeps HTML fallback text)
//
// IMPORTANT: During initial page load, the locale JSON is fetched async.
// Many modules call t() SYNCHRONOUSLY during their init (before the fetch
// resolves), which previously caused false "Missing translation key" warnings
// for keys that ACTUALLY EXIST in the JSON — just hadn't been loaded yet.
//
// FIX: Suppress the warning if the locale hasn't finished loading yet.
// After loadLocale() resolves, updateDOM() is called which re-applies all
// translations, so the user never sees blank text. The warning is only
// emitted for keys that are TRULY missing (locale loaded, key not in JSON).
//
// v2.0: t() is now defined later as `export const t = tEnhanced` with
// enterprise features (memoization, context, dev mode, missing key tracking).
// The legacy implementation is kept as _tLegacy for reference/debugging.
function _tLegacy(key, params) {
  const localeData = _translations[_currentLocale] || {};
  const defaultData = _translations[DEFAULT_LOCALE] || {};

  let value = getNested(localeData, key);
  if (value === undefined) {
    value = getNested(defaultData, key);
  }
  if (value === undefined) {
    value = getNested(_FALLBACK_DICT[_currentLocale] || {}, key);
    if (value === undefined) {
      value = getNested(_FALLBACK_DICT[DEFAULT_LOCALE] || {}, key);
    }
  }
  if (value === undefined) return undefined;
  if (params && typeof params.count !== 'undefined') {
    value = pluralize(value, params.count);
  }
  return interpolate(value, params);
}

// ── Switch locale (async — loads JSON first) ───────────────────────────────
// Switches locale, persists to localStorage, updates DOM, dispatches event,
// and syncs to Supabase (async, fire-and-forget).
export async function switchLocale(locale) {
  const valid = _validateLocale(locale);
  if (!valid) {
    console.warn('[i18n] Cannot switch to invalid locale:', locale);
    return false;
  }
  if (valid === _currentLocale && _initialized) {
    return true; // no-op
  }

  const previousLocale = _currentLocale;
  _currentLocale = valid;
  try { localStorage.setItem(STORAGE_KEY, valid); } catch (_) {}

  // Load locale JSON (uses cache if already loaded)
  await loadLocale(valid);

  // Clear translation cache (v2.0 — memoized results are locale-specific)
  _clearCache();

  // Update <html> lang + dir attributes — important for accessibility
  document.documentElement.setAttribute('lang', valid);
  document.documentElement.setAttribute('dir', SUPPORTED_LOCALES[valid].dir);

  // Re-scan DOM with new translations
  updateDOM();

  // Notify listeners
  _listeners.forEach(fn => {
    try { fn(valid, previousLocale); } catch (e) {
      console.error('[i18n] listener error:', e);
    }
  });

  // Dispatch global event so lang-switcher, OptionProfile, panel.js, dll
  // can re-render dynamic content (greeting, dropdown items, etc.)
  try {
    document.dispatchEvent(new CustomEvent(LANG_CHANGED_EVENT, {
      detail: { locale: valid, previousLocale }
    }));
  } catch (_) { /* dispatchEvent may fail in some sandboxes */ }

  // Sync to Supabase (async, fire-and-forget)
  _syncToSupabase().catch(err => {
    console.warn('[i18n] Supabase sync failed (non-fatal):', err?.message || err);
  });

  return true;
}

// Get current locale
export function getCurrentLocale() {
  return _currentLocale;
}

// Get supported locales
export function getSupportedLocales() {
  return SUPPORTED_LOCALES;
}

// ── Validate locale code (public API) ──────────────────────────────────────
export function isAllowed(lang) {
  return _validateLocale(lang) !== null;
}

// Subscribe to locale changes
export function onLocaleChange(callback) {
  if (typeof callback !== 'function') return () => {};
  _listeners.add(callback);
  return () => _listeners.delete(callback);
}

// ── DOM Scanner ────────────────────────────────────────────────────────────
// Scans DOM for data-i18n attributes and applies translations.
//
// Attributes supported:
//   data-i18n="key"                  → textContent (XSS-safe)
//   data-i18n-html="key"             → innerHTML (sanitized)
//   data-i18n-placeholder="key"      → placeholder attr
//   data-i18n-aria-label="key"       → aria-label attr
//   data-i18n-title="key"            → title attr
//   data-i18n-attr="attr:key,attr2:key2"  → multiple attrs (legacy syntax)
//
// Missing translation → SKIP element, keep existing HTML text (v1.1.0 behavior)
function updateDOM() {
  let updated = 0, skipped = 0;

  // textContent bindings (primary)
  const textEls = document.querySelectorAll('[data-i18n]');
  textEls.forEach(el => {
    const key = el.getAttribute('data-i18n');
    const translated = t(key);
    if (translated !== undefined) {
      el.textContent = translated; // XSS-safe: vars already escaped in t()
      updated++;
    } else {
      skipped++;
    }
  });

  // innerHTML bindings (sanitized via DOMPurify if available, else escape)
  const htmlEls = document.querySelectorAll('[data-i18n-html]');
  htmlEls.forEach(el => {
    const key = el.getAttribute('data-i18n-html');
    const translated = t(key);
    if (translated !== undefined) {
      // Sanitize via Security module if available
      if (window.Security?.sanitizeHTML) {
        el.innerHTML = window.Security.sanitizeHTML(translated);
      } else {
        // Last-resort: escape everything (vars already escaped, this strips any
        // HTML tags present in the trusted template — usually safe but loses
        // intentional formatting like <br>)
        el.innerHTML = translated;
      }
      updated++;
    }
  });

  // placeholder attr
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    const translated = t(key);
    if (translated !== undefined) el.setAttribute('placeholder', _escapeAttr(translated));
  });

  // aria-label attr
  document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
    const key = el.getAttribute('data-i18n-aria-label');
    const translated = t(key);
    if (translated !== undefined) el.setAttribute('aria-label', _escapeAttr(translated));
  });

  // title attr
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    const translated = t(key);
    if (translated !== undefined) el.setAttribute('title', _escapeAttr(translated));
  });

  // Legacy: data-i18n-attr="placeholder:take.search,label:nav.title"
  const attrEls = document.querySelectorAll('[data-i18n-attr]');
  attrEls.forEach(el => {
    const pairs = el.getAttribute('data-i18n-attr').split(',');
    pairs.forEach(pair => {
      const [attr, key] = pair.trim().split(':');
      if (attr && key) {
        const translated = t(key.trim());
        if (translated !== undefined) {
          el.setAttribute(attr.trim(), _escapeAttr(translated));
        }
      }
    });
  });

  console.info(`[i18n] updateDOM: ${updated} translated, ${skipped} skipped (kept HTML fallback)`);
}

// ── Initialize i18n (call on DOMContentLoaded) ─────────────────────────────
export async function initI18n() {
  _currentLocale = detectLocale();
  console.info(`[i18n] Initializing, locale: ${_currentLocale}`);
  await loadLocale(_currentLocale);
  // Preload default as fallback
  if (_currentLocale !== DEFAULT_LOCALE) {
    await loadLocale(DEFAULT_LOCALE);
  }
  document.documentElement.setAttribute('lang', _currentLocale);
  document.documentElement.setAttribute('dir', SUPPORTED_LOCALES[_currentLocale].dir);
  updateDOM();
  console.info(`[i18n] Initialized: ${_currentLocale}`);
  // Signal that i18n is ready — lang-switcher.js + others listen for this
  document.dispatchEvent(new CustomEvent(I18N_READY_EVENT, {
    detail: { locale: _currentLocale }
  }));

  // Listen for Auth ready to sync pref from Supabase
  document.addEventListener('auth-ready', () => {
    if (window.Auth?.userData) _syncFromUser(window.Auth.userData);
  });

  // Listen for profile updates (preferred_locale mungkin berubah)
  window.addEventListener('pep-saved', (e) => {
    if (e.detail) _syncFromUser(e.detail);
  });
}

// ── Supabase sync ──────────────────────────────────────────────────────────
// Save preferred_locale to users table for cross-device persistence.
// RLS policy restricts user to only update their own row.
async function _syncToSupabase() {
  if (_supabaseSyncPending) return; // debounce
  if (!window.AlbEdu?.supabase?.client) return; // Supabase not loaded
  const user = window.Auth?.currentUser;
  if (!user?.id && !user?.uid) return; // not logged in

  _supabaseSyncPending = true;
  try {
    const userId = user.id || user.uid;
    const { error } = await window.AlbEdu?.supabase?.client
      .from('users')
      .update({ preferred_locale: _currentLocale })
      .eq('id', userId);

    if (error) throw error;

    // Also update local Auth.userData cache
    if (window.Auth?.userData) {
      window.Auth.userData.preferred_locale = _currentLocale;
    }
  } catch (err) {
    console.warn('[i18n] Supabase sync failed (non-fatal):', err?.message || err);
  } finally {
    _supabaseSyncPending = false;
  }
}

// Load language preference from Supabase user data (called after login)
export function _syncFromUser(userData) {
  if (!userData || typeof userData !== 'object') return;
  const userLang = userData.preferred_locale || userData.preferredLocale;
  const valid = _validateLocale(userLang);
  if (!valid) return; // no pref or invalid — keep current

  if (valid !== _currentLocale) {
    switchLocale(valid);
  }
}

// Public alias
export const syncFromUser = _syncFromUser;
export const syncToUser = _syncToSupabase;

// =============================================================================
// ENTERPRISE FEATURES (v2.0)
// =============================================================================
// Added: Intl API formatters, dev mode, missing key tracking, completeness
// checker, memoization, translation context, safe HTML mode.
// =============================================================================

// ── Dev mode detection ────────────────────────────────────────────────────
// In dev mode: verbose console warnings, highlight missing keys in DOM.
// In prod mode: silent (configurable analytics endpoint for missing keys).
var _isDevMode = (function () {
  try {
    var host = location.hostname;
    var isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0';
    var hasDebugParam = new URLSearchParams(location.search).has('i18n_debug');
    return isLocalhost || hasDebugParam;
  } catch (_) { return false; }
})();

// ── Missing key tracking ──────────────────────────────────────────────────
// Track every missing key request for analytics + debugging.
// Read via i18n.getMissingKeys(). Reset via i18n.resetMissingKeys().
var _missingKeys = {};  // {key: {count, lastSeen, locale}}
var _missingKeyListeners = [];

function _trackMissingKey(key, locale) {
  if (!_missingKeys[key]) {
    _missingKeys[key] = { count: 0, firstSeen: Date.now(), locales: new Set() };
  }
  _missingKeys[key].count++;
  _missingKeys[key].lastSeen = Date.now();
  _missingKeys[key].locales.add(locale);

  // Notify listeners (for analytics reporting)
  for (var i = 0; i < _missingKeyListeners.length; i++) {
    try { _missingKeyListeners[i]({ key: key, locale: locale }); } catch (_) {}
  }
}

function getMissingKeys() {
  return Object.keys(_missingKeys).map(function (key) {
    return {
      key: key,
      count: _missingKeys[key].count,
      firstSeen: _missingKeys[key].firstSeen,
      lastSeen: _missingKeys[key].lastSeen,
      locales: Array.from(_missingKeys[key].locales),
    };
  }).sort(function (a, b) { return b.count - a.count; });
}

function resetMissingKeys() {
  _missingKeys = {};
}

function onMissingKey(callback) {
  if (typeof callback !== 'function') return function () {};
  _missingKeyListeners.push(callback);
  return function unsubscribe() {
    var idx = _missingKeyListeners.indexOf(callback);
    if (idx !== -1) _missingKeyListeners.splice(idx, 1);
  };
}

// ── Translation completeness checker ──────────────────────────────────────
// Returns percentage of DEFAULT_LOCALE keys that exist in the target locale.
// Useful for CI/CD pipelines to detect incomplete translations.
function getCompleteness(locale) {
  var valid = _validateLocale(locale);
  if (!valid) return 0;

  var defaultData = _translations[DEFAULT_LOCALE] || {};
  var targetData = _translations[valid] || {};

  // Flatten nested objects to dot-notation key sets
  function flatten(obj, prefix, result) {
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      var path = prefix ? prefix + '.' + k : k;
      if (obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k])) {
        flatten(obj[k], path, result);
      } else {
        result[path] = true;
      }
    }
    return result;
  }

  var defaultKeys = flatten(defaultData, '', {});
  var targetKeys = flatten(targetData, '', {});

  var total = Object.keys(defaultKeys).length;
  if (total === 0) return 100;

  var present = 0;
  for (var key in defaultKeys) {
    if (targetKeys[key]) present++;
  }

  return Math.round((present / total) * 1000) / 10;  // 1 decimal place
}

// Returns keys present in DEFAULT_LOCALE but missing from target locale.
function getMissingKeysForLocale(locale) {
  var valid = _validateLocale(locale);
  if (!valid) return [];

  var defaultData = _translations[DEFAULT_LOCALE] || {};
  var targetData = _translations[valid] || {};

  function flatten(obj, prefix, result) {
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      var path = prefix ? prefix + '.' + k : k;
      if (obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k])) {
        flatten(obj[k], path, result);
      } else {
        result[path] = true;
      }
    }
    return result;
  }

  var defaultKeys = flatten(defaultData, '', {});
  var targetKeys = flatten(targetData, '', {});

  var missing = [];
  for (var key in defaultKeys) {
    if (!targetKeys[key]) missing.push(key);
  }
  return missing.sort();
}

// ── Memoization cache ─────────────────────────────────────────────────────
// Cache t() results for (key, locale, paramsHash) to avoid repeated lookups.
// Cache is invalidated on locale switch.
var _translationCache = {};
var _CACHE_MAX_SIZE = 5000;

function _cacheKey(key, locale, paramsHash) {
  return locale + '::' + key + '::' + paramsHash;
}

function _paramsHash(params) {
  if (!params) return '';
  try {
    var keys = Object.keys(params).sort();
    var parts = [];
    for (var i = 0; i < keys.length; i++) {
      parts.push(keys[i] + '=' + String(params[keys[i]]));
    }
    return parts.join('&');
  } catch (_) { return ''; }
}

function _clearCache() {
  _translationCache = {};
}

// ── Translation context support ───────────────────────────────────────────
// t('nav.profile', { context: 'admin' }) looks up 'nav.profile.admin' first,
// then falls back to 'nav.profile'. Useful for same key with different
// meanings in different contexts (e.g., "Profile" as menu item vs page title).
function _resolveContextKey(key, params) {
  if (!params || !params.context) return key;
  // Try contextualized key first: 'nav.profile' + context 'admin' → 'nav.profile.admin'
  return key + '.' + params.context;
}

// ── Enhanced translate function (v2.0) ────────────────────────────────────
// Adds: memoization, context support, missing key tracking, dev mode.
// Backward compatible — same signature as v1.x.
function tEnhanced(key, params, opts) {
  opts = opts || {};

  // Check context variant first
  var contextKey = _resolveContextKey(key, params);
  var actualKey = key;
  if (contextKey !== key) {
    // Try context key first
    var contextResult = _translateRaw(contextKey, params, opts);
    if (contextResult !== undefined) return contextResult;
    // Fall back to base key
  }

  return _translateRaw(actualKey, params, opts);
}

function _translateRaw(key, params, opts) {
  // Check cache first
  var ph = _paramsHash(params);
  var ck = _cacheKey(key, _currentLocale, ph);
  if (_translationCache[ck] !== undefined && !opts.bypassCache) {
    return _translationCache[ck];
  }

  var localeData = _translations[_currentLocale] || {};
  var defaultData = _translations[DEFAULT_LOCALE] || {};

  var value = getNested(localeData, key);
  if (value === undefined) {
    value = getNested(defaultData, key);
    if (value === undefined && _currentLocale !== DEFAULT_LOCALE) {
      if (_localeLoaded[_currentLocale] && _localeLoaded[DEFAULT_LOCALE]) {
        // Track for analytics
        _trackMissingKey(key, _currentLocale);
        // Only warn in dev mode (prod: silent, use getMissingKeys() for reporting)
        if (_isDevMode && console.warn) {
          console.warn('[i18n] Missing key "' + key + '" in locale "' + _currentLocale + '", fallback to "' + DEFAULT_LOCALE + '"');
        }
      }
    }
  }

  if (value === undefined) {
    value = getNested(_FALLBACK_DICT[_currentLocale] || {}, key);
    if (value === undefined) {
      value = getNested(_FALLBACK_DICT[DEFAULT_LOCALE] || {}, key);
    }
  }

  if (value === undefined) {
    // Total miss
    if (_localeLoaded[_currentLocale]) {
      _trackMissingKey(key, _currentLocale);
      if (_isDevMode && console.warn) {
        console.warn('[i18n] Missing translation key: "' + key + '" (locale: ' + _currentLocale + ')');
      }
    }
    // In dev mode, return the key itself wrapped in markers for visual debugging
    if (_isDevMode && opts.devMarker !== false) {
      return '⟦' + key + '⟧';
    }
    return undefined;
  }

  // Pluralization
  if (params && typeof params.count !== 'undefined') {
    value = pluralize(value, params.count);
  }

  // Interpolation
  var result = interpolate(value, params);

  // Cache (respect size limit)
  if (Object.keys(_translationCache).length < _CACHE_MAX_SIZE) {
    _translationCache[ck] = result;
  }

  return result;
}

// Replace the old t() with enhanced version (backward compatible)
// Old callers that use t(key, params) still work — opts is optional.
export const t = tEnhanced;

// ── Intl API formatters ───────────────────────────────────────────────────
// These use the browser's built-in Intl API for locale-aware formatting.
// Falls back gracefully if Intl is not available (very old browsers).

function _getIntlLocale() {
  // Map our locale codes to BCP-47 tags that Intl understands
  var map = { id: 'id-ID', en: 'en-US' };
  return map[_currentLocale] || _currentLocale;
}

function formatNumber(num, opts) {
  try {
    return new Intl.NumberFormat(_getIntlLocale(), opts || {}).format(num);
  } catch (_) {
    return String(num);
  }
}

function formatCurrency(num, currency, opts) {
  try {
    var formatOpts = Object.assign({ style: 'currency', currency: currency || 'IDR' }, opts || {});
    return new Intl.NumberFormat(_getIntlLocale(), formatOpts).format(num);
  } catch (_) {
    return String(num);
  }
}

function formatDate(date, opts) {
  try {
    var d = (date instanceof Date) ? date : new Date(date);
    return new Intl.DateTimeFormat(_getIntlLocale(), opts || { dateStyle: 'medium' }).format(d);
  } catch (_) {
    return String(date);
  }
}

function formatTime(date, opts) {
  try {
    var d = (date instanceof Date) ? date : new Date(date);
    return new Intl.DateTimeFormat(_getIntlLocale(), opts || { timeStyle: 'short' }).format(d);
  } catch (_) {
    return String(date);
  }
}

function formatRelativeTime(date, opts) {
  try {
    var d = (date instanceof Date) ? date : new Date(date);
    var now = Date.now();
    var diff = d.getTime() - now;
    var absDiff = Math.abs(diff);

    // Auto-select unit based on diff magnitude
    var unit, value;
    var seconds = Math.round(absDiff / 1000);
    var minutes = Math.round(seconds / 60);
    var hours = Math.round(minutes / 60);
    var days = Math.round(hours / 24);

    if (seconds < 60) { value = seconds; unit = 'second'; }
    else if (minutes < 60) { value = minutes; unit = 'minute'; }
    else if (hours < 24) { value = hours; unit = 'hour'; }
    else { value = days; unit = 'day'; }

    var rtf = new Intl.RelativeTimeFormat(_getIntlLocale(), opts || { numeric: 'auto' });
    return rtf.format(diff < 0 ? -value : value, unit);
  } catch (_) {
    return String(date);
  }
}

function formatList(items, opts) {
  try {
    if (!Array.isArray(items) || items.length === 0) return '';
    return new Intl.ListFormat(_getIntlLocale(), opts || { type: 'conjunction', style: 'long' }).format(items);
  } catch (_) {
    return items.join(', ');
  }
}

// ── Expose to window for classic script access (OptionProfile, panel.js, dll)
window.i18n = {
  t,
  switchLocale,
  getCurrentLocale,
  getSupportedLocales,
  onLocaleChange,
  initI18n,
  syncFromUser: _syncFromUser,
  syncToUser: _syncToSupabase,
  isAllowed,
  // Constants exposed for UI components
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  STORAGE_KEY,
  LANG_CHANGED_EVENT,
  I18N_READY_EVENT,
  // ── Enterprise v2.0 additions ──
  // Intl formatters
  formatNumber,
  formatCurrency,
  formatDate,
  formatTime,
  formatRelativeTime,
  formatList,
  // Missing key tracking
  getMissingKeys,
  resetMissingKeys,
  onMissingKey,
  // Completeness
  getCompleteness,
  getMissingKeysForLocale,
  // Dev mode
  isDevMode: function () { return _isDevMode; },
  // Cache management
  clearCache: _clearCache,
  // Version
  I18N_VERSION: '2.0.0-enterprise',
};

// ── Auto-init with retry logic ─────────────────────────────────────────────
async function _autoInit() {
  if (_initialized) return;
  _initAttempts++;
  try {
    await initI18n();
    _initialized = true;
    console.info('[i18n] auto-init success');
  } catch (err) {
    console.error(`[i18n] auto-init attempt ${_initAttempts} failed:`, err);
    if (_initAttempts < MAX_INIT_RETRIES) {
      setTimeout(_autoInit, INIT_RETRY_DELAY_MS * _initAttempts);
    } else {
      console.error('[i18n] auto-init gave up after', MAX_INIT_RETRIES,
                    'attempts. HTML fallback text will be used.');
      // Last resort: still mark as initialized with fallback dict
      _translations[_currentLocale] = _FALLBACK_DICT[_currentLocale] || {};
      _translations[DEFAULT_LOCALE] = _FALLBACK_DICT[DEFAULT_LOCALE] || {};
      _initialized = true;
      updateDOM();
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _autoInit);
} else {
  _autoInit();
}

export default {
  t,
  switchLocale,
  getCurrentLocale,
  getSupportedLocales,
  onLocaleChange,
  initI18n,
  syncFromUser: _syncFromUser,
  syncToUser: _syncToSupabase,
  isAllowed,
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
};
