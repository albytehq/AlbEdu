#!/usr/bin/env python3
"""
fix_page_heads.py — AlbEdu Phase 2 Boot Path Cleanup

For every HTML page in the project, replace the duplicated per-page font loading
+ per-page Supabase SDK loading + per-page Material Symbols loading with the
shared head strategy:
  - critical-css.js (synchronous, tiny)
  - tokens.css (deferred)
  - shared/head/fonts.js (single font strategy)
  - shared/icons/icons.js (SVG icons, replaces Material Symbols font)
  - platform/supabase-client.js (native Supabase, replaces shim)
  - platform/repository.js (typed table access)
  - security/sanitize.js (DOM sanitization)
  - shared/boot.js (boot orchestrator)

Strategy:
  1. Compute the REL prefix from the page's location (root/pages/pages/admin).
  2. Remove every <link rel=stylesheet href=...fonts.googleapis.com...> tag.
  3. Remove every <link rel=preconnect href=...fonts.googleapis...> tag.
  4. Remove the legacy <script src=...supabase-api.js...> tag (replaced by platform).
  5. Replace the first <link rel=stylesheet href=tokens.css> tag with the shared
     head block (critical-css + tokens + shared modules), preserving the REL prefix.
  6. Change any remaining <script src=...supabase-js... defer> to async.
  7. Leave page-specific CSS/JS alone.

Also removes the legacy inline theme-FOUC script (now handled by critical-css.js).
"""

import re
import sys
from pathlib import Path

ROOT = Path('/home/z/my-project/work/AlbEdu')

# Pages to process — every .html file under ROOT (excluding PAGE-TEMPLATE.html)
def find_pages():
    pages = []
    for html in ROOT.rglob('*.html'):
        if 'node_modules' in html.parts:
            continue
        if html.name == 'PAGE-TEMPLATE.html':
            continue
        pages.append(html)
    return pages

# Compute the relative prefix from the page to ROOT
def rel_prefix(page_path):
    rel = page_path.relative_to(ROOT)
    depth = len(rel.parts) - 1  # subtract 1 for the filename
    if depth == 0:
        return ''
    return '../' * depth

# Build the shared head block (replaces the tokens.css line)
def build_shared_head_block(rel):
    return f'''    <!-- ═══ CRITICAL CSS (synchronous, tiny — paints shell in first paint) ═══ -->
    <script src="{rel}src/shared/head/critical-css.js"></script>

    <!-- ═══ Design tokens ═══ -->
    <link rel="stylesheet" href="{rel}styles/tokens.css">

    <!-- ═══ Deferred shared modules (run after parse, in order) ═══ -->
    <script defer src="{rel}src/shared/head/fonts.js"></script>
    <script defer src="{rel}src/shared/icons/icons.js"></script>
    <script defer src="{rel}src/platform/supabase-client.js"></script>
    <script defer src="{rel}src/platform/repository.js"></script>
    <script defer src="{rel}src/security/sanitize.js"></script>
    <script defer src="{rel}src/shared/boot.js"></script>
    <script defer src="{rel}src/legacy/firebase-compat.js"></script>'''

# Patterns to remove
FONT_LINK_RE = re.compile(
    r'\s*<link\s+rel="stylesheet"\s+href="https://fonts\.googleapis\.com/[^"]*"\s*/?>\s*\n?',
    re.IGNORECASE
)
PRECONNECT_RE = re.compile(
    r'\s*<link\s+rel="preconnect"\s+href="https://fonts\.(googleapis|gstatic)\.com"[^>]*>\s*\n?',
    re.IGNORECASE
)
SUPABASE_API_RE = re.compile(
    r'\s*<script\s+[^>]*src="[^"]*src/utils/supabase-api\.js"[^>]*>\s*</script>\s*\n?',
    re.IGNORECASE
)
LEGACY_THEME_FOUC_RE = re.compile(
    r'\s*<!--\s*v0\.742\.9[^<]*?Apply default theme[^<]*?-->\s*<script>\s*\(function\s*\(\)\s*\{[^}]*?localStorage\.getItem\([^)]*\)[^}]*?\}\)\(\);\s*</script>\s*\n?',
    re.IGNORECASE | re.DOTALL
)
# Comment marker
FONT_COMMENT_RE = re.compile(
    r'\s*<!--\s*F1\+F2 fix[^>]*?-->\s*\n?',
    re.IGNORECASE
)

# Convert <script src="...supabase-js..." defer> to async
def fix_supabase_sdk_async(content):
    # Match: <script ... src="...supabase-js@2/dist/umd/supabase.min.js" ... defer ...>
    pattern = re.compile(
        r'(<script\s+[^>]*?src="https://cdn\.jsdelivr\.net/npm/@supabase/supabase-js@2/dist/umd/supabase\.min\.js"[^>]*?)\s+defer([^>]*>)',
        re.IGNORECASE
    )
    return pattern.sub(r'\1 async\2', content)

# Replace tokens.css line with shared head block (only if not already done)
def replace_tokens_with_shared(content, rel):
    # Skip if already has critical-css.js (already migrated)
    if 'critical-css.js' in content:
        return content

    # Match: <link rel="stylesheet" href="{rel}styles/tokens.css">
    # Allow any whitespace/quote style
    pattern = re.compile(
        r'<link\s+rel="stylesheet"\s+href="[^"]*?styles/tokens\.css"\s*/?>',
        re.IGNORECASE
    )
    replacement = build_shared_head_block(rel)
    new_content, count = pattern.subn(replacement, content, count=1)
    if count == 0:
        # No tokens.css found — that's OK for landing pages without it
        return content
    return new_content

def process_page(page_path):
    try:
        content = page_path.read_text(encoding='utf-8')
    except Exception as e:
        print(f'  ⚠ read error: {e}')
        return False

    original = content
    rel = rel_prefix(page_path)

    # 1. Remove duplicate font <link> tags
    content = FONT_LINK_RE.sub('', content)
    # 2. Remove preconnect tags
    content = PRECONNECT_RE.sub('', content)
    # 3. Remove supabase-api.js script (replaced by platform layer)
    content = SUPABASE_API_RE.sub('', content)
    # 4. Remove legacy theme FOUC inline script (handled by critical-css.js)
    content = LEGACY_THEME_FOUC_RE.sub('', content)
    # 5. Remove the F1+F2 fix comment marker
    content = FONT_COMMENT_RE.sub('', content)
    # 6. Replace tokens.css with shared head block (only if not already migrated)
    content = replace_tokens_with_shared(content, rel)
    # 7. Convert remaining supabase-js defer → async
    content = fix_supabase_sdk_async(content)

    if content == original:
        return False

    try:
        page_path.write_text(content, encoding='utf-8')
        return True
    except Exception as e:
        print(f'  ⚠ write error: {e}')
        return False

def main():
    pages = find_pages()
    print(f'Found {len(pages)} pages to process')
    changed = 0
    for page in sorted(pages):
        rel_path = page.relative_to(ROOT)
        if process_page(page):
            print(f'  ✓ migrated {rel_path}')
            changed += 1
        else:
            print(f'  · skipped {rel_path} (no changes needed or already migrated)')
    print(f'\nDone. {changed}/{len(pages)} pages migrated.')

if __name__ == '__main__':
    main()
