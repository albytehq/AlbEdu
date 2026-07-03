// =============================================================================
// QNotify 1.0.5 For AlbEdu — TypeScript Definitions
// =============================================================================
// Type definitions for the QNotify notification system API.
// Import: import show from './public/QNotify/api/index.js';
// =============================================================================

/** Toast notification type */
export type NotificationType = 'success' | 'error' | 'warning' | 'info';

/** Dialog intent — determines visual treatment + mechanic */
export type DialogIntent = 'info' | 'warning' | 'danger';

/** ReadNote UI type */
export type ReadNoteUiType = 'default' | 'text_only';

/** ReadNote read type */
export type ReadNoteReadType = 'required' | 'optional';

/** Dialog mechanic — how the user confirms */
export type DialogMechanic = 'confirm' | 'async' | 'hold' | 'hold-async';

/** Options for show() — generic toast */
export interface ShowOptions {
    type?: NotificationType;
    title?: string | null;
    message?: string | null;
    duration?: number;
    icon?: string | null;
}

/** Options for confirm dialog */
export interface ConfirmOptions {
    title?: string;
    message: string;
    icon?: string;
    onYes?: () => void;
    onNo?: () => void;
    intent?: DialogIntent;
}

/** Options for async confirm dialog */
export interface AsyncConfirmOptions {
    title?: string;
    message: string;
    icon?: string;
    /** async fn — return true for success, false for error. Or callback pattern. */
    onAsyncYes?: (() => Promise<boolean>) | ((resolve: (success: boolean) => void) => void);
    onAsyncNo?: () => void;
    intent?: DialogIntent;
}

/** Options for hold confirm dialog */
export interface HoldConfirmOptions {
    title?: string;
    message: string;
    icon?: string;
    holdDuration?: number;
    onConfirm?: () => void;
    onCancel?: () => void;
    intent?: DialogIntent;
}

/** Options for hold async confirm dialog */
export interface HoldAsyncConfirmOptions {
    title?: string;
    message: string;
    icon?: string;
    holdDuration?: number;
    onAsyncConfirm?: (() => Promise<boolean>) | ((resolve: (success: boolean) => void) => void);
    onCancel?: () => void;
    intent?: DialogIntent;
}

/** Options for alert label */
export interface AlertOptions {
    title?: string;
    message: string;
    icon?: string;
    intent?: DialogIntent;
    okText?: string;
    onOk?: () => void;
}

/** Step definition for multi-step ReadNote */
export interface ReadNoteStep {
    title: string;
    body?: string;
}

/** Options for ReadNote */
export interface ReadNoteOptions {
    title: string;
    subtitle?: string;
    bodyText?: string;
    logoSrc?: string;
    logoIcon?: string;
    uiType?: ReadNoteUiType;
    readType?: ReadNoteReadType;
    progress?: number;
    closeText?: string;
    continueText?: string;
    steps?: ReadNoteStep[];
    onClose?: () => void;
    onContinue?: () => void;
}

/** Toast notification family */
export interface NotifyFamily {
    success: (title: string, message?: string, duration?: number) => string;
    error: (title: string, message?: string, duration?: number) => string;
    warning: (title: string, message?: string, duration?: number) => string;
    info: (title: string, message?: string, duration?: number) => string;
    // Bahasa Indonesia aliases
    sukses: (title: string, message?: string, duration?: number) => string;
    gagal: (title: string, message?: string, duration?: number) => string;
    peringatan: (title: string, message?: string, duration?: number) => string;
    informasi: (title: string, message?: string, duration?: number) => string;
}

/** Dialog family */
export interface DialogFamily {
    confirm: (options: ConfirmOptions) => string;
    async: (options: AsyncConfirmOptions) => string;
    hold: (options: HoldConfirmOptions) => string;
    holdAsync: (options: HoldAsyncConfirmOptions) => string;
    danger: (options: Partial<AsyncConfirmOptions>) => string;
    warning: (options: Partial<ConfirmOptions>) => string;
    info: (options: Partial<ConfirmOptions>) => string;
}

/** Label family */
export interface LabelFamily {
    alert: (options: AlertOptions | string) => string;
    readNote: (options: ReadNoteOptions) => string;
}

/** Main QNotify API — exported as default from api/index.js */
export interface QNotifyAPI {
    notify: NotifyFamily;
    dialog: DialogFamily;
    label: LabelFamily;
    show: (options: ShowOptions) => string;
    dismiss: (id: string) => void;
    dismissReadNote: (id: string) => void;
    setReadNoteProgress: (id: string, percent: number) => void;
    clearAll: () => void;
    setLanguage: (lang: 'id' | 'en') => void;
    // Solver config
    setSolver: (mode: 'analytic' | 'rk4' | 'hybrid') => void;
    setSolverDebug: (enabled: boolean) => void;
    getSolverConfig: () => { mode: string; debug: boolean };
    // Dev tools
    setGlitchAudit: (enabled: boolean) => void;
    enablePerfMonitor: () => void;
    getFPS: () => number;
    getLayerCount: () => number;
    getDeviceCaps: () => { tier: 'full' | 'reduced' | 'minimal' };
}

declare const show: QNotifyAPI;
export default show;
