// take-assessment/identity.js — identity form phase. Renders the peserta
// identity form (via IdentityProvider), persists the snapshot to the session
// row on submit, then hands off to the exam runtime.
// MUST load after utils.js and fetch.js, before take-assessment.js.

(function () {
  'use strict';

  const _internal = window.TakeAssessment = window.TakeAssessment || {};
  _internal._internal = _internal._internal || { state: {}, dom: {}, constants: {}, t: null };
  const I = _internal._internal;
  const t = I.t || ((key, vars, fallback) => fallback || key);

  // Render identity phase
  async function _renderIdentity(assessment) {
    _internal._setPhase('identity');

    // Banner
    I.dom.identitySubj.textContent = assessment.subject || 'Asesmen';
    I.dom.identityTitle.textContent = assessment.title || 'Asesmen';

    // Chips
    const chips = [];
    chips.push(`<span class="identity-banner__chip"><span data-albedu-icon="schedule"></span> ${_internal._escAttr(assessment.duration_minutes || 0)} menit</span>`);
    if (assessment.identity_mode === 'daftar') {
      const label = assessment.identity_config?.daftar_label ||
                    assessment.identity_config?.daftar_tipe || 'Daftar Nama';
      chips.push(`<span class="identity-banner__chip"><span data-albedu-icon="format_list_bulleted"></span> ${_internal._escAttr(label)}</span>`);
    } else {
      chips.push(`<span class="identity-banner__chip"><span data-albedu-icon="keyboard"></span> Form Manual</span>`);
    }
    I.dom.identityChips.innerHTML = chips.join('');

    // Note
    if (assessment.note_enabled && assessment.note_text) {
      I.dom.identityNote.hidden = false;
      I.dom.identityNote.innerHTML = _internal._sanitizeHTML(assessment.note_text);
    } else {
      I.dom.identityNote.hidden = true;
    }

    // Bind icons injected via innerHTML
    window.AlbEdu?.bindIcons?.(I.dom.identityChips);

    // Render form via IdentityProvider (async — daftar mode may fetch from DB)
    if (window.IdentityProvider?.render) {
      try {
        await window.IdentityProvider.render(
          I.dom.identityMount,
          assessment,
          (identity) => _internal._onIdentitySubmit(identity),
          null
        );
      } catch (err) {
        console.error('[take] IdentityProvider.render failed:', err);
        window.notify?.error(t('wizard.title_failed', null, 'Gagal'), t('identity.cannot_load_form', null, 'Tidak bisa memuat form identitas. Muat ulang halaman.'));
      }
    } else {
      // Fallback: minimal manual form
      I.dom.identityMount.innerHTML = `
        <div class="albedu-field">
          <label for="fallback-nama">${t('identity.field_name', null, 'Nama Lengkap')} <span class="albedu-required">*</span></label>
          <input id="fallback-nama" type="text" class="albedu-input" maxlength="80" placeholder="${t('identity.field_name_placeholder', null, 'Masukkan nama lengkap')}" />
        </div>
        <button class="albedu-btn albedu-btn-primary" id="fallback-submit" type="button">${t('identity.start_assessment', null, 'Mulai Asesmen')}</button>
      `;
      document.getElementById('fallback-submit').addEventListener('click', () => {
        const nama = document.getElementById('fallback-nama').value.trim();
        if (!nama) return window.notify?.warning(t('wizard.title_warning', null, 'Validasi'), t('identity.field_required', { field: t('identity.field_name', null, 'Nama') }, 'Nama wajib diisi'));
        _internal._onIdentitySubmit({ _mode: 'manual', _display_name: nama, nama });
      });
    }
  }

  // Identity form submit
  async function _onIdentitySubmit(identity) {
    // Validate
    if (window.IdentityProvider?.validate) {
      const cfg = window.IdentityProvider.getIdentityConfig(I.state.assessment);
      const errors = window.IdentityProvider.validate(cfg, identity);
      if (errors.length > 0) {
        window.notify?.error(t('wizard.validation_failed', null, 'Validasi Gagal'), errors[0]);
        return;
      }
    }

    // Sanitize display name (peserta could enter arbitrary name)
    if (identity._display_name) {
      identity._display_name = String(identity._display_name).slice(0, 80).trim();
    }
    if (identity.nama) {
      identity.nama = String(identity.nama).slice(0, 80).trim();
    }

    I.state.identity = identity;

    // Persist identity snapshot to server so a refresh restores to the exam
    // phase instead of re-showing the identity form.
    try {
      const repo = window.AlbEdu?.repository;
      if (repo) {
        await repo.updateDoc('assessment_sessions', I.state.session.id, {
          identity_snapshot: identity,
          updated_at: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.warn('[take] persist identity failed (will retry via heartbeat):', err);
    }

    _internal._startExam(identity, { isResume: false });
  }

  Object.assign(_internal, {
    _renderIdentity,
    _onIdentitySubmit,
  });
})();
