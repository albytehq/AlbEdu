// =============================================================================
// wizard-controller.js — Step navigation + list/wizard view toggle (v0.2.0)
// =============================================================================
// 3 steps:
//   Step 1: Informasi Ujian + Identitas Peserta + Tema Visual (hybrid)
//   Step 2: Soal Ujian (sections + questions)
//   Step 3: Ringkasan & Publish
//
// List view is default. Clicking "Buat Ujian Baru" reveals the wizard view.
// Clicking "Batal" returns to list view. PublishCard._publish() also returns
// to list view after successful publish.
//
// Step navigation rules:
//   - Next validates the CURRENT step before advancing
//   - Prev always allowed (no validation)
//   - Step indicator clicks allow jumping back to completed steps only
//
// Loaded as classic <script defer>. Exposes window.WizardController.
// =============================================================================

(function () {
  'use strict';

  const TOTAL_STEPS = 3;

  // Field-name prefixes that belong to each step (used for partial validation)
  const STEP1_FIELDS = [
    'judul', 'mapel', 'time', 'mode_pembuka', 'identity_mode',
    'identity_fields', 'identity_daftar', 'scheduled_start', 'is_catatan',
  ];
  const STEP2_FIELDS_PREFIXES = ['section[', 'q[', 'sections'];

  const WizardController = {
    init() {
      this._listView = document.getElementById('bu-list-view');
      this._wizardView = document.getElementById('bu-wizard-view');
      this._btnNewExam = document.getElementById('bu-btn-new-exam');
      this._btnCancel = document.getElementById('bu-btn-cancel');
      this._btnPrev = document.getElementById('bu-btn-prev');
      this._btnNext = document.getElementById('bu-btn-next');
      this._btnPublishFinal = document.getElementById('bu-btn-publish-final');
      this._stepContents = [
        document.getElementById('bu-step-1'),
        document.getElementById('bu-step-2'),
        document.getElementById('bu-step-3'),
      ];
      this._stepIndicators = document.querySelectorAll('.bu-step');

      if (!this._wizardView) {
        console.warn('[WizardController] wizard view element missing');
        return;
      }

      this._currentStep = 1;
      this._completedSteps = new Set(); // steps the user has passed via Next

      this._btnNewExam?.addEventListener('click', () => this._openWizard());
      this._btnCancel?.addEventListener('click', () => this._closeWizard());
      this._btnPrev?.addEventListener('click', () => this._prevStep());
      this._btnNext?.addEventListener('click', () => this._nextStep());
      this._btnPublishFinal?.addEventListener('click', () => window.PublishCard?._publish());

      // Step indicator clicks — only allow jumping back to completed steps
      this._stepIndicators.forEach((el) => {
        el.addEventListener('click', () => {
          const step = parseInt(el.dataset.step, 10);
          if (el.dataset.clickable === 'true') {
            this._goToStep(step);
          }
        });
      });
    },

    _openWizard() {
      this._listView.hidden = true;
      this._wizardView.hidden = false;
      this._completedSteps.clear();
      this._goToStep(1);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },

    _closeWizard() {
      // Confirm before discarding
      const doClose = () => {
        this._wizardView.hidden = true;
        this._listView.hidden = false;
        // Refresh list view to show any newly-published exam
        window.ListView?.refresh?.();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      };

      if (window.notify?.confirm) {
        window.notify.confirm({
          title: 'Batalkan pembuatan ujian?',
          message: 'Semua perubahan akan hilang. Yakin batal?',
          intent: 'danger',
          onYes: doClose,
        });
      } else if (confirm('Batalkan pembuatan ujian? Semua perubahan akan hilang.')) {
        doClose();
      }
    },

    _goToStep(step) {
      if (step < 1 || step > TOTAL_STEPS) return;
      this._currentStep = step;

      // Show/hide step content
      this._stepContents.forEach((el, i) => {
        el.hidden = (i + 1) !== step;
      });

      // Update step indicator states
      this._stepIndicators.forEach((el) => {
        const s = parseInt(el.dataset.step, 10);
        el.classList.toggle('bu-step-active', s === step);
        el.classList.toggle('bu-step-complete', this._completedSteps.has(s) && s !== step);
        // Clickable if completed and not current
        el.dataset.clickable = (this._completedSteps.has(s) && s !== step) ? 'true' : 'false';
        el.setAttribute('aria-selected', s === step ? 'true' : 'false');
      });

      // Show/hide footer buttons
      this._btnPrev.hidden = step === 1;
      this._btnNext.hidden = step === TOTAL_STEPS;
      this._btnPublishFinal.hidden = step !== TOTAL_STEPS;

      // Trigger publish card render when entering step 3
      if (step === 3) {
        const state = window.BuatUjian?.getState?.();
        if (state) window.PublishCard?._render?.(state);
      }

      // Auto-generate token when entering step 3 (if not yet generated)
      if (step === 3) {
        if (!window.BuatUjian?.getToken?.()) {
          window.BuatUjian.generateToken();
        }
      }

      window.scrollTo({ top: 0, behavior: 'smooth' });
    },

    _nextStep() {
      if (this._currentStep >= TOTAL_STEPS) return;

      // Validate current step
      const { valid, errors } = window.BuatUjian.validate();
      if (!valid) {
        const stepErrors = this._filterErrorsForStep(errors, this._currentStep);
        if (stepErrors.length) {
          window.notify?.error('Validasi gagal', stepErrors[0].message, 4000);
          return;
        }
      }

      // Mark current step as completed
      this._completedSteps.add(this._currentStep);
      this._goToStep(this._currentStep + 1);
    },

    _prevStep() {
      if (this._currentStep > 1) {
        this._goToStep(this._currentStep - 1);
      }
    },

    _filterErrorsForStep(errors, step) {
      if (step === 1) {
        return errors.filter((e) => STEP1_FIELDS.includes(e.field));
      }
      if (step === 2) {
        return errors.filter((e) =>
          STEP2_FIELDS_PREFIXES.some((p) => e.field === p || e.field.startsWith(p))
        );
      }
      return errors;
    },

    // Public API — allows PublishCard to return to list view after publish
    returnToListView() {
      this._wizardView.hidden = true;
      this._listView.hidden = false;
      this._completedSteps.clear();
      window.ListView?.refresh?.();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
  };

  window.WizardController = WizardController;
})();
