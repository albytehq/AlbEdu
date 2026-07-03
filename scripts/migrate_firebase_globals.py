#!/usr/bin/env python3
"""
migrate_firebase_globals.py — Stage 2 batch migration of common Firebase shim
patterns to the native AlbEdu platform layer.

Handles the most common patterns:
  1. window.firebaseDb → window.AlbEdu?.repository (for chained .collection().doc() calls)
     But we can't blindly swap — chained calls need refactoring. Skip these.
  2. window.firebaseAuth?.currentUser → window.AlbEdu?.supabase?.auth?.currentUser
  3. window.firebaseAuth?.currentUser?.uid → window.AlbEdu?.supabase?.auth?.currentUser?.id
  4. window.firebaseAuth?.currentUser?.email → window.AlbEdu?.supabase?.auth?.currentUser?.email
  5. window.firebaseAuth.onAuthStateChanged → window.AlbEdu?.supabase?.auth?.onAuthStateChange
     (with callback wrapper — but this changes signature, skip auto-migration)

For complex .collection().doc() chain refactoring, manual review is needed.
This script handles the simple identifier swaps only.
"""
import re
from pathlib import Path

ROOT = Path('/home/z/my-project/work/AlbEdu/src')
SKIP_DIRS = {'legacy', 'platform', 'shared'}
SKIP_FILES = {'sanitize.js', 'icons.js'}

# Simple identifier swaps — safe to do automatically
PATTERNS = [
    # window.firebaseAuth?.currentUser?.uid → window.AlbEdu?.supabase?.auth?.currentUser?.id
    (re.compile(r'window\.firebaseAuth\?\.currentUser\?\.uid'), 'window.AlbEdu?.supabase?.auth?.currentUser?.id'),
    # window.firebaseAuth?.currentUser?.email → window.AlbEdu?.supabase?.auth?.currentUser?.email
    (re.compile(r'window\.firebaseAuth\?\.currentUser\?\.email'), 'window.AlbEdu?.supabase?.auth?.currentUser?.email'),
    # window.firebaseAuth?.currentUser → window.AlbEdu?.supabase?.auth?.currentUser
    (re.compile(r'window\.firebaseAuth\?\.currentUser'), 'window.AlbEdu?.supabase?.auth?.currentUser'),
    # window.firebaseAuth.currentUser → window.AlbEdu.supabase.auth.currentUser
    (re.compile(r'window\.firebaseAuth\.currentUser'), 'window.AlbEdu.supabase.auth.currentUser'),
    # window.firebaseAuth (standalone, not followed by ? or .) — skip, too risky
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
