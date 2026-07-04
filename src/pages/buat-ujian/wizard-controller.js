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

  const t = (key, vars, fallback) => fallback;

  const TOTAL_STEPS = 3;

  // Field-name prefixes that belong to each step (used for partial validation)
  const STEP1_FIELDS = [
    'judul', 'mapel', 'time', 'mode_pembuka', 'identity_mode',
    'identity_fields', 'identity_daftar', 'scheduled_start', 'is_catatan',
  ];
  const STEP2_FIELDS_PREFIXES = ['section[', 'q[', 'sections'];

  const WizardController = {
    init() {
      this._listView = document.getElementById('list-view');
      this._wizardView = document.getElementById('wizard-view');
      this._btnNewExam = document.getElementById('btn-new-assessment');
      this._btnCancel = document.getElementById('btn-cancel');
      this._btnPrev = document.getElementById('btn-prev');
      this._btnNext = document.getElementById('btn-next');
      this._btnPublishFinal = document.getElementById('btn-publish-final');
      this._stepContents = [
        document.getElementById('step-1'),
        document.getElementById('step-2'),
        document.getElementById('step-3'),
      ];
      this._stepIndicators = document.querySelectorAll('.albedu-step');

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
          title: t('wizard.cancel_title', null, 'Batalkan pembuatan ujian?'),
          message: t('wizard.cancel_msg', null, 'Semua perubahan akan hilang. Yakin batal?'),
          intent: 'danger',
          onYes: doClose,
        });
      } else if (confirm(t('wizard.cancel_msg_short', null, 'Batalkan pembuatan ujian? Semua perubahan akan hilang.'))) {
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
        el.classList.toggle('albedu-step-active', s === step);
        el.classList.toggle('albedu-step-complete', this._completedSteps.has(s) && s !== step);
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
        const state = window.CreateAssessment?.getState?.();
        if (state) window.PublishCard?._render?.(state);
      }

      // Auto-generate token when entering step 3 (if not yet generated)
      if (step === 3) {
        if (!window.CreateAssessment?.getToken?.()) {
          window.CreateAssessment.generateToken();
        }
      }

      window.scrollTo({ top: 0, behavior: 'smooth' });
    },

    _nextStep() {
      if (this._currentStep >= TOTAL_STEPS) return;

      // Validate current step
      const { valid, errors } = window.CreateAssessment.validate();
      if (!valid) {
        const stepErrors = this._filterErrorsForStep(errors, this._currentStep);
        if (stepErrors.length) {
          window.notify?.error(t('wizard.validation_failed', null, 'Validasi gagal'), stepErrors[0].message, 4000);
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
