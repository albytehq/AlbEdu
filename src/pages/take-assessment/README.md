# take-assessment/ — split modules

The take-assessment page is split into 5 modules, loaded in this order:

```html
<script defer src="../../src/pages/take-assessment/utils.js"></script>
<script defer src="../../src/pages/take-assessment/fetch.js"></script>
<script defer src="../../src/pages/take-assessment/identity.js"></script>
<script defer src="../../src/pages/take-assessment/exam.js"></script>
<script defer src="../../src/pages/take-assessment/submit.js"></script>
<script defer src="../../src/pages/take-assessment.js"></script>
```

| Module       | Responsibility                                                       |
| ------------ | ------------------------------------------------------------------- |
| `utils.js`   | Pure helpers (sanitizers, waiters, shuffle, parse, math render)    |
| `fetch.js`   | Fetch assessment + session, restore draft, access check, theme      |
| `identity.js`| Identity form phase (renders + persists identity snapshot)         |
| `exam.js`    | Exam runtime (rendering, answers, timer, security, lifecycle)       |
| `submit.js`  | Submit flow + result rendering                                      |

All modules share state via `window.TakeAssessment._internal`:
- `.state` — runtime state object
- `.dom` — cached DOM references
- `.constants` — SUBMIT_UNLOCK_SECONDS, TIMER_WARNING_SECONDS, etc.

The parent `take-assessment.js` (one level up) defines `_internal`, the public
`init()` boot sequence, and the `window.ExamLogic` shim used by Heartbeat.js.
It must load LAST.
