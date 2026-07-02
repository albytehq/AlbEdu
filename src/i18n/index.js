// =============================================================================
// i18n/index.js — AlbEdu Internationalization Core v1.0.0
// =============================================================================
//
//  Satu file, satu tanggung jawab: jembungkan teks statis UI ↔ multi-bahasa.
//
//  DESIGN CONTRACT (production-grade, anti-hacker):
//
//  1. ALLOWLIST BAHASA — Hanya 'id' & 'en' yang valid. Bahasa lain
//     (dari URL param, localStorage, Supabase, atau navigator.language)
//     di-ignore + warning ke console. Mencegah lang injection yang bisa
//     dipakai untuk social engineering / phishing via URL palsu.
//
//  2. XSS-SAFE RENDERING — Semua string translasi di-escape via
//     Security.escapeText() sebelum masuk ke DOM lewat textContent.
//     Untuk placeholder/aria-label, pakai Security.escapeAttr().
//     Tidak pernah ada innerHTML dengan translasi raw.
//
//  3. FALLBACK CHAIN — Key missing di active lang → fallback ke 'id'
//     (default) → fallback ke key itu sendiri + warning di console.
//     Tidak pernah ada text blank / undefined di UI.
//
//  4. STORAGE LAYER — localStorage untuk instant load + Supabase sync
//     untuk cross-device. localStorage key: 'albedu_lang'. Invalid value
//     di-ignore (tamper attempt tidak crash system).
//
//  5. CSP-FRIENDLY — Tidak ada eval, tidak ada inline style/script dari
//     translasi. Translation JSON inline di JS file (bukan fetch) untuk
//     avoid dynamic loading + match existing AlbEdu pattern.
//
//  6. INSTANT SWITCH — Tidak reload page. DOM scan ulang + dispatch
//     'language-changed' event supaya module lain (QNotify,
//     OptionProfile, dll) bisa re-render dynamic content.
//
//  7. DOM SCANNING — Pakai data-i18n attributes:
//       data-i18n="key"              → textContent
//       data-i18n-html="key"         → innerHTML (sanitized via DOMPurify)
//       data-i18n-placeholder="key"  → placeholder attr
//       data-i18n-aria-label="key"   → aria-label attr
//       data-i18n-title="key"        → title attr
//       data-i18n-aria-describedby="key" → aria-describedby (rare)
//
//  PUBLIC API:
//    I18n.init({ defaultLang, storageKey })
//    I18n.t(key, vars?)            → translated string (escaped)
//    I18n.tRaw(key, vars?)         → translated string (raw, for HTML use)
//    I18n.getLang()                → current language code
//    I18n.setLang(lang)            → switch language + persist + re-render
//    I18n.scan(root?)              → re-scan DOM for data-i18n attributes
//    I18n.onChanged(cb)            → subscribe to language change
//    I18n.syncFromUser(userData)   → load pref from Supabase user data
//    I18n.syncToUser()             → save pref to Supabase (async)
//
//  LOAD ORDER:
//    Harus load SETELAH security.js (butuh Security.escapeText/escapeAttr).
//    Boleh load sebelum/sesudah supabase-api.js — sync Supabase lazy.
// =============================================================================

(function (global) {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────────────
  const ALLOWLIST_LANGS = ['id', 'en'];          // Hanya 2 bahasa yang valid
  const DEFAULT_LANG    = 'id';                  // Bahasa default AlbEdu
  const STORAGE_KEY     = 'albedu_lang';         // localStorage key
  const LANG_CHANGED_EVENT = 'albedu:language-changed';

  // ── State ─────────────────────────────────────────────────────────────────
  let _currentLang   = DEFAULT_LANG;
  let _initialized   = false;
  let _dictionaries  = {};     // { id: {...}, en: {...} }
  let _changeCallbacks = new Set();
  let _supabaseSyncPending = false;

  // ── Security helpers (delegate to Security module) ────────────────────────
  // WHY delegate: supabase security.js sudah ada escape functions yang
  // battle-tested. Kita reuse, bukan re-implement.
  function _escapeText(str) {
    if (global.Security?.escapeText) return global.Security.escapeText(str);
    // Fallback inline (jika security.js belum loaded — jangan biarkan leak)
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function _escapeAttr(str) {
    if (global.Security?.escapeAttr) return global.Security.escapeAttr(str);
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function _sanitizeHTML(html) {
    if (global.Security?.sanitizeHTML) return global.Security.sanitizeHTML(html);
    // Last-resort fallback: strict escape everything
    return _escapeText(html);
  }

  // ── Validate language code (ALLOWLIST enforcement) ────────────────────────
  // CRITICAL: ini gerbang pertama anti-injection. Apapun sumber bahasa
  // (URL, localStorage, Supabase, navigator), harus lewat sini.
  // Invalid lang di-ignore, bukan di-throw — supaya tidak crash UI.
  function _validateLang(lang) {
    if (typeof lang !== 'string') return null;
    const normalized = lang.trim().toLowerCase().slice(0, 10); // cap length
    if (ALLOWLIST_LANGS.includes(normalized)) return normalized;
    // Handle locale format: 'id-ID' → 'id', 'en-US' → 'en'
    const base = normalized.split('-')[0];
    if (ALLOWLIST_LANGS.includes(base)) return base;
    if (typeof console !== 'undefined') {
      console.warn('[I18n] Rejected invalid language code:', lang, '(allowlist:', ALLOWLIST_LANGS.join(', ') + ')');
    }
    return null;
  }

  // ── Resolve language from multiple sources (priority order) ───────────────
  // Priority:
  //   1. URL param (?lang=en) — highest, supaya shareable link works
  //   2. localStorage (user explicit pref)
  //   3. Auth.userData.preferred_language (Supabase sync)
  //   4. navigator.language (browser auto-detect, first visit only)
  //   5. DEFAULT_LANG
  function _resolveInitialLang() {
    // 1. URL param
    try {
      const url = new URL(global.location?.href || '');
      const urlLang = url.searchParams.get('lang');
      const valid = _validateLang(urlLang);
      if (valid) {
        _persistLang(valid);
        // Hapus param dari URL supaya bersih (tanpa reload, pakai history API)
        url.searchParams.delete('lang');
        global.history?.replaceState?.({}, '', url.toString());
        return valid;
      }
    } catch (_) { /* URL parse failed, skip */ }

    // 2. localStorage
    try {
      const stored = global.localStorage?.getItem(STORAGE_KEY);
      const valid = _validateLang(stored);
      if (valid) return valid;
    } catch (_) { /* localStorage disabled (private mode), skip */ }

    // 3. Auth userData (Supabase sync) — only if Auth is loaded
    try {
      const userData = global.Auth?.userData;
      const userLang = userData?.preferred_language || userData?.preferredLanguage;
      const valid = _validateLang(userLang);
      if (valid) {
        _persistLang(valid);
        return valid;
      }
    } catch (_) { /* Auth not ready yet, skip */ }

    // 4. navigator.language — only if no localStorage pref yet
    //    (jangan override explicit pref dengan browser detection)
    try {
      const hasStoredPref = !!global.localStorage?.getItem(STORAGE_KEY);
      if (!hasStoredPref) {
        const browserLang = global.navigator?.language;
        const valid = _validateLang(browserLang);
        if (valid) {
          _persistLang(valid);
          return valid;
        }
      }
    } catch (_) { /* skip */ }

    // 5. Fallback
    return DEFAULT_LANG;
  }

  function _persistLang(lang) {
    const valid = _validateLang(lang);
    if (!valid) return false;
    try {
      global.localStorage?.setItem(STORAGE_KEY, valid);
      return true;
    } catch (_) {
      // localStorage may be disabled — silent fail, lang still active in memory
      return false;
    }
  }

  // ── Variable interpolation ────────────────────────────────────────────────
  // Replace {var} placeholders with values from vars object.
  // Variables di-escape BEFORE substitution supaya nilai variabel tidak
  // bisa inject HTML.
  //
  // Example:
  //   t('welcome', { name: '<script>alert(1)</script>' })
  //   → "Halo, &lt;script&gt;alert(1)&lt;/script&gt;!"
  function _interpolate(template, vars, escape = true) {
    if (typeof template !== 'string') return '';
    if (!vars || typeof vars !== 'object') return template;
    return template.replace(/\{(\w+)\}/g, (match, key) => {
      const value = vars[key];
      if (value === undefined || value === null) return match; // leave placeholder
      return escape ? _escapeText(value) : String(value);
    });
  }

  // ── Register dictionary ───────────────────────────────────────────────────
  // Multiple modules boleh register dictionary sendiri2 (modular).
  // Merge: key dari register terakhir MENANG (override) — untuk flexibility.
  function _registerDictionary(lang, dict) {
    const valid = _validateLang(lang);
    if (!valid) {
      console.warn('[I18n] Cannot register dictionary: invalid lang:', lang);
      return;
    }
    if (!dict || typeof dict !== 'object') {
      console.warn('[I18n] Cannot register dictionary: dict must be object');
      return;
    }
    if (!_dictionaries[valid]) _dictionaries[valid] = {};
    // Deep merge (shallow for top-level keys is enough for our use case)
    Object.assign(_dictionaries[valid], dict);
  }

  // ── Translate ─────────────────────────────────────────────────────────────
  // Public:
  //   I18n.t('hero.title')                           → "Kelola Ujian Online"
  //   I18n.t('greeting', { name: 'Budi' })           → "Halo, Budi!"
  //   I18n.tRaw('html.welcome')                      → raw string (untuk sanitasi eksternal)
  //
  // Fallback chain:
  //   1. active lang dictionary
  //   2. DEFAULT_LANG dictionary
  //   3. key itself + console warning
  function _translate(key, vars, opts = {}) {
    if (typeof key !== 'string' || !key) return '';
    const escape = opts.escape !== false; // default true

    // Lookup: active lang → default lang → key
    let value = undefined;
    const activeDict = _dictionaries[_currentLang];
    const defaultDict = _dictionaries[DEFAULT_LANG];

    if (activeDict && Object.prototype.hasOwnProperty.call(activeDict, key)) {
      value = activeDict[key];
    } else if (defaultDict && Object.prototype.hasOwnProperty.call(defaultDict, key)) {
      // Missing key in active lang → fallback to default
      if (typeof console !== 'undefined' && _currentLang !== DEFAULT_LANG) {
        console.warn('[I18n] Missing key "' + key + '" in lang "' + _currentLang + '", fallback to "' + DEFAULT_LANG + '"');
      }
      value = defaultDict[key];
    } else {
      // Total miss → return key itself + warning
      if (typeof console !== 'undefined') {
        console.warn('[I18n] Missing translation key: "' + key + '" (lang: ' + _currentLang + ')');
      }
      return escape ? _escapeText(key) : key;
    }

    if (typeof value !== 'string') {
      // Non-string value (e.g. number, object) → coerce to string
      value = String(value);
    }

    return _interpolate(value, vars, escape);
  }

  // ── DOM Scanner ───────────────────────────────────────────────────────────
  // Scan root (default: document.body) for elements with data-i18n* attributes
  // and apply translations. Idempotent — safe to call multiple times.
  //
  // Attributes supported:
  //   data-i18n="key"               → textContent (XSS-safe via escapeText)
  //   data-i18n-html="key"          → innerHTML (sanitized via Security.sanitizeHTML)
  //   data-i18n-placeholder="key"   → placeholder attr
  //   data-i18n-aria-label="key"    → aria-label attr
  //   data-i18n-title="key"         → title attr
  //   data-i18n-aria-describedby    → aria-describedby attr
  //
  // Variable interpolation:
  //   data-i18n-vars='{"name":"Budi"}'  → JSON-encoded vars object
  //   (parsed safely, never eval'd)
  function _scan(root) {
    const scope = root || document;
    if (!scope || !scope.querySelectorAll) return;

    // textContent bindings
    scope.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (!key) return;
      const vars = _parseVarsAttr(el);
      // Always use textContent — escape internally via _translate
      // _translate already escapes, so we use tRaw + manual textContent assignment
      const text = _translate(key, vars, { escape: true });
      // Use textContent (not innerHTML) — value is already escaped but
      // textContent is safer because it never parses HTML at all.
      el.textContent = _unescapeForTextNode(text);
    });

    // innerHTML bindings (sanitized)
    scope.querySelectorAll('[data-i18n-html]').forEach((el) => {
      const key = el.getAttribute('data-i18n-html');
      if (!key) return;
      const vars = _parseVarsAttr(el);
      // Raw string (interpolation escapes vars), then sanitize
      const raw = _translate(key, vars, { escape: false });
      // Re-interpolate with escape for safety
      const safe = _interpolate(raw, vars, true);
      // Sanitize HTML to strip dangerous tags (script, iframe, on* handlers)
      el.innerHTML = _sanitizeHTML(safe);
    });

    // placeholder
    scope.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const key = el.getAttribute('data-i18n-placeholder');
      if (!key) return;
      const vars = _parseVarsAttr(el);
      const text = _translate(key, vars, { escape: false });
      // Attr value — escape for safety
      el.setAttribute('placeholder', _escapeAttr(text));
    });

    // aria-label
    scope.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
      const key = el.getAttribute('data-i18n-aria-label');
      if (!key) return;
      const vars = _parseVarsAttr(el);
      const text = _translate(key, vars, { escape: false });
      el.setAttribute('aria-label', _escapeAttr(text));
    });

    // title (native tooltip)
    scope.querySelectorAll('[data-i18n-title]').forEach((el) => {
      const key = el.getAttribute('data-i18n-title');
      if (!key) return;
      const vars = _parseVarsAttr(el);
      const text = _translate(key, vars, { escape: false });
      el.setAttribute('title', _escapeAttr(text));
    });

    // aria-describedby (rare, but include for completeness)
    scope.querySelectorAll('[data-i18n-aria-describedby]').forEach((el) => {
      const key = el.getAttribute('data-i18n-aria-describedby');
      if (!key) return;
      const vars = _parseVarsAttr(el);
      const text = _translate(key, vars, { escape: false });
      el.setAttribute('aria-describedby', _escapeAttr(text));
    });

    // Update <html lang="..."> attribute — important for accessibility
    // (screen readers use this to pick the right voice)
    if (scope === document || scope === document.body) {
      const html = document.documentElement;
      if (html && html.getAttribute('lang') !== _currentLang) {
        html.setAttribute('lang', _currentLang);
      }
    }
  }

  // When we use textContent, we need to UN-escape the HTML entities that
  // _translate produced — because textContent doesn't interpret entities,
  // it treats them as literal text.
  //
  // WHY this is safe:
  //   - _translate escapes <, >, & → entities
  //   - We unescape them back to literal <, >, &
  //   - textContent assigns them as TEXT, not HTML
  //   - Browser never parses them as HTML
  //
  // Net effect: textContent shows "<script>" as literal text, not executes it.
  function _unescapeForTextNode(escapedText) {
    return String(escapedText ?? '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&'); // must be LAST to avoid double-unescape
  }

  // Parse data-i18n-vars attribute (JSON-encoded object)
  // Safe: uses JSON.parse, not eval. Invalid JSON → empty object.
  function _parseVarsAttr(el) {
    if (!el.hasAttribute('data-i18n-vars')) return null;
    const raw = el.getAttribute('data-i18n-vars');
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch (e) {
      console.warn('[I18n] Invalid data-i18n-vars JSON on element:', el, '—', e.message);
    }
    return null;
  }

  // ── Set language ──────────────────────────────────────────────────────────
  // Switch language, persist, re-scan DOM, dispatch event, sync to Supabase.
  // Public — called by language switcher UI.
  async function _setLang(lang) {
    const valid = _validateLang(lang);
    if (!valid) {
      console.warn('[I18n] Cannot set invalid language:', lang);
      return false;
    }

    if (valid === _currentLang && _initialized) {
      // No-op — already active
      return true;
    }

    const previousLang = _currentLang;
    _currentLang = valid;
    _persistLang(valid);

    // Re-scan DOM with new translations
    _scan(document);

    // Dispatch event so other modules can re-render dynamic content
    // (QNotify toasts, OptionProfile items, etc.)
    try {
      global.dispatchEvent(new CustomEvent(LANG_CHANGED_EVENT, {
        detail: { lang: valid, previousLang }
      }));
    } catch (_) { /* dispatchEvent may fail in some sandboxes */ }

    // Notify registered callbacks
    _changeCallbacks.forEach((cb) => {
      try { cb(valid, previousLang); } catch (e) {
        console.warn('[I18n] Change callback error:', e);
      }
    });

    // Sync to Supabase (async, fire-and-forget) — only if user is logged in
    _syncToSupabase().catch((err) => {
      console.warn('[I18n] Supabase sync failed (non-fatal):', err?.message || err);
    });

    return true;
  }

  // ── Supabase sync ─────────────────────────────────────────────────────────
  // Save preferred_language to users table for cross-device persistence.
  // RLS policy akan restrict user hanya bisa update row sendiri.
  async function _syncToSupabase() {
    if (_supabaseSyncPending) return; // debounce
    if (!global.sb) return; // Supabase not loaded
    const user = global.Auth?.currentUser;
    if (!user?.id && !user?.uid) return; // not logged in

    _supabaseSyncPending = true;
    try {
      const userId = user.id || user.uid;
      const { error } = await global.sb
        .from('users')
        .update({ preferred_language: _currentLang })
        .eq('id', userId);

      if (error) throw error;

      // Also update local Auth.userData cache
      if (global.Auth?.userData) {
        global.Auth.userData.preferred_language = _currentLang;
      }
    } finally {
      _supabaseSyncPending = false;
    }
  }

  // Load language preference from Supabase user data (called after login)
  function _syncFromUser(userData) {
    if (!userData || typeof userData !== 'object') return;
    const userLang = userData.preferred_language || userData.preferredLanguage;
    const valid = _validateLang(userLang);
    if (!valid) return; // no pref or invalid — keep current

    // Only switch if different from current
    if (valid !== _currentLang) {
      _setLang(valid);
    }
  }

  // ── Subscribe to language changes ─────────────────────────────────────────
  function _onChanged(callback) {
    if (typeof callback !== 'function') return () => {};
    _changeCallbacks.add(callback);
    return () => _changeCallbacks.delete(callback); // unsubscribe
  }

  // ── Initialize ────────────────────────────────────────────────────────────
  // Called once on page load. Idempotent.
  function _init(opts = {}) {
    if (_initialized) return;
    _initialized = true;

    // Register dictionaries — load inline translations
    // (each module can register additional keys via I18n.register)
    if (global.AlbEduI18n_translations_id) {
      _registerDictionary('id', global.AlbEduI18n_translations_id);
    }
    if (global.AlbEduI18n_translations_en) {
      _registerDictionary('en', global.AlbEduI18n_translations_en);
    }

    // Resolve initial language (URL → localStorage → Auth → navigator → default)
    _currentLang = _resolveInitialLang();

    // Initial DOM scan (after DOM is ready)
    const doScan = () => _scan(document);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', doScan, { once: true });
    } else {
      doScan();
    }

    // Listen for Auth ready to sync pref from Supabase
    // (hanya jika user logged in DAN punya pref di DB yang berbeda)
    document.addEventListener('auth-ready', () => {
      if (global.Auth?.userData) {
        _syncFromUser(global.Auth.userData);
      }
    });

    // Listen for pep-saved (profile editor) — mungkin preferred_language berubah
    window.addEventListener('pep-saved', (e) => {
      if (e.detail) _syncFromUser(e.detail);
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────
  global.I18n = {
    init:           _init,
    t:              (key, vars) => _translate(key, vars, { escape: true }),
    tRaw:           (key, vars) => _translate(key, vars, { escape: false }),
    tHtml:          (key, vars) => _sanitizeHTML(_translate(key, vars, { escape: false })),
    getLang:        () => _currentLang,
    setLang:        _setLang,
    scan:           _scan,
    onChanged:      _onChanged,
    syncFromUser:   _syncFromUser,
    syncToUser:     _syncToSupabase,
    register:       _registerDictionary,
    isAllowed:      (lang) => _validateLang(lang) !== null,
    // Constants exposed for UI components
    ALLOWED_LANGS:  [...ALLOWLIST_LANGS],
    DEFAULT_LANG,
    STORAGE_KEY,
    LANG_CHANGED_EVENT,
  };

  // ── Auto-init on script load ──────────────────────────────────────────────
  // WHY auto-init: supaya semua halaman yang include script ini langsung
  // dapat i18n tanpa perlu manual init. Pattern sama seperti security.js.
  _init();

}(window));
