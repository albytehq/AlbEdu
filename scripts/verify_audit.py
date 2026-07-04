#!/usr/bin/env python3
"""
verify_audit.py — AlbEdu Phase 6 · Automated Verification Suite

Runs automated checks to prevent regression in:
  1. Duplicate font imports
  2. Repeated remote font loads (Material Symbols etc.)
  3. `type="module"src=` syntax mistakes
  4. Legacy Firebase shim references in NEW code
     (src/platform/, src/shared/, src/security/, src/identity/ must not reference firebase shim)
  5. Unsafe DOM injection (innerHTML = without sanitize)
  6. Missing defer on non-critical scripts
  7. Regression in shell-first rendering (critical-css.js missing from pages)

Usage:
  python3 scripts/verify_audit.py
"""

import re
import sys
from pathlib import Path

ROOT = Path('/home/z/my-project/work/AlbEdu')

class Result:
    def __init__(self):
        self.errors = []
        self.warnings = []
        self.passed = 0
    def ok(self, msg):
        self.passed += 1
    def warn(self, msg):
        self.warnings.append(msg)
    def error(self, msg):
        self.errors.append(msg)
    def exit_code(self):
        return 1 if self.errors else 0

result = Result()

def find_files(pattern):
    return sorted(ROOT.rglob(pattern))

# ─────────────────────────────────────────────────────────────────────────
# Check 1: No duplicate Google Fonts <link> tags in any page
# ─────────────────────────────────────────────────────────────────────────
def check_duplicate_fonts():
    print('\n[1] Checking for duplicate font <link> tags...')
    font_pattern = re.compile(
        r'<link\s+[^>]*href="https://fonts\.googleapis\.com/[^"]+"',
        re.IGNORECASE
    )
    found = False
    for html in find_files('*.html'):
        if 'node_modules' in html.parts: continue
        if html.name == 'PAGE-TEMPLATE.html': continue
        content = html.read_text(encoding='utf-8')
        matches = font_pattern.findall(content)
        # Pages may have ONE font link via the legacy head, but new architecture
        # expects zero (fonts.js handles it).
        if matches:
            rel = html.relative_to(ROOT)
            result.warn(f'{rel}: still has {len(matches)} Google Fonts <link> tag(s) — should be handled by fonts.js')
            found = True
    if not found:
        result.ok('No duplicate Google Fonts links found')

# ─────────────────────────────────────────────────────────────────────────
# Check 2: No Material Symbols font references in HTML pages
# ─────────────────────────────────────────────────────────────────────────
def check_material_symbols_html():
    print('\n[2] Checking for Material Symbols font usage in HTML...')
    found = False
    for html in find_files('*.html'):
        if 'node_modules' in html.parts: continue
        if html.name == 'PAGE-TEMPLATE.html': continue
        content = html.read_text(encoding='utf-8')
        if 'fonts.googleapis.com/css2?family=Material+Symbols' in content:
            rel = html.relative_to(ROOT)
            result.error(f'{rel}: still loads Material Symbols font — replace with SVG icons (src/shared/icons/icons.js)')
            found = True
    if not found:
        result.ok('No Material Symbols font references in HTML pages')

# ─────────────────────────────────────────────────────────────────────────
# Check 3: No broken `type="module"src=` syntax in any HTML
# ─────────────────────────────────────────────────────────────────────────
def check_broken_module_syntax():
    print('\n[3] Checking for broken `type="module"src=` syntax...')
    found = False
    broken_pattern = re.compile(r'type="module"src=', re.IGNORECASE)
    for html in find_files('*.html'):
        if 'node_modules' in html.parts: continue
        content = html.read_text(encoding='utf-8')
        if broken_pattern.search(content):
            rel = html.relative_to(ROOT)
            result.error(f'{rel}: broken `type="module"src=` syntax — must be `type="module" src=` with space')
            found = True
    if not found:
        result.ok('No broken module script syntax found')

# ─────────────────────────────────────────────────────────────────────────
# Check 4: New code (platform/shared/security/identity) must NOT reference
# legacy Firebase shim globals (firebaseAuth, firebaseDb, firebase-ready)
# ─────────────────────────────────────────────────────────────────────────
def check_no_legacy_refs_in_new_code():
    print('\n[4] Checking new code for legacy Firebase shim references...')
    legacy_pattern = re.compile(
        r'window\.(firebaseAuth|firebaseDb|firebase\b|sb\b)|'
        r'firebase-ready|firebase-error|__firebaseReady|__firebaseError',
        re.IGNORECASE
    )
    # New code lives in these dirs:
    new_code_dirs = [
        ROOT / 'src' / 'platform',
        ROOT / 'src' / 'shared',
        ROOT / 'src' / 'security',
        ROOT / 'src' / 'identity',
    ]
    found = False
    for d in new_code_dirs:
        if not d.exists(): continue
        for js in d.rglob('*.js'):
            content = js.read_text(encoding='utf-8')
            # Allow references inside comments — strip them
            content_no_comments = re.sub(r'//.*$', '', content, flags=re.MULTILINE)
            content_no_comments = re.sub(r'/\*.*?\*/', '', content_no_comments, flags=re.DOTALL)
            matches = legacy_pattern.findall(content_no_comments)
            if matches:
                rel = js.relative_to(ROOT)
                result.error(f'{rel}: new code references legacy Firebase shim ({matches[0]}) — must use AlbEdu.supabase.* / AlbEdu.repository.*')
                found = True
    if not found:
        result.ok('New code does not reference legacy Firebase shim')

# ─────────────────────────────────────────────────────────────────────────
# Check 5: Unsafe innerHTML = without sanitize call
# (Allow el.innerHTML = AlbEdu.icon(...) and el.innerHTML = '' (clear))
# ─────────────────────────────────────────────────────────────────────────
def check_unsafe_inner_html():
    print('\n[5] Checking for unsafe innerHTML assignments...')
    # Match: el.innerHTML = 'something' or el.innerHTML = `something`
    # where 'something' is NOT:
    #   - empty string ''
    #   - AlbEdu.icon(...)
    #   - sanitizeHtml(...)
    #   - already-escaped via escapeHTML(...)
    unsafe_pattern = re.compile(
        r'\.innerHTML\s*=\s*([^;]+);',
        re.IGNORECASE
    )
    found_count = 0
    for js in find_files('*.js'):
        if 'node_modules' in js.parts: continue
        if js.name == 'icons.js': continue  # icon system itself emits HTML
        content = js.read_text(encoding='utf-8')
        # Strip comments
        content_nc = re.sub(r'//.*$', '', content, flags=re.MULTILINE)
        content_nc = re.sub(r'/\*.*?\*/', '', content_nc, flags=re.DOTALL)
        for match in unsafe_pattern.finditer(content_nc):
            rhs = match.group(1).strip()
            # Allow clear
            if rhs in ("''", '""', '``'):
                continue
            # Allow safe helpers
            if rhs.startswith('AlbEdu.icon') or rhs.startswith('window.AlbEdu.icon'):
                continue
            if rhs.startswith('sanitizeHtml') or rhs.startswith('AlbEdu.sanitize'):
                continue
            if rhs.startswith('escapeHtml') or rhs.startswith('escapeHTML'):
                continue
            # Allow template literals that use _esc/_escapeHtml/_escAttr/_sanitizeHTML
            # anywhere in the expression — these are the project's sanitize helpers.
            # The verifier can't fully parse template literal data flow, so we
            # treat any template literal containing a sanitize call as safe.
            if '`' in rhs:
                if any(fn in rhs for fn in ['_esc(', '_escAttr(', '_escapeHtml(', '_escapeHTML(',
                                              '_sanitizeHTML(', '_sanitizeHtml(',
                                              'AlbEdu.sanitize', 'AlbEdu._esc',
                                              'window.AlbEdu.sanitize']):
                    continue
                # [Item 1] Also allow template literals that only use t() —
                # translation strings are developer-controlled, not user-controlled.
                if 't(' in rhs and '${' in rhs:
                    # Check if ALL ${} interpolations are t() calls or static
                    import re as _re
                    interpolations = _re.findall(r'\$\{([^}]+)\}', rhs)
                    all_safe = all('t(' in interp or interp.strip().startswith("'") or interp.strip().startswith('"') for interp in interpolations)
                    if all_safe:
                        continue
            # Allow .map() chains that produce escaped output (heuristic:
            # the map callback contains a sanitize call)
            if '.map(' in rhs and any(fn in rhs for fn in ['_esc(', '_escAttr(', '_escapeHtml(',
                                                                       '_sanitizeHTML(', '_sanitizeHtml(']):
                continue
            # [Item 1] Allow static HTML strings (no ${} interpolation, no user data)
            if '`' not in rhs and '$' not in rhs and "'" in rhs:
                continue  # single-quoted static HTML string
            if '`' not in rhs and '$' not in rhs and '"' in rhs:
                continue  # double-quoted static HTML string
            # Allow clear/empty assignments
            if rhs.strip() in ("''", '""', '``'):
                continue
            # Flag anything else
            rel = js.relative_to(ROOT)
            # Find line number
            line_no = content[:match.start()].count('\n') + 1
            result.warn(f'{rel}:{line_no}: innerHTML assignment without sanitize — review for XSS')
            found_count += 1
    if found_count == 0:
        result.ok('No unsafe innerHTML assignments found')

# ─────────────────────────────────────────────────────────────────────────
# Check 6: Non-critical scripts in <head> should have defer or async
# ─────────────────────────────────────────────────────────────────────────
def check_defer_on_head_scripts():
    print('\n[6] Checking <head> scripts for defer/async...')
    script_pattern = re.compile(
        r'<script\s+([^>]*)src="([^"]+)"([^>]*)>\s*</script>',
        re.IGNORECASE
    )
    found = False
    for html in find_files('*.html'):
        if 'node_modules' in html.parts: continue
        if html.name == 'PAGE-TEMPLATE.html': continue
        content = html.read_text(encoding='utf-8')
        # Get the <head>...</head> portion
        head_match = re.search(r'<head[^>]*>(.*?)</head>', content, re.IGNORECASE | re.DOTALL)
        if not head_match: continue
        head = head_match.group(1)
        for sm in script_pattern.finditer(head):
            pre_attrs = sm.group(1) + ' ' + sm.group(3)
            src = sm.group(2)
            # Critical-css.js is intentionally synchronous — exempt
            if 'critical-css.js' in src: continue
            # If it's a module, it's deferred by default
            if 'type="module"' in pre_attrs or "type='module'" in pre_attrs: continue
            # Check for defer or async
            if 'defer' not in pre_attrs.lower() and 'async' not in pre_attrs.lower():
                rel = html.relative_to(ROOT)
                result.warn(f'{rel}: head script "{src}" missing defer/async — blocks HTML parser')
                found = True
    if not found:
        result.ok('All non-critical head scripts have defer or async')

# ─────────────────────────────────────────────────────────────────────────
# Check 7: Every page that renders UI must load critical-css.js
# ─────────────────────────────────────────────────────────────────────────
def check_critical_css_loaded():
    print('\n[7] Checking pages load critical-css.js...')
    # Skip redirect stubs (those with http-equiv refresh)
    found = False
    for html in find_files('*.html'):
        if 'node_modules' in html.parts: continue
        if html.name == 'PAGE-TEMPLATE.html': continue
        content = html.read_text(encoding='utf-8')
        # Skip redirect stubs
        if 'http-equiv="refresh"' in content: continue
        # Skip pages/404.html (redirect to /404.html)
        if html.name == '404.html' and 'pages/' in str(html.parent): continue
        if 'critical-css.js' not in content:
            rel = html.relative_to(ROOT)
            result.warn(f'{rel}: missing critical-css.js — first paint may flash')
            found = True
    if not found:
        result.ok('All UI pages load critical-css.js')

# ─────────────────────────────────────────────────────────────────────────
# Check 8: No `type="module"src=` syntax mistakes (also catches `type='module'src=`)
# ─────────────────────────────────────────────────────────────────────────
def check_module_script_spacing():
    print('\n[8] Checking module script tag spacing...')
    pattern = re.compile(r"type=[\"']module[\"']\s*src=", re.IGNORECASE)
    # Actually we want to FLAG cases where there's NO space between " and src
    bad_pattern = re.compile(r"type=[\"']module[\"']src=", re.IGNORECASE)
    found = False
    for html in find_files('*.html'):
        if 'node_modules' in html.parts: continue
        content = html.read_text(encoding='utf-8')
        if bad_pattern.search(content):
            rel = html.relative_to(ROOT)
            result.error(f'{rel}: `type="module"src=` missing space')
            found = True
    if not found:
        result.ok('All module script tags have proper spacing')

# ─────────────────────────────────────────────────────────────────────────
# Check 9: No supabase-api.js references (old shim, deleted)
# ─────────────────────────────────────────────────────────────────────────
def check_no_old_shim_refs():
    print('\n[9] Checking for references to deleted supabase-api.js...')
    found = False
    for f in find_files('*.html') + find_files('*.js'):
        if 'node_modules' in f.parts: continue
        if f.name == 'verify_audit.py': continue
        try:
            content = f.read_text(encoding='utf-8')
        except: continue
        if 'supabase-api.js' in content:
            rel = f.relative_to(ROOT)
            result.error(f'{rel}: references deleted src/utils/supabase-api.js — replace with src/platform/supabase-client.js')
            found = True
    if not found:
        result.ok('No references to deleted supabase-api.js')

# ─────────────────────────────────────────────────────────────────────────
# Stage 2 (final): No legacy bridge references anywhere
# ─────────────────────────────────────────────────────────────────────────
def check_no_legacy_bridge_anywhere():
    print('\n[10] Checking for legacy bridge references...')
    found = False
    # 1. src/legacy/ directory must not exist
    legacy_dir = ROOT / 'src' / 'legacy'
    if legacy_dir.exists():
        result.error(f'src/legacy/ directory still exists — delete it')
        found = True
    # 2. No HTML page should reference legacy/firebase-compat.js
    for html in find_files('*.html'):
        if 'node_modules' in html.parts: continue
        if html.name == 'PAGE-TEMPLATE.html': continue
        content = html.read_text(encoding='utf-8')
        if 'legacy/firebase-compat.js' in content:
            rel = html.relative_to(ROOT)
            result.error(f'{rel}: still loads legacy/firebase-compat.js — delete the <script> tag')
            found = True
    # 3. No JS file (except comments) should reference window.firebaseAuth/firebaseDb
    for js in (ROOT / 'src').rglob('*.js'):
        content = js.read_text(encoding='utf-8')
        content_no_comments = re.sub(r'//.*$', '', content, flags=re.MULTILINE)
        content_no_comments = re.sub(r'/\*.*?\*/', '', content_no_comments, flags=re.DOTALL)
        if re.search(r'window\.firebaseAuth|window\.firebaseDb|window\.firebase\.', content_no_comments):
            rel = js.relative_to(ROOT)
            result.error(f'{rel}: references window.firebaseAuth/firebaseDb — migrate to AlbEdu.supabase/repository')
            found = True
    if not found:
        result.ok('No legacy bridge references anywhere')

# ─────────────────────────────────────────────────────────────────────────
# QNotify v2: Verify QNotify is loaded via qnotify-loader.js (not inline bootstrap)
# QNotify is INTENTIONALLY kept as AlbEdu's native notification system.
# This check verifies that pages use the shared loader, not inline bootstraps.
# ─────────────────────────────────────────────────────────────────────────
def check_no_qnotify_loads():
    print('\n[10] Checking QNotify boot determinism (qnotify-loader.js)...')
    found_errors = False
    for html in find_files('*.html'):
        if 'node_modules' in html.parts: continue
        if html.name == 'PAGE-TEMPLATE.html': continue
        content = html.read_text(encoding='utf-8')
        # Pages that load QNotify CSS should also load qnotify-loader.js
        if 'public/QNotify/ui/' in content and 'qnotify-loader.js' not in content:
            rel = html.relative_to(ROOT)
            result.error(f'{rel}: loads QNotify CSS but missing qnotify-loader.js')
            found_errors = True
        # No inline QNotify bootstrap scripts should remain
        if 'import QNotify from' in content:
            rel = html.relative_to(ROOT)
            result.error(f'{rel}: has inline QNotify bootstrap — use qnotify-loader.js instead')
            found_errors = True
    if not found_errors:
        result.ok('QNotify loaded deterministically via qnotify-loader.js')

# ─────────────────────────────────────────────────────────────────────────
# Stage 3: No window.sb in new code (platform/, shared/, security/, identity/)
# ─────────────────────────────────────────────────────────────────────────
def check_no_window_sb_in_new_code():
    print('\n[11] Checking new code for window.sb references...')
    sb_pattern = re.compile(r'\bwindow\.sb\b')
    new_code_dirs = [
        ROOT / 'src' / 'platform',
        ROOT / 'src' / 'shared',
        ROOT / 'src' / 'security',
        ROOT / 'src' / 'identity',
    ]
    found = False
    for d in new_code_dirs:
        if not d.exists(): continue
        for js in d.rglob('*.js'):
            content = js.read_text(encoding='utf-8')
            content_no_comments = re.sub(r'//.*$', '', content, flags=re.MULTILINE)
            content_no_comments = re.sub(r'/\*.*?\*/', '', content_no_comments, flags=re.DOTALL)
            if sb_pattern.search(content_no_comments):
                rel = js.relative_to(ROOT)
                result.error(f'{rel}: new code references window.sb — must use AlbEdu.supabase.client')
                found = True
    if not found:
        result.ok('New code does not reference window.sb')

# ─────────────────────────────────────────────────────────────────────────
# Stage 3: Pages that have notify consumers must load notify.js
# ─────────────────────────────────────────────────────────────────────────
def check_notify_js_loaded_on_pages_with_consumers():
    print('\n[12] Checking notify.js loaded on pages with notify consumers...')
    # Pages with consumers: any page that loads auth/main.js OR has an inline
    # script that uses window.notify. For simplicity, check pages that load
    # any src/auth/ or src/pages/ script.
    consumer_pattern = re.compile(r'<script\s+[^>]*src="[^"]*src/(?:auth|pages|utils|profile)/[^"]+\.js"', re.IGNORECASE)
    found = False
    for html in find_files('*.html'):
        if 'node_modules' in html.parts: continue
        if html.name == 'PAGE-TEMPLATE.html': continue
        content = html.read_text(encoding='utf-8')
        if 'http-equiv="refresh"' in content: continue  # redirect stub
        if not consumer_pattern.search(content): continue
        if 'src/shared/notify.js' not in content:
            rel = html.relative_to(ROOT)
            result.warn(f'{rel}: loads consumer scripts but missing src/shared/notify.js')
            found = True
    if not found:
        result.ok('All pages with notify consumers load notify.js')

# ─────────────────────────────────────────────────────────────────────────
# Stage 3: Skip link present for accessibility
# ─────────────────────────────────────────────────────────────────────────
def check_skip_link_present():
    print('\n[13] Checking for skip-link (accessibility)...')
    found = False
    for html in find_files('*.html'):
        if 'node_modules' in html.parts: continue
        if html.name == 'PAGE-TEMPLATE.html': continue
        content = html.read_text(encoding='utf-8')
        if 'http-equiv="refresh"' in content: continue  # redirect stub
        # Look for skip-link class OR skip-to-main class
        if 'skip-link' not in content and 'skip-to-main' not in content and 'albedu-skip-link' not in content:
            rel = html.relative_to(ROOT)
            result.warn(f'{rel}: missing skip-link for keyboard accessibility')
            found = True
    if not found:
        result.ok('Skip-link present on all pages')

# ─────────────────────────────────────────────────────────────────────────
# Stage 3: <html lang="id"> present (accessibility)
# ─────────────────────────────────────────────────────────────────────────
def check_lang_attr_present():
    print('\n[14] Checking for <html lang> attribute (accessibility)...')
    found = False
    for html in find_files('*.html'):
        if 'node_modules' in html.parts: continue
        if html.name == 'PAGE-TEMPLATE.html': continue
        content = html.read_text(encoding='utf-8')
        if 'http-equiv="refresh"' in content: continue  # redirect stub
        # Look for <html lang="...">
        if not re.search(r'<html\s+[^>]*lang="[^"]+"', content, re.IGNORECASE):
            rel = html.relative_to(ROOT)
            result.warn(f'{rel}: missing <html lang> attribute')
            found = True
    if not found:
        result.ok('All pages have <html lang> attribute')

# ─────────────────────────────────────────────────────────────────────────
# Run all checks
# ─────────────────────────────────────────────────────────────────────────
print('═══════════════════════════════════════════════════════════════')
print(' AlbEdu — Automated Verification Suite (Stage 3)')
print('═══════════════════════════════════════════════════════════════')

check_duplicate_fonts()
check_material_symbols_html()
check_broken_module_syntax()
check_no_legacy_refs_in_new_code()
check_unsafe_inner_html()
check_defer_on_head_scripts()
check_critical_css_loaded()
check_module_script_spacing()
check_no_old_shim_refs()
check_no_legacy_bridge_anywhere()
check_no_qnotify_loads()
check_no_window_sb_in_new_code()
check_notify_js_loaded_on_pages_with_consumers()
check_skip_link_present()
check_lang_attr_present()

print('\n═══════════════════════════════════════════════════════════════')
print(f' PASSED: {result.passed} checks')
print(f' WARNINGS: {len(result.warnings)}')
print(f' ERRORS: {len(result.errors)}')
print('═══════════════════════════════════════════════════════════════')
if result.warnings:
    print('\nWarnings:')
    for w in result.warnings:
        print(f'  ⚠ {w}')
if result.errors:
    print('\nErrors:')
    for e in result.errors:
        print(f'  ❌ {e}')
sys.exit(result.exit_code())
