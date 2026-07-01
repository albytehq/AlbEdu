#!/usr/bin/env node
/**
 * verify-structure.mjs — Post-migration integrity check for AlbEdu v2.0.0
 *
 * Checks:
 *   1. All expected folders exist
 *   2. No orphan files in old paths (assets/, admin/, ujian/)
 *   3. All HTML files reference valid JS/CSS paths
 *   4. All ES module imports resolve
 *   5. No inline <style> blocks > 50 lines
 *   6. All feature folders have index.js (barrel export)
 *   7. Required documentation files exist
 *   8. Required config files exist
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

let errors = 0;
let warnings = 0;

function error(msg) {
  console.error(`  ❌ ${msg}`);
  errors++;
}

function warn(msg) {
  console.warn(`  ⚠️  ${msg}`);
  warnings++;
}

function ok(msg) {
  console.log(`  ✓ ${msg}`);
}

function check(condition, msg, isWarn = false) {
  if (!condition) {
    if (isWarn) warn(msg);
    else error(msg);
  } else {
    ok(msg);
  }
}

// === CHECK 1: Expected folders exist ===
console.log('\n=== Check 1: Folder structure ===');

const EXPECTED_FOLDERS = [
  'src', 'src/auth', 'src/exam', 'src/identity',
  'src/profile', 'src/pages', 'src/pages/buat-ujian', 'src/utils',
  'styles', 'pages', 'pages/admin', 'pages/ujian',
  'public', 'public/images', 'public/images/favicon', 'public/QNotify',
  'supabase', 'supabase/functions', 'supabase/migrations',
  'scripts', 'tests', 'docs',
];

EXPECTED_FOLDERS.forEach(folder => {
  check(existsSync(join(ROOT, folder)), `Folder exists: ${folder}/`);
});

// === CHECK 2: Old paths removed ===
console.log('\n=== Check 2: Old paths removed ===');

const OLD_PATHS = ['assets', 'assets/js', 'assets/css', 'assets/images', 'assets/QNotify', 'admin', 'ujian'];
OLD_PATHS.forEach(path => {
  check(!existsSync(join(ROOT, path)), `Old path removed: ${path}/`, true);
});

// === CHECK 3: Feature folders have index.js ===
console.log('\n=== Check 3: Barrel exports (index.js) ===');

const FEATURE_FOLDERS = ['auth', 'exam', 'identity', 'profile', 'pages', 'utils'];
FEATURE_FOLDERS.forEach(folder => {
  check(existsSync(join(ROOT, 'src', folder, 'index.js')), `Barrel export: src/${folder}/index.js`);
});
// v2.2.0 — Buat Ujian v2 has its own sub-folder barrel (src/pages/buat-ujian/index.js)
check(existsSync(join(ROOT, 'src', 'pages', 'buat-ujian', 'index.js')), 'Barrel export: src/pages/buat-ujian/index.js');

// === CHECK 4: Required root files ===
console.log('\n=== Check 4: Root files ===');

const ROOT_FILES = [
  'index.html', '404.html', 'package.json', 'README.md', 'LICENSE',
  'rule-url-albedu.md',
  '.gitignore', '.editorconfig', '.eslintrc.json', '.prettierrc', 'jsconfig.json',
];

ROOT_FILES.forEach(file => {
  // .gitignore, .editorconfig, .eslintrc.json, .prettierrc may not exist — soft check
  const isSoft = ['.', '_'].includes(file[0]);
  if (existsSync(join(ROOT, file))) {
    ok(`Root file: ${file}`);
  } else if (isSoft) {
    warn(`Root file missing (soft): ${file}`);
  } else {
    error(`Root file: ${file}`);
  }
});

// === CHECK 5: Documentation files ===
console.log('\n=== Check 5: Documentation ===');

const DOCS = ['README.md', 'ARCHITECTURE.md', 'CONTRIBUTING.md', 'AI-CONTEXT.md', 'MIGRATION.md', 'UPDATE-GUIDE.md'];
DOCS.forEach(doc => {
  check(existsSync(join(ROOT, 'docs', doc)), `Doc exists: docs/${doc}`);
});

// === CHECK 6: HTML files exist ===
console.log('\n=== Check 6: HTML pages ===');

const HTML_FILES = [
  // Root (canonical)
  'index.html', '404.html',
  // Public pages
  'pages/login.html', 'pages/register-admin.html',
  'pages/register-success.html', 'pages/forgot-password.html',
  'pages/reset-password.html', 'pages/404.html',
  // Admin (v0.742.0+: flattened — pages/admin/pages/ removed)
  'pages/admin/index.html',
  'pages/admin/buat-ujian.html', 'pages/admin/daftar-nama.html',
  'pages/admin/data-hasil.html', 'pages/admin/profile.html',
  'pages/admin/ujian-peserta.html',
  'pages/admin/create-assessment.html', 'pages/admin/active-assessments.html',
  'pages/admin/question-bank.html', 'pages/admin/monitoring.html',
  'pages/admin/results-analytics.html',
  // Ujian
  'pages/ujian/index.html', 'pages/ujian/kerjakan-ujian.html',
  // Assessment
  'pages/assessment/index.html', 'pages/assessment/take.html',
  'pages/assessment/submitted.html', 'pages/assessment/blocked.html',
];

HTML_FILES.forEach(file => {
  check(existsSync(join(ROOT, file)), `HTML page: ${file}`);
});

// === CHECK 7: Critical JS files exist ===
console.log('\n=== Check 7: Critical JS files ===');

const CRITICAL_JS = [
  // Auth orchestrator + helpers
  'src/auth/main.js', 'src/auth/errors.js', 'src/auth/user-helpers.js',
  'src/auth/index.js', 'src/auth/constants.js',
  // Auth flows
  'src/auth/user-auth-portal.js', 'src/auth/admin-onboarding.js',
  'src/auth/forgot-password.js', 'src/auth/reset-password.js',
  'src/auth/preflight.js', 'src/auth/turnstile.js', 'src/auth/authFlow.js',
  'src/auth/errorMapper.js', 'src/auth/security.js', 'src/auth/byteward.js',
  'src/auth/device-fingerprint.js',
  // Feature modules
  'src/exam/index.js',
  'src/identity/index.js',
  'src/profile/index.js',
  'src/pages/index.js',
  'src/utils/index.js', 'src/utils/supabase-api.js', 'src/utils/ui.js',
  'src/utils/navigasi.js',
  // v0.2.0 — Buat Ujian (replaces src/wizard/*)
  // v1.0.0 — Removed `src/pages/buat-ujian.js` (replaced by create-assessment.js)
  'src/pages/buat-ujian/index.js',
  'src/pages/buat-ujian/templates.js',
  'src/pages/buat-ujian/keyboard-shortcuts.js',
  'src/pages/buat-ujian/metadata-card.js',
  'src/pages/buat-ujian/soal-editor-modal.js',
  'src/pages/buat-ujian/soal-card.js',
  'src/pages/buat-ujian/publish-card.js',
  'src/pages/buat-ujian/wizard-controller.js',
  'src/pages/buat-ujian/list-view.js',
  // Supabase edge functions
  'supabase/functions/user-auth-preflight/index.ts',
  'supabase/functions/user-auth-complete/index.ts',
  'supabase/functions/register-admin/index.ts',
  // v1.0.0 — Removed `supabase/functions/exam-token-attempt/index.ts` (replaced by access-code-attempt)
  'supabase/functions/access-code-attempt/index.ts',
];

CRITICAL_JS.forEach(file => {
  check(existsSync(join(ROOT, file)), `JS file: ${file}`);
});

// === CHECK 8: CSS files exist ===
console.log('\n=== Check 8: CSS files ===');

const CSS_FILES = [
  'styles/tokens.css', 'styles/loading.css', 'styles/navigasi.css',
  'styles/profile.css', 'styles/buat-ujian-v2.css', 'styles/buat-ujian-modal.css',
  'styles/login.css', 'styles/landing.css', 'styles/kerjakan-ujian.css',
];

CSS_FILES.forEach(file => {
  check(existsSync(join(ROOT, file)), `CSS file: ${file}`);
});

// === CHECK 9: HTML files don't have broken refs ===
console.log('\n=== Check 9: HTML references resolve ===');

function findHtmlFiles(dir) {
  const results = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== '.git') {
      results.push(...findHtmlFiles(fullPath));
    } else if (entry.name.endsWith('.html')) {
      results.push(fullPath);
    }
  }
  return results;
}

const htmlFiles = findHtmlFiles(ROOT);
let brokenRefs = 0;

htmlFiles.forEach(htmlFile => {
  const content = readFileSync(htmlFile, 'utf-8');
  const rel = relative(ROOT, htmlFile);

  // Find all src="..." and href="..." references
  const refPattern = /(?:src|href)="([^"]+)"/g;
  let match;
  while ((match = refPattern.exec(content)) !== null) {
    const refPath = match[1];

    // Skip CDN URLs and data URIs
    if (refPath.startsWith('http') || refPath.startsWith('//') || refPath.startsWith('data:') || refPath.startsWith('mailto:')) {
      continue;
    }

    // Skip JS template literals (false positives from inline <script> strings)
    if (refPath.includes("'") || refPath.includes('+') || refPath.includes('${')) {
      continue;
    }

    // Strip query strings
    const cleanPath = refPath.split('?')[0].split('#')[0];

    // Resolve relative to HTML file's directory
    const htmlDir = dirname(htmlFile);
    const resolvedPath = resolve(htmlDir, cleanPath);

    // Check if file exists
    if (!existsSync(resolvedPath)) {
      // Skip if path starts with / (absolute URL, server-resolved)
      if (cleanPath.startsWith('/')) continue;
      // Skip inline references (e.g., #id)
      if (cleanPath.startsWith('#')) continue;
      console.error(`  ❌ Broken ref in ${rel}: ${refPath}`);
      brokenRefs++;
    }
  }
});

if (brokenRefs === 0) {
  ok(`All HTML references resolve (${htmlFiles.length} files checked)`);
} else {
  error(`${brokenRefs} broken references found`);
}

// === CHECK 9b: Classic script dependency chain (catches v2.1.2 bug class) ===
console.log('\n=== Check 9b: Classic script dependency chain ===');
//
// main.js (classic script) reads from `window.CompletionError` (defined by
// errors.js) and `window.AuthHelpers` (defined by user-helpers.js) at
// module-eval time. If those scripts aren't loaded BEFORE main.js via
// <script defer> tags, main.js throws TypeError and `window.Auth` never
// gets defined → ALL auth flows break silently.
//
// This check verifies that every HTML file which loads `auth/main.js`
// ALSO loads `auth/errors.js` AND `auth/user-helpers.js` BEFORE main.js.
//
// Bug history: v2.0.0 by-feature restructure extracted errors.js and
// user-helpers.js out of auth.js, but forgot to add the new <script>
// tags to any HTML file. The bug went unnoticed for weeks because the
// error was caught by security.js's global error handler and logged
// to console.error but didn't prevent the page from rendering.

const SCRIPT_SRC_REGEX = /<script\s+[^>]*src="([^"]+)"/g;
const mainJsPages = [];
const missingDeps = [];

htmlFiles.forEach(htmlFile => {
  const content = readFileSync(htmlFile, 'utf8');
  const rel = relative(ROOT, htmlFile);

  // Extract all <script src="..."> in order
  const scripts = [];
  let m;
  const r = new RegExp(SCRIPT_SRC_REGEX);
  while ((m = r.exec(content)) !== null) {
    scripts.push(m[1]);
  }

  // Find if this page loads auth/main.js
  const mainJsIdx = scripts.findIndex(s => s.endsWith('auth/main.js'));
  if (mainJsIdx === -1) return; // doesn't load main.js — skip

  mainJsPages.push(rel);

  // Check that errors.js and user-helpers.js are loaded BEFORE main.js
  const errorsIdx = scripts.findIndex(s => s.endsWith('auth/errors.js'));
  const helpersIdx = scripts.findIndex(s => s.endsWith('auth/user-helpers.js'));

  const hasErrorsBefore = errorsIdx !== -1 && errorsIdx < mainJsIdx;
  const hasHelpersBefore = helpersIdx !== -1 && helpersIdx < mainJsIdx;

  if (!hasErrorsBefore) {
    missingDeps.push(`${rel}: missing auth/errors.js before auth/main.js`);
  }
  if (!hasHelpersBefore) {
    missingDeps.push(`${rel}: missing auth/user-helpers.js before auth/main.js`);
  }
});

if (missingDeps.length === 0) {
  ok(`All ${mainJsPages.length} pages loading auth/main.js also load errors.js + user-helpers.js first`);
} else {
  missingDeps.forEach(d => console.error(`  ❌ ${d}`));
  error(`${missingDeps.length} missing script dependency (catches v2.1.2-style bugs)`);
}

// === CHECK 9c: Classic scripts don't share top-level const/class/function names ===
console.log('\n=== Check 9c: Classic script global name conflicts ===');
//
// Classic scripts (no `type="module"`) share the global lexical environment.
// If two scripts both declare `const Foo` at top level, the second one throws
// `SyntaxError: Identifier 'Foo' has already been declared`.
//
// The v2.1.3 bug: errors.js declared `class CompletionError` at top level,
// then main.js tried `const CompletionError = window.CompletionError;` —
// duplicate declaration in the shared global scope.
//
// Fix: wrap classic scripts that expose globals via `window.X = X` in IIFEs
// so their top-level declarations stay scoped. Only the `window.X` assignment
// leaks out.
//
// This check scans all classic scripts loaded in HTML pages, extracts their
// top-level `const`/`let`/`class`/`function` names, and flags any name that
// appears in MORE THAN ONE file.

const CLASSIC_SCRIPT_FILES = [
  // Files loaded via <script defer> (not <script type="module">) in HTML pages.
  // These share the global lexical environment.
  'src/auth/errors.js',
  'src/auth/user-helpers.js',
  'src/auth/main.js',
  'src/auth/security.js',
  'src/auth/byteward.js',
  'src/auth/device-fingerprint.js',
  'src/utils/supabase-api.js',
  'src/utils/ui.js',
  'src/utils/navigasi.js',
];

// Collect top-level declarations from each classic script.
// A declaration is "top-level" if it appears at column 0 (no indentation).
// This is a heuristic — it won't catch indented top-level declarations inside
// if-blocks, but that's rare and the check is conservative.
const TOP_LEVEL_REGEX = /^(?:const|let|class|function)\s+([A-Z_]\w*)\s*[={(\s]/gm;

const nameToFiles = new Map(); // name → Set of files

CLASSIC_SCRIPT_FILES.forEach(file => {
  const fullPath = join(ROOT, file);
  if (!existsSync(fullPath)) return;
  const content = readFileSync(fullPath, 'utf8');

  // Check if file is wrapped in IIFE — if so, its top-level declarations
  // are scoped and don't leak to global. Skip them.
  const stripped = content.replace(/^\/\*[\s\S]*?\*\//, '').replace(/^\/\/.*$/gm, '').trimStart();
  const isWrapped = stripped.startsWith('(function');
  if (isWrapped) return; // ✅ IIFE-wrapped, declarations are scoped

  // Extract top-level declarations
  const r = new RegExp(TOP_LEVEL_REGEX);
  let m;
  while ((m = r.exec(content)) !== null) {
    const name = m[1];
    if (!nameToFiles.has(name)) nameToFiles.set(name, new Set());
    nameToFiles.get(name).add(file);
  }
});

// Find names that appear in more than one file
const conflicts = [];
for (const [name, files] of nameToFiles) {
  if (files.size > 1) {
    conflicts.push({ name, files: [...files] });
  }
}

if (conflicts.length === 0) {
  ok(`No top-level name conflicts across ${CLASSIC_SCRIPT_FILES.length} classic scripts`);
} else {
  conflicts.forEach(({ name, files }) => {
    console.error(`  ❌ "${name}" declared in ${files.length} files: ${files.join(', ')}`);
  });
  error(`${conflicts.length} top-level name conflicts found (wrap one of the files in an IIFE)`);
}

// === CHECK 10: No large inline <style> blocks ===
console.log('\n=== Check 10: Inline <style> blocks ===');

htmlFiles.forEach(htmlFile => {
  const content = readFileSync(htmlFile, 'utf-8');
  const rel = relative(ROOT, htmlFile);

  const stylePattern = /<style[^>]*>([\s\S]*?)<\/style>/g;
  let match;
  let blockNum = 0;
  while ((match = stylePattern.exec(content)) !== null) {
    blockNum++;
    const lines = match[1].split('\n').length;
    if (lines > 50) {
      warn(`${rel}: inline <style> block #${blockNum} has ${lines} lines (should be extracted)`);
    }
  }
});

// === CHECK 11: ES module imports resolve ===
console.log('\n=== Check 11: ES module imports ===');

function findJsFiles(dir) {
  const results = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== '.git' && entry.name !== 'QNotify') {
      results.push(...findJsFiles(fullPath));
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
      results.push(fullPath);
    }
  }
  return results;
}

const jsFiles = findJsFiles(join(ROOT, 'src'));
let brokenImports = 0;

jsFiles.forEach(jsFile => {
  const content = readFileSync(jsFile, 'utf-8');
  const rel = relative(ROOT, jsFile);

  // Find ES module imports
  const importPattern = /(?:import|export)\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = importPattern.exec(content)) !== null) {
    const importPath = match[1];

    // Skip npm packages (no .js extension, not relative)
    if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
      continue;
    }

    // Resolve relative to JS file's directory
    const jsDir = dirname(jsFile);
    let resolvedPath = resolve(jsDir, importPath);

    // If no extension, try .js
    if (!resolvedPath.endsWith('.js') && !resolvedPath.endsWith('.mjs')) {
      resolvedPath += '.js';
    }

    if (!existsSync(resolvedPath)) {
      console.error(`  ❌ Broken import in ${rel}: ${importPath}`);
      brokenImports++;
    }
  }
});

if (brokenImports === 0) {
  ok(`All ES module imports resolve (${jsFiles.length} JS files checked)`);
} else {
  error(`${brokenImports} broken imports found`);
}

// === CHECK 12: Function call sites have definitions (catches the v2.1.1 bug class) ===
console.log('\n=== Check 12: Undefined function references ===');
//
// This check catches the bug class that v2.1.1 fixed: a function called
// in N places but defined in ZERO places. The classic symptom was
// `_createUserDocViaServer` being called at lines 402 and 464 but never
// defined → ReferenceError at runtime, caught by outer try/catch, user
// silently signed out with no error message.
//
// Algorithm: for each .js file, extract every function/method definition
// AND every `NAME(` call site (excluding method calls like `obj.NAME(`).
// A call site is "unresolved" if NAME is not defined in the same file AND
// not in the known-safe global list (builtins + window.* + imported names).
//
// We only flag calls that match `_`-prefixed identifiers (the project
// convention for "private but cross-file" functions) to keep noise low.
// This catches the high-risk case where someone references a helper that
// was renamed, deleted, or never created.
//
// Definition patterns we recognize:
//   - `function NAME(`            — top-level function declaration
//   - `async function NAME(`      — async top-level function declaration
//   - `NAME(...) {`               — class method (inside `class { ... }`)
//   - `async NAME(...) {`         — async class method
//   - `const NAME = (...) =>`     — arrow function assignment
//   - `const NAME = async (...) =>` — async arrow function assignment
//   - `const NAME = function`     — function expression assignment
//   - `(const|let|var) NAME = ...` — variable assignment (callbacks stored as vars)
//     We treat ANY variable named `_xxx` as "defined" because it might be
//     a callback stored for later invocation. This is more permissive but
//     avoids false positives like `_onAnswerCb = cb; _onAnswerCb();`.

const FN_DEF_REGEX = /(?:async\s+)?function\s+([A-Za-z_]\w*)\s*\(/g;
const METHOD_DEF_REGEX = /(?:async\s+)?([A-Za-z_]\w*)\s*\([^)]*\)\s*\{/g;
const ARROW_DEF_REGEX = /(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g;
const VAR_DEF_REGEX = /(?:const|let|var)\s+(_[A-Za-z_]\w*)\s*=/g;  // any var assignment to _xxx
const PRIVATE_CALL_REGEX = /(?<![\w.$])(_[A-Za-z]\w*)\s*\(/g;

// Known-safe globals (window.* + JS builtins + AlbEdu conventions)
const SAFE_GLOBALS = new Set([
  // JS builtins that start with _ (rare but valid)
  '_iterator', '_propertyIsEnumerable',
]);

let undefinedPrivateCalls = 0;

function collectDefinitions(content) {
  const defs = new Set();
  let m;
  let r;
  r = new RegExp(FN_DEF_REGEX);       while ((m = r.exec(content)) !== null) defs.add(m[1]);
  r = new RegExp(METHOD_DEF_REGEX);   while ((m = r.exec(content)) !== null) defs.add(m[1]);
  r = new RegExp(ARROW_DEF_REGEX);    while ((m = r.exec(content)) !== null) defs.add(m[1]);
  r = new RegExp(VAR_DEF_REGEX);      while ((m = r.exec(content)) !== null) defs.add(m[1]);
  return defs;
}

jsFiles.forEach(jsFile => {
  const rawContent = readFileSync(jsFile, 'utf8');
  const rel = relative(ROOT, jsFile);

  // Strip only comments (line + block), NOT strings.
  // The previous implementation stripped strings too, which broke when
  // function definitions contained string literals with special chars
  // (e.g. `function _shadeColor(hex, pct) {` after a line containing a
  // template literal that the state machine lost track of).
  //
  // We use a careful state machine that:
  //   - Tracks line/block comments
  //   - Tracks single/double/template string state to NOT mistake
  //     comment-like sequences inside strings as comment starts
  //   - PRESERVES string contents (replaces with safe placeholder)
  //     so function definitions inside template literals (rare) still work
  function stripComments(src) {
    let out = '';
    let i = 0;
    let state = 'code'; // 'code' | 'lineComment' | 'blockComment' | 'singleStr' | 'doubleStr' | 'templateStr'
    while (i < src.length) {
      const c = src[i];
      const c2 = src[i + 1];
      if (state === 'code') {
        if (c === '/' && c2 === '/') { state = 'lineComment'; i += 2; continue; }
        if (c === '/' && c2 === '*') { state = 'blockComment'; i += 2; continue; }
        if (c === "'")  { state = 'singleStr';   out += "'"; i++; continue; }
        if (c === '"')  { state = 'doubleStr';   out += '"'; i++; continue; }
        if (c === '`')  { state = 'templateStr'; out += '`'; i++; continue; }
        out += c; i++;
      } else if (state === 'lineComment') {
        if (c === '\n') { state = 'code'; out += '\n'; }
        i++;
      } else if (state === 'blockComment') {
        if (c === '*' && c2 === '/') { state = 'code'; i += 2; }
        else i++;
      } else if (state === 'singleStr' || state === 'doubleStr') {
        if (c === '\\') { out += c + (c2 || ''); i += 2; continue; }
        const quote = state === 'singleStr' ? "'" : '"';
        if (c === quote) state = 'code';
        out += c;
        i++;
      } else if (state === 'templateStr') {
        if (c === '\\') { out += c + (c2 || ''); i += 2; continue; }
        if (c === '`') state = 'code';
        // Note: ${...} inside template literal — we treat the whole template
        // as a string. This means we'd miss a function call inside ${...},
        // but that's a false-negative-safe direction (better to miss a real
        // bug than to flag a non-bug).
        out += c;
        i++;
      }
    }
    return out;
  }

  const content = stripComments(rawContent);
  const defs = collectDefinitions(content);

  // Collect call sites — also skip property access (`.foo()` and `obj.foo()`)
  // by requiring NO `.` immediately before AND not being part of `obj._x`
  // access pattern. The regex already handles `.foo()` via the negative
  // lookbehind `(?<![\w.$])`. We additionally filter out property access
  // patterns by checking the character before the match in the source.
  const calls = new Set();
  const callRegex = new RegExp(PRIVATE_CALL_REGEX, 'g');
  let m;
  while ((m = callRegex.exec(content)) !== null) {
    calls.add(m[1]);
  }

  // Find unresolved calls
  for (const call of calls) {
    if (defs.has(call)) continue;            // defined in same file ✅
    if (SAFE_GLOBALS.has(call)) continue;    // known global ✅
    // Check if it's defined in ANY other JS file in the project
    let foundElsewhere = false;
    for (const otherFile of jsFiles) {
      if (otherFile === jsFile) continue;
      try {
        const otherContent = stripComments(readFileSync(otherFile, 'utf8'));
        const otherDefs = collectDefinitions(otherContent);
        if (otherDefs.has(call)) { foundElsewhere = true; break; }
      } catch (_) {}
    }
    if (!foundElsewhere) {
      console.error(`  ❌ ${rel}: undefined function call "${call}()"`);
      undefinedPrivateCalls++;
    }
  }
});

if (undefinedPrivateCalls === 0) {
  ok(`No undefined private function references (catches v2.1.1-style bugs)`);
} else {
  error(`${undefinedPrivateCalls} undefined private function references found`);
}

// === SUMMARY ===
console.log('\n' + '='.repeat(60));
console.log(`Verification complete: ${errors} errors, ${warnings} warnings`);
console.log('='.repeat(60));

if (errors > 0) {
  console.log('\n❌ STRUCTURE VERIFICATION FAILED');
  process.exit(1);
} else if (warnings > 0) {
  console.log('\n⚠️  Structure OK with warnings');
  process.exit(0);
} else {
  console.log('\n✅ STRUCTURE VERIFICATION PASSED');
  process.exit(0);
}
