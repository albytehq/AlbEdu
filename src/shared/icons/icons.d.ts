// =============================================================================
// icons.d.ts — TypeScript definitions for AlbEdu Icon System (v6.0)
// =============================================================================
// Place this file alongside icons.js for IDE autocomplete + type checking.
// =============================================================================

/** Options for rendering an icon. */
export interface IconOptions {
  /** Explicit size in pixels (sets both width and height). */
  size?: number;
  /** Additional CSS classes to add to the SVG element. */
  class?: string;
  /** Accessibility label. If provided, icon gets role="img". */
  'aria-label'?: string;
  /** Override default stroke width (default: 2). */
  strokeWidth?: number;
  /** Show placeholder if icon is missing (default: true). Set false to return empty string. */
  fallback?: boolean;
}

/** Performance metrics for the icon system. */
export interface IconMetrics {
  /** Total number of icon() calls that successfully rendered. */
  iconsRendered: number;
  /** Total number of icons bound via bindIcons(). */
  iconsBound: number;
  /** Map of missing icon names → request count. */
  missingIcons: Record<string, number>;
  /** Number of distinct missing icons requested. */
  missingIconCount: number;
  /** Number of errors caught by error boundary. */
  errorCount: number;
  /** Array of error entries (capped at 50). */
  errors: Array<{
    context: string;
    message: string;
    stack?: string;
    timestamp: number;
  }>;
  /** Time spent in last bindIcons() call (ms). */
  bindTimeMs: number;
  /** Time spent in auto-init (ms). */
  initTimeMs: number;
  /** Timestamp of last bindIcons() call. */
  lastBindTimestamp: number | null;
  /** Total icons in registry. */
  totalIconsInRegistry: number;
}

/** Result of bindIcons() call. */
export interface BindResult {
  /** Number of icons bound immediately (in viewport). */
  immediate: number;
  /** Number of icons deferred (off-screen, will bind on scroll). */
  deferred: number;
}

/** Event detail for 'icon-missing' event. */
export interface IconMissingEvent {
  requested: string;
  normalized: string;
}

/** Event detail for 'icons-bound' event. */
export interface IconsBoundEvent {
  immediate: number;
  deferred: number;
  durationMs: number;
}

/** Event detail for 'icon-error' event. */
export interface IconErrorEvent {
  name?: string;
  context?: string;
  error: Error;
  element?: Element;
}

/** Event listener unsubscribe function. */
export type Unsubscribe = () => void;

/** AlbEdu Icon System public API. */
export interface AlbEduIcons {
  /** Render an icon as an HTML string. Never throws — returns fallback on error. */
  icon(name: string, opts?: IconOptions): string;
  /** Set an icon on an existing DOM element. Mutates innerHTML. */
  setIcon(el: Element, name: string, opts?: IconOptions): void;
  /** Register a custom icon at runtime. svgPath = inner SVG content. */
  registerIcon(name: string, svgPath: string): boolean;
  /** Bind all [data-albedu-icon] elements in root. Returns bind counts. */
  bindIcons(root?: Element | Document): BindResult;
  /** List all registered icon names (registry + aliases), sorted. */
  listIcons(): string[];
  /** Check if an icon exists in the registry (resolves aliases). */
  hasIcon(name: string): boolean;
  /** Get performance metrics for debugging/observability. */
  getMetrics(): IconMetrics;
  /** Reset all metrics to zero. */
  resetMetrics(): void;
  /** Subscribe to an event. Returns unsubscribe function. */
  addEventListener(event: 'icon-missing', cb: (detail: IconMissingEvent) => void): Unsubscribe;
  addEventListener(event: 'icons-bound', cb: (detail: IconsBoundEvent) => void): Unsubscribe;
  addEventListener(event: 'icon-error', cb: (detail: IconErrorEvent) => void): Unsubscribe;
  /** Alias for addEventListener (DOM API naming). */
  on(event: 'icon-missing', cb: (detail: IconMissingEvent) => void): Unsubscribe;
  on(event: 'icons-bound', cb: (detail: IconsBoundEvent) => void): Unsubscribe;
  on(event: 'icon-error', cb: (detail: IconErrorEvent) => void): Unsubscribe;
  /** Icon system version string. */
  ICONS_VERSION: string;
}

/** Augment the global AlbEdu namespace with icon system. */
declare global {
  interface Window {
    AlbEdu: {
      icon: AlbEduIcons['icon'];
      setIcon: AlbEduIcons['setIcon'];
      registerIcon: AlbEduIcons['registerIcon'];
      bindIcons: AlbEduIcons['bindIcons'];
      listIcons: AlbEduIcons['listIcons'];
      hasIcon: AlbEduIcons['hasIcon'];
      getMetrics: AlbEduIcons['getMetrics'];
      resetMetrics: AlbEduIcons['resetMetrics'];
      addEventListener: AlbEduIcons['addEventListener'];
      on: AlbEduIcons['on'];
      ICONS_VERSION: string;
    };
  }
}

export {};
