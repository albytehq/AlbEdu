// =============================================================================
// keyboard-shortcuts.js — Global shortcuts for Buat Ujian (v0.2.0)
//   Cmd/Ctrl + Enter  → publish exam to Supabase (only fires in wizard view)
//   Cmd/Ctrl + N      → open "add question" modal on first typed section
// Loaded as classic <script defer>. No external state — reads from window.*.
// =============================================================================

(function () {
  'use strict';

  const KeyboardShortcuts = {
    init() {
      document.addEventListener('keydown', (e) => {
        // Only fire when modifier (Cmd on macOS, Ctrl elsewhere) is held
        const mod = e.metaKey || e.ctrlKey;
        if (!mod) return;

        const key = e.key.toLowerCase();

        if (key === 'enter') {
          // Only fire if wizard view is visible
          const wizard = document.getElementById('wizard-view');
          if (!wizard || wizard.hidden) return;
          e.preventDefault();
          e.stopPropagation();
          // If on step 3 → publish; else → next step
          const currentStep = window.WizardController?._currentStep;
          if (currentStep === 3) {
            window.PublishCard?._publish?.();
          } else {
            window.WizardController?._nextStep?.();
          }
          return;
        }

        if (key === 'n') {
          // Only fire if wizard view is on step 2 (soal)
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
        window.notify?.warning('Tambah bagian dulu', 'Buat bagian dan pilih tipe soal sebelum menambah soal', 3000);
        return;
      }
      const sIdx = state.examData.sections.indexOf(sec);
      window.SoalEditorModal.open({ mode: 'new', sectionIndex: sIdx, questionType: sec.type_question });
    },
  };

  window.KeyboardShortcuts = KeyboardShortcuts;
})();
