// ═══════════════════════════════════════════════════════════════════════════
//  AlbEduDropdown — Unified custom dropdown component (v1.0.0)
//  --------------------------------------------------------------------------
//  Replaces every native <select> on the AlbEdu platform with a polished,
//  Chrome-default-free dropdown that:
//
//    • Escapes any `overflow:hidden` parent — the options panel is portaled
//      to document.body and positioned via getBoundingClientRect(), so it
//      is NEVER clipped by an ancestor card/modal/scroll-container.
//
//    • Adapts panel height to option count:
//        - 0 options      → "Kosong" empty state
//        - 1–8 options    → natural height, no scroll
//        - 9+ options     → max 280px, scroll, + search field (toggleable)
//
//    • Auto-flips UP when there's no room below the trigger; auto-shifts
//      horizontally when the panel would overflow the right edge.
//
//    • Repositions on scroll/resize (rAF-throttled) — panel stays anchored
//      to the trigger even while the page scrolls.
//
//    • Full keyboard nav: ArrowUp/Down, Home/End, Enter, Escape, Tab,
//      type-ahead (first-character jump).
//
//    • WAI-ARIA combobox pattern: role=combobox, aria-expanded,
//      aria-activedescendant, role=listbox/option, aria-selected.
//
//    • Auto-enhances any <select> with class `albedu-dropdown` on DOM ready.
//      Call AlbEduDropdown.enhance(root) after dynamically inserting selects.
//
//  Public API:
//    new AlbEduDropdown(selectEl, { placeholder, searchable, onChange, ... })
//    AlbEduDropdown.enhance(rootEl?)   → convert all .albedu-dropdown <select> under root
//    instance.setValue(val) / getValue() / setOptions(opts) / clear()
//    instance.disable() / enable() / destroy()
//
//  Dependencies: none (vanilla JS). Optionally consumes Material Symbols
//  icon registry via window.AlbEdu?.bindIcons — falls back to a unicode
//  chevron if icons are unavailable.
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  if (window.AlbEduDropdown) return; // idempotent

  // ── Helpers ──────────────────────────────────────────────────────────────

  function _escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function _escapeAttr(s) {
    return _escapeHtml(s).replace(/`/g, '&#96;');
  }

  function _uid() {
    return 'aedd_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  // Read CSS variable from :root, with fallback
  function _var(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (_) { return fallback; }
  }

  // ── Constants ────────────────────────────────────────────────────────────

  const SCROLL_THRESHOLD = 8;        // > 8 options → scrollable panel
  const SEARCH_THRESHOLD = 10;       // > 10 options → show search input
  const PANEL_MAX_HEIGHT = 280;      // px, when scrollable
  const PANEL_MIN_HEIGHT = 36;       // px, empty state
  const FLIP_MARGIN = 8;             // px gap from viewport edge when flipping
  const PORTAL_Z = 999999;           // above modals (which typically use 9999)

  // ── Component ────────────────────────────────────────────────────────────

  class Dropdown {
    /**
     * @param {HTMLSelectElement|HTMLElement} sourceEl — the <select> to replace
     *   (or a placeholder element that will become the dropdown trigger)
     * @param {Object} opts
     *   - placeholder {string}      — text shown when no value
     *   - searchable {boolean|'auto'} — true / false / 'auto' (default 'auto')
     *   - onChange {fn(value, label, opt)}
     *   - options  {Array<{value,label}>}  — initial options (if sourceEl is not a <select>)
     *   - value    {string}                  — initial value
     *   - disabled {boolean}
     *   - ariaLabel {string}
     *   - name     {string}                  — hidden input name (form submit)
     *   - className {string}                 — extra classes for the wrap
     */
    constructor(sourceEl, opts) {
      if (!sourceEl) throw new Error('AlbEduDropdown: source element required');
      this._opts = Object.assign({
        placeholder: '-- Pilih --',
        searchable: 'auto',
        onChange: null,
        options: null,
        value: '',
        disabled: false,
        ariaLabel: '',
        name: '',
        className: '',
      }, opts || {});

      this._id = _uid();
      this._listeners = [];
      this._isOpen = false;
      this._activeIdx = -1;
      this._rafPos = null;
      this._scrollParents = [];
      this._destroyed = false;

      this._build(sourceEl);
      this._wire();
      this._renderOptions();
      this._syncDisabled();
    }

    // ── Build DOM ──────────────────────────────────────────────────────────

    _build(sourceEl) {
      const isSelect = sourceEl.tagName === 'SELECT';
      const opts = this._opts;

      // Pull options + initial value from <select> if not explicitly provided
      let initialOptions = opts.options;
      let initialValue = opts.value;
      let initialDisabled = opts.disabled;
      let name = opts.name;
      let ariaLabel = opts.ariaLabel;

      if (isSelect) {
        if (!initialOptions) {
          initialOptions = Array.from(sourceEl.options).map(o => ({
            value: o.value,
            label: o.textContent,
          }));
        }
        if (!initialValue && sourceEl.value) initialValue = sourceEl.value;
        if (!initialDisabled) initialDisabled = sourceEl.disabled;
        if (!name) name = sourceEl.name;
        if (!ariaLabel) ariaLabel = sourceEl.getAttribute('aria-label') || sourceEl.title || '';
        // Preserve classes from original select so page-specific selectors still work
        const preservedClasses = sourceEl.className
          .split(/\s+/)
          .filter(c => c && c !== 'albedu-dropdown');
        if (preservedClasses.length) {
          this._opts.className = (this._opts.className + ' ' + preservedClasses.join(' ')).trim();
        }
      }

      this._options = Array.isArray(initialOptions) ? initialOptions.slice() : [];
      this._value = initialValue || '';
      this._disabled = !!initialDisabled;
      this._name = name || '';

      // Wrap (trigger container) — replaces the <select> in the DOM
      const wrap = document.createElement('div');
      wrap.className = 'albedu-dropdown' + (this._opts.className ? ' ' + this._opts.className : '');
      wrap.setAttribute('role', 'combobox');
      wrap.setAttribute('aria-haspopup', 'listbox');
      wrap.setAttribute('aria-expanded', 'false');
      wrap.tabIndex = this._disabled ? -1 : 0;
      if (ariaLabel) wrap.setAttribute('aria-label', ariaLabel);
      wrap.dataset.uid = this._id;

      // Trigger button
      const trigger = document.createElement('div');
      trigger.className = 'albedu-dropdown__trigger';
      trigger.setAttribute('role', 'button');
      trigger.setAttribute('aria-haspopup', 'listbox');
      trigger.setAttribute('aria-expanded', 'false');
      if (ariaLabel) trigger.setAttribute('aria-label', ariaLabel);

      const labelEl = document.createElement('span');
      labelEl.className = 'albedu-dropdown__label';
      labelEl.textContent = opts.placeholder;
      trigger.appendChild(labelEl);

      const arrow = document.createElement('span');
      arrow.className = 'albedu-dropdown__arrow';
      arrow.setAttribute('aria-hidden', 'true');
      arrow.innerHTML = '<span data-albedu-icon="expand_more"></span>';
      trigger.appendChild(arrow);

      wrap.appendChild(trigger);

      // Hidden input — preserves form submission semantics
      if (this._name) {
        const hidden = document.createElement('input');
        hidden.type = 'hidden';
        hidden.name = this._name;
        hidden.className = 'albedu-dropdown__hidden';
        hidden.value = this._value;
        wrap.appendChild(hidden);
        this._hidden = hidden;
      }

      // Portal — appended to <body> on open, detached on close
      const portal = document.createElement('div');
      portal.className = 'albedu-dropdown__portal';
      portal.setAttribute('role', 'listbox');
      portal.setAttribute('aria-label', ariaLabel || opts.placeholder);
      portal.style.zIndex = String(PORTAL_Z);
      portal.hidden = true;

      // Search input (inside portal, above options)
      const search = document.createElement('input');
      search.type = 'search';
      search.className = 'albedu-dropdown__search';
      search.placeholder = 'Cari...';
      search.setAttribute('aria-label', 'Cari opsi');
      search.autocomplete = 'off';
      search.spellcheck = false;
      portal.appendChild(search);

      const list = document.createElement('div');
      list.className = 'albedu-dropdown__list';
      portal.appendChild(list);

      // Stash refs
      this._wrap = wrap;
      this._trigger = trigger;
      this._label = labelEl;
      this._arrow = arrow;
      this._portal = portal;
      this._search = search;
      this._list = list;

      // Insert wrap in place of source element
      if (sourceEl.parentNode) {
        sourceEl.parentNode.insertBefore(wrap, sourceEl);
      }
      // Hide source element (don't remove — it may have IDs/styles page code relies on)
      if (isSelect) {
        sourceEl.style.display = 'none';
        sourceEl.setAttribute('data-albedu-dropdown-bound', this._id);
        this._sourceSelect = sourceEl;
        // Store the instance on the source select element so callers that
        // dynamically update options (e.g. results-analytics.js populating
        // assessments) can call instance.setOptions() instead of setting
        // innerHTML on the hidden select (which wouldn't update the custom
        // dropdown's trigger label or options panel).
        sourceEl._albeduDropdownInstance = this;
        // If source select is NOT in the DOM (e.g. caller created it via
        // document.createElement but hasn't appended yet), attach it inside
        // the wrap so it gets inserted when the wrap is mounted. This keeps
        // form-submission semantics + .value sync working.
        if (!sourceEl.parentNode) {
          wrap.appendChild(sourceEl);
        }
      }

      // Append portal to body (always available, even when closed — keeps event handlers alive)
      document.body.appendChild(portal);

      // Sync label with initial value
      this._syncLabel();
    }

    // ── Event wiring ───────────────────────────────────────────────────────

    _wire() {
      // Trigger click — toggle open
      this._on(this._trigger, 'click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (this._disabled) return;
        this.toggle();
      });

      // Keyboard on wrap (when focused via Tab)
      this._on(this._wrap, 'keydown', (e) => this._onKeydown(e));

      // Click outside → close
      this._on(document, 'click', (e) => {
        if (!this._isOpen) return;
        if (this._wrap.contains(e.target) || this._portal.contains(e.target)) return;
        this.close();
      });

      // Search input
      this._on(this._search, 'input', (e) => {
        this._renderOptions(e.target.value);
        this._activeIdx = -1;
        // First item auto-highlight when searching
        const items = this._list.querySelectorAll('.albedu-dropdown__option:not(.is-hidden)');
        if (items.length > 0) this._setActive(0, false);
      });
      this._on(this._search, 'keydown', (e) => this._onKeydown(e));

      // Reposition on scroll/resize
      this._on(window, 'resize', () => this._scheduleReposition());
      this._on(window, 'scroll', () => this._scheduleReposition(), true);

      // Track scrollable ancestors
      this._cacheScrollParents();
    }

    _on(target, type, fn, opts) {
      target.addEventListener(type, fn, opts);
      this._listeners.push({ target, type, fn, opts });
    }

    _off() {
      this._listeners.forEach(({ target, type, fn, opts }) => {
        try { target.removeEventListener(type, fn, opts); } catch (_) {}
      });
      this._listeners = [];
    }

    _cacheScrollParents() {
      this._scrollParents = [];
      let el = this._wrap.parentNode;
      while (el && el !== document.body) {
        const style = getComputedStyle(el);
        if (/(auto|scroll|overlay)/.test(style.overflow + style.overflowY + style.overflowX)) {
          this._scrollParents.push(el);
        }
        el = el.parentNode;
      }
      // Attach scroll listener to each scroll parent
      this._scrollParents.forEach(p => {
        this._on(p, 'scroll', () => this._scheduleReposition(), { passive: true });
      });
    }

    // ── Render options (filtered by query) ─────────────────────────────────

    _renderOptions(query) {
      const q = (query || '').trim().toLowerCase();
      const list = this._list;
      list.innerHTML = '';

      // Filter
      const visible = this._options.filter(opt => {
        if (!q) return true;
        return String(opt.label || opt.value || '').toLowerCase().includes(q);
      });

      // Empty state
      if (this._options.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'albedu-dropdown__option albedu-dropdown__option--empty';
        empty.textContent = '(Kosong)';
        list.appendChild(empty);
        this._toggleSearch(false);
        return;
      }

      // No matches (when searching)
      if (visible.length === 0) {
        const noMatch = document.createElement('div');
        noMatch.className = 'albedu-dropdown__option albedu-dropdown__option--empty';
        noMatch.textContent = 'Tidak ada yang cocok';
        list.appendChild(noMatch);
        return;
      }

      visible.forEach(opt => {
        const item = document.createElement('div');
        item.className = 'albedu-dropdown__option';
        item.setAttribute('role', 'option');
        item.dataset.value = opt.value;
        const isSelected = opt.value === this._value;
        item.setAttribute('aria-selected', String(isSelected));
        if (isSelected) item.classList.add('is-selected');
        item.textContent = opt.label != null ? opt.label : opt.value;
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          this._select(opt.value, opt.label, opt);
          this.close();
        });
        list.appendChild(item);
      });

      // Smart panel height: natural for short lists, capped + scroll for long
      const needsScroll = this._options.length > SCROLL_THRESHOLD;
      const showSearch = this._resolveSearchable();
      this._toggleSearch(showSearch);

      // Panel max-height only when there are enough options to warrant scroll
      if (needsScroll) {
        this._list.style.maxHeight = PANEL_MAX_HEIGHT + 'px';
        this._list.style.overflowY = 'auto';
      } else {
        this._list.style.maxHeight = '';
        this._list.style.overflowY = '';
      }
    }

    _resolveSearchable() {
      const s = this._opts.searchable;
      if (s === true) return true;
      if (s === false) return false;
      return this._options.length >= SEARCH_THRESHOLD; // 'auto'
    }

    _toggleSearch(show) {
      this._search.style.display = show ? '' : 'none';
      if (!show) {
        // Clear search when hidden so options are not filtered
        if (this._search.value) {
          this._search.value = '';
        }
      }
    }

    // ── Selection ──────────────────────────────────────────────────────────

    _select(value, label, opt) {
      const changed = this._value !== value;
      this._value = value;
      this._syncLabel(label);
      if (this._hidden) this._hidden.value = value;
      // Update aria-selected on rendered options
      this._list.querySelectorAll('.albedu-dropdown__option').forEach(o => {
        const sel = o.dataset.value === value;
        o.setAttribute('aria-selected', String(sel));
        o.classList.toggle('is-selected', sel);
      });
      // Sync native <select> (if any) so legacy page code that reads selectEl.value still works
      if (this._sourceSelect) {
        this._sourceSelect.value = value;
        // Dispatch change event so existing listeners on the <select> fire
        try {
          this._sourceSelect.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (_) { /* IE */ }
      }
      if (changed && typeof this._opts.onChange === 'function') {
        try { this._opts.onChange(value, label, opt); } catch (e) { console.error(e); }
      }
    }

    _syncLabel(forceLabel) {
      if (forceLabel != null) {
        this._label.textContent = forceLabel;
        this._trigger.classList.toggle('is-filled', !!this._value);
        return;
      }
      if (this._value) {
        const opt = this._options.find(o => o.value === this._value);
        this._label.textContent = opt ? (opt.label || opt.value) : this._value;
        this._trigger.classList.add('is-filled');
      } else {
        this._label.textContent = this._opts.placeholder;
        this._trigger.classList.remove('is-filled');
      }
    }

    // ── Open / close ───────────────────────────────────────────────────────

    open() {
      if (this._disabled || this._isOpen) return;
      // Close any other open dropdown
      Dropdown._openInstances.forEach(d => { if (d !== this) d.close(); });
      Dropdown._openInstances.add(this);

      this._isOpen = true;
      this._wrap.classList.add('is-open');
      this._wrap.setAttribute('aria-expanded', 'true');
      this._trigger.setAttribute('aria-expanded', 'true');

      // Re-render options (in case options were updated since last close)
      this._renderOptions();
      this._portal.hidden = false;
      this._portal.classList.add('is-open');

      // Position the portal
      this._position();

      // Focus search (if shown) or first option
      if (this._resolveSearchable()) {
        // Defer focus to next frame so portal layout is settled
        requestAnimationFrame(() => { try { this._search.focus(); } catch (_) {} });
      }

      // Highlight currently selected (or first)
      const items = this._list.querySelectorAll('.albedu-dropdown__option');
      let idx = Array.from(items).findIndex(o => o.dataset.value === this._value);
      if (idx < 0) idx = 0;
      this._setActive(idx, true);
    }

    close() {
      if (!this._isOpen) return;
      this._isOpen = false;
      Dropdown._openInstances.delete(this);
      this._wrap.classList.remove('is-open');
      this._wrap.setAttribute('aria-expanded', 'false');
      this._trigger.setAttribute('aria-expanded', 'false');
      this._portal.classList.remove('is-open');
      // Hide after fade-out animation
      const portal = this._portal;
      setTimeout(() => {
        if (!this._isOpen) portal.hidden = true;
      }, 150);

      // Clear search so next open shows full list
      if (this._search.value) {
        this._search.value = '';
      }

      if (this._rafPos) {
        cancelAnimationFrame(this._rafPos);
        this._rafPos = null;
      }
    }

    toggle() {
      this._isOpen ? this.close() : this.open();
    }

    // ── Position the portal under the trigger ──────────────────────────────

    _position() {
      const trigger = this._trigger;
      const portal = this._portal;
      if (!trigger || !portal) return;

      const rect = trigger.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const scrollY = window.scrollY;
      const scrollX = window.scrollX;

      // Measure portal size (it must be visible to measure — temporarily place it)
      portal.style.visibility = 'hidden';
      portal.style.left = '0px';
      portal.style.top = '0px';
      const pw = portal.offsetWidth;
      const ph = portal.offsetHeight;
      portal.style.visibility = '';

      // Decide flip direction
      const spaceBelow = vh - rect.bottom;
      const spaceAbove = rect.top;
      const openDown = spaceBelow >= ph || spaceBelow >= spaceAbove;

      let top;
      if (openDown) {
        top = rect.bottom + scrollY + 4;
      } else {
        top = rect.top + scrollY - ph - 4;
      }
      portal.classList.toggle('is-flipped-up', !openDown);

      // Horizontal: align left edge with trigger, but shift if overflows right
      let left = rect.left + scrollX;
      if (left + pw > vw - FLIP_MARGIN) {
        left = vw - pw - FLIP_MARGIN + scrollX;
      }
      if (left < FLIP_MARGIN + scrollX) {
        left = FLIP_MARGIN + scrollX;
      }

      // Match width to trigger (min trigger width)
      const width = Math.max(rect.width, 160);
      portal.style.width = width + 'px';
      portal.style.left = left + 'px';
      portal.style.top = top + 'px';
    }

    _scheduleReposition() {
      if (!this._isOpen) return;
      if (this._rafPos) return;
      this._rafPos = requestAnimationFrame(() => {
        this._rafPos = null;
        this._position();
      });
    }

    // ── Keyboard navigation ────────────────────────────────────────────────

    _onKeydown(e) {
      const isOpen = this._isOpen;
      const items = this._list.querySelectorAll('.albedu-dropdown__option:not(.is-hidden)');
      const inSearch = e.target === this._search;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          if (!isOpen) { this.open(); return; }
          if (items.length === 0) return;
          this._setActive(Math.min(this._activeIdx + 1, items.length - 1), true);
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (!isOpen) { this.open(); return; }
          if (items.length === 0) return;
          this._setActive(Math.max(this._activeIdx - 1, 0), true);
          break;
        case 'Home':
          if (isOpen && items.length > 0) {
            e.preventDefault();
            this._setActive(0, true);
          }
          break;
        case 'End':
          if (isOpen && items.length > 0) {
            e.preventDefault();
            this._setActive(items.length - 1, true);
          }
          break;
        case 'Enter':
          if (isOpen && this._activeIdx >= 0 && items[this._activeIdx]) {
            e.preventDefault();
            const el = items[this._activeIdx];
            const opt = this._options.find(o => o.value === el.dataset.value);
            if (opt) {
              this._select(opt.value, opt.label, opt);
              this.close();
              // Return focus to the trigger
              try { this._wrap.focus({ preventScroll: true }); } catch (_) {}
            }
          } else if (!isOpen && !inSearch) {
            e.preventDefault();
            this.open();
          }
          break;
        case 'Escape':
          if (isOpen) {
            e.preventDefault();
            this.close();
            try { this._wrap.focus({ preventScroll: true }); } catch (_) {}
          }
          break;
        case 'Tab':
          if (isOpen) this.close();
          break;
        default:
          // Typeahead: if user types a printable char (not in search), focus search
          if (isOpen && !inSearch && e.key.length === 1 && /[a-zA-Z0-9]/.test(e.key)) {
            try { this._search.focus(); } catch (_) {}
            // Don't preventDefault — let the char land in search
          }
          break;
      }
    }

    _setActive(idx, scrollIntoView) {
      const items = this._list.querySelectorAll('.albedu-dropdown__option:not(.is-hidden)');
      items.forEach((it, i) => {
        const active = i === idx;
        it.classList.toggle('is-active', active);
        if (active) {
          this._wrap.setAttribute('aria-activedescendant', it.dataset.value || '');
          if (scrollIntoView) {
            try { it.scrollIntoView({ block: 'nearest' }); } catch (_) {}
          }
        }
      });
      this._activeIdx = idx;
    }

    // ── Disabled state ─────────────────────────────────────────────────────

    _syncDisabled() {
      this._wrap.classList.toggle('is-disabled', this._disabled);
      this._wrap.setAttribute('aria-disabled', String(this._disabled));
      this._wrap.tabIndex = this._disabled ? -1 : 0;
      if (this._sourceSelect) this._sourceSelect.disabled = this._disabled;
    }

    // ── Public API ─────────────────────────────────────────────────────────

    getValue() { return this._value; }

    setValue(value) {
      const opt = this._options.find(o => o.value === value);
      if (opt) {
        this._select(opt.value, opt.label, opt);
      } else if (value === '') {
        this._select('', this._opts.placeholder, null);
      } else {
        // Value not in options — still set it (caller may add option later)
        this._value = value;
        this._syncLabel(value);
        if (this._hidden) this._hidden.value = value;
        if (this._sourceSelect) this._sourceSelect.value = value;
      }
    }

    setOptions(newOptions, opts) {
      this._options = Array.isArray(newOptions) ? newOptions.slice() : [];
      const preserveValue = opts && opts.preserveValue;
      if (!preserveValue) {
        this._value = '';
        if (this._hidden) this._hidden.value = '';
        this._syncLabel();
      } else {
        // If preserved value no longer exists in new options, clear it
        if (this._value && !this._options.find(o => o.value === this._value)) {
          this._value = '';
          if (this._hidden) this._hidden.value = '';
          this._syncLabel();
        }
      }
      // Re-render if open
      if (this._isOpen) this._renderOptions();
      // Update source <select> options too (for form submission parity)
      if (this._sourceSelect) {
        this._sourceSelect.innerHTML = '';
        this._options.forEach(o => {
          const opt = document.createElement('option');
          opt.value = o.value;
          opt.textContent = o.label != null ? o.label : o.value;
          if (o.value === this._value) opt.selected = true;
          this._sourceSelect.appendChild(opt);
        });
      }
    }

    setPlaceholder(text) {
      this._opts.placeholder = text || '-- Pilih --';
      if (!this._value) this._syncLabel();
    }

    clear() {
      this._value = '';
      if (this._hidden) this._hidden.value = '';
      this._syncLabel();
      if (this._sourceSelect) this._sourceSelect.value = '';
    }

    disable() {
      this._disabled = true;
      this._syncDisabled();
      if (this._isOpen) this.close();
    }

    enable() {
      this._disabled = false;
      this._syncDisabled();
    }

    isDisabled() { return this._disabled; }

    show() { this._wrap.style.display = ''; }
    hide() { this._wrap.style.display = 'none'; if (this._isOpen) this.close(); }

    getElement() { return this._wrap; }
    getTriggerElement() { return this._trigger; }
    getPortalElement() { return this._portal; }

    destroy() {
      if (this._destroyed) return;
      this._destroyed = true;
      this.close();
      this._off();
      Dropdown._openInstances.delete(this);

      // Remove portal
      if (this._portal && this._portal.parentNode) {
        this._portal.parentNode.removeChild(this._portal);
      }
      // Restore native <select> visibility
      if (this._sourceSelect) {
        this._sourceSelect.style.display = '';
        this._sourceSelect.removeAttribute('data-albedu-dropdown-bound');
      }
      // Replace wrap with original select (or remove if there was none)
      if (this._wrap && this._wrap.parentNode) {
        this._wrap.parentNode.removeChild(this._wrap);
      }
      this._wrap = this._trigger = this._label = this._arrow = null;
      this._portal = this._search = this._list = null;
      this._sourceSelect = null;
    }
  }

  // Track open instances for global click-to-close behavior
  Dropdown._openInstances = new Set();

  // ── Static: auto-enhance <select> elements ──────────────────────────────

  Dropdown.enhance = function (root) {
    const scope = root || document;
    if (!scope || !scope.querySelectorAll) return [];
    const selects = scope.querySelectorAll('select.albedu-dropdown:not([data-albedu-dropdown-bound])');
    const instances = [];
    selects.forEach(sel => {
      try {
        instances.push(new Dropdown(sel, {
          placeholder: sel.dataset.placeholder || '-- Pilih --',
          searchable: sel.dataset.searchable === 'true' ? true : (sel.dataset.searchable === 'false' ? false : 'auto'),
          onChange: null, // native change event will fire from source select
          name: sel.name,
          ariaLabel: sel.getAttribute('aria-label') || sel.title || '',
        }));
      } catch (e) {
        console.error('[AlbEduDropdown] enhance failed for', sel, e);
      }
    });
    return instances;
  };

  // Auto-enhance on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      try { Dropdown.enhance(); } catch (e) { console.error('[AlbEduDropdown] auto-enhance failed:', e); }
    });
  } else {
    try { Dropdown.enhance(); } catch (e) { console.error('[AlbEduDropdown] auto-enhance failed:', e); }
  }

  // Watch for dynamically inserted <select class="albedu-dropdown">
  if (typeof MutationObserver !== 'undefined') {
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.tagName === 'SELECT' && node.classList.contains('albedu-dropdown') && !node.hasAttribute('data-albedu-dropdown-bound')) {
            try { Dropdown.enhance(node.parentNode); } catch (_) {}
          } else if (node.querySelectorAll) {
            try { Dropdown.enhance(node); } catch (_) {}
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    Dropdown._observer = observer;
  }

  // Expose
  window.AlbEduDropdown = Dropdown;
  if (window.AlbEdu) window.AlbEdu.Dropdown = Dropdown;
})();
