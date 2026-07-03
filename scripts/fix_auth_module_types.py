#!/usr/bin/env python3
"""
fix_auth_module_types.py — Fix 4 auth files that use ES module imports
but are loaded as <script defer>. Change to <script type="module">.

Files:
  - src/auth/user-auth-portal.js  (login.html)
  - src/auth/reset-password.js    (reset-password.html)
  - src/auth/forgot-password.js   (forgot-password.html)
  - src/auth/admin-onboarding.js  (register-admin.html)
"""
import re
from pathlib import Path

ROOT = Path('/home/z/my-project/work/AlbEdu')

AUTH_MODULES = [
    'user-auth-portal.js',
    'reset-password.js',
    'forgot-password.js',
    'admin-onboarding.js',
]

def find_pages():
    return [p for p in ROOT.rglob('*.html')
            if 'node_modules' not in p.parts and p.name != 'PAGE-TEMPLATE.html']

def process_page(page):
    content = page.read_text(encoding='utf-8')
    changed = False

    for mod in AUTH_MODULES:
        # Match: <script defer src="...mod"></script>
        # Also match: <script src="...mod" defer></script>
        patterns = [
            re.compile(
                r'<script\s+defer\s+src="([^"]*' + re.escape(mod) + ')"[^>]*></script>',
                re.IGNORECASE
            ),
            re.compile(
                r'<script\s+src="([^"]*' + re.escape(mod) + ')"\s+defer[^>]*></script>',
                re.IGNORECASE
            ),
        ]
        for pattern in patterns:
            new_content, count = pattern.subn(
                lambda m: f'<script type="module" src="{m.group(1)}"></script>',
                content
            )
            if count > 0:
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
