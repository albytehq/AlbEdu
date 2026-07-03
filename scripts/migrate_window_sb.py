#!/usr/bin/env python3
"""
migrate_window_sb.py — Replace window.sb with window.AlbEdu.supabase.client
in remaining auth/util files.

Pattern: window.sb → window.AlbEdu?.supabase?.client
Also: window.__firebaseReady → window.AlbEdu?.supabase?.isReady?.()
Also: 'firebase-ready' event → 'albedu:platform-ready' event
Also: 'firebase-error' event → 'albedu:platform-error' event
Also: 'supabase-ready' event → 'albedu:platform-ready' event

Skips: src/legacy/ (the compat bridge itself)
        src/platform/ (already native)
        src/shared/ (already native)
        src/security/sanitize.js (already native)
"""
import re
from pathlib import Path

ROOT = Path('/home/z/my-project/work/AlbEdu/src')

SKIP_DIRS = {'legacy', 'platform', 'shared'}
SKIP_FILES = {'sanitize.js'}

# Patterns
PATTERNS = [
    # window.sb → window.AlbEdu?.supabase?.client
    (re.compile(r'\bwindow\.sb\b'), 'window.AlbEdu?.supabase?.client'),
    # window.__firebaseReady → window.AlbEdu?.supabase?.isReady?.()
    (re.compile(r'\bwindow\.__firebaseReady\b'), 'window.AlbEdu?.supabase?.isReady?.()'),
    # 'firebase-ready' event → 'albedu:platform-ready'
    (re.compile(r"'firebase-ready'"), "'albedu:platform-ready'"),
    (re.compile(r'"firebase-ready"'), '"albedu:platform-ready"'),
    # 'firebase-error' event → 'albedu:platform-error'
    (re.compile(r"'firebase-error'"), "'albedu:platform-error'"),
    (re.compile(r'"firebase-error"'), '"albedu:platform-error"'),
    # 'supabase-ready' event → 'albedu:platform-ready'
    (re.compile(r"'supabase-ready'"), "'albedu:platform-ready'"),
    (re.compile(r'"supabase-ready"'), '"albedu:platform-ready"'),
]

def process_file(path):
    if path.name in SKIP_FILES:
        return 0
    if path.parent.name in SKIP_DIRS:
        return 0
    try:
        content = path.read_text(encoding='utf-8')
    except Exception as e:
        print(f'  ⚠ read error: {e}')
        return 0
    original = content
    total = 0
    for pattern, replacement in PATTERNS:
        content, count = pattern.subn(replacement, content)
        total += count
    if content == original or total == 0:
        return 0
    path.write_text(content, encoding='utf-8')
    return total

def main():
    total_changes = 0
    files_changed = 0
    for js in sorted(ROOT.rglob('*.js')):
        n = process_file(js)
        if n > 0:
            rel = js.relative_to(ROOT)
            print(f'  ✓ {rel}: {n} replacements')
            total_changes += n
            files_changed += 1
    print(f'\nDone. {total_changes} replacements across {files_changed} files.')

if __name__ == '__main__':
    main()
