#!/usr/bin/env python3
"""
consolidate_qnotify_css.py — Phase C: Replace 4 QNotify CSS <link> tags
with a single <link> to qnotify.css (merged file).
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

# Match any of the 4 QNotify CSS links
QNOTIFY_CSS_RE = re.compile(
    r'\s*<!--\s*QNotify Styles\s*-->\s*\n?'
    r'(\s*<link\s+rel="stylesheet"\s+href="[^"]*public/QNotify/ui/(?:notify|dialog|label|Readnote)\.css"\s*/?>\s*\n?)+',
    re.IGNORECASE
)

def process_page(page):
    content = page.read_text(encoding='utf-8')
    if 'qnotify.css' in content:
        return False  # already migrated

    rel = rel_prefix(page)
    merged_css = f'    <!-- QNotify Styles (consolidated) -->\n    <link rel="stylesheet" href="{rel}public/QNotify/ui/qnotify.css">'

    new_content, count = QNOTIFY_CSS_RE.subn(merged_css, content, count=1)
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
            print(f'  ✓ consolidated CSS: {rel}')
            changed += 1
    print(f'\nDone. {changed} pages migrated to single qnotify.css.')

if __name__ == '__main__':
    main()
