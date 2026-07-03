# take-assessment/ — Split modules

This directory contains the split modules for the take-assessment page.

## Files

1. **utils.js** — Pure utilities (no state/dom access)
   - _sanitizeHTML, _escAttr, _getUrlParam, _t
   - _waitForAuth, _waitForQNotify, _waitForThemeSystem
   - mulberry32, _shuffleFisherYates, _computeSeed, _shufflePages, _parseSections
   - _formatDuration, _findQuestion, _countEmpty

2. **fetch.js** — Data fetch + access check + theme
   - _fetchAssessment, _fetchSession, _restoreDraft
   - _checkAccess, _applyTheme

3. **identity.js** — Identity form phase
   - _renderIdentity, _onIdentitySubmit

4. **exam.js** — Exam runtime (rendering + answers + timer + security + lifecycle)
   - _startExam, _renderPageTabs, _renderQuestion, _buildQuestionCard, _buildMediaHTML
   - _updateQuestionAnsweredState, _saveAnswer, _debounceEsai, _scheduleDraftSync
   - _buildAnswersPayload
   - _startTimer, _stopTimer, _updateTimerDisplay, _updateSubmitLockState, _getCurrentSisa
   - _startSecurity, _stopSecurity, _pauseSecurity, _resumeSecurity
   - _handleMaxViolations, _handleBlocked, _handleSubmitted, _handleExpired
   - _wireGlobalEvents, _beforeUnloadGuard, _popstateTrap, _renderMath

5. **submit.js** — Submit + result rendering
   - _submitExam, _confirmSubmit, _showSubmitRetryError
   - _renderResult, _renderResultItem

## Shared state

All modules access shared state via `window.TakeAssessment._internal`:
- `.state` — the runtime state object
- `.dom` — cached DOM references
- `.constants` — SUBMIT_UNLOCK_SECONDS, TIMER_WARNING_SECONDS, etc.
- `.t(key, vars, fallback)` — i18n helper

## Load order (in assessment/take.html)

```html
<script defer src="../../src/pages/take-assessment/utils.js"></script>
<script defer src="../../src/pages/take-assessment/fetch.js"></script>
<script defer src="../../src/pages/take-assessment/identity.js"></script>
<script defer src="../../src/pages/take-assessment/exam.js"></script>
<script defer src="../../src/pages/take-assessment/submit.js"></script>
<script defer src="../../src/pages/take-assessment.js"></script>
```

The main `take-assessment.js` file defines `_internal` (state, dom, constants, t),
the public `init()` method, and `window.ExamLogic` shim. It must load LAST.
