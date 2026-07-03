#!/usr/bin/env python3
"""
migrate_material_icons.py — Replace Material Symbols font icons with SVG icons.

Pattern matched:
    <i class="...material-symbols-outlined..." ...>icon_name</i>

Replacement:
    <span class="..." data-albedu-icon="icon_name"></span>

This relies on src/shared/icons/icons.js to materialize the SVG at runtime
via AlbEdu.bindIcons(document). That script auto-runs on DOMContentLoaded
and re-runs whenever AlbEdu.bindIcons() is called manually after dynamic HTML.

Icons not in the icon registry will be silently dropped (with a console warning).
The registry covers ~60 icons actually used by the codebase. Page-specific icons
can be added via AlbEdu.registerIcon() at runtime.
"""

import re
from pathlib import Path

ROOT = Path('/home/z/my-project/work/AlbEdu')

# Match <i ...class="...material-symbols-outlined..."...>icon_name</i>
# Captures: 1=leading attrs+class, 2=other classes, 3=icon name
ICON_PATTERN = re.compile(
    r'<i\b([^>]*?)class="([^"]*\bmaterial-symbols-outlined\b[^"]*)"([^>]*)>([^<]+)</i>',
    re.IGNORECASE
)

# Some pages also use <i class="material-symbols-outlined notranslate">icon</i>
# (in case Google Translate would try to translate the icon name as text).

def normalize_icon_name(name):
    """Material Symbols names use underscores or camelCase.
    Our registry uses both styles. Normalize to kebab-case? No — preserve
    original underscore form since the registry uses it."""
    return name.strip()

def clean_other_classes(other_classes):
    """Strip the 'material-symbols-outlined' token and any 'notranslate' flag.
    Return a single class string or empty."""
    tokens = other_classes.split()
    keep = [t for t in tokens
            if t and
            t.lower() != 'material-symbols-outlined' and
            t.lower() != 'notranslate']
    return ' '.join(keep)

def replace_one(match):
    pre_attrs = match.group(1)  # attrs before class=""
    class_attr = match.group(2)  # the class="..." value
    post_attrs = match.group(3)  # attrs after class=""
    icon_name = normalize_icon_name(match.group(4))

    other_classes = clean_other_classes(class_attr)

    # Build replacement: <span class="..." data-albedu-icon="..."></span>
    # Preserve other attributes (style, aria-*, etc.) — but drop aria-hidden
    # since the SVG will set it itself based on whether aria-label is given.
    # Actually, preserve pre_attrs and post_attrs as-is so callers can pass
    # aria-hidden="true" themselves.
    attrs_str = ''
    if pre_attrs.strip():
        attrs_str += ' ' + pre_attrs.strip()
    if post_attrs.strip():
        attrs_str += ' ' + post_attrs.strip()
    if other_classes:
        return f'<span class="{other_classes}"{attrs_str} data-albedu-icon="{icon_name}"></span>'
    else:
        return f'<span{attrs_str} data-albedu-icon="{icon_name}"></span>'

def process_file(path):
    try:
        content = path.read_text(encoding='utf-8')
    except Exception as e:
        print(f'  ⚠ read error: {e}')
        return 0
    new_content, count = ICON_PATTERN.subn(replace_one, content)
    if count == 0:
        return 0
    path.write_text(new_content, encoding='utf-8')
    return count

def main():
    total = 0
    files_changed = 0
    for html in sorted(ROOT.rglob('*.html')):
        if 'node_modules' in html.parts:
            continue
        if html.name == 'PAGE-TEMPLATE.html':
            continue
        n = process_file(html)
        if n > 0:
            rel = html.relative_to(ROOT)
            print(f'  ✓ {rel}: replaced {n} icons')
            total += n
            files_changed += 1
    print(f'\nDone. {total} icons migrated across {files_changed} files.')

if __name__ == '__main__':
    main()
