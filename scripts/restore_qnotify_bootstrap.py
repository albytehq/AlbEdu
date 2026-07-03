#!/usr/bin/env python3
"""
restore_qnotify_bootstrap.py — Restore QNotify CSS + bootstrap script ke
10 halaman yang sebelumnya pakai QNotify.

Ini adalah restore sementara sampai Phase A (qnotify-loader.js) siap.
Setelah qnotify-loader.js ready, bootstrap ini akan diganti dengan 1 baris
<script defer src="...qnotify-loader.js"></script>.
"""
import re
from pathlib import Path

ROOT = Path('/home/z/my-project/work/AlbEdu')

# 10 halaman yang sebelumnya pakai QNotify (dari audit sebelumnya)
QNOTIFY_PAGES = [
    'pages/admin/index.html',
    'pages/admin/monitoring.html',
    'pages/admin/active-assessments.html',
    'pages/admin/daftar-nama.html',
    'pages/admin/profile.html',
    'pages/admin/results-analytics.html',
    'pages/admin/question-bank.html',
    'pages/admin/create-assessment.html',
    'pages/assessment/index.html',
    'pages/assessment/take.html',
]

def rel_prefix(page_path):
    rel = page_path.relative_to(ROOT)
    depth = len(rel.parts) - 1
    return '' if depth == 0 else '../' * depth

def restore_page(page_rel):
    page = ROOT / page_rel
    if not page.exists():
        print(f'  ⚠ not found: {page_rel}')
        return False

    content = page.read_text(encoding='utf-8')
    rel = rel_prefix(page)

    # Skip if QNotify CSS already present
    if 'QNotify/ui/notify.css' in content:
        print(f'  · already has QNotify CSS: {page_rel}')
        return False

    # Find the tokens.css or loading.css line to insert QNotify CSS after
    # Insert QNotify CSS after the first <link rel="stylesheet" href="...loading.css"> or tokens.css
    css_insert_pattern = re.compile(
        r'(<link\s+rel="stylesheet"\s+href="[^"]*(?:loading|tokens)\.css"\s*/?>)',
        re.IGNORECASE
    )

    qnotify_css = f'''
    <!-- QNotify Styles -->
    <link rel="stylesheet" href="{rel}public/QNotify/ui/notify.css">
    <link rel="stylesheet" href="{rel}public/QNotify/ui/dialog.css">
    <link rel="stylesheet" href="{rel}public/QNotify/ui/label.css">
    <link rel="stylesheet" href="{rel}public/QNotify/ui/Readnote.css">'''

    content, css_count = css_insert_pattern.subn(
        lambda m: m.group(1) + qnotify_css,
        content, count=1
    )

    if css_count == 0:
        print(f'  ⚠ no CSS insertion point found: {page_rel}')
        return False

    # Insert QNotify bootstrap module before </head>
    qnotify_bootstrap = f'''
    <!-- QNotify Module + Bridge -->
    <script type="module">
        import QNotify from '{rel}public/QNotify/api/index.js';
        window.QNotify = QNotify;
        window.show    = QNotify;
        window.notify  = {{
            success:          (t, m, d) => QNotify.notify.success(t, m, d),
            error:            (t, m, d) => QNotify.notify.error(t, m, d),
            warning:          (t, m, d) => QNotify.notify.warning(t, m, d),
            info:             (t, m, d) => QNotify.notify.info(t, m, d),
            confirm:          (opts)    => QNotify.dialog.confirm(opts),
            holdConfirmAsync: (opts)    => QNotify.dialog.holdAsync(opts),
        }};
        window.dispatchEvent(new Event('qnotify-ready'));
    </script>
</head>'''

    content = content.replace('</head>', qnotify_bootstrap, 1)

    page.write_text(content, encoding='utf-8')
    print(f'  ✓ restored QNotify CSS + bootstrap: {page_rel}')
    return True

def main():
    print(f'Restoring QNotify bootstrap to {len(QNOTIFY_PAGES)} pages...')
    restored = 0
    for page_rel in QNOTIFY_PAGES:
        if restore_page(page_rel):
            restored += 1
    print(f'\nDone. {restored}/{len(QNOTIFY_PAGES)} pages restored.')

if __name__ == '__main__':
    main()
