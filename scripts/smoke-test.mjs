#!/usr/bin/env node
/**
 * Deep smoke test: Verify all HTML pages load AND their referenced assets resolve.
 * Uses Node.js path.resolve() for correct path resolution.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const PAGES_TO_TEST = [
  '/',
  '/404.html',                          // v2.1: canonical root 404 (GitHub Pages auto-serves this)
  '/pages/login.html',
  '/pages/register-admin.html',
  '/pages/forgot-password.html',
  '/pages/reset-password.html',
  '/pages/404.html',                    // legacy 404 (only reachable by direct link)
  '/pages/admin/index.html',
  '/pages/admin/pages/buat-ujian.html',
  '/pages/admin/pages/daftar-nama.html',
  '/pages/admin/pages/data-hasil.html',
  '/pages/admin/pages/profile.html',
  '/pages/admin/pages/ujian-peserta.html',
  '/pages/ujian/index.html',
  '/pages/ujian/kerjakan-ujian.html',
];

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:8765${url}`, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

async function main() {
  console.log('\n=== Deep Smoke Test: All HTML refs resolve ===\n');

  let totalPages = 0;
  let totalAssets = 0;
  let broken = 0;

  for (const pageUrl of PAGES_TO_TEST) {
    console.log(`--- ${pageUrl} ---`);
    totalPages++;

    const { status, body } = await fetchUrl(pageUrl);
    if (status !== 200) {
      console.log(`  ❌ Page itself returns ${status}`);
      broken++;
      continue;
    }

    // Extract all src="..." and href="..." references
    const refPattern = /(?:src|href)="([^"]+)"/g;
    const refs = new Set();
    let match;
    while ((match = refPattern.exec(body)) !== null) {
      refs.add(match[1]);
    }

    for (const ref of refs) {
      // Skip CDN URLs, data URIs, mailto, hash-only, absolute paths
      if (/^(https?:)?\/\//.test(ref) || ref.startsWith('data:') || ref.startsWith('mailto:') || ref.startsWith('#') || ref.startsWith('/')) {
        continue;
      }

      // Skip JS template literals
      if (ref.includes("'") || ref.includes('+') || ref.includes('${')) {
        continue;
      }

      // Resolve relative to HTML file's directory
      const htmlDir = path.dirname(pageUrl);
      const resolved = path.resolve(htmlDir, ref);

      // Test if file exists on filesystem
      const fsPath = path.join(ROOT, resolved);
      if (!fs.existsSync(fsPath)) {
        console.log(`  ❌ 404  ${resolved}  (from ref: ${ref})`);
        broken++;
      }
      totalAssets++;
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Pages checked:  ${totalPages}`);
  console.log(`Assets checked: ${totalAssets}`);
  console.log(`Broken refs:    ${broken}`);
  console.log('='.repeat(60));

  if (broken > 0) {
    console.log('\n❌ SMOKE TEST FAILED');
    process.exit(1);
  } else {
    console.log('\n✅ ALL REFS RESOLVE — SMOKE TEST PASSED');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Smoke test error:', err);
  process.exit(1);
});
