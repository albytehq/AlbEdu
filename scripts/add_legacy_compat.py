#!/usr/bin/env python3
"""
add_legacy_compat.py — Add the firebase-compat.js script to every page
that already loads shared/boot.js but doesn't yet load the legacy compat.

The legacy compat bridge is needed because the existing consumer files
(auth/main.js, take-assessment.js, etc.) still reference window.firebaseAuth
and window.firebaseDb. The compat bridge aliases those to the new native
platform layer (AlbEdu.supabase + AlbEdu.repository).

Once consumers are migrated to use AlbEdu.* directly, this script (and
the legacy/firebase-compat.js file) can be deleted.
"""

import re
from pathlib import Path

ROOT = Path('/home/z/my-project/work/AlbEdu')

def find_pages():
    pages = []
    for html in ROOT.rglob('*.html'):
        if 'node_modules' in html.parts:
            continue
        if html.name == 'PAGE-TEMPLATE.html':
            continue
        pages.append(html)
    return pages

def rel_prefix(page_path):
    rel = page_path.relative_to(ROOT)
    depth = len(rel.parts) - 1
    if depth == 0:
        return ''
    return '../' * depth

def process_page(page):
    content = page.read_text(encoding='utf-8')
    if 'legacy/firebase-compat.js' in content:
        return False
    # Look for the line that loads shared/boot.js
    rel = rel_prefix(page)
    boot_pattern = re.compile(
        r'<script\s+defer\s+src="' + re.escape(rel) + r'src/shared/boot\.js"></script>\s*\n?'
    )
    compat_line = f'<script defer src="{rel}src/legacy/firebase-compat.js"></script>\n'
    new_content, count = boot_pattern.subn(lambda m: m.group(0) + '    ' + compat_line + '    ', content, count=1)
    if count == 0:
        return False
    page.write_text(new_content, encoding='utf-8')
    return True

def main():
    pages = find_pages()
    print(f'Found {len(pages)} pages')
    changed = 0
    for page in sorted(pages):
        rel = page.relative_to(ROOT)
        if process_page(page):
            print(f'  ✓ added legacy-compat to {rel}')
            changed += 1
    print(f'\nDone. {changed} pages updated.')

if __name__ == '__main__':
    main()
