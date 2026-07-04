#!/usr/bin/env python3
"""
fix_module_types.py — Fix script loading types:
  1. qnotify-loader.js: defer → type="module" (uses dynamic import)
  2. resilience.js: already type="module" (verified)
"""
import re
from pathlib import Path

ROOT = Path('/home/z/my-project/work/AlbEdu')

def find_pages():
    return [p for p in ROOT.rglob('*.html')
            if 'node_modules' not in p.parts and p.name != 'PAGE-TEMPLATE.html']

def process_page(page):
    content = page.read_text(encoding='utf-8')
    changed = False

    # Fix qnotify-loader.js: defer → type="module"
    # Pattern: <script defer src="...qnotify-loader.js"></script>
    old_qnotify = re.compile(
        r'<script\s+defer\s+src="([^"]*qnotify-loader\.js)"></script>',
        re.IGNORECASE
    )
    new_content, qnotify_count = old_qnotify.subn(
        lambda m: f'<script type="module" src="{m.group(1)}"></script>',
        content
    )
    if qnotify_count > 0:
        changed = True
        content = new_content

    # Fix resilience.js: ensure it's type="module" not defer
    # Pattern: <script type="module" src="...resilience.js"></script>  ← already correct
    # Pattern: <script defer src="...resilience.js"></script>  ← needs fix
    old_resilience = re.compile(
        r'<script\s+defer\s+src="([^"]*resilience\.js)"></script>',
        re.IGNORECASE
    )
    new_content, resilience_count = old_resilience.subn(
        lambda m: f'<script type="module" src="{m.group(1)}"></script>',
        content
    )
    if resilience_count > 0:
        changed = True
        content = new_content

    if changed:
        page.write_text(content, encoding='utf-8')
    return changed

def main():
    pages = find_pages()
    changed = 0
    for page in sorted(pages):
        rel = page.relative_to(ROOT)
        if process_page(page):
            print(f'  ✓ fixed script types: {rel}')
            changed += 1
    print(f'\nDone. {changed} pages fixed.')

if __name__ == '__main__':
    main()
