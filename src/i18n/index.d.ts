// =============================================================================
// i18n.d.ts — TypeScript definitions for AlbEdu I18N System (v2.0 Enterprise)
// =============================================================================
// Place this file alongside index.js for IDE autocomplete + type checking.
// =============================================================================

/** Translation parameters for interpolation and pluralization. */
export interface TranslateParams {
  /** Count for pluralization (triggers plural form selection). */
  count?: number;
  /** Context variant (looks up `key.context` before `key`). */
  context?: string;
  /** Any {{var}} placeholder values. Values are HTML-escaped. */
  [key: string]: unknown;
}

/** Options for the translate function. */
export interface TranslateOptions {
  /** Bypass memoization cache (force re-translation). */
  bypassCache?: boolean;
  /** In dev mode, wrap missing keys with ⟦key⟧ markers. Set false to disable. */
  devMarker?: boolean;
}

/** Number formatting options (delegates to Intl.NumberFormat). */
export interface NumberFormatOptions extends Intl.NumberFormatOptions {}

/** Date/time formatting options (delegates to Intl.DateTimeFormat). */
export interface DateTimeFormatOptions extends Intl.DateTimeFormatOptions {}

/** Relative time formatting options. */
export interface RelativeTimeFormatOptions {
  /** 'auto' → "yesterday", 'always' → "1 day ago". Default: 'auto'. */
  numeric?: 'always' | 'auto';
  /** 'long' → "1 day ago", 'short' → "1 day ago", 'narrow' → "1d ago". */
  style?: 'long' | 'short' | 'narrow';
}

/** List formatting options. */
export interface ListFormatOptions {
  /** 'conjunction' → "A, B, and C", 'disjunction' → "A, B, or C". */
  type?: 'conjunction' | 'disjunction' | 'unit';
  /** 'long', 'short', 'narrow'. */
  style?: 'long' | 'short' | 'narrow';
}

/** Missing key entry from getMissingKeys(). */
export interface MissingKeyEntry {
  /** The i18n key that was missing (e.g., 'nav.profile'). */
  key: string;
  /** How many times this key was requested. */
  count: number;
  /** First request timestamp (ms since epoch). */
  firstSeen: number;
  /** Most recent request timestamp. */
  lastSeen: number;
  /** Locales where this key was missing. */
  locales: string[];
}

/** Missing key event detail for onMissingKey callback. */
export interface MissingKeyEvent {
  key: string;
  locale: string;
}

/** Locale metadata. */
export interface LocaleInfo {
  /** English name (e.g., 'Indonesian'). */
  name: string;
  /** Native name (e.g., 'Bahasa Indonesia'). */
  native: string;
  /** Text direction. */
  dir: 'ltr' | 'rtl';
  /** Flag emoji. */
  flag: string;
}

/** AlbEdu I18N Enterprise public API. */
export interface AlbEduI18N {
  // ── Core translation ──
  /** Translate a key with optional params. Returns translated string or undefined. */
  t(key: string, params?: TranslateParams, opts?: TranslateOptions): string | undefined;
  /** Switch to a new locale. Loads JSON, updates DOM, syncs to Supabase. */
  switchLocale(locale: string): Promise<boolean>;
  /** Get the current active locale code. */
  getCurrentLocale(): string;
  /** Get all supported locales with metadata. */
  getSupportedLocales(): Record<string, LocaleInfo>;
  /** Check if a locale code is valid (allowlist enforced). */
  isAllowed(lang: string): boolean;
  /** Subscribe to locale changes. Returns unsubscribe function. */
  onLocaleChange(callback: (locale: string, previousLocale: string) => void): () => void;
  /** Initialize i18n (auto-called on DOMContentLoaded). */
  initI18n(): Promise<void>;
  /** Sync locale preference from Supabase user data. */
  syncFromUser(userData: Record<string, unknown>): void;
  /** Sync locale preference to Supabase. */
  syncToUser(): Promise<void>;

  // ── Intl API formatters (v2.0) ──
  /** Format a number using locale-aware formatting. */
  formatNumber(num: number, opts?: NumberFormatOptions): string;
  /** Format a number as currency. Default currency: IDR. */
  formatCurrency(num: number, currency?: string, opts?: NumberFormatOptions): string;
  /** Format a date. Default style: medium. */
  formatDate(date: Date | string | number, opts?: DateTimeFormatOptions): string;
  /** Format a time. Default style: short. */
  formatTime(date: Date | string | number, opts?: DateTimeFormatOptions): string;
  /** Format relative time (e.g., "2 hours ago", "tomorrow"). */
  formatRelativeTime(date: Date | string | number, opts?: RelativeTimeFormatOptions): string;
  /** Format a list of items (e.g., "A, B, and C"). */
  formatList(items: string[], opts?: ListFormatOptions): string;

  // ── Missing key tracking (v2.0) ──
  /** Get all missing keys tracked since last reset, sorted by request count. */
  getMissingKeys(): MissingKeyEntry[];
  /** Reset missing key tracking. */
  resetMissingKeys(): void;
  /** Subscribe to missing key events. Returns unsubscribe function. */
  onMissingKey(callback: (event: MissingKeyEvent) => void): () => void;

  // ── Completeness checker (v2.0) ──
  /** Get translation completeness percentage (0-100) for a locale. */
  getCompleteness(locale: string): number;
  /** Get keys present in default locale but missing from target locale. */
  getMissingKeysForLocale(locale: string): string[];

  // ── Dev mode (v2.0) ──
  /** Check if dev mode is active (localhost or ?i18n_debug param). */
  isDevMode(): boolean;

  // ── Cache management (v2.0) ──
  /** Clear the translation memoization cache. */
  clearCache(): void;

  // ── Constants ──
  SUPPORTED_LOCALES: Record<string, LocaleInfo>;
  DEFAULT_LOCALE: string;
  STORAGE_KEY: string;
  LANG_CHANGED_EVENT: string;
  I18N_READY_EVENT: string;
  I18N_VERSION: string;
}

/** Augment the global window with i18n. */
declare global {
  interface Window {
    i18n: AlbEduI18N;
  }
}

export {};
