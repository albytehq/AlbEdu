// csrf.js — cookie-auth request helper. Loaded before the platform client.
(function () {
  'use strict';

  function getCsrfToken() {
    const prefix = 'albedu_csrf=';
    const item = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith(prefix));
    if (!item) return null;
    try { return decodeURIComponent(item.slice(prefix.length)); } catch (_) { return null; }
  }

  function isMutating(method) {
    return ['POST', 'PUT', 'PATCH', 'DELETE'].includes((method || 'GET').toUpperCase());
  }

  function authFetch(input, init = {}) {
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    const method = init.method || (input instanceof Request ? input.method : 'GET');
    const token = getCsrfToken();
    if (isMutating(method) && token) headers.set('X-CSRF-Token', token);
    const examMode = window.AlbEdu?.examMode === true || /\/assessment\/take\.html$/.test(window.location.pathname);
    if (examMode) headers.set('X-Exam-Mode', '1');
    return fetch(input, { ...init, method, headers, credentials: init.credentials || 'include' }).then(response => {
      if (examMode && response.status === 401) document.dispatchEvent(new Event('albedu:exam-session-expired'));
      return response;
    });
  }

  window.AlbEdu = window.AlbEdu || {};
  window.AlbEdu.getCsrfToken = getCsrfToken;
  window.AlbEdu.authFetch = authFetch;
}());
