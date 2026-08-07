/**
 * Error Manager - Mengelola error validasi secara terpusat
 */
const ErrorManager = (() => {
  let errors = {};
  
  const setError = (field, message) => {
    errors[field] = message;
    // Trigger UI update
    const errorEl = document.querySelector(`.wizard-wrapper [data-error="${field}"]`);
    if (errorEl) {
      errorEl.style.display = 'flex';
      const span = errorEl.querySelector('.error-text');
      if (span) span.textContent = message;
      // Highlight input
      const input = document.querySelector(`.wizard-wrapper [data-field="${field}"]`) ||
        document.querySelector(`.wizard-wrapper [data-dropdown="${field}"]`);
      if (input) input.classList.add('has-error');
    }
  };
  
  const clearError = (field) => {
    delete errors[field];
    const errorEl = document.querySelector(`.wizard-wrapper [data-error="${field}"]`);
    if (errorEl) {
      errorEl.style.display = 'none';
      const input = document.querySelector(`.wizard-wrapper [data-field="${field}"]`) ||
        document.querySelector(`.wizard-wrapper [data-dropdown="${field}"]`);
      if (input) input.classList.remove('has-error');
    }
  };
  
  const clearAll = () => {
    errors = {};
    document.querySelectorAll('.wizard-wrapper .validation-error').forEach(el => el.style.display = 'none');
    document.querySelectorAll('.wizard-wrapper .has-error').forEach(el => el.classList.remove('has-error'));
  };
  
  const getErrors = () => ({ ...errors });
  
  const applyErrors = (errorMap) => {
    clearAll();
    Object.entries(errorMap).forEach(([field, msg]) => setError(field, msg));
  };
  
  return { setError, clearError, clearAll, getErrors, applyErrors };
})();