#!/usr/bin/env python3
# consolidate_qnotify.py — Replace per-page QNotify bootstrap with the shared
# native notify.js module.
#
# For every HTML page that has:
#   - <link rel="stylesheet" href="...QNotify/ui/notify.css"> (and dialog/label/Readnote)
#   - <script type="module">import QNotify from '...QNotify/api/index.js'; ...</script>
#
# This script:
#   1. Removes the 4 QNotify <link> tags (notify/dialog/label/Readnote CSS).
#   2. Removes the inline QNotify bootstrap <script type="module">...</script>.
#   3. Adds <script defer src="...src/shared/notify.js"></script> right after
#      the existing src/shared/boot.js line (so it loads in deterministic order).
#
# The notify.js module auto-installs window.notify, window.QNotify (legacy shim),
# window.show, and dispatches 'qnotify-ready' — so consumers keep working without
# any changes.

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

# Match the 4 QNotify CSS <link> tags
QNOTIFY_CSS_RE = re.compile(
    r'\s*<link\s+rel="stylesheet"\s+href="[^"]*?public/QNotify/ui/[^"]+\.css"\s*/?>\s*\n?',
    re.IGNORECASE
)

# Match the inline QNotify bootstrap <script type="module">...</script>
# This is a multi-line block that imports QNotify and sets up window.QNotify
QNOTIFY_BOOTSTRAP_RE = re.compile(
    r'\s*(?:<!--\s*QNotify[^>]*?-->\s*\n?)?\s*<script\s+type="module">\s*import\s+QNotify\s+from\s+[^;]+?;\s*window\.QNotify\s*=\s*QNotify;.*?</script>\s*\n?',
    re.IGNORECASE | re.DOTALL
)

# Match the "QNotify Styles" comment marker
QNOTIFY_COMMENT_RE = re.compile(
    r'\s*<!--\s*QNotify Styles\s*-->\s*\n?',
    re.IGNORECASE
)

# Match the "QNotify engine" / "QNotify Module + Bridge" comment
QNOTIFY_HEADER_COMMENT_RE = re.compile(
    r'\s*<!--\s*(?:QNotify engine|QNotify Module \+ Bridge|QNotify)\s*-->\s*\n?',
    re.IGNORECASE
)

def process_page(page):
    try:
        content = page.read_text(encoding='utf-8')
    except Exception as e:
        print(f'  ⚠ read error: {e}')
        return (0, 0)
    original = content

    # 1. Remove QNotify CSS link tags
    content, css_count = QNOTIFY_CSS_RE.subn('', content)
    # 2. Remove QNotify comment markers
    content = QNOTIFY_COMMENT_RE.sub('', content)
    content = QNOTIFY_HEADER_COMMENT_RE.sub('', content)
    # 3. Remove QNotify bootstrap module script
    content, boot_count = QNOTIFY_BOOTSTRAP_RE.subn('', content)

    if content == original:
        return (0, 0)

    # 4. Add shared notify.js after shared/boot.js (if not already present)
    if 'src/shared/notify.js' not in content:
        rel = rel_prefix(page)
        # Find the boot.js line and add notify.js right after
        boot_line_pattern = re.compile(
            r'(<script\s+defer\s+src="' + re.escape(rel) + r'src/shared/boot\.js"></script>\s*\n)'
        )
        notify_line = f'    <script defer src="{rel}src/shared/notify.js"></script>\n'
        content, added = boot_line_pattern.subn(
            lambda m: m.group(1) + '    ' + notify_line,
            content,
            count=1
        )
        # Also add notify.js AFTER the legacy/firebase-compat.js (so it loads
        # after the compat bridge, before any page-specific scripts)
        # Actually, notify.js should load BEFORE legacy compat since legacy
        # compat dispatches firebase-ready which consumers may handle with
        # notify calls. But boot.js already loads first. Let's add notify.js
        # right after boot.js — that's the cleanest position.

    page.write_text(content, encoding='utf-8')
    return (css_count, boot_count)

def main():
    pages = find_pages()
    print(f'Found {len(pages)} pages')
    total_css = 0
    total_boot = 0
    pages_changed = 0
    for page in sorted(pages):
        rel = page.relative_to(ROOT)
        css_count, boot_count = process_page(page)
        if css_count > 0 or boot_count > 0:
            print(f'  ✓ {rel}: removed {css_count} CSS links, {boot_count} bootstrap script(s)')
            total_css += css_count
            total_boot += boot_count
            pages_changed += 1
    print(f'\nDone. {pages_changed} pages updated.')
    print(f'  Total QNotify CSS links removed: {total_css}')
    print(f'  Total QNotify bootstrap scripts removed: {total_boot}')
    print(f'\nNext: verify with "rg QNotify pages/" — should only show in legacy contexts.')

if __name__ == '__main__':
    main()
