// AlbEdu minify pipeline v2.0.0 — production-grade, zero runtime dependency.
// Updated for new by-feature structure (src/, styles/, pages/, public/).
import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true });
fs.mkdirSync(DIST, { recursive: true });

function copyDirIfExists(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirIfExists(s, d);
    else fs.copyFileSync(s, d);
  }
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

let jsCount = 0, cssCount = 0, htmlCount = 0;
const errors = [];

// === Minify & copy src/ (JS) ===
const SRC_DIRS = ['src'];
for (const srcDir of SRC_DIRS) {
  const srcPath = path.join(ROOT, srcDir);
  if (!fs.existsSync(srcPath)) continue;
  const files = walk(srcPath);
  for (const file of files) {
    const rel = path.relative(path.join(ROOT, srcDir), file);
    const ext = path.extname(file).toLowerCase();
    const outPath = path.join(DIST, srcDir, rel);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    try {
      if (ext === '.js' || ext === '.mjs') {
        const code = fs.readFileSync(file, 'utf8');
        const result = await esbuild.transform(code, {
          minify: true,
          target: 'es2020',
          format: 'iife',
          sourcemap: false,
          legalComments: 'none',
        });
        fs.writeFileSync(outPath, result.code);
        jsCount++;
      } else {
        fs.copyFileSync(file, outPath);
      }
    } catch (e) {
      errors.push({ file: rel, error: e.message });
      fs.copyFileSync(file, outPath);
    }
  }
}

// === Minify & copy styles/ (CSS) ===
const STYLES_DIR = path.join(ROOT, 'styles');
if (fs.existsSync(STYLES_DIR)) {
  const cssFiles = walk(STYLES_DIR);
  for (const file of cssFiles) {
    const rel = path.relative(STYLES_DIR, file);
    const outPath = path.join(DIST, 'styles', rel);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    try {
      const code = fs.readFileSync(file, 'utf8');
      try {
        const { transform: cssTransform } = await import('lightningcss');
        const result = cssTransform({
          filename: file,
          code: Buffer.from(code),
          minify: true,
          targets: { chrome: 100, firefox: 100, safari: 16, edge: 100 },
        });
        fs.writeFileSync(outPath, result.code.toString());
      } catch (e) {
        fs.writeFileSync(outPath, code); // fall back to raw CSS
      }
      cssCount++;
    } catch (e) {
      errors.push({ file: rel, error: e.message });
      fs.copyFileSync(file, outPath);
    }
  }
}

// === Copy public/ (images, QNotify — static assets, no minify) ===
copyDirIfExists(path.join(ROOT, 'public'), path.join(DIST, 'public'));

// === Copy supabase/ ===
copyDirIfExists(path.join(ROOT, 'supabase'), path.join(DIST, 'supabase'));

// === Copy HTML pages/ ===
const PAGES_DIR = path.join(ROOT, 'pages');
if (fs.existsSync(PAGES_DIR)) {
  const htmlFiles = walk(PAGES_DIR);
  for (const file of htmlFiles) {
    const rel = path.relative(PAGES_DIR, file);
    const outPath = path.join(DIST, 'pages', rel);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.copyFileSync(file, outPath);
    htmlCount++;
  }
}

// === Copy root files (index.html, 404.html, package.json, README.md, rule-url-albedu.md, etc.) ===
// v2.1: Added 404.html (canonical, GitHub Pages auto-serves this) and
//        rule-url-albedu.md (routing documentation) to the copy list.
for (const f of fs.readdirSync(ROOT)) {
  const full = path.join(ROOT, f);
  const stat = fs.statSync(full);
  if (stat.isFile() && (
    f.endsWith('.html') ||
    f === 'package.json' ||
    f === 'README.md' ||
    f === 'rule-url-albedu.md' ||
    f === 'LICENSE'
  )) {
    fs.copyFileSync(full, path.join(DIST, f));
  }
}

console.log(`=== AlbEdu Build Complete (v2.1.0) ===`);
console.log(`JS files minified: ${jsCount}`);
console.log(`CSS files minified: ${cssCount}`);
console.log(`HTML files copied:  ${htmlCount}`);
console.log(`Output: ${DIST}`);
if (errors.length > 0) {
  console.log(`\nErrors (${errors.length}):`);
  for (const e of errors.slice(0, 10)) console.log(`  - ${e.file}: ${e.error.slice(0, 100)}`);
}
