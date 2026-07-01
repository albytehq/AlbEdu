// active-assessments.js — v1.0.0 stub
// Loads assessments from Supabase `assessments` table via onSnapshot
// Renders cards with status, actions (start/pause/resume/finish/delete)
// TODO: implement full logic in Phase 7

(function () {
  'use strict';
  const ActiveAssessments = {
    init() {
      console.info('[ActiveAssessments] v1.0.0 init (stub)');
      // TODO: load assessments, render cards, wire actions
    },
  };
  window.ActiveAssessments = ActiveAssessments;
  document.addEventListener('DOMContentLoaded', () => ActiveAssessments.init());
})();
