#!/usr/bin/env python3
"""
replace_qnotify_bootstrap.py — Phase A: Replace 10 per-page inline QNotify
bootstrap <script type="module"> blocks with a single <script defer> tag
that loads src/shared/qnotify-loader.js.

This makes QNotify boot deterministic — no more per-page timing variations.
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

# Match the inline QNotify bootstrap <script type="module">...</script>
# Pattern: <!-- QNotify Module + Bridge --> <script type="module"> import QNotify ... </script>
QNOTIFY_BOOTSTRAP_RE = re.compile(
    r'\s*(?:<!--\s*QNotify Module \+ Bridge\s*-->\s*\n?)?'
    r'\s*<script\s+type="module">\s*'
    r'import\s+QNotify\s+from\s+[^;]+?;\s*'
    r'window\.QNotify\s*=\s*QNotify;.*?</script>',
    re.IGNORECASE | re.DOTALL
)

def process_page(page):
    content = page.read_text(encoding='utf-8')
    if 'qnotify-loader.js' in content:
        return False  # already migrated

    # Remove the inline bootstrap
    new_content, count = QNOTIFY_BOOTSTRAP_RE.subn('', content)
    if count == 0:
        return False

    # Add <script defer src="...qnotify-loader.js"> after the last shared/ defer script
    rel = rel_prefix(page)
    loader_line = f'<script defer src="{rel}src/shared/qnotify-loader.js"></script>'

    # Insert after shared/boot.js (or after legacy/firebase-compat.js if it exists)
    # Try boot.js first
    boot_pattern = re.compile(
        r'(<script\s+defer\s+src="' + re.escape(rel) + r'src/shared/boot\.js"></script>)'
    )
    new_content2, added = boot_pattern.subn(
        lambda m: m.group(1) + '\n    ' + loader_line,
        new_content, count=1
    )

    if added == 0:
        # Fallback: insert before </head>
        new_content2 = new_content.replace('</head>', '    ' + loader_line + '\n</head>', 1)

    page.write_text(new_content2, encoding='utf-8')
    return True

def main():
    pages = find_pages()
    changed = 0
    for page in sorted(pages):
        rel = page.relative_to(ROOT)
        if process_page(page):
            print(f'  ✓ migrated {rel}')
            changed += 1
    print(f'\nDone. {changed} pages migrated from inline bootstrap to qnotify-loader.js.')

if __name__ == '__main__':
    main()
