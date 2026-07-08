// keyboard-shortcuts.js — global shortcuts for the buat-ujian page:
//   Cmd/Ctrl + Enter → publish (step 3) or advance to next step (steps 1-2)
//   Cmd/Ctrl + N     → add a question to the first typed section (step 2 only)
// Reads all state from window.*; no local state of its own.

(function () {
  'use strict';

  const t = (key, vars, fallback) => fallback;

  const KeyboardShortcuts = {
    init() {
      document.addEventListener('keydown', (e) => {
        // Only fire when Cmd (macOS) or Ctrl (everywhere else) is held.
        const mod = e.metaKey || e.ctrlKey;
        if (!mod) return;

        const key = e.key.toLowerCase();

        if (key === 'enter') {
          const wizard = document.getElementById('wizard-view');
          if (!wizard || wizard.hidden) return;
          e.preventDefault();
          e.stopPropagation();
          const currentStep = window.WizardController?._currentStep;
          if (currentStep === 3) {
            window.PublishCard?._publish?.();
          } else {
            window.WizardController?._nextStep?.();
          }
          return;
        }

        if (key === 'n') {
          const wizard = document.getElementById('wizard-view');
          if (!wizard || wizard.hidden) return;
          const currentStep = window.WizardController?._currentStep;
          if (currentStep !== 2) return;
          e.preventDefault();
          e.stopPropagation();
          this._addQuestion();
          return;
        }
      });

      console.info('[KeyboardShortcuts] init — Cmd+Enter (publish / next), Cmd+N (new question)');
    },

    _addQuestion() {
      const state = window.CreateAssessment.getState();
      const sec = state.examData.sections.find((s) => s.type_question);
      if (!sec) {
        window.notify?.warning(
          t('wizard.add_section_first', null, 'Tambah bagian dulu'),
          t('wizard.add_section_first_msg', null, 'Buat bagian dan pilih tipe soal sebelum menambah soal'),
          3000
        );
        return;
      }
      const sIdx = state.examData.sections.indexOf(sec);
      window.SoalEditorModal.open({ mode: 'new', sectionIndex: sIdx, questionType: sec.type_question });
    },
  };

  window.KeyboardShortcuts = KeyboardShortcuts;
})();
