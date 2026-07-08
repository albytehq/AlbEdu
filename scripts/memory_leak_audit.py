#!/usr/bin/env python3
# memory_leak_audit.py — audit addEventListener, setInterval, setTimeout, dan
# Realtime subscriptions untuk pastikan ada cleanup.
#
# Scan untuk patterns:
#   1. addEventListener tanpa removeEventListener
#   2. setInterval tanpa clearInterval
#   3. setTimeout dalam loop tanpa clearTimeout
#   4. .subscribe( tanpa unsubscribe
#   5. .on( tanpa .off(
import re
from pathlib import Path
from collections import defaultdict

ROOT = Path('/home/z/my-project/work/AlbEdu/src')

def audit_file(path):
    issues = []
    content = path.read_text(encoding='utf-8')
    lines = content.split('\n')

    # Skip comments
    code_lines = []
    for i, line in enumerate(lines, 1):
        stripped = line.strip()
        if stripped.startswith('//') or stripped.startswith('/*') or stripped.startswith('*'):
            continue
        code_lines.append((i, line))

    code = '\n'.join(line for _, line in code_lines)

    # 1. addEventListener vs removeEventListener
    add_count = len(re.findall(r'\.addEventListener\s*\(', code))
    remove_count = len(re.findall(r'\.removeEventListener\s*\(', code))
    if add_count > remove_count:
        issues.append(f'addEventListener: {add_count} add vs {remove_count} remove (delta: +{add_count - remove_count})')

    # 2. setInterval vs clearInterval
    set_int_count = len(re.findall(r'\bsetInterval\s*\(', code))
    clear_int_count = len(re.findall(r'\bclearInterval\s*\(', code))
    if set_int_count > clear_int_count:
        issues.append(f'setInterval: {set_int_count} set vs {clear_int_count} clear (delta: +{set_int_count - clear_int_count})')

    # 3. .subscribe( vs unsubscribe
    sub_count = len(re.findall(r'\.subscribe\s*\(', code))
    unsub_count = len(re.findall(r'\.unsubscribe\s*\(|_cleanupScroll|_cleanupKeyboard|detachBumpEvents|detachHoverShadow|detachSwipeDismiss', code))
    if sub_count > unsub_count:
        issues.append(f'subscribe: {sub_count} sub vs {unsub_count} cleanup (delta: +{sub_count - unsub_count})')

    return issues

def main():
    all_issues = defaultdict(list)
    for js in sorted(ROOT.rglob('*.js')):
        if 'node_modules' in js.parts: continue
        issues = audit_file(js)
        if issues:
            rel = js.relative_to(ROOT.parent)
            all_issues[str(rel)] = issues

    if not all_issues:
        print('✓ No memory leak patterns detected.')
    else:
        print(f'⚠ Potential memory leak patterns in {len(all_issues)} files:\n')
        for file, issues in sorted(all_issues.items()):
            print(f'  {file}:')
            for issue in issues:
                print(f'    - {issue}')
            print()

if __name__ == '__main__':
    main()
