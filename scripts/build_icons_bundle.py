#!/usr/bin/env python3
"""
build_icons_bundle.py — Bundle the modular icon system into a single
production icons.js file.

Reads:
  src/shared/icons/icons.template.js       (orchestrator with placeholder)
  src/shared/icons/modules/performance/metrics.js
  src/shared/icons/modules/cache/cache.js
  src/shared/icons/modules/sprite/sprite.js
  src/shared/icons/modules/registry/critical.js
  src/shared/icons/modules/registry/secondary.js
  src/shared/icons/modules/renderer/renderer.js
  src/shared/icons/modules/loader/loader.js

Writes:
  src/shared/icons/icons.js (overwrites with bundled output)

The output is a single file with all modules inlined, preserving the
existing <script defer src="src/shared/icons/icons.js"> loading pattern
(zero HTML changes, zero extra HTTP requests).

Usage:
  python3 scripts/build_icons_bundle.py
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULES_DIR = ROOT / 'src/shared/icons/modules'
TEMPLATE = ROOT / 'src/shared/icons/icons.template.js'
OUTPUT = ROOT / 'src/shared/icons/icons.js'

# Strict load order (dependency-respecting)
MODULE_ORDER = [
    'performance/metrics.js',
    'cache/cache.js',
    'sprite/sprite.js',
    'registry/critical.js',
    'registry/secondary.js',
    'renderer/renderer.js',
    'loader/loader.js',
]

PLACEHOLDER = '// === PLACEHOLDER:MODULES ==='

def read_module(rel_path):
    """Read a module file and return its content."""
    p = MODULES_DIR / rel_path
    if not p.exists():
        raise RuntimeError(f"Module not found: {p}")
    return p.read_text(encoding='utf-8')

def main():
    if not TEMPLATE.exists():
        print(f"ERROR: template not found: {TEMPLATE}", file=sys.stderr)
        sys.exit(1)

    template_text = TEMPLATE.read_text(encoding='utf-8')
    if PLACEHOLDER not in template_text:
        print(f"ERROR: placeholder not found in template", file=sys.stderr)
        sys.exit(1)

    # Build the modules section
    modules_section = '\n'.join(
        f'  // ─── Module: {rel} ─────────────────────────────────\n'
        f'{read_module(rel)}\n'
        for rel in MODULE_ORDER
    )

    # Replace placeholder with modules
    bundled = template_text.replace(PLACEHOLDER, modules_section)

    # Verify no placeholders remain
    if PLACEHOLDER in bundled:
        print(f"ERROR: placeholder still present after replacement", file=sys.stderr)
        sys.exit(1)

    # Write the bundled output
    OUTPUT.write_text(bundled, encoding='utf-8')
    size_kb = len(bundled.encode('utf-8')) / 1024
    print(f"Wrote bundled icons.js ({size_kb:.1f} KB)")
    print(f"  Path: {OUTPUT.relative_to(ROOT)}")
    print(f"  Modules inlined: {len(MODULE_ORDER)}")

if __name__ == '__main__':
    main()
