#!/usr/bin/env python3
"""
fix_missing_boot_notify.py — Add boot.js + notify.js to pages that have
the partial head (supabase-client.js, repository.js, sanitize.js) but
are missing boot.js and notify.js. These pages were missed by the
earlier add_notify_js.py because that script keyed off boot.js.
"""
import re
from pathlib import Path

ROOT = Path('/home/z/my-project/work/AlbEdu')

def find_pages():
    return [p for p in ROOT.rglob('*.html')
            if 'node_modules' not in p.parts and p.name != 'PAGE-TEMPLATE.html']

def rel_prefix(page_path):
    rel = page_path.relative_to(ROOT)
    depth = len(rel.parts) - 1
    return '' if depth == 0 else '../' * depth

def process_page(page):
    content = page.read_text(encoding='utf-8')
    # Skip redirect stubs
    if 'http-equiv="refresh"' in content:
        return False
    # Only process pages that have sanitize.js (partial head) but not boot.js
    if 'src/security/sanitize.js' not in content:
        return False
    if 'src/shared/boot.js' in content and 'src/shared/notify.js' in content:
        return False

    rel = rel_prefix(page)
    changed = False

    # Add boot.js after sanitize.js if missing
    if 'src/shared/boot.js' not in content:
        sanitize_pattern = re.compile(
            r'(<script\s+defer\s+src="' + re.escape(rel) + r'src/security/sanitize\.js"></script>)'
        )
        boot_line = f'<script defer src="{rel}src/shared/boot.js"></script>'
        content, count = sanitize_pattern.subn(
            lambda m: m.group(1) + '\n    ' + boot_line,
            content, count=1
        )
        if count > 0:
            changed = True

    # Add notify.js after boot.js if missing
    if 'src/shared/notify.js' not in content and 'src/shared/boot.js' in content:
        boot_pattern = re.compile(
            r'(<script\s+defer\s+src="' + re.escape(rel) + r'src/shared/boot\.js"></script>)'
        )
        notify_line = f'<script defer src="{rel}src/shared/notify.js"></script>'
        content, count = boot_pattern.subn(
            lambda m: m.group(1) + '\n    ' + notify_line,
            content, count=1
        )
        if count > 0:
            changed = True

    if changed:
        page.write_text(content, encoding='utf-8')
    return changed

def main():
    pages = find_pages()
    changed = 0
    for page in sorted(pages):
        rel = page.relative_to(ROOT)
        if process_page(page):
            print(f'  ✓ fixed boot.js + notify.js in {rel}')
            changed += 1
    print(f'\nDone. {changed} pages fixed.')

if __name__ == '__main__':
    main()
