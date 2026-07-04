#!/usr/bin/env python3
"""
fix_all_module_types.py — Fix ALL ES module scripts to use type="module".
Files with export/import statements MUST be loaded as type="module", not defer.
Also fix Supabase SDK loading: async → defer (ensure it loads before supabase-client.js).
"""
import re
from pathlib import Path

ROOT = Path('/home/z/my-project/work/AlbEdu')

# Files that have export/import statements (ES modules)
ES_MODULE_FILES = [
    'src/shared/resilience.js',
    'src/shared/qnotify-loader.js',
    'src/theme-system/index.js',
]

def find_pages():
    return [p for p in ROOT.rglob('*.html')
            if 'node_modules' not in p.parts and p.name != 'PAGE-TEMPLATE.html']

def rel_prefix(page_path):
    rel = page_path.relative_to(ROOT)
    depth = len(rel.parts) - 1
    return '' if depth == 0 else '../' * depth

def process_page(page):
    content = page.read_text(encoding='utf-8')
    changed = False
    rel = rel_prefix(page)

    # Fix 1: Change all ES module files from defer to type="module"
    for mod_file in ES_MODULE_FILES:
        # Match: <script defer src="...mod_file"></script>
        pattern = re.compile(
            r'<script\s+defer\s+src="([^"]*' + re.escape(mod_file) + ')"[^>]*></script>',
            re.IGNORECASE
        )
        new_content, count = pattern.subn(
            lambda m: f'<script type="module" src="{m.group(1)}"></script>',
            content
        )
        if count > 0:
            content = new_content
            changed = True

    # Fix 2: Change Supabase SDK from async to defer
    # async = download parallel, execute ASAP (unpredictable order)
    # defer = download parallel, execute after parse in order
    # supabase-client.js (defer) needs window.supabase available.
    # With async, SDK might load AFTER supabase-client.js already timed out.
    # Fix: load SDK BEFORE supabase-client.js with defer (maintains order)
    sdk_pattern = re.compile(
        r'<script\s+async\s+src="(https://cdn\.jsdelivr\.net/npm/@supabase/supabase-js[^"]+)"[^>]*></script>',
        re.IGNORECASE
    )
    new_content, sdk_count = sdk_pattern.subn(
        lambda m: f'<script defer src="{m.group(1)}"></script>',
        content
    )
    if sdk_count > 0:
        content = new_content
        changed = True

    # Also fix: <script src="..." async> format (attribute order varies)
    sdk_pattern2 = re.compile(
        r'<script\s+src="(https://cdn\.jsdelivr\.net/npm/@supabase/supabase-js[^"]+)"\s+async[^>]*></script>',
        re.IGNORECASE
    )
    new_content, sdk_count2 = sdk_pattern2.subn(
        lambda m: f'<script defer src="{m.group(1)}"></script>',
        content
    )
    if sdk_count2 > 0:
        content = new_content
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
            print(f'  ✓ fixed: {rel}')
            changed += 1
    print(f'\nDone. {changed} pages fixed.')

if __name__ == '__main__':
    main()
