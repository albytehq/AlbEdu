#!/usr/bin/env python3
"""
migrate_material_icons_js.py — Replace Material Symbols font icons in JS source.

Same pattern as migrate_material_icons.py, but operates on .js files where the
HTML is embedded as string literals.

Pattern matched:
    '<i class="...material-symbols-outlined..." ...>icon_name</i>'
    `<i class="...material-symbols-outlined..." ...>icon_name</i>`

Replacement:
    '<span class="..." data-albedu-icon="icon_name"></span>'

Special handling:
  - ${item.icon} (template literal expressions) are preserved — the binder
    will look up the icon name at runtime.

After this migration, page controllers that inject HTML dynamically must
call AlbEdu.bindIcons(parentEl) after injection. The auto-binder in
icons.js handles the initial DOMContentLoaded case.
"""

import re
from pathlib import Path

ROOT = Path('/home/z/my-project/work/AlbEdu/src')

# Match <i ...class="...material-symbols-outlined..." ...>icon_name_or_expr</i>
# Allow ${...} in the icon name capture (template literal).
# We need a non-greedy capture and to allow `<` inside ${...}? Unlikely to
# occur in icon names — keep it simple.
ICON_PATTERN = re.compile(
    r'<i\b([^>]*?)class="([^"]*\bmaterial-symbols-outlined\b[^"]*)"([^>]*)>([^<]+?)</i>',
    re.IGNORECASE
)

def normalize_icon_name(name):
    return name.strip()

def clean_other_classes(other_classes):
    tokens = other_classes.split()
    keep = [t for t in tokens
            if t and
            t.lower() != 'material-symbols-outlined' and
            t.lower() != 'notranslate']
    return ' '.join(keep)

def replace_one(match):
    pre_attrs = match.group(1)
    class_attr = match.group(2)
    post_attrs = match.group(3)
    icon_name = normalize_icon_name(match.group(4))

    other_classes = clean_other_classes(class_attr)
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
    for js in sorted(ROOT.rglob('*.js')):
        if 'node_modules' in js.parts:
            continue
        if js.name == 'icons.js':
            continue  # skip the icon system itself
        n = process_file(js)
        if n > 0:
            rel = js.relative_to(ROOT)
            print(f'  ✓ {rel}: replaced {n} icons')
            total += n
            files_changed += 1
    print(f'\nDone. {total} icons migrated across {files_changed} JS files.')

if __name__ == '__main__':
    main()
