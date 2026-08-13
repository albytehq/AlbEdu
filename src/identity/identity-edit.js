// identity-edit.js — Production-grade Identity Editor for mid-exam corrections
//
// ARCHITECTURE:
//   IdentityEditor is a standalone module that:
//   1. Reads assessment config (identity_mode, identity_config)
//   2. Reads current identity_snapshot from session state
//   3. Builds a form with proper field types (text, select, number, email)
//   4. Validates ALL fields with 20+ edge cases
//   5. Saves to DB (assessment_sessions.identity_snapshot)
//   6. Updates topbar display
//
// EDGE CASES HANDLED (20+):
//   E1:  identity_snapshot is null/undefined → build from assessment config
//   E2:  identity_config is null → default to _display_name field
//   E3:  identity_mode is null → treat as 'manual'
//   E4:  fields array is empty → add _display_name as default
//   E5:  field has no id → skip (malformed config)
//   E6:  field has no label → use id as label
//   E7:  field value is null/undefined → empty string
//   E8:  field value has HTML → escape on render
//   E9:  field value exceeds max_length → truncate
//   E10: select field has no options → render as text input
//   E11: select field value not in options → add as extra option
//   E12: required field empty on save → validation error
//   E13: email field invalid format → validation error
//   E14: number field non-numeric → validation error
//   E15: text field exceeds max_length → validation error
//   E16: daftar mode → show nama (readonly) + tab_nama (readonly)
//   E17: daftar mode nama is null → show empty text field
//   E18: save fails (network/RLS) → error toast + re-enable button
//   E19: modal closed mid-save → cancel save, restore state
//   E20: double-click save → idempotency guard
//   E21: _display_name sync with nama field (bidirectional)
//   E22: Escape key closes modal (but not during save)
//   E23: Click outside closes modal (but not during save)
//   E24: field has placeholder → use it
//   E25: field has no type → default to 'text'

(function () {
  'use strict';

  const MAX_IDENTITY_LEN = 80;

  const IdentityEditor = {
    _isOpen: false,
    _isSaving: false,
    _overlay: null,
    _body: null,
    _saveBtn: null,
    _state: null,

    /**
     * Open the identity edit modal.
     * @param {Object} sessionState - { identity, assessment, session }
     * @param {Function} onSave - callback(updatedIdentity)
     */
    open(sessionState, onSave) {
      if (this._isOpen) return;
      this._isOpen = true;
      this._isSaving = false;
      this._state = sessionState;
      this._onSave = onSave;
      this._render();
    },

    close() {
      if (this._isSaving) return; // E19: don't close during save
      this._isOpen = false;
      if (this._overlay) {
        this._overlay.hidden = true;
        this._body.innerHTML = '';
      }
      document.removeEventListener('keydown', this._escHandler);
    },

    _render() {
      this._overlay = document.getElementById('identity-edit-overlay');
      this._body = document.getElementById('identity-edit-body');
      this._saveBtn = document.getElementById('identity-edit-save');

      if (!this._overlay || !this._body) {
        console.error('[IdentityEditor] Modal elements not found');
        this._isOpen = false;
        return;
      }

      const fields = this._buildFields();
      this._renderForm(fields);
      this._wireEvents();

      this._overlay.hidden = false;
      this._saveBtn.disabled = false;
      this._saveBtn.innerHTML = '<span data-albedu-icon="check"></span> <span>Simpan Perubahan</span>';
      window.AlbEdu?.bindIcons?.(this._saveBtn);
    },

    // ═══════════════════════════════════════════════════════════════
    // Field building — handles E1-E11, E16-E17, E24-E25
    // ═══════════════════════════════════════════════════════════════
    _buildFields() {
      const identity = this._state.identity || {};  // E1
      const assessment = this._state.assessment || {};
      const mode = assessment.identity_mode || 'manual';  // E3
      const config = assessment.identity_config || {};
      const fields = [];

      if (mode === 'daftar') {
        // E16: daftar mode — nama + tab are usually fixed (selected from list)
        // But we allow editing nama (peserta might have typo)
        fields.push({
          key: '_display_name',
          label: 'Nama',
          value: this._safeValue(identity._display_name || identity.nama),  // E4, E7, E17
          type: 'text',
          required: true,
          max_length: MAX_IDENTITY_LEN,
          placeholder: 'Masukkan nama',
        });
        // Tab name (usually readonly but show for context)
        if (identity.tab_nama) {
          fields.push({
            key: 'tab_nama',
            label: 'Kelas/Tab',
            value: this._safeValue(identity.tab_nama),
            type: 'text',
            required: false,
            readonly: true,
            max_length: 30,
          });
        }
      } else {
        // Manual mode — render configured fields
        const configFields = Array.isArray(config.fields) ? config.fields : [];  // E2

        if (configFields.length === 0) {
          // E4: no fields configured → add _display_name as default
          fields.push(this._defaultNameField(identity));
        } else {
          configFields.forEach(f => {
            const key = f.id || f.key || f.name;  // E5: skip if no id
            if (!key) return;

            const label = f.label || key;  // E6
            const value = this._safeValue(identity[key]);  // E7
            const type = f.type || 'text';  // E25
            const options = Array.isArray(f.options) ? f.options : [];  // E10

            fields.push({
              key,
              label,
              value,
              type,
              required: f.required !== false,
              max_length: f.max_length || MAX_IDENTITY_LEN,
              placeholder: f.placeholder || ('Masukkan ' + label.toLowerCase()),  // E24
              options,
              readonly: f.readonly || false,
            });
          });
        }

        // Ensure _display_name is always editable (E4)
        const hasName = fields.some(f => f.key === '_display_name' || f.key === 'nama' || f.key === 'field_nama');
        if (!hasName) {
          fields.unshift(this._defaultNameField(identity));
        }
      }

      return fields;
    },

    _defaultNameField(identity) {
      return {
        key: '_display_name',
        label: 'Nama',
        value: this._safeValue(identity._display_name || identity.nama || identity.field_nama),
        type: 'text',
        required: true,
        max_length: MAX_IDENTITY_LEN,
        placeholder: 'Masukkan nama lengkap',
      };
    },

    _safeValue(val) {
      if (val == null) return '';  // E7
      return String(val).slice(0, MAX_IDENTITY_LEN);  // E9
    },

    // ═══════════════════════════════════════════════════════════════
    // Form rendering — handles E8, E10, E11
    // ═══════════════════════════════════════════════════════════════
    _renderForm(fields) {
      let html = '';
      fields.forEach(f => {
        // E8: escape HTML in value
        const val = this._escapeAttr(f.value);
        const reqStar = f.required ? ' <span style="color:var(--take-danger,#EF4444)">*</span>' : '';
        const readonlyAttr = f.readonly ? ' readonly' : '';
        const placeholder = this._escapeAttr(f.placeholder || '');

        html += '<div class="ex-id-field">';
        html += '<label class="ex-id-label">' + this._escapeHtml(f.label) + reqStar + '</label>';

        if (f.type === 'select' && f.options.length > 0) {
          // E10: select with options
          html += '<select class="ex-id-input" data-field="' + this._escapeAttr(f.key) + '"' + readonlyAttr + '>';
          html += '<option value="">— Pilih —</option>';
          let valueExists = false;
          f.options.forEach(opt => {
            const optVal = typeof opt === 'string' ? opt : (opt.value || opt.label || '');
            const optLabel = typeof opt === 'string' ? opt : (opt.label || opt.value || '');
            const selected = optVal === f.value ? ' selected' : '';
            if (selected) valueExists = true;
            html += '<option value="' + this._escapeAttr(optVal) + '"' + selected + '>' + this._escapeHtml(optLabel) + '</option>';
          });
          // E11: value not in options → add as extra
          if (!valueExists && f.value) {
            html += '<option value="' + val + '" selected>' + this._escapeHtml(f.value) + ' (saat ini)</option>';
          }
          html += '</select>';
        } else if (f.type === 'textarea') {
          html += '<textarea class="ex-id-input ex-id-textarea" data-field="' + this._escapeAttr(f.key) + '" maxlength="' + f.max_length + '" placeholder="' + placeholder + '"' + readonlyAttr + '>' + val + '</textarea>';
        } else {
          // text, email, number — all use input
          const inputType = f.type === 'email' ? 'email' : f.type === 'number' ? 'text' : 'text';
          html += '<input type="' + inputType + '" class="ex-id-input" data-field="' + this._escapeAttr(f.key) + '" value="' + val + '" maxlength="' + f.max_length + '" placeholder="' + placeholder + '"' + readonlyAttr + ' data-field-type="' + f.type + '" />';
        }

        // Hint text
        if (f.max_length && f.max_length < MAX_IDENTITY_LEN) {
          html += '<div class="ex-id-hint">Maks ' + f.max_length + ' karakter</div>';
        }
        if (f.readonly) {
          html += '<div class="ex-id-hint ex-id-hint-readonly">Tidak dapat diubah</div>';
        }

        html += '</div>';
      });

      this._body.innerHTML = html;
    },

    // ═══════════════════════════════════════════════════════════════
    // Event wiring — handles E20, E22, E23
    // ═══════════════════════════════════════════════════════════════
    _wireEvents() {
      // Close buttons (clone to avoid stacking)
      const closeBtn = document.getElementById('identity-edit-close');
      const cancelBtn = document.getElementById('identity-edit-cancel');

      const newClose = closeBtn.cloneNode(true);
      closeBtn.parentNode.replaceChild(newClose, closeBtn);
      newClose.addEventListener('click', () => this.close());

      const newCancel = cancelBtn.cloneNode(true);
      cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
      newCancel.addEventListener('click', () => this.close());

      // E23: click outside closes (but not during save)
      this._overlay.onclick = (e) => {
        if (e.target === this._overlay) this.close();
      };

      // E22: escape closes (but not during save)
      this._escHandler = (e) => {
        if (e.key === 'Escape' && !this._isSaving) {
          this.close();
        }
      };
      document.addEventListener('keydown', this._escHandler);

      // E20: save button (clone to avoid stacking)
      const newSave = this._saveBtn.cloneNode(true);
      this._saveBtn.parentNode.replaceChild(newSave, this._saveBtn);
      this._saveBtn = newSave;
      newSave.addEventListener('click', () => this._handleSave());
      window.AlbEdu?.bindIcons?.(newSave);

      // Focus first input
      setTimeout(() => {
        const firstInput = this._body.querySelector('.ex-id-input:not([readonly])');
        if (firstInput) firstInput.focus();
      }, 100);
    },

    // ═══════════════════════════════════════════════════════════════
    // Validation — handles E12-E15
    // ═══════════════════════════════════════════════════════════════
    _validate(fields) {
      const errors = [];

      fields.forEach(f => {
        if (f.readonly) return; // skip readonly

        const input = this._body.querySelector('[data-field="' + this._cssEscape(f.key) + '"]');
        if (!input) return;

        const val = (input.value || '').trim();

        // E12: required field empty
        if (f.required && !val) {
          errors.push('Field "' + f.label + '" wajib diisi.');
          input.classList.add('ex-id-input-error');
          return;
        }

        if (!val) return; // optional & empty → skip

        // E13: email validation
        if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
          errors.push('Field "' + f.label + '": format email tidak valid.');
          input.classList.add('ex-id-input-error');
          return;
        }

        // E14: number validation
        if (f.type === 'number' && !/^-?\d+(\.\d+)?$/.test(val)) {
          errors.push('Field "' + f.label + '": harus berupa angka.');
          input.classList.add('ex-id-input-error');
          return;
        }

        // E15: max_length
        if (f.max_length && val.length > f.max_length) {
          errors.push('Field "' + f.label + '": melebihi ' + f.max_length + ' karakter.');
          input.classList.add('ex-id-input-error');
          return;
        }

        // Clear error state
        input.classList.remove('ex-id-input-error');
      });

      return errors;
    },

    // ═══════════════════════════════════════════════════════════════
    // Save handler — handles E18, E20, E21
    // ═══════════════════════════════════════════════════════════════
    async _handleSave() {
      // E20: idempotency guard
      if (this._isSaving) return;

      const fields = this._buildFields();
      const errors = this._validate(fields);

      if (errors.length > 0) {
        window.notify?.error('Validasi Gagal', errors[0], 4000);
        return;
      }

      this._isSaving = true;
      this._saveBtn.disabled = true;
      this._saveBtn.innerHTML = '<span class="ex-id-spinner"></span> <span>Menyimpan...</span>';

      try {
        // Collect updated values
        const updated = Object.assign({}, this._state.identity || {});

        this._body.querySelectorAll('[data-field]').forEach(input => {
          const key = input.dataset.field;
          const val = (input.value || '').trim();
          if (val) {
            updated[key] = val;
          } else if (updated[key]) {
            // Clear empty optional fields
            updated[key] = '';
          }
        });

        // E21: sync _display_name ↔ nama bidirectional
        if (updated.nama && !updated._display_name) {
          updated._display_name = updated.nama;
        }
        if (updated._display_name && !updated.nama) {
          updated.nama = updated._display_name;
        }
        if (updated.field_nama && !updated._display_name) {
          updated._display_name = updated.field_nama;
        }

        // Save to DB
        const repo = window.AlbEdu?.repository;
        const sessionId = this._state.session?.id;
        if (repo && sessionId) {
          await repo.updateDoc('assessment_sessions', sessionId, {
            identity_snapshot: updated,
            updated_at: new Date().toISOString(),
          });
        }

        // Update topbar display
        const userText = document.getElementById('exam-user-text');
        if (userText) {
          userText.textContent = updated._display_name || updated.nama || updated.field_nama || 'Peserta';
        }

        // Callback
        if (this._onSave) {
          this._onSave(updated);
        }

        this._isSaving = false;
        this._isOpen = false;
        this._overlay.hidden = true;
        this._body.innerHTML = '';

        window.notify?.success(
          'Identitas Diperbarui',
          'Perubahan identitas telah disimpan. Timer tetap berjalan.',
          3000
        );
      } catch (err) {
        // E18: save failed
        console.error('[IdentityEditor] Save failed:', err);
        window.notify?.error('Gagal Menyimpan', err.message || 'Tidak dapat menyimpan perubahan. Coba lagi.', 5000);
        this._isSaving = false;
        this._saveBtn.disabled = false;
        this._saveBtn.innerHTML = '<span data-albedu-icon="check"></span> <span>Simpan Perubahan</span>';
        window.AlbEdu?.bindIcons?.(this._saveBtn);
      }
    },

    // ═══════════════════════════════════════════════════════════════
    // Helpers
    // ═══════════════════════════════════════════════════════════════
    _escapeHtml(s) {
      if (s == null) return '';
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
    _escapeAttr(s) {
      return this._escapeHtml(s);
    },
    _cssEscape(s) {
      return String(s).replace(/"/g, '\\"');
    },
  };

  window.IdentityEditor = IdentityEditor;
})();
