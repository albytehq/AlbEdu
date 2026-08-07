# Strict Commenting Rules for AI Assistants

> MUST READ before editing any file in the AlbEdu codebase.
> Applies to: Claude, GPT, Copilot, Cursor, Codex, and any other LLM-based assistant.

## Purpose

This document exists because AI assistants have a consistent failure mode: they decorate code with patterns that look "professional" to a pattern-matcher but read as noise to a human engineer. ASCII-art headers, version-stamped comments (`// v0.742.0: ...`), marketing-speak (`// Enterprise-grade, production-ready...`), and JSDoc on internal helpers all fall into this category. They make the codebase harder to read, harder to grep, and harder to maintain — not easier.

The AlbEdu codebase is vanilla JS with no compiler, no type-checker, and no JSDoc toolchain. Comments exist for one purpose: to explain something the code cannot explain itself. If a comment merely restates the code in English, it is noise. If it explains WHY a non-obvious decision was made, it is signal.

This document codifies the rules. AI assistants that violate them will have their diffs rejected in review.

## The 5 Rules

### Rule 1: Comments explain WHY, not WHAT

A comment that restates the code in English is noise. The reader can already read the code. What the reader cannot infer is the historical context, the constraint that forced a particular approach, the bug that this line prevents, or the trade-off that was made.

- `// Increment counter` above `counter++` — noise. Delete it.
- `// Counter is 1-indexed because the legacy API expects 1-based pagination` — signal. Keep it.

If you find yourself writing a comment that starts with "This function...", "This variable...", or "This loop...", stop. You are almost certainly restating the code. Ask yourself: what would a reader NOT know without this comment? If the answer is "nothing", delete the comment.

### Rule 2: No ASCII art, no boxes, no dividers

File headers like `/* ============================================================ */` and section dividers like `// ──────────────────────────────────────────────────────────────` are visual noise. They were popular in 1990s C code because editors didn't have folding. Modern editors fold on function boundaries, not on ASCII boxes.

A file header should be a single-line `// filename.js — one-line description` at the top. No border. No box. No `@author`. No `@since`. The git log already has the author and the date.

Section dividers inside a file should be a plain `// Section Name` comment, or — better — a function with a descriptive name. If you need a divider to find your way around a file, the file is too long. Split it.

### Rule 3: No version archaeology (git keeps history)

Comments like `// v0.742.0: changed from X to Y` or `// v0.815.7: added Z` are noise. Git blame already records when a line changed, who changed it, and (via the commit message) why. Stamping the version in the comment creates a maintenance burden: the comment has to be updated when the version bumps, and it never is, so the comment becomes a lie.

The only acceptable version reference in a comment is a one-time note like `// NOTE: requires migration 021` when the code literally cannot function without a specific migration. Even then, prefer a runtime check (`if (!await columnExists('foo')) throw new Error('run migration 021')`) over a comment.

### Rule 4: No marketing-speak

Words like `enterprise-grade`, `production-ready`, `world-class`, `robust`, `seamless`, `cutting-edge`, `state-of-the-art`, `next-generation`, `revolutionary`, and `powerful` have no place in code comments. They are subjective, unverifiable, and add no information. A function either works or it doesn't — calling it "robust" doesn't make it so.

This rule also bans phrases like `// This is a comprehensive solution for...` and `// Best-in-class implementation of...`. If the implementation is best-in-class, the reader will notice. If it isn't, the comment is a lie.

The exception: marketing copy in user-facing strings (`<h1>Enterprise-grade assessment platform</h1>` on the landing page) is fine — that's copywriting, not code commenting.

### Rule 5: JSDoc only on public API

JSDoc (`/** ... */` with `@param`, `@returns`, `@throws`) is for functions that other modules call — i.e., the public API surface. It is NOT for internal helpers, private methods, or one-off utility functions used in a single file.

AlbEdu has no JSDoc toolchain. There is no `typedoc` step in the build. JSDoc comments are read by humans (in the source) and by IDEs (for hover hints). Putting JSDoc on a `_sanitizeInput()` helper that's only called from two places in the same file adds 8 lines of `@param` boilerplate to communicate what the function signature already communicates.

Reserve JSDoc for:
- Functions exported from a barrel (`src/utils/index.js`, `src/platform/repository.js`, etc.)
- Functions on the `window.AlbEdu.*` namespace
- Edge Function handler signatures

Everything else: a single-line `// description` above the function is enough.

## BANNED patterns

| Pattern | Why banned | Human alternative |
|---|---|---|
| `/* ============================================================ */` file header border | Visual noise; editors fold on function boundaries | `// filename.js — one-line description` |
| `// ─────────────────────────────────────────` section divider | Noise; split the file instead | `// Section Name` or extract to a function |
| `// v0.742.0: changed X to Y` | Git blame already records this | Delete the comment; write a good commit message |
| `// Phase 8 PWA feature` | Phase refs are internal project-management noise | Delete the comment |
| `// Enterprise-grade, production-ready implementation` | Marketing-speak; unverifiable | Delete the comment |
| `// This function does X` (above a function named `doX`) | Restates the code in English | Delete the comment, or explain WHY X matters |
| `@author Albi` `@since v2.0.0` | Git log has this | Delete |
| JSDoc `/** @param {string} foo ... */` on internal helpers | No toolchain consumes it; pure boilerplate | `// one-line description` |
| `// TODO: refactor this` without context | Unactionable; everyone adds TODOs, nobody actiones them | Either do the refactor now, or file an issue with context |
| `// FIXME: this is a hack` | Same as TODO — unactionable | Either fix it now, or file an issue |
| `// ============================================` inside function bodies | Noise | Delete |
| Emoji in comments (`// 🚀 performance optimization`) | Unprofessional in source code | Plain text |
| `// Code below handles the case where...` paragraph comments | If it needs a paragraph, extract a function with a descriptive name | Extract function |

## ALLOWED patterns

| Pattern | When to use | Example |
|---|---|---|
| `// one-line description` above a non-obvious function | When the function's purpose isn't clear from its name | `// Heartbeat uses 15s, not 5s, to stay under Free Plan invocation cap` |
| Inline `// explanation` next to a tricky line | When a line looks wrong but is actually correct | `x = x >> 0;  // coerce to int32 (faster than Math.floor for positive)` |
| `// NOTE: ...` for a non-obvious constraint | When the code depends on something external | `// NOTE: requires migration 021 — peran_user() must filter deleted_at` |
| `// HACK: ...` with a specific reason | When you knowingly did something ugly | `// HACK: Supabase JS client v2 doesn't expose the raw response; we re-parse it` |
| `// WHY: ...` for a non-obvious decision | When the reader will ask "why not the obvious thing?" | `// WHY: setTimeout(0) instead of queueMicrotask — Safari 15 microtask ordering bug` |
| JSDoc `/** ... */` on exported public API | Functions exported from barrels or on `window.AlbEdu` | `/** Submit assessment atomically. @param {string} sessionId */` |
| File-top `// filename.js — description` | One line, at the top of every JS file | `// heartbeat.js — peserta-side 15s heartbeat to keep session alive` |

## Examples — BAD vs GOOD

### Example 1: File header

BAD:
```javascript
/* ============================================================
 * heartbeat.js — AlbEdu Heartbeat Module
 * 
 * Enterprise-grade heartbeat implementation with retry logic,
 * exponential backoff, and seamless error recovery.
 * 
 * @author Albi Fahriza
 * @since v0.742.0
 * @version v0.815.7
 * ============================================================ */
```

GOOD:
```javascript
// heartbeat.js — peserta-side 15s heartbeat to keep session alive
```

### Example 2: Function comment

BAD:
```javascript
/**
 * Starts the heartbeat interval. This function is responsible for
 * initiating the periodic heartbeat mechanism that sends session
 * updates to the server at regular intervals.
 *
 * @param {string} sessionId - The session ID to heartbeat for
 * @param {number} intervalMs - The interval in milliseconds
 * @returns {void}
 * @since v0.742.0
 */
function start(sessionId, intervalMs) {
  // Set the interval
  _interval = setInterval(() => {
    // Send the heartbeat
    _send(sessionId);
  }, intervalMs);
}
```

GOOD:
```javascript
// 15s default — under Free Plan's 500K invocations/month cap for ~100 peserta
function start(sessionId, intervalMs = 15000) {
  _interval = setInterval(() => _send(sessionId), intervalMs);
}
```

### Example 3: Section divider

BAD:
```javascript
// ──────────────────────────────────────────────────────────────
// 1. INITIALIZATION
// ──────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────
// 2. HEARTBEAT LOOP
// ──────────────────────────────────────────────────────────────
```

GOOD:
```javascript
// (no dividers — extract each section into its own function:
//   _init(), _startHeartbeatLoop(), _stopHeartbeatLoop()
// and call them from a top-level start() / stop() pair)
```

### Example 4: Version archaeology

BAD:
```javascript
// v0.742.0: changed from 5s to 15s interval
// v0.745.0: added exponential backoff
// v0.815.7: added AbortController teardown
const HEARTBEAT_INTERVAL_MS = 15000;
```

GOOD:
```javascript
const HEARTBEAT_INTERVAL_MS = 15000;
```

### Example 5: Marketing-speak

BAD:
```javascript
/**
 * World-class anti-cheat system with cutting-edge DevTools detection.
 * This robust implementation provides enterprise-grade security for
 * high-stakes assessments.
 */
export class AntiCheat { ... }
```

GOOD:
```javascript
// Client-side anti-cheat. Server-side scoring is the source of truth;
// this layer only catches casual cheating (DevTools, copy/paste, tab-switching).
export class AntiCheat { ... }
```

### Example 6: Restating the code

BAD:
```javascript
// Increment the violation count
violationCount++;

// Check if the user is blocked
if (user.status === 'blocked') {
  // Redirect to blocked page
  window.location.href = '/blocked.html';
}
```

GOOD:
```javascript
violationCount++;

if (user.status === 'blocked') {
  window.location.href = '/blocked.html';
}
```

### Example 7: WHY comment (keep this one)

BAD:
```javascript
// Use Promise.allSettled
const results = await Promise.allSettled(images.map(upload));
```

GOOD:
```javascript
// allSettled, not all — one bad image must not abort the whole batch
const results = await Promise.allSettled(images.map(upload));
```

### Example 8: JSDoc on internal helper

BAD:
```javascript
/**
 * Sanitizes the input string by removing potentially dangerous characters.
 *
 * @param {string} input - The input string to sanitize
 * @returns {string} The sanitized string
 * @private
 */
function _sanitize(input) {
  return input.replace(/[<>]/g, '');
}
```

GOOD:
```javascript
function _sanitize(input) {
  return input.replace(/[<>]/g, '');
}
```

### Example 9: Indonesian example (codebase is bilingual)

BAD:
```javascript
// ============================================================
// FUNGSI UNTUK MENGHITUNG NILAI AKHIR PESERTA
// Enterprise-grade scoring algorithm
// ============================================================
```

GOOD:
```javascript
// Skor dihitung server-side di submit-assessment RPC — jangan percaya skor client
function hitungNilai(jawaban, kunci) { ... }
```

### Example 10: HACK comment with context

BAD:
```javascript
// FIXME: this is bad
setTimeout(() => el.focus(), 0);
```

GOOD:
```javascript
// HACK: setTimeout(0) — iOS Safari 15 refuses to focus an element
// synchronously after a touchend event; deferring to the next tick works.
setTimeout(() => el.focus(), 0);
```

## Enforcement

### Grep patterns to find violations

Run these from the repo root. Any hit is a violation that should be fixed before merge.

```bash
# ASCII-art file headers
rg -n '^/\* ={5,}' src/ styles/ supabase/ cloudflare-worker/

# Section dividers
rg -n '// ─{5,}|// ={5,}|// -{5,}|// \*{5,}' src/ styles/ supabase/

# Version archaeology
rg -n '// v0\.\d+\.\d+|// v[0-9]+\.[0-9]+\.[0-9]+:' src/ styles/ supabase/

# Phase refs
rg -n '// Phase [0-9]+' src/ styles/

# Marketing-speak
rg -n -i 'enterprise-grade|production-ready|world-class|cutting-edge|state-of-the-art|next-generation|revolutionary|seamless|robust implementation' src/ styles/

# @author / @since in comments
rg -n '@author|@since' src/ styles/

# JSDoc on private/internal helpers (functions starting with _)
rg -n -B 5 'function _\w+' src/ | rg '/\*\*'
```

### CI check ideas

Wire these into `scripts/verify_audit.py` as additional checks (the script already runs 14 structural checks; add these as #15–#20):

15. No ASCII-art file headers (`^/\* ={5,}` in any .js/.ts/.css file)
16. No section dividers (`// ─{5,}` or `// ={5,}` in any .js/.ts file)
17. No version-stamped comments (`// v0\.\d+\.\d+:` in any .js/.ts/.css file)
18. No marketing-speak (`enterprise-grade|production-ready|world-class` etc.)
19. No `@author` or `@since` tags in comments
20. JSDoc only on exported functions (heuristic: `/** ... */` must be above `export function` or `export class`, not above `function _foo`)

### Reviewer checklist

When reviewing an AI-generated diff, ask:

1. Did the AI add any comments that restate the code? Delete them.
2. Did the AI add ASCII-art headers or dividers? Delete them.
3. Did the AI stamp a version in a comment? Delete it.
4. Did the AI use words like "robust", "seamless", "enterprise-grade"? Delete the comment.
5. Did the AI add JSDoc to an internal helper? Replace with a one-liner or delete.
6. Did the AI add a `// TODO` or `// FIXME` without context? Either fix it now or delete it.

If the answer to any of these is "yes", request changes. Do not merge AI-generated noise.

---

**Document version:** 1.0.0
**Last updated:** 2026-07-08
