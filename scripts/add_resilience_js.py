#!/usr/bin/env python3
"""
add_resilience_js.py — Add src/shared/resilience.js to all pages that
load supabase-client.js. resilience.js is an ES module (imports Actly),
so it must be loaded as <script type="module">.
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
    if 'resilience.js' in content:
        return False
    if 'supabase-client.js' not in content:
        return False
    if 'http-equiv="refresh"' in content:
        return False

    rel = rel_prefix(page)
    # resilience.js is an ES module (imports Actly) — load as type="module"
    resilience_line = f'<script type="module" src="{rel}src/shared/resilience.js"></script>'

    # Insert after supabase-client.js
    pattern = re.compile(
        r'(<script\s+defer\s+src="' + re.escape(rel) + r'src/platform/supabase-client\.js"></script>)'
    )
    new_content, count = pattern.subn(
        lambda m: m.group(1) + '\n    ' + resilience_line,
        content, count=1
    )
    if count == 0:
        return False

    page.write_text(new_content, encoding='utf-8')
    return True

def main():
    pages = find_pages()
    changed = 0
    for page in sorted(pages):
        rel = page.relative_to(ROOT)
        if process_page(page):
            print(f'  ✓ added resilience.js to {rel}')
            changed += 1
    print(f'\nDone. {changed} pages updated.')

if __name__ == '__main__':
    main()
