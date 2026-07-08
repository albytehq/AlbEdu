#!/usr/bin/env python3
# Extract the icon registry from icons.legacy-v6.js and split into
# critical.js + secondary.js for the modular icons.js bundle.
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LEGACY = ROOT / 'src/shared/icons/icons.legacy-v6.js'
CRITICAL_OUT = ROOT / 'src/shared/icons/modules/registry/critical.js'
SECONDARY_OUT = ROOT / 'src/shared/icons/modules/registry/secondary.js'

# Critical icon set — must match sprite.js CRITICAL_ICONS
CRITICAL_NAMES = {
    'menu', 'close', 'login', 'logout', 'person', 'person_add',
    'manage_accounts', 'notifications', 'arrow_back', 'arrow_forward',
    'chevron_right', 'chevron_left', 'search', 'home', 'language', 'refresh',
}

def extract_registry(text):
    """Pull the `var I = {...}` object out of the legacy icons.js."""
    # Match: var I = { ... };
    m = re.search(r"var\s+I\s*=\s*(\{[^}]+\})\s*;", text, re.DOTALL)
    if not m:
        raise RuntimeError("Could not locate `var I = {...}` in legacy icons.js")
    raw = m.group(1)
    # The object is `'name':'<svg>'` pairs. Parse it.
    # We can't use json.loads directly because the values contain unescaped HTML.
    # Use a manual parser that respects single-quoted strings.
    icons = {}
    i = 0
    while i < len(raw):
        # Skip whitespace
        while i < len(raw) and raw[i] in ' \t\n\r,{}':
            i += 1
        if i >= len(raw):
            break
        # Expect opening quote for key
        if raw[i] != "'":
            i += 1
            continue
        i += 1  # skip opening quote
        key_start = i
        while i < len(raw) and raw[i] != "'":
            i += 1
        key = raw[key_start:i]
        i += 1  # skip closing quote
        # Skip whitespace and colon
        while i < len(raw) and raw[i] in ' \t\n\r:':
            i += 1
        # Expect opening quote for value
        if i >= len(raw) or raw[i] != "'":
            continue
        i += 1  # skip opening quote
        val_start = i
        while i < len(raw) and raw[i] != "'":
            i += 1
        val = raw[val_start:i]
        i += 1  # skip closing quote
        icons[key] = val
    return icons

def write_registry(path, var_name, icons, header_lines):
    lines = header_lines + [
        f"window.AlbEdu = window.AlbEdu || {{}};",
        f"window.AlbEdu.{var_name} = {{",
    ]
    for name, val in sorted(icons.items()):
        # Escape backslashes and single quotes in the value
        escaped = val.replace('\\', '\\\\').replace("'", "\\'")
        lines.append(f"  '{name}': '{escaped}',")
    lines.append("};")
    path.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(f"Wrote {len(icons):3d} icons → {path.relative_to(ROOT)}")

def main():
    if not LEGACY.exists():
        print(f"ERROR: legacy file not found: {LEGACY}", file=sys.stderr)
        sys.exit(1)
    text = LEGACY.read_text(encoding='utf-8')
    all_icons = extract_registry(text)
    print(f"Extracted {len(all_icons)} icons from legacy icons.js")

    critical = {k: v for k, v in all_icons.items() if k in CRITICAL_NAMES}
    secondary = {k: v for k, v in all_icons.items() if k not in CRITICAL_NAMES}

    critical_header = [
        "// critical.js — AlbEdu Icon System · Critical Icon Registry (Layer 1)",
        "// 16 critical icons bundled into the main icons.js. These are ALSO injected",
        "// as an inline SVG sprite by critical-css.js so they render INSTANTLY on",
        "// first paint (before any JS executes).",
        "//",
        "// Critical icons MUST satisfy ALL of these criteria:",
        "//   1. Appears in the persistent app shell (navbar/sidebar/header/footer)",
        "//   2. Appears on auth gates (login, register, forgot-password)",
        "//   3. Used on EVERY page (or nearly every page)",
        "//   4. Visible above the fold on first paint",
        "//",
        "// Do NOT add feature-specific icons here. Use secondary-registry.js instead.",
        "//",
        "// License: ISC (Lucide icons — https://lucide.dev)",
        "",
    ]
    write_registry(CRITICAL_OUT, '__iconRegistryCritical', critical, critical_header)

    secondary_header = [
        "// secondary.js — AlbEdu Icon System · Secondary Icon Registry (Layer 2)",
        "// Secondary icons are bundled into the main icons.js (so they're available",
        "// immediately after the deferred script loads) but NOT in the inline sprite.",
        "// They render via the cached-template renderer (cloneNode — ~0.005ms each).",
        "//",
        "// Secondary icons cover feature-specific UI (charts, editor, admin tools).",
        "// For truly lazy-loaded icons (rarely used), use dynamic import chunks:",
        "//   const editorIcons = await import('../../src/shared/icons/modules/registry/feature-editor.js')",
        "//",
        "// License: ISC (Lucide icons — https://lucide.dev)",
        "",
    ]
    write_registry(SECONDARY_OUT, '__iconRegistrySecondary', secondary, secondary_header)

if __name__ == '__main__':
    main()
