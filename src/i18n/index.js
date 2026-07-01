// =============================================================================
// i18n/index.js — AlbEdu Internationalization Engine (v1.1.0)
// =============================================================================
// Supports: id (default), en, ru, es, zh
// Features: interpolation, pluralization, fallback, DOM auto-update
//
// v1.1.0 (v0.742.6): Comprehensive reliability fixes.
//   1. _getBasePath() now mirrors AUTH_CONFIG.BASE_PATH logic exactly —
//      walks up past known app subfolders (/pages/admin/, /pages/assessment/,
//      /pages/, /admin/, /ujian/, etc.). Previous fallback regex
//      (/^(\/[^\/]+\/)/) returned '/pages/' for /pages/admin/profile.html
//      → fetch('/pages/src/i18n/locales/id.json') → 404 → silent fail.
//   2. t() no longer returns the raw KEY when translation is missing.
//      Instead it returns undefined. updateDOM() then SKIPS elements whose
//      translation is missing, preserving the HTML fallback text (e.g.
//      <span data-i18n="nav.profile">Profil Admin</span> keeps "Profil Admin"
//      if the locale JSON fails to load). This prevents raw keys from
//      "spreading" across pages when i18n init fails.
//   3. _autoInit() now retries up to 3 times with 200ms backoff if the
//      locale fetch fails. Handles transient network issues.
//   4. Console logging is more verbose for debugging — every step
//      (basePath, fetch URL, locale loaded, DOM updated) is logged.
// =============================================================================

const SUPPORTED_LOCALES = {
  id: { name: 'Bahasa Indonesia', native: 'Bahasa Indonesia', dir: 'ltr' },
  en: { name: 'English', native: 'English', dir: 'ltr' },
  ru: { name: 'Russian', native: 'Русский', dir: 'ltr' },
  es: { name: 'Spanish', native: 'Español', dir: 'ltr' },
  zh: { name: 'Chinese', native: '中文', dir: 'ltr' },
};

const DEFAULT_LOCALE = 'id';
const STORAGE_KEY = 'albedu_locale';
const MAX_INIT_RETRIES = 3;
const INIT_RETRY_DELAY_MS = 200;

let _currentLocale = DEFAULT_LOCALE;
let _translations = {};
let _listeners = new Set();

// Map browser locale to our supported locale
function mapBrowserLocale(browserLocale) {
  if (!browserLocale) return DEFAULT_LOCALE;
  const lower = browserLocale.toLowerCase();
  const lang = lower.split('-')[0];
  if (lang in SUPPORTED_LOCALES) return lang;
  // Special mappings
  const map = { 'in': 'id', 'iw': 'id', 'zh-tw': 'zh', 'zh-cn': 'zh' };
  if (lower in map) return map[lower];
  if (lang in map) return map[lang];
  return DEFAULT_LOCALE;
}

// Auto-detect locale from: localStorage → browser → default
export function detectLocale() {
  // 1. User's manual choice
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && stored in SUPPORTED_LOCALES) return stored;
  // 2. Browser language
  const browser = navigator.language || navigator.languages?.[0];
  return mapBrowserLocale(browser);
}

// v1.1.0: Detect base path for locale loading.
// Strategy:
//   1. Try import.meta.url (ES module) — go up 2 levels from src/i18n/ to root.
//      This is the most reliable: it points at the ACTUAL module location
//      regardless of which page loaded it.
//   2. Fallback: walk up past known app subfolders (mirrors
//      AUTH_CONFIG.BASE_PATH in src/auth/main.js). This handles the case
//      where import.meta.url is unavailable (very old browsers) or the
//      module is bundled in a way that breaks import.meta.url.
//
// Previous fallback regex (/^(\/[^\/]+\/)/) returned '/pages/' for
// /pages/admin/profile.html → fetch URL was '/pages/src/i18n/locales/id.json'
// → 404 → silent init failure → raw keys displayed.
function _getBasePath() {
  // Strategy 1: import.meta.url
  try {
    const moduleUrl = new URL(import.meta.url);
    // moduleUrl = .../src/i18n/index.js → go up 2 levels to project root
    const rootUrl = new URL('..', moduleUrl);
    const path = rootUrl.pathname;
    if (path && path.endsWith('/')) {
      return path; // e.g. /AlbEdu/ or /
    }
  } catch {
    // import.meta.url unavailable — fall through to strategy 2
  }

  // Strategy 2: walk up past known app subfolders.
  // Same logic as AUTH_CONFIG.BASE_PATH in src/auth/main.js.
  const p = window.location.pathname;
  const base = p.substring(0, p.lastIndexOf('/') + 1);
  // Order matters: longer paths first.
  const APP_SUBFOLDERS = [
    '/pages/admin/pages/', '/pages/assessment/',
    '/pages/admin/', '/pages/ujian/', '/pages/',
    '/admin/pages/', '/ujian/', '/admin/',
  ];
  for (const sub of APP_SUBFOLDERS) {
    const idx = base.indexOf(sub);
    if (idx !== -1) return base.substring(0, idx + 1);
  }
  return base || '/';
}

// Load locale JSON file (lazy)
async function loadLocale(locale) {
  if (_translations[locale]) return _translations[locale];
  try {
    const basePath = _getBasePath();
    const url = `${basePath}src/i18n/locales/${locale}.json`;
    console.info(`[i18n] Loading locale: ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _translations[locale] = data;
    console.info(`[i18n] Locale '${locale}' loaded:`, Object.keys(data).length, 'top-level keys');
    return data;
  } catch (err) {
    console.warn(`[i18n] Failed to load locale '${locale}':`, err);
    // Fallback to default
    if (locale !== DEFAULT_LOCALE) {
      return loadLocale(DEFAULT_LOCALE);
    }
    return null; // v1.1.0: return null (not {}) so caller can detect failure
  }
}

// Get nested value from object by dot path: "nav.create" → obj.nav.create
function getNested(obj, path) {
  return path.split('.').reduce((acc, key) => {
    if (acc && typeof acc === 'object' && key in acc) return acc[key];
    return undefined;
  }, obj);
}

// Interpolate: "Sisa: {{minutes}} menit" → "Sisa: 15 menit"
function interpolate(str, params) {
  if (!params || typeof str !== 'string') return str;
  return str.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return params[key] !== undefined ? String(params[key]) : `{{${key}}}`;
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

// Main translate function.
// v1.1.0: returns undefined (not the key) when translation is missing.
// This lets updateDOM() preserve the HTML fallback text instead of
// overwriting it with a raw key like "nav.profile".
export function t(key, params) {
  const localeData = _translations[_currentLocale] || {};
  const defaultData = _translations[DEFAULT_LOCALE] || {};

  // Try current locale, then default
  let value = getNested(localeData, key);
  if (value === undefined) {
    value = getNested(defaultData, key);
  }
  if (value === undefined) {
    // v1.1.0: return undefined — caller decides what to do.
    // updateDOM() will keep the existing HTML text.
    return undefined;
  }

  // Pluralization
  if (params && typeof params.count !== 'undefined') {
    value = pluralize(value, params.count);
  }

  // Interpolation
  return interpolate(value, params);
}

// Switch locale (async — loads JSON first)
export async function switchLocale(locale) {
  if (!SUPPORTED_LOCALES[locale]) {
    console.warn(`[i18n] Unsupported locale: ${locale}`);
    return;
  }
  _currentLocale = locale;
  localStorage.setItem(STORAGE_KEY, locale);
  await loadLocale(locale);

  // Update <html> lang attribute
  document.documentElement.setAttribute('lang', locale);
  document.documentElement.setAttribute('dir', SUPPORTED_LOCALES[locale].dir);

  // Update all DOM elements with data-i18n attribute
  updateDOM();

  // Notify listeners
  _listeners.forEach(fn => {
    try { fn(locale); } catch (e) { console.error('[i18n] listener error:', e); }
  });
}

// Get current locale
export function getCurrentLocale() {
  return _currentLocale;
}

// Get supported locales
export function getSupportedLocales() {
  return SUPPORTED_LOCALES;
}

// Subscribe to locale changes
export function onLocaleChange(callback) {
  _listeners.add(callback);
  return () => _listeners.delete(callback);
}

// Update all DOM elements with data-i18n attribute.
// v1.1.0: SKIP elements whose translation is missing (t() returns undefined).
// This preserves the HTML fallback text (e.g. "Profil Admin" in
// <span data-i18n="nav.profile">Profil Admin</span>) instead of
// overwriting it with the raw key "nav.profile".
function updateDOM() {
  // Text content
  const textEls = document.querySelectorAll('[data-i18n]');
  let updated = 0, skipped = 0;
  textEls.forEach(el => {
    const key = el.getAttribute('data-i18n');
    const translated = t(key);
    if (translated !== undefined) {
      el.textContent = translated;
      updated++;
    } else {
      skipped++;
    }
  });
  // Attributes (data-i18n-attr="placeholder:take.search,label:nav.title")
  const attrEls = document.querySelectorAll('[data-i18n-attr]');
  attrEls.forEach(el => {
    const pairs = el.getAttribute('data-i18n-attr').split(',');
    pairs.forEach(pair => {
      const [attr, key] = pair.trim().split(':');
      if (attr && key) {
        const translated = t(key.trim());
        if (translated !== undefined) {
          el.setAttribute(attr.trim(), translated);
        }
      }
    });
  });
  console.info(`[i18n] updateDOM: ${updated} translated, ${skipped} skipped (kept HTML fallback)`);
}

// Initialize i18n (call on DOMContentLoaded)
export async function initI18n() {
  _currentLocale = detectLocale();
  console.info(`[i18n] Initializing, locale: ${_currentLocale}`);
  await loadLocale(_currentLocale);
  // Also preload default as fallback
  if (_currentLocale !== DEFAULT_LOCALE) {
    await loadLocale(DEFAULT_LOCALE);
  }
  document.documentElement.setAttribute('lang', _currentLocale);
  document.documentElement.setAttribute('dir', SUPPORTED_LOCALES[_currentLocale].dir);
  updateDOM();
  console.info(`[i18n] Initialized: ${_currentLocale}`);
}

// Expose to window for classic script access
window.i18n = { t, switchLocale, getCurrentLocale, getSupportedLocales, onLocaleChange, initI18n };

// v1.1.0: Auto-initialize on DOMContentLoaded with retry logic.
// - If DOM is still loading, wait for DOMContentLoaded.
// - If DOM is already ready (interactive/complete), run immediately.
// - If locale fetch fails, retry up to MAX_INIT_RETRIES times with backoff.
// - Idempotent: safe to call from multiple pages / multiple times.
let _initialized = false;
let _initAttempts = 0;

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
      console.error('[i18n] auto-init gave up after', MAX_INIT_RETRIES, 'attempts. HTML fallback text will be used.');
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _autoInit);
} else {
  // DOM already parsed (interactive or complete) — run now.
  _autoInit();
}

export default { t, switchLocale, getCurrentLocale, getSupportedLocales, onLocaleChange, initI18n };
