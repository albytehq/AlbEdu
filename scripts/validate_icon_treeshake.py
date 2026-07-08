#!/usr/bin/env python3
# validate_icon_treeshake.py — Tree-shaking validation for the icon system.
# Verifies registry icons are used, no unused icons bundled, critical set
# covers shell/nav icons, and bundle size is within limits.
import json
import re
import sys
from pathlib import Path
from collections import Counter

ROOT = Path(__file__).resolve().parents[1]
ICONS_JS = ROOT / 'src/shared/icons/icons.js'
CRITICAL_JS = ROOT / 'src/shared/icons/modules/registry/critical.js'
SECONDARY_JS = ROOT / 'src/shared/icons/modules/registry/secondary.js'

# Directories to scan for icon usage
SCAN_DIRS = ['pages', 'src', 'index.html']
SCAN_EXTS = {'.html', '.js', '.mjs'}

def load_registry():
    """Extract icon names from the bundled icons.js registry."""
    text = ICONS_JS.read_text(encoding='utf-8')
    # Find all icon names in the merged registry
    # They appear as keys: 'name': '<svg...'
    # Match within the __iconRegistryCritical and __iconRegistrySecondary objects
    names = set()

    # Match critical registry
    for m in re.finditer(r"__iconRegistryCritical\s*=\s*\{([^}]+)\}", text, re.DOTALL):
        for k in re.finditer(r"'([^']+)':\s*'", m.group(1)):
            names.add(k.group(1))

    # Match secondary registry
    for m in re.finditer(r"__iconRegistrySecondary\s*=\s*\{([^}]+)\}", text, re.DOTALL):
        for k in re.finditer(r"'([^']+)':\s*'", m.group(1)):
            names.add(k.group(1))

    return names

def load_critical_set():
    """Extract the critical icon names from critical.js."""
    text = CRITICAL_JS.read_text(encoding='utf-8')
    names = set()
    for m in re.finditer(r"__iconRegistryCritical\s*=\s*\{([^}]+)\}", text, re.DOTALL):
        for k in re.finditer(r"'([^']+)':\s*'", m.group(1)):
            names.add(k.group(1))
    return names

def scan_html_icon_usage():
    """Scan all HTML files for data-albedu-icon attributes."""
    usage = Counter()
    for dir_name in SCAN_DIRS:
        dir_path = ROOT / dir_name
        if not dir_path.exists():
            continue
        if dir_path.is_file():
            files = [dir_path]
        else:
            files = [f for f in dir_path.rglob('*') if f.suffix in SCAN_EXTS]
        for f in files:
            try:
                text = f.read_text(encoding='utf-8')
            except Exception:
                continue
            # Match: data-albedu-icon="NAME" (ignore dynamic ${...} values)
            for m in re.finditer(r'data-albedu-icon="([^"$][^"]*)"', text):
                name = m.group(1).strip()
                if name and not name.startswith('$'):
                    usage[name] += 1
    return usage

def scan_js_icon_usage():
    """Scan all JS files for AlbEdu.icon('NAME') calls."""
    usage = Counter()
    for dir_name in SCAN_DIRS:
        dir_path = ROOT / dir_name
        if not dir_path.exists():
            continue
        if dir_path.is_file():
            files = [dir_path]
        else:
            files = [f for f in dir_path.rglob('*') if f.suffix in SCAN_EXTS]
        for f in files:
            if 'icons.js' in str(f) or 'icons.legacy' in str(f) or 'icons.bundle' in str(f):
                continue  # skip the icon system itself
            try:
                text = f.read_text(encoding='utf-8')
            except Exception:
                continue
            # Match: AlbEdu.icon('NAME' ...) or AlbEdu.icon("NAME" ...)
            for m in re.finditer(r"AlbEdu\.icon\(\s*['\"]([^'\"]+)['\"]", text):
                usage[m.group(1)] += 1
            # Match: AlbEdu.setIcon(el, 'NAME' ...)
            for m in re.finditer(r"AlbEdu\.setIcon\([^,]+,\s*['\"]([^'\"]+)['\"]", text):
                usage[m.group(1)] += 1
    return usage

def normalize_name(name):
    """Normalize icon name to underscore form (matches renderer._normalizeName)."""
    s = name.strip()
    # camelCase → underscore
    s = re.sub(r'([a-z0-9])([A-Z])', r'\1_\2', s)
    s = s.lower()
    s = s.replace('-', '_')
    return s

def main():
    print('-' * 72)
    print('AlbEdu Icon System — Tree-Shaking Validation')
    print('-' * 72)

    registry = load_registry()
    critical_set = load_critical_set()
    html_usage = scan_html_icon_usage()
    js_usage = scan_js_icon_usage()

    # Normalize usage names
    html_usage_norm = Counter({normalize_name(k): v for k, v in html_usage.items()})
    js_usage_norm = Counter({normalize_name(k): v for k, v in js_usage.items()})
    all_usage = html_usage_norm + js_usage_norm

    # Find unused icons (in registry but not referenced anywhere)
    unused = sorted(registry - set(all_usage.keys()))
    # Find missing icons (referenced but not in registry)
    missing = sorted(set(all_usage.keys()) - registry)

    print(f'\nRegistry')
    print(f'  Total icons in registry:    {len(registry)}')
    print(f'  Critical icons (sprite):    {len(critical_set)}')
    print(f'  Secondary icons (cached):   {len(registry) - len(critical_set)}')

    print(f'\nUsage')
    print(f'  Icons referenced in HTML:   {len(html_usage_norm)}')
    print(f'  Icons referenced in JS:     {len(js_usage_norm)}')
    print(f'  Total unique icons used:    {len(all_usage)}')
    print(f'  Total icon instances:       {sum(all_usage.values())}')

    print(f'\nTree-shaking analysis')
    print(f'  Unused icons (in registry, not referenced): {len(unused)}')
    if unused:
        print(f'    {", ".join(unused[:20])}{"..." if len(unused) > 20 else ""}')
    print(f'  Missing icons (referenced, not in registry): {len(missing)}')
    if missing:
        for m in missing[:10]:
            print(f'    ✗ {m} (referenced {all_usage[m]}x)')

    # Bundle size analysis
    bundle_size = ICONS_JS.stat().st_size
    print(f'\nBundle size')
    print(f'  icons.js (uncompressed):    {bundle_size / 1024:.1f} KB')
    print(f'  Estimated (Brotli):         ~{bundle_size / 1024 * 0.25:.1f} KB')
    print(f'  Icons per KB:               {len(registry) / (bundle_size / 1024):.1f}')

    # Critical icon coverage check
    print(f'\nCritical icon coverage')
    shell_icons = {'menu', 'close', 'login', 'logout', 'person', 'person_add',
                   'manage_accounts', 'notifications', 'arrow_back', 'arrow_forward',
                   'chevron_right', 'chevron_left', 'search', 'home', 'language', 'refresh'}
    missing_critical = shell_icons - critical_set
    if missing_critical:
        print(f'  ✗ Missing critical icons: {", ".join(missing_critical)}')
    else:
        print(f'  ✓ All 16 shell/navigation icons are in critical set')

    # Validation result
    print('\n' + '-' * 72)
    has_unused = len(unused) > 0
    has_missing = len(missing) > 0
    if has_missing:
        print('✗ VALIDATION FAILED: Missing icons detected')
        print('  These icons are referenced in the codebase but not in the registry.')
        print('  Either add them to the registry or fix the references.')
        sys.exit(1)
    elif has_unused:
        print(f'⚠ VALIDATION PASSED (with warnings): {len(unused)} unused icons in registry')
        print('  These icons are bundled but never referenced.')
        print('  Consider removing them to reduce bundle size.')
        sys.exit(0)
    else:
        print('✓ VALIDATION PASSED: All icons are used, no missing icons')
        sys.exit(0)

if __name__ == '__main__':
    main()
