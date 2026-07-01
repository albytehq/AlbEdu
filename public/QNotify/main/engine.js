// engine.js — Qnotify v8.0.5
/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  Qnotify — engine.js v8.0.5                                 ║
 * ║  "Pusat Kontrol — Glitch-Free, Jank-Free, Spike-Free"      ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * v8.0.0 CRITICAL FIXES:
 *  🎭 Backdrop spike lag — prewarmBackdrop() di _init(), GPU layer ready sebelum dialog pertama
 *  🔀 Z-index stacking conflict — unified Z constants dari glitch.js
 *  💥 Layout thrash di activateDialog() — stamp SEBELUM DOM insert, satu forceReflow
 *  🌊 Backdrop transition double-define — dihapus dari critical CSS, hanya di dialog.css
 *  🎬 Triple rAF barrier — lebih reliable di mid-range Android
 */

import { TYPE_ALIAS, SHADOW_TINTS, LIMITS, NOTIFICATION_TYPES, SPAWN, DEFAULT_DURATION, VERSION } from './config.js';
import {
    getText,
    ensureContainer, applyShadowColor,
    createNotifyElement, setupProgressBar,
    updateProgressBarOrientation, removeElement,
    appendToContainer, showBackdrop, hideBackdrop,
} from './render.js';
import {
    animateDesktopEnter, animateDesktopExit,
    animateMobileEnter, animateMobileExit,
    applySpawnShadow, applyDepthShadow, applyExitShadow,
    cancelNotificationSprings, makeShadowBase, updateElementTransform,
    initBumpState, attachBumpEvents, detachBumpEvents,
    attachHoverShadow, detachHoverShadow,
} from './motion.js';
import {
    requestStackingUpdate, recalcAllHeights,
    enforceStackLimits, updateContainerMode,
} from './stack.js';
import { startTimer, clearTimer } from './timer.js';
import {
    createConfirmDialog, createAsyncConfirmDialog,
    createHoldConfirmDialog, createHoldAsyncConfirmDialog,
    animateDialogExit,
} from './dialog.js';
import { createAlertElement, animateAlertEnter, animateAlertExit } from './label.js';
import {
    createReadNoteElement, animateReadNoteEnter, animateReadNoteExit,
    updateReadNoteProgress, wireScrollProgress, advanceReadNoteStep,
} from './Readnote.js';
import {
    loadFonts, injectCriticalCSS, prewarmBackdrop,
    stampInitialState, clearInitialState,
    stampTheme, afterTwoFrames, forceReflow, onResize,
} from './glitch.js';

const INTENT_TITLES = {
    id: { danger: 'Peringatan', warning: 'Perhatian', success: 'Berhasil', info: 'Informasi' },
    en: { danger: 'Warning',    warning: 'Attention', success: 'Success',  info: 'Information' },
};

export class QNotifyEngine {
    constructor(options = {}) {
        this.notifications = new Map();
        this.autoId        = 0;
        this.container     = null;

        this.lang = options.lang || document.documentElement.lang || 'id';
        if (!['id', 'en'].includes(this.lang)) this.lang = 'id';

        // FOUC Guard: CSS harus ada SEBELUM apapun, di constructor bukan lazy
        injectCriticalCSS();

        this._init();

        this.dialog = {
            danger:  (opts) => this.dialogDanger(opts),
            warning: (opts) => this.dialogWarning(opts),
            info:    (opts) => this.dialogInfo(opts),
            main:    (opts) => this._dialogFactory(opts),
        };
    }

    _init() {
        this.container = ensureContainer();
        this._updateMode();
        this._setupResize();
        this._setupMorphCompleteListener();

        // [v8.0.0] Pre-warm backdrop: GPU layer allocated NOW, not on first dialog open.
        // Eliminates the "spike lag" bug where first dialog open was visibly slow.
        prewarmBackdrop();

        // Init banner — styled, informative, once per page load.
        // Disable with: window.__QNOTIFY_SILENT__ = true (before script loads).
        // This is intentional and follows the convention of professional libraries
        // (Axios, Socket.io, Three.js) that announce themselves in the console.
        if (!window.__QNOTIFY_SILENT__) {
            const lang = this.lang === 'id' ? 'Indonesia 🇮🇩' : 'English 🇬🇧';
            // Phase 11 rebrand: QNotify 1.0.5 For AlbEdu
            // eslint-disable-next-line no-console
            console.log(
                `%c QNotify ${VERSION} For AlbEdu %c ${lang} `,
                'background:#1a1a1e;color:#fff;font-weight:700;font-size:11px;border-radius:4px 0 0 4px;padding:2px 6px;',
                'background:#007aff;color:#fff;font-weight:600;font-size:11px;border-radius:0 4px 4px 0;padding:2px 6px;'
            );
        }
    }

    _setupMorphCompleteListener() {
        window.addEventListener('qnotify:morph-complete', (e) => {
            const id = e.detail.id;
            const n  = this.notifications.get(id);
            if (n && !n.isDead) {
                recalcAllHeights(this.notifications);
                requestStackingUpdate(this.notifications);
            }
        });
    }

    _loadFonts() {
        // glitch.loadFonts(): FOIT+FOUT safe, idempotent
        loadFonts();
    }

    _setupResize() {
        // onResize() dari glitch.js: throttled ke satu rAF per resize, tidak jank
        this._unregisterResize = onResize(() => {
            this._updateMode();
            recalcAllHeights(this.notifications);
            requestStackingUpdate(this.notifications);
        });
    }

    _updateMode() {
        const isDesktop = updateContainerMode(this.container, this.notifications);
        this.notifications.forEach(n => {
            if (['confirmation', 'hold', 'hold-async', 'alert'].includes(n.type)) return;
            n.isDesktop  = isDesktop;
            n.shadowBase = makeShadowBase(isDesktop);
            updateProgressBarOrientation(n.element, isDesktop, n.duration);
        });
        requestStackingUpdate(this.notifications, true);
    }

    _makeId(prefix = 'qnotify') {
        return `${prefix}-${Date.now()}-${this.autoId++}`;
    }

    get _isDesktop() {
        return window.innerWidth > LIMITS.MOBILE_BREAKPOINT;
    }

    // ══════════════════════════════════════════════════════════════
    //  SHOW — Anti-Glitch Pipeline:
    //   1. stampTheme()          FOWT prevention
    //   2. stampInitialState()   FOIS + Initial Jump prevention
    //   3. appendToContainer()   DOM insert saat sudah off-screen
    //   4. forceReflow()         lock in initial state
    //   5. afterTwoFrames()      triple-barrier (rAF→rAF→µtask) → Animation Flash prevention
    // ══════════════════════════════════════════════════════════════

    show(options = {}) {
        this._loadFonts();

        const {
            type     = 'info',
            title    = null,
            message  = null,
            duration = DEFAULT_DURATION,
            icon     = null,
        } = options;

        const finalType = TYPE_ALIAS[type] || type;
        const id        = this._makeId('qnotify');
        const isDesktop = this._isDesktop;

        const element = createNotifyElement({
            id, type: finalType, title, message, icon, isDesktop, duration, lang: this.lang,
        });

        // [FOWT] Theme sebelum append
        stampTheme(element, finalType);
        applyShadowColor(element, finalType);
        setupProgressBar(element, duration, isDesktop);

        const notification = {
            id, element, isDead: false, isDesktop,
            createdAt: Date.now(),
            expiresAt: duration > 0 ? Date.now() + duration : Infinity,
            duration, type: finalType, state: 'spawn', depthFactor: 1,
            shadowBase:         makeShadowBase(isDesktop),
            tint:               SHADOW_TINTS[finalType] || SHADOW_TINTS.info,
            dismissTimer:       null,
            height:             null,
            currentTranslateX:  isDesktop ? SPAWN.DESKTOP_TRANSLATE_X : 0,
            currentScale:       isDesktop ? SPAWN.DESKTOP_SCALE : 1,
            currentStackOffset: 0,
        };

        initBumpState(notification);
        applySpawnShadow(notification);

        // [FOIS + Initial Jump] Stamp sebelum append — tidak ada "posisi salah" frame
        if (isDesktop) {
            stampInitialState(element, { translateX: SPAWN.DESKTOP_TRANSLATE_X, scale: SPAWN.DESKTOP_SCALE, opacity: 0, gpuPromote: true });
        } else {
            stampInitialState(element, { translateX: 0, translateY: SPAWN.MOBILE_TRANSLATE_Y, scale: 1, opacity: 0, gpuPromote: true });
        }

        this.notifications.set(id, notification);
        appendToContainer(this.container, element);

        // [Animation Flash] One forceReflow locks the stamped state before triple-barrier.
        forceReflow(element);

        // [Animation Flash] Triple-barrier: rAF1 → rAF2 → microtask → animation starts.
        // Browser needs 2 frames to allocate compositor layer; microtask flushes CSS vars.
        const cancelFrames = afterTwoFrames(() => {
            if (notification.isDead) return;

            element.classList.remove('spawn');

            if (isDesktop) {
                notification.currentTranslateX = 450;
                notification.currentScale      = 0.85;
                updateElementTransform(notification);
                element.style.opacity = '1';
                animateDesktopEnter(notification);
            } else {
                animateMobileEnter(notification);
            }

            notification.state = 'active';

            if (isDesktop) {
                notification.height = element.getBoundingClientRect().height;
            } else {
                notification.height = 78;
            }

            requestStackingUpdate(this.notifications);
            enforceStackLimits(this.notifications, isDesktop, id => this.dismiss(id));
            applyDepthShadow(notification);
            attachBumpEvents(notification);
            attachHoverShadow(notification);
        });

        notification._cancelFrames = cancelFrames;

        if (duration > 0) {
            startTimer(id, duration, id => this.dismiss(id));
        }

        return id;
    }

    // ══════════════════════════════════════════════════════════════
    //  DISMISS
    // ══════════════════════════════════════════════════════════════

    dismiss(id) {
        const n = this.notifications.get(id);
        if (!n || n.isDead) return;

        clearTimer(id);
        n.isDead = true;
        n.state  = 'exit';

        // Batalkan pending frame barrier kalau dismiss sebelum animasi mulai
        if (n._cancelFrames) { n._cancelFrames(); n._cancelFrames = null; }

        detachBumpEvents(n);

        const isModal = ['confirmation', 'hold', 'hold-async', 'alert', 'readnote'].includes(n.type);

        if (isModal) {
            if (n.type === 'readnote') {
                animateReadNoteExit(n.element, () => this._cleanup(id));
                requestStackingUpdate(this.notifications);
                return;
            }

            if (n.type === 'alert') {
                animateAlertExit(n.element, () => this._cleanup(id));
                requestStackingUpdate(this.notifications);
                return;
            }

            const el = n.element;
            el.classList.remove('active', 'layer-1', 'layer-2', 'holding');
            el.classList.add('exit');
            applyExitShadow(n);
            animateDialogExit(el, () => this._cleanup(id));

        } else if (n.isDesktop) {
            animateDesktopExit(n, () => this._cleanup(id));
        } else {
            applyExitShadow(n);
            animateMobileExit(n, () => this._cleanup(id));
        }

        requestStackingUpdate(this.notifications);
    }

    // ══════════════════════════════════════════════════════════════
    //  CLEANUP
    // ══════════════════════════════════════════════════════════════

    _cleanup(id) {
        const n = this.notifications.get(id);
        if (!n) return;

        cancelNotificationSprings(id);

        if (n.bump?.reboundTimeout) {
            clearTimeout(n.bump.reboundTimeout);
            n.bump.reboundTimeout = null;
        }
        if (n._enterTimeout)   { clearTimeout(n._enterTimeout);   n._enterTimeout   = null; }
        if (n._exitOpTimeout)  { clearTimeout(n._exitOpTimeout);  n._exitOpTimeout  = null; }
        if (n._cancelFrames)   { n._cancelFrames();               n._cancelFrames   = null; }
        if (n._cleanupScroll)  { n._cleanupScroll();              n._cleanupScroll  = null; }

        detachHoverShadow(n);

        if (n.handlers?.events) {
            n.handlers.events.forEach(({ el, type, fn, options }) => {
                el.removeEventListener(type, fn, options);
            });
            n.handlers.events = [];
        }

        // [GPU Fix] Bersihkan will-change — hemat compositor memory
        if (n.element) clearInitialState(n.element);

        removeElement(n.element);
        this.notifications.delete(id);

        const anyModal = Array.from(this.notifications.values())
            .some(x => !x.isDead && ['confirmation', 'hold', 'hold-async', 'alert', 'readnote'].includes(x.type));

        if (!anyModal) hideBackdrop();

        requestStackingUpdate(this.notifications);
    }

    clearAll() {
        Array.from(this.notifications.keys()).forEach(id => this.dismiss(id));
    }

    // ══════════════════════════════════════════════════════════════
    //  ALERT — Anti-Glitch pipeline sama dengan show()
    // ══════════════════════════════════════════════════════════════

    alert(options) {
        this._loadFonts();

        const {
            title, message, icon, intent = 'info', okText, onOk,
        } = typeof options === 'string'
            ? { title: options, message: arguments[1], intent: arguments[2] || 'info' }
            : (options || {});

        const id        = this._makeId('qnotify-alert');
        const lang      = this.lang;
        const isDesktop = this._isDesktop;

        const titleMap     = INTENT_TITLES[lang] || INTENT_TITLES.id;
        const finalTitle   = title   || titleMap[intent] || titleMap.info;
        const finalMessage = message || '';

        const element = createAlertElement({ id, title: finalTitle, message: finalMessage, icon, lang, intent, okText });

        // [FOWT] Theme sebelum append
        // WHY: label.css intent selectors use .danger (not .error) for red accent vars.
        // stampTheme preserves .danger class; only applyShadowColor maps to SHADOW_TINTS['error'].
        stampTheme(element, intent);
        applyShadowColor(element, intent === 'danger' ? 'error' : intent);

        // [v7.5.0 FOIS Fix — Alert Special Case]
        // label-alert uses position:fixed + left:50% + top:50% + translate(-50%,-50%).
        // stampInitialState({ scale:0.88 }) produces "scale(0.88)" which REMOVES the
        // centering translate — element appears at top-left.
        // FIX: CSS .spawn { visibility:hidden } = FOUC guard.
        //      JS only sets will-change for GPU layer.
        //      animateAlertEnter() spring jump(0.88) is the animation start ground truth.
        element.style.willChange = 'transform, opacity';

        const notification = {
            id, element, isDead: false, type: 'alert', isDesktop, state: 'spawn', handlers: null,
        };

        showBackdrop();
        // [D2] Alert goes directly to body — must NOT be inside #qnotify-container.
        // container has z-index:10000 + isolation:isolate = new stacking context.
        // backdrop z-index:10001 is at body level → would cover everything inside container.
        // Direct body append = alert z-index:10002 competes in body context → dialog wins.
        document.body.appendChild(element);
        forceReflow(element);

        const cancelFrames = afterTwoFrames(() => {
            if (notification.isDead) return;
            element.classList.remove('spawn');
            element.classList.add('active');

            animateAlertEnter(element, () => {
                if (!notification.isDead) {
                    const focusBtn = element.querySelector('.alert-btn.ok');
                    if (focusBtn) focusBtn.focus();
                }
            });
        });

        notification._cancelFrames = cancelFrames;

        const events = [];
        const okBtn  = element.querySelector('.alert-btn.ok');
        let _clicked = false;

        const handleOk = (e) => {
            e.stopPropagation();
            if (notification.isDead || _clicked) return;
            _clicked = true;
            if (okBtn) { okBtn.disabled = true; okBtn.setAttribute('data-locked', 'true'); }
            if (onOk) { try { onOk(); } catch (_) { /* user callback errors are swallowed */ } }
            this.dismiss(id);
        };

        let _keyPending = false;
        const handleKeydown = (e) => {
            if (notification.isDead || _clicked || _keyPending) return;
            _keyPending = true;
            requestAnimationFrame(() => { _keyPending = false; });

            if (e.key === 'Escape')  { e.preventDefault(); e.stopPropagation(); _clicked = true; this.dismiss(id); return; }
            if (e.key === 'Enter' && document.activeElement === okBtn) { e.preventDefault(); handleOk(e); return; }
            if (e.key === 'Tab')     { e.preventDefault(); if (okBtn) okBtn.focus(); }
        };

        const backdrop = document.getElementById('qnotify-backdrop');
        const handleBackdropClick = (e) => {
            if (notification.isDead || _clicked) return;
            if (e.target === backdrop) { _clicked = true; this.dismiss(id); }
        };

        if (okBtn)   { okBtn.addEventListener('click', handleOk); events.push({ el: okBtn, type: 'click', fn: handleOk }); }
        document.addEventListener('keydown', handleKeydown);
        events.push({ el: document, type: 'keydown', fn: handleKeydown });

        if (backdrop) {
            backdrop.addEventListener('click', handleBackdropClick);
            events.push({ el: backdrop, type: 'click', fn: handleBackdropClick });
        }

        notification.handlers = { events };
        this.notifications.set(id, notification);
        return id;
    }

    // ══════════════════════════════════════════════════════════════
    //  CONFIRM / ASYNC CONFIRM / HOLD / HOLD ASYNC
    // ══════════════════════════════════════════════════════════════

    confirm({ title, message, icon, onYes, onNo, intent = 'info' } = {}) {
        this._loadFonts();
        const id = this._makeId('qnotify-confirm');
        const n  = createConfirmDialog({
            id, container: document.body, lang: this.lang, isDesktop: this._isDesktop,
            title, message, icon, onYes, onNo, dismissFn: id => this.dismiss(id), intent,
        });
        this.notifications.set(id, n);
        if (n.element && !['confirmation', 'hold', 'hold-async'].includes(n.type)) {
            initBumpState(n);
            requestAnimationFrame(() => attachBumpEvents(n));
        }
        return id;
    }

    asyncConfirm({ title, message, icon, onAsyncYes, onAsyncNo, intent = 'info' } = {}) {
        this._loadFonts();
        const id = this._makeId('qnotify-async');
        const n  = createAsyncConfirmDialog({
            id, container: document.body, lang: this.lang, isDesktop: this._isDesktop,
            title, message, icon, onAsyncYes, onAsyncNo, dismissFn: id => this.dismiss(id), intent,
        });
        this.notifications.set(id, n);
        if (n.element && !['confirmation', 'hold', 'hold-async'].includes(n.type)) {
            initBumpState(n);
            requestAnimationFrame(() => attachBumpEvents(n));
        }
        return id;
    }

    holdConfirm({ title, message, icon, holdDuration, onConfirm, onCancel, intent = 'warning' } = {}) {
        this._loadFonts();
        const id = this._makeId('qnotify-hold');
        const n  = createHoldConfirmDialog({
            id, container: document.body, lang: this.lang, isDesktop: this._isDesktop,
            title, message, icon, holdDuration, onConfirm, onCancel,
            dismissFn: id => this.dismiss(id), intent,
        });
        this.notifications.set(id, n);
        if (n.element && !['confirmation', 'hold', 'hold-async'].includes(n.type)) {
            initBumpState(n);
            requestAnimationFrame(() => attachBumpEvents(n));
        }
        return id;
    }

    holdConfirmAsync({ title, message, icon, holdDuration, onAsyncConfirm, onCancel, intent = 'warning' } = {}) {
        this._loadFonts();
        const id = this._makeId('qnotify-hold-async');
        const n  = createHoldAsyncConfirmDialog({
            id, container: document.body, lang: this.lang, isDesktop: this._isDesktop,
            title, message, icon, holdDuration, onAsyncConfirm, onCancel,
            dismissFn: id => this.dismiss(id), intent,
        });
        this.notifications.set(id, n);
        if (n.element && !['confirmation', 'hold', 'hold-async'].includes(n.type)) {
            initBumpState(n);
            requestAnimationFrame(() => attachBumpEvents(n));
        }
        return id;
    }

    // ══════════════════════════════════════════════════════════════
    //  READ NOTE
    // ══════════════════════════════════════════════════════════════

    readNote(options = {}) {
        this._loadFonts();

        const {
            title = '', subtitle, bodyText, logoSrc, logoIcon = 'article',
            uiType = 'default', readType = 'required', progress,
            closeText, continueText, onClose, onContinue, steps,
        } = options;

        const id        = this._makeId('qnotify-readnote');
        const isDesktop = this._isDesktop;
        const hasSteps  = Array.isArray(steps) && steps.length > 1;

        const element = createReadNoteElement({
            id, title, subtitle, bodyText, logoSrc, logoIcon,
            uiType, readType, progress, lang: this.lang, closeText, continueText, steps,
        });

        // [v7.5.0 FOIS Fix — ReadNote Special Case]
        // .rn-card uses position:fixed + left:50% + top:50% + translate(-50%,-50%).
        // stampInitialState() would overwrite this centering with translate(0,60px) scale(0.97).
        // FIX: CSS .label-readnote.spawn .rn-card { visibility:hidden } = FOUC guard.
        //      will-change set manually for GPU layer.
        //      animateReadNoteEnter() spring jumps (scaleSpring=0.97, txYSpring=60) are ground truth.
        element.style.willChange = 'transform, opacity';

        const notification = {
            id, element, isDead: false, type: 'readnote', isDesktop, state: 'spawn', handlers: null,
        };

        // [D2] ReadNote goes directly to body — same stacking context fix as dialog/alert.
        document.body.appendChild(element);
        forceReflow(element);

        const cancelFrames = afterTwoFrames(() => {
            if (notification.isDead) return;
            element.classList.remove('spawn');
            animateReadNoteEnter(element, uiType, () => {
                if (notification.isDead) return;
                element.classList.add('active');
                notification.state = 'active';
            });
        });

        notification._cancelFrames = cancelFrames;

        const events = [];
        let _closed = false;

        const doClose = () => {
            if (notification.isDead || _closed) return;
            _closed = true;
            if (onClose) { try { onClose(); } catch (_) { /* user callback errors are swallowed */ } }
            this.dismissReadNote(id);
        };

        const doContn = () => {
            if (notification.isDead || _closed) return;
            if (hasSteps) {
                const currentIdx = element._rnStepIdx || 0;
                const nextIdx    = currentIdx + 1;
                if (nextIdx < steps.length) {
                    advanceReadNoteStep(element, nextIdx, () => {
                        _closed = true;
                        if (onContinue) { try { onContinue(); } catch (e) {} }
                        this.dismissReadNote(id);
                    });
                    return;
                }
            }
            _closed = true;
            if (onContinue) { try { onContinue(); } catch (e) {} }
            this.dismissReadNote(id);
        };

        const closeBtn = element.querySelector('.rn-close-btn');
        if (closeBtn) { closeBtn.addEventListener('click', doClose); events.push({ el: closeBtn, type: 'click', fn: doClose }); }

        const contBtn = element.querySelector('.rn-continue-btn');
        if (contBtn)  { contBtn.addEventListener('click', doContn); events.push({ el: contBtn, type: 'click', fn: doContn }); }

        const backdrop = element.querySelector('.rn-backdrop');
        if (backdrop)  { backdrop.addEventListener('click', doClose); events.push({ el: backdrop, type: 'click', fn: doClose }); }

        const handleKey = (e) => {
            if (notification.isDead || _closed) return;
            if (e.key === 'Escape') { e.preventDefault(); doClose(); }
        };
        document.addEventListener('keydown', handleKey);
        events.push({ el: document, type: 'keydown', fn: handleKey });

        let _cleanupScroll = null;
        if (!hasSteps && readType === 'required' && bodyText) {
            afterTwoFrames(() => {
                if (!notification.isDead) _cleanupScroll = wireScrollProgress(id, this.lang);
            });
        }

        notification.handlers = { events };
        notification._cleanupScroll = () => { if (_cleanupScroll) _cleanupScroll(); };
        this.notifications.set(id, notification);
        return id;
    }

    dismissReadNote(id) {
        const n = this.notifications.get(id);
        if (!n || n.isDead || n.type !== 'readnote') return;
        n.isDead = true; n.state = 'exit';
        if (n._cancelFrames) { n._cancelFrames(); n._cancelFrames = null; }
        animateReadNoteExit(n.element, () => this._cleanup(id));
    }

    setReadNoteProgress(id, percent) { updateReadNoteProgress(id, percent); }

    setLanguage(lang) {
        if (!['id', 'en'].includes(lang)) return;
        this.lang = lang;

    }

    _dialogFactory(options) {
        const {
            intent = 'info', mechanic, title, message, icon,
            onYes, onNo, onAsyncYes, onAsyncNo, onConfirm, onCancel, onAsyncConfirm,
        } = options;

        const defaultMechanic = { danger: 'hold-async', warning: 'confirm', info: 'confirm' };
        const finalMechanic   = mechanic || defaultMechanic[intent] || 'confirm';

        // [BUG FIX v7.5.1] NOTIFICATION_TYPES tidak punya key 'danger' — hanya 'error'.
        // Sebelumnya intentConfig bisa undefined kalau intent='danger', menyebabkan
        // getText(undefined.title) crash. Map 'danger' → 'error' SEBELUM lookup.
        const typeKey    = intent === 'danger' ? 'error' : intent;
        const intentConfig = NOTIFICATION_TYPES[typeKey] || NOTIFICATION_TYPES.info;

        const finalTitle   = title   || getText(intentConfig.title, this.lang);
        const finalMessage = message || getText(intentConfig.msg,   this.lang);
        const finalIcon    = icon    || intentConfig.icon;

        switch (finalMechanic) {
            case 'confirm':    return this.confirm({ title: finalTitle, message: finalMessage, icon: finalIcon, onYes, onNo, intent });
            case 'async':      return this.asyncConfirm({ title: finalTitle, message: finalMessage, icon: finalIcon, onAsyncYes, onAsyncNo, intent });
            case 'hold':       return this.holdConfirm({ title: finalTitle, message: finalMessage, icon: finalIcon, onConfirm, onCancel, intent });
            case 'hold-async': return this.holdConfirmAsync({ title: finalTitle, message: finalMessage, icon: finalIcon, onAsyncConfirm, onCancel, intent });
            default:
                // Unknown mechanic: silently fall through to confirm. Dev audit tool can surface this.
                return this.confirm({ title: finalTitle, message: finalMessage, icon: finalIcon, onYes, onNo, intent });
        }
    }

    dialogDanger(options)  { return this._dialogFactory({ ...options, intent: 'danger'  }); }
    dialogWarning(options) { return this._dialogFactory({ ...options, intent: 'warning' }); }
    dialogInfo(options)    { return this._dialogFactory({ ...options, intent: 'info'    }); }
}
