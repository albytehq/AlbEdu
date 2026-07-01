// =============================================================================
// i18n/index.js — AlbEdu Internationalization Engine (v1.0.0)
// =============================================================================
// Supports: id (default), en, ru, es, zh
// Features: interpolation, pluralization, fallback, DOM auto-update
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

// Detect base path for locale loading (works on localhost + GitHub Pages subpath)
function _getBasePath() {
  // Try import.meta.url (ES module)
  try {
    const moduleUrl = new URL(import.meta.url);
    // moduleUrl = .../src/i18n/index.js → go up 2 levels to project root
    const rootUrl = new URL('..', moduleUrl);
    return rootUrl.pathname; // e.g. /AlbEdu/ or /
  } catch {
    // Fallback: detect from window location
    const path = window.location.pathname;
    // If path contains /AlbEdu/, use it as base
    const match = path.match(/^(\/[^\/]+\/)/);
    return match ? match[1] : '/';
  }
}

// Load locale JSON file (lazy)
async function loadLocale(locale) {
  if (_translations[locale]) return _translations[locale];
  try {
    const basePath = _getBasePath();
    const res = await fetch(`${basePath}src/i18n/locales/${locale}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _translations[locale] = data;
    return data;
  } catch (err) {
    console.warn(`[i18n] Failed to load locale '${locale}':`, err);
    // Fallback to default
    if (locale !== DEFAULT_LOCALE) {
      return loadLocale(DEFAULT_LOCALE);
    }
    return {};
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

// Main translate function
export function t(key, params) {
  const localeData = _translations[_currentLocale] || {};
  const defaultData = _translations[DEFAULT_LOCALE] || {};

  // Try current locale, then default
  let value = getNested(localeData, key);
  if (value === undefined) {
    value = getNested(defaultData, key);
  }
  if (value === undefined) {
    // Return key as fallback (dev mode — missing translations visible)
    return key;
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

// Update all DOM elements with data-i18n attribute
function updateDOM() {
  // Text content
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    el.textContent = t(key);
  });
  // Attributes (data-i18n-attr="placeholder:take.search,label:nav.title")
  document.querySelectorAll('[data-i18n-attr]').forEach(el => {
    const pairs = el.getAttribute('data-i18n-attr').split(',');
    pairs.forEach(pair => {
      const [attr, key] = pair.trim().split(':');
      if (attr && key) {
        el.setAttribute(attr.trim(), t(key.trim()));
      }
    });
  });
}

// Initialize i18n (call on DOMContentLoaded)
export async function initI18n() {
  _currentLocale = detectLocale();
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

// v0.742.4 FIX: Auto-initialize on DOMContentLoaded.
// Previously, the module exported initI18n() but never called it — so every
// page that loaded the module via `<script type="module" src=".../i18n/index.js">`
// saw raw i18n keys (e.g. "nav.profile", "create.page_title") instead of
// translated text. The fallback text in HTML (e.g. <span data-i18n="nav.profile">Profil Admin</span>)
// was being overwritten by updateDOM() which called t(key) — but t(key)
// returned the KEY itself because _translations was empty (no locale loaded).
//
// Now: auto-init when DOM is ready. This is idempotent and safe to call
// from multiple pages. Pages that want to control init timing can still
// call window.i18n.initI18n() manually — the auto-init checks if already
// initialized and skips.
let _initialized = false;

async function _autoInit() {
  if (_initialized) return;
  _initialized = true;
  try {
    await initI18n();
  } catch (err) {
    console.error('[i18n] auto-init failed:', err);
    _initialized = false; // allow retry
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _autoInit);
} else {
  _autoInit();
}

export default { t, switchLocale, getCurrentLocale, getSupportedLocales, onLocaleChange, initI18n };
