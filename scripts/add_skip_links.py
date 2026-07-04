#!/usr/bin/env python3
"""
add_skip_links.py — Add accessibility skip-link to every page body.

The skip-link is the first focusable element — lets keyboard users jump
directly to main content without tabbing through nav/header.
"""
import re
from pathlib import Path

ROOT = Path('/home/z/my-project/work/AlbEdu')

SKIP_LINK_HTML = '<a href="#main-content" class="albedu-skip-link">Langsung ke konten utama</a>\n'

# Some pages use #main as the anchor (legacy), some use #main-content.
# Detect which to use by looking for id="main" or id="main-content" in the body.
# Default to #main-content (canonical).

def find_pages():
    return [p for p in ROOT.rglob('*.html')
            if 'node_modules' not in p.parts and p.name != 'PAGE-TEMPLATE.html']

def process_page(page):
    content = page.read_text(encoding='utf-8')
    if 'albedu-skip-link' in content or 'skip-to-main' in content or 'skip-link' in content:
        return False
    if 'http-equiv="refresh"' in content:
        return False  # redirect stub

    # Determine anchor: prefer #main-content, fall back to #main
    anchor = '#main-content'
    if 'id="main-content"' not in content and 'id=\'main-content\'' not in content:
        if 'id="main"' in content or 'id=\'main\'' in content:
            anchor = '#main'
        else:
            # No main anchor — add a wrapper id later. For now, use #main-content
            # which will work once we add id="main-content" to <main> or <body>.
            anchor = '#main-content'

    skip_html = SKIP_LINK_HTML.replace('#main-content', anchor)

    # Insert right after <body> tag (handle attributes on body too)
    body_pattern = re.compile(r'(<body[^>]*>\s*\n?)', re.IGNORECASE)
    new_content, count = body_pattern.subn(lambda m: m.group(1) + '    ' + skip_html, content, count=1)
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
            print(f'  ✓ added skip-link to {rel}')
            changed += 1
    print(f'\nDone. {changed} pages updated.')

if __name__ == '__main__':
    main()
