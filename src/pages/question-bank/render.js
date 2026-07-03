// =============================================================================
// question-bank/render.js — DOM cache, event wiring, card rendering
// =============================================================================
// Part of the question-bank split.
// Functions: _cacheDom, _wireEvents, _render, _renderCard
// Load order: MUST load after utils.js and data.js, before question-bank.js.
// =============================================================================

(function () {
  'use strict';

  const _internal = window.QuestionBank = window.QuestionBank || {};
  _internal._internal = _internal._internal || { state: {}, dom: {}, constants: {}, t: null };
  const I = _internal._internal;
  const t = I.t || ((key, vars, fallback) => fallback || key);
  const SEARCH_DEBOUNCE_MS = () => I.constants.SEARCH_DEBOUNCE_MS || 240;

  // ── DOM cache ───────────────────────────────────────────────────────────
  function _cacheDom() {
    I.dom.searchInput      = document.getElementById('qb-search-input');
    I.dom.filterSubject    = document.getElementById('qb-filter-subject');
    I.dom.filterDifficulty = document.getElementById('qb-filter-difficulty');
    I.dom.filterTags       = document.getElementById('qb-filter-tags');
    I.dom.count            = document.getElementById('qb-count');
    I.dom.grid             = document.getElementById('qb-grid');
    I.dom.empty            = document.getElementById('qb-empty');
    I.dom.noResults        = document.getElementById('qb-no-results');
    I.dom.btnAdd           = document.getElementById('btn-qb-add');
    I.dom.btnImport        = document.getElementById('btn-qb-import');
    I.dom.btnExport        = document.getElementById('btn-qb-export');
    I.dom.btnEmptyAdd      = document.getElementById('btn-qb-empty-add');

    I.dom.fileInput        = document.createElement('input');
    I.dom.fileInput.type   = 'file';
    I.dom.fileInput.accept = '.json,application/json';
    I.dom.fileInput.style.display = 'none';
    document.body.appendChild(I.dom.fileInput);
  }

  function _wireEvents() {
    if (I.dom.btnAdd)      I.dom.btnAdd.addEventListener('click', () => _internal._openModal(null));
    if (I.dom.btnEmptyAdd) I.dom.btnEmptyAdd.addEventListener('click', () => _internal._openModal(null));
    if (I.dom.btnImport)   I.dom.btnImport.addEventListener('click', () => I.dom.fileInput.click());
    if (I.dom.btnExport)   I.dom.btnExport.addEventListener('click', () => _internal._exportJson());
    I.dom.fileInput.addEventListener('change', (e) => _internal._importJson(e));

    if (I.dom.searchInput) {
      I.dom.searchInput.addEventListener('input', (e) => {
        I.state.search = e.target.value || '';
        clearTimeout(I._searchTimer);
        I._searchTimer = setTimeout(_internal._applyFilters, SEARCH_DEBOUNCE_MS());
      });
    }

    if (I.dom.filterSubject) {
      I.dom.filterSubject.addEventListener('change', (e) => {
        I.state.filterSubject = e.target.value || '';
        _internal._applyFilters();
      });
    }
    if (I.dom.filterDifficulty) {
      I.dom.filterDifficulty.addEventListener('change', (e) => {
        I.state.filterDifficulty = e.target.value || '';
        _internal._applyFilters();
      });
    }

    if (I.dom.filterTags) {
      I.dom.filterTags.addEventListener('input', () => {
        clearTimeout(I._tagFilterTimer);
        I._tagFilterTimer = setTimeout(() => {
          I.state.filterTags = _internal._parseTags(I.dom.filterTags.value).map((t) => t.toLowerCase());
          _internal._applyFilters();
        }, SEARCH_DEBOUNCE_MS());
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && I.state.modalOpen) _internal._closeModal();
    });
  }

  // ── Render ──────────────────────────────────────────────────────────────
  function _render() {
    if (!I.dom.grid) return;
    const total = I.state.filtered.length;

    if (I.dom.count) I.dom.count.textContent = String(total);

    if (I.state.questions.length === 0) {
      I.dom.grid.hidden = true;
      I.dom.grid.innerHTML = '';
      if (I.dom.empty)     I.dom.empty.hidden = false;
      if (I.dom.noResults) I.dom.noResults.hidden = true;
      return;
    }
    if (total === 0) {
      I.dom.grid.hidden = true;
      I.dom.grid.innerHTML = '';
      if (I.dom.empty)     I.dom.empty.hidden = true;
      if (I.dom.noResults) I.dom.noResults.hidden = false;
      return;
    }

    if (I.dom.empty)     I.dom.empty.hidden = true;
    if (I.dom.noResults) I.dom.noResults.hidden = true;
    I.dom.grid.hidden = false;
    I.dom.grid.innerHTML = I.state.filtered.map(_renderCard).join('');

    // Bind icons injected via innerHTML
    window.AlbEdu?.bindIcons?.(I.dom.grid);

    I.dom.grid.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const action = btn.dataset.action;
        const id = btn.dataset.id;
        if (!action || !id) return;
        if (action === 'edit')            _internal._openModal(id);
        else if (action === 'delete')     _internal._confirmDelete(id);
        else if (action === 'add-to-asm') _internal._addToAssessment(id);
      });
    });
  }

  function _renderCard(q) {
    const type = q.type || 'esai';
    const typeClass = type === 'PG' ? 'qb-type-PG' : 'qb-type-ESAI';
    const typeLabel = type === 'PG' ? 'PG' : 'Esai';

    const diff = q.difficulty || '';
    const diffKey = diff ? ('question_bank.difficulty_' + diff) : '';
    const diffLabel = diff ? _internal._t(diffKey) : '';
    const diffBadge = diff
      ? `<span class="qb-difficulty-badge qb-difficulty-${_internal._esc(diff)}">${_internal._esc(diffLabel)}</span>`
      : '';

    const tags = Array.isArray(q.tags) ? q.tags : [];
    const tagsHtml = tags.length
      ? tags.map((t) => `<span class="qb-tag">#${_internal._esc(t)}</span>`).join('')
      : '';

    const usage = Number(q.usage_count) || 0;
    const usageLabel = _internal._t('question_bank.usage_count', { count: usage });

    return `
      <article class="qb-card" data-id="${_internal._esc(q.id)}">
        <header class="qb-card-head">
          <span class="qb-type-badge ${typeClass}">${_internal._esc(typeLabel)}</span>
          ${diffBadge}
          <span class="qb-usage" title="Jumlah dipakai di asesmen">${_internal._esc(usageLabel)}</span>
        </header>
        <div class="qb-card-text">${_internal._esc(_internal._truncate(q.question, 200))}</div>
        <div class="qb-card-meta">
          <span class="qb-subject">${_internal._esc(q.subject || '—')}</span>
          ${q.topic ? `<span>• ${_internal._esc(q.topic)}</span>` : ''}
          ${tagsHtml}
        </div>
        <footer class="qb-card-actions">
          <button class="albedu-btn albedu-btn-secondary albedu-btn-sm" data-action="edit" data-id="${_internal._esc(q.id)}" type="button">
            <span data-albedu-icon="edit"></span>
            <span>${_internal._esc(_internal._t('common.edit'))}</span>
          </button>
          <button class="albedu-btn albedu-btn-danger albedu-btn-sm" data-action="delete" data-id="${_internal._esc(q.id)}" type="button">
            <span data-albedu-icon="delete"></span>
            <span>${_internal._esc(_internal._t('common.delete'))}</span>
          </button>
          <button class="albedu-btn albedu-btn-ghost albedu-btn-sm" data-action="add-to-asm" data-id="${_internal._esc(q.id)}" type="button" title="${_internal._esc(_internal._t('question_bank.add_to_assessment'))}">
            <span data-albedu-icon="add"></span>
            <span>+ Asesmen</span>
          </button>
        </footer>
      </article>
    `;
  }

  // ── Expose ──────────────────────────────────────────────────────────────
  Object.assign(_internal, {
    _cacheDom, _wireEvents, _render, _renderCard,
  });
})();
