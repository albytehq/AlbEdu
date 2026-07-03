#!/usr/bin/env python3
"""
fix_sdk_load_order.py — Move Supabase SDK script tag BEFORE supabase-client.js.
Defer scripts execute in document order. SDK must appear before supabase-client.js
so window.supabase is available when supabase-client.js runs.
"""
import re
from pathlib import Path

ROOT = Path('/home/z/my-project/work/AlbEdu')

def find_pages():
    return [p for p in ROOT.rglob('*.html')
            if 'node_modules' not in p.parts and p.name != 'PAGE-TEMPLATE.html']

def process_page(page):
    content = page.read_text(encoding='utf-8')
    if 'supabase.min.js' not in content or 'supabase-client.js' not in content:
        return False

    # Find the SDK script tag
    sdk_pattern = re.compile(
        r'(\s*)(<script\s+defer\s+src="https://cdn\.jsdelivr\.net/npm/@supabase/supabase-js[^"]+"[^>]*></script>)\s*\n?',
        re.IGNORECASE
    )
    sdk_match = sdk_pattern.search(content)
    if not sdk_match:
        return False

    sdk_tag = sdk_match.group(2)

    # Remove SDK from its current position
    content = sdk_pattern.sub('', content, count=1)

    # Insert SDK BEFORE supabase-client.js
    client_pattern = re.compile(
        r'(\s*)(<script\s+defer\s+src="[^"]*src/platform/supabase-client\.js"></script>)',
        re.IGNORECASE
    )
    new_content, count = client_pattern.subn(
        lambda m: f'\n    {sdk_tag}{m.group(1)}{m.group(2)}',
        content,
        count=1
    )
    if count == 0:
        # Put it back if we couldn't find supabase-client.js
        content = sdk_match.group(0) + content
        return False

    page.write_text(new_content, encoding='utf-8')
    return True

def main():
    pages = find_pages()
    changed = 0
    for page in sorted(pages):
        rel = page.relative_to(ROOT)
        if process_page(page):
            print(f'  ✓ reordered SDK before supabase-client: {rel}')
            changed += 1
    print(f'\nDone. {changed} pages fixed.')

if __name__ == '__main__':
    main()
