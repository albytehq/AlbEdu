#!/usr/bin/env python3
"""
add_notify_js.py — Add src/shared/notify.js to pages that load shared/boot.js
but don't yet load notify.js. Handles the case where boot.js and legacy-compat.js
are on the same line.
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
    if 'src/shared/notify.js' in content:
        return False
    if 'src/shared/boot.js' not in content:
        return False
    rel = rel_prefix(page)
    notify_line = f'<script defer src="{rel}src/shared/notify.js"></script>'

    # Insert right after the boot.js </script> tag — handle both:
    #   case A: boot.js</script>\n  (separate line)
    #   case B: boot.js</script>    <script ... legacy-compat.js ...  (same line)
    boot_pattern = re.compile(
        r'(<script\s+defer\s+src="' + re.escape(rel) + r'src/shared/boot\.js"></script>)'
    )
    new_content, count = boot_pattern.subn(
        lambda m: m.group(1) + '    ' + notify_line,
        content,
        count=1
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
            print(f'  ✓ added notify.js to {rel}')
            changed += 1
    print(f'\nDone. {changed} pages updated.')

if __name__ == '__main__':
    main()
