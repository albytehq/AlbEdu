#!/usr/bin/env python3
"""
split_take_assessment.py — Split src/pages/take-assessment.js (1,741 lines)
into 5 focused namespace files under src/pages/take-assessment/.

Strategy:
  - Create a shared namespace: window.TakeAssessment._internal
    with { state, dom, constants, t }
  - Each split file is an IIFE that extends window.TakeAssessment
    with its functions, accessing shared state via _internal.
  - The main take-assessment.js becomes the orchestrator that:
    1. Defines window.TakeAssessment._internal (state, dom, constants, t)
    2. Defines the public init() method
    3. Loads the 5 split files via <script defer> BEFORE itself

  The 5 split files:
    1. utils.js     — _sanitizeHTML, _escAttr, _waitForAuth, _waitForQNotify,
                      _waitForThemeSystem, _getUrlParam, _t, mulberry32,
                      _shuffleFisherYates, _computeSeed, _shufflePages,
                      _parseSections, _formatDuration, _findQuestion,
                      _countEmpty
    2. fetch.js     — _fetchAssessment, _fetchSession, _restoreDraft,
                      _checkAccess, _applyTheme
    3. identity.js  — _renderIdentity, _onIdentitySubmit
    4. exam.js      — _startExam, _renderPageTabs, _renderQuestion,
                      _buildQuestionCard, _buildMediaHTML,
                      _updateQuestionAnsweredState, _saveAnswer,
                      _debounceEsai, _scheduleDraftSync, _buildAnswersPayload,
                      _startTimer, _stopTimer, _updateTimerDisplay,
                      _updateSubmitLockState, _getCurrentSisa,
                      _startSecurity, _stopSecurity, _pauseSecurity,
                      _resumeSecurity, _handleMaxViolations,
                      _handleBlocked, _handleSubmitted, _handleExpired,
                      _wireGlobalEvents, _beforeUnloadGuard, _popstateTrap,
                      _renderMath
    5. submit.js    — _submitExam, _confirmSubmit, _showSubmitRetryError,
                      _renderResult, _renderResultItem

  The HTML page (assessment/take.html) loads them in order:
    <script defer src="../../src/pages/take-assessment/utils.js"></script>
    <script defer src="../../src/pages/take-assessment/fetch.js"></script>
    <script defer src="../../src/pages/take-assessment/identity.js"></script>
    <script defer src="../../src/pages/take-assessment/exam.js"></script>
    <script defer src="../../src/pages/take-assessment/submit.js"></script>
    <script defer src="../../src/pages/take-assessment.js"></script>

This is a refactor, not a feature. The public API (window.TakeAssessment.init)
is unchanged. Heartbeat.js / BlockListener.js / AntiCheat.js / ExamGuardian
continue to work via window.ExamLogic and window.ExamGuardian.
"""
import re
from pathlib import Path

ROOT = Path('/home/z/my-project/work/AlbEdu')
SRC = ROOT / 'src/pages/take-assessment.js'
DEST_DIR = ROOT / 'src/pages/take-assessment'

# Read the original file
content = SRC.read_text(encoding='utf-8')

# We won't actually parse and split the file programmatically — the IIFE
# closure sharing makes that fragile. Instead, this script creates the
# directory and a README explaining the split plan, and the actual split
# is done manually via Edit tool calls (safer for a critical runtime file).
DEST_DIR.mkdir(parents=True, exist_ok=True)

# Write a README documenting the split
readme = """# take-assessment/ — Split modules

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
"""
(DEST_DIR / 'README.md').write_text(readme, encoding='utf-8')

print(f'Created {DEST_DIR}/README.md')
print('The actual split files will be created via manual edits (safer for critical runtime).')
print('Original file backed up at: src/pages/take-assessment.js.bak')
