// =============================================================================
// benchmark_icons.mjs — Performance Benchmark Suite for v7.0 Icon System
// =============================================================================
// Measures:
//   1. Cold render (cache miss) — first time rendering each icon
//   2. Warm render (cache hit) — subsequent renders of same icon
//   3. Critical icon fast-path (<use href="#i-...">) vs full SVG
//   4. Bulk bind (100, 500, 1000 icons) — bindIcons() throughput
//   5. Memory cache effectiveness (hit rate, eviction)
//   6. Comparison with v6.0 baseline (legacy file)
//
// Run: node scripts/benchmark_icons.mjs
// =============================================================================
import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function setupEnv() {
  const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body></body></html>`, {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;
  window.requestIdleCallback = (cb) => setTimeout(cb, 1);
  window.IntersectionObserver = class { observe(){} unobserve(){} disconnect(){} };
  window.MutationObserver = class { observe(){} disconnect(){} };
  return { window, document };
}

function loadIcons(window, document, filePath) {
  const code = fs.readFileSync(filePath, 'utf8');
  const script = document.createElement('script');
  script.textContent = code;
  document.head.appendChild(script);
}

function fmt(n, decimals = 3) {
  if (n < 0.001) return n.toFixed(6);
  if (n < 1) return n.toFixed(4);
  return n.toFixed(decimals);
}

function bench(label, fn, iterations = 1000) {
  // Warmup
  for (let i = 0; i < 10; i++) fn();
  const start = window.performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const total = window.performance.now() - start;
  const avg = total / iterations;
  return { label, total, avg, iterations };
}

let window; // hoisted

console.log('═'.repeat(72));
console.log('AlbEdu Icon System v7.0 — Performance Benchmark Suite');
console.log('═'.repeat(72));

// ── Setup ────────────────────────────────────────────────────────────
const env = setupEnv();
window = env.window;
const { document } = env;

loadIcons(window, document, path.join(ROOT, 'src/shared/icons/icons.js'));
// Also load critical-css.js to inject the sprite
loadIcons(window, document, path.join(ROOT, 'src/shared/head/critical-css.js'));

await new Promise(r => setTimeout(r, 200));

console.log('\n┌─ Environment');
console.log('│ Node.js:', process.version);
console.log('│ Icons in registry:', window.AlbEdu.listIcons().length);
console.log('│ Critical icons (sprite):', window.AlbEdu.getMetrics().criticalIconsCount);
console.log('│ Icons.js file size:', (fs.statSync(path.join(ROOT, 'src/shared/icons/icons.js')).size / 1024).toFixed(1), 'KB');
console.log('└─');

// ════════════════════════════════════════════════════════════════════
// BENCHMARK 1: Cold render (cache miss)
// ════════════════════════════════════════════════════════════════════
console.log('\n┌─ Benchmark 1: Cold render (cache miss)');
console.log('│ Rendering 100 unique icons for the first time. Cache is reset between samples.');

const allIcons = window.AlbEdu.listIcons().slice(0, 100);
window.AlbEdu.resetMetrics();

const coldStart = window.performance.now();
for (const name of allIcons) {
  window.AlbEdu.icon(name);
}
const coldTotal = window.performance.now() - coldStart;
const coldAvg = coldTotal / allIcons.length;
console.log(`│ Total: ${fmt(coldTotal)}ms for ${allIcons.length} icons`);
console.log(`│ Average per icon: ${fmt(coldAvg)}ms (cold)`);
console.log('└─');

// ════════════════════════════════════════════════════════════════════
// BENCHMARK 2: Warm render (cache hit)
// ════════════════════════════════════════════════════════════════════
console.log('\n┌─ Benchmark 2: Warm render (cache hit)');
console.log('│ Rendering the same icon 10,000 times (cache fully warm).');

const WARM_ITERATIONS = 10000;
const warmStart = window.performance.now();
for (let i = 0; i < WARM_ITERATIONS; i++) {
  window.AlbEdu.icon('home');
}
const warmTotal = window.performance.now() - warmStart;
const warmAvg = warmTotal / WARM_ITERATIONS;
console.log(`│ Total: ${fmt(warmTotal)}ms for ${WARM_ITERATIONS} renders`);
console.log(`│ Average per render: ${fmt(warmAvg)}ms (warm)`);
console.log(`│ Cache speedup: ${(coldAvg / warmAvg).toFixed(1)}x faster than cold`);
console.log('└─');

// ════════════════════════════════════════════════════════════════════
// BENCHMARK 3: Critical icon fast-path vs secondary icon
// ════════════════════════════════════════════════════════════════════
console.log('\n┌─ Benchmark 3: Critical vs Secondary icon render');
console.log('│ Comparing critical icon (uses <use> sprite) vs secondary (uses cached template).');

// For a fair comparison, we measure the string API which both go through.
// The critical fast-path advantage is in bindIcons() (DOM binding).
window.AlbEdu.resetMetrics();
const critBench = bench('Critical icon (login)', () => window.AlbEdu.icon('login'), 5000);
const secBench = bench('Secondary icon (bar_chart)', () => window.AlbEdu.icon('bar_chart'), 5000);
console.log(`│ Critical icon:    ${fmt(critBench.avg)}ms/render`);
console.log(`│ Secondary icon:   ${fmt(secBench.avg)}ms/render`);
console.log('└─');

// ════════════════════════════════════════════════════════════════════
// BENCHMARK 4: Bulk bindIcons() throughput
// ════════════════════════════════════════════════════════════════════
console.log('\n┌─ Benchmark 4: Bulk bindIcons() throughput');
console.log('│ Binding N [data-albedu-icon] elements in a fresh container.');

[100, 500, 1000].forEach(n => {
  const container = document.createElement('div');
  let html = '';
  for (let i = 0; i < n; i++) {
    const iconName = allIcons[i % allIcons.length];
    html += `<span data-albedu-icon="${iconName}"></span>`;
  }
  container.innerHTML = html;
  document.body.appendChild(container);

  // Reset metrics for clean measurement
  window.AlbEdu.resetMetrics();
  const start = window.performance.now();
  const result = window.AlbEdu.bindIcons(container);
  const elapsed = window.performance.now() - start;
  const bound = result.immediate + result.deferred;
  console.log(`│ ${String(n).padStart(4)} icons: ${fmt(elapsed)}ms total, ${fmt(elapsed / n)}ms/icon (${bound} bound)`);

  document.body.removeChild(container);
});
console.log('└─');

// ════════════════════════════════════════════════════════════════════
// BENCHMARK 5: setIcon() — single element re-render
// ════════════════════════════════════════════════════════════════════
console.log('\n┌─ Benchmark 5: setIcon() — single element re-render');
console.log('│ Toggling between menu and close icons (mobile sidebar use case).');

const toggleEl = document.createElement('span');
document.body.appendChild(toggleEl);
const toggleStart = window.performance.now();
const TOGGLE_ITERATIONS = 5000;
for (let i = 0; i < TOGGLE_ITERATIONS; i++) {
  window.AlbEdu.setIcon(toggleEl, i % 2 === 0 ? 'menu' : 'close');
}
const toggleTotal = window.performance.now() - toggleStart;
console.log(`│ ${TOGGLE_ITERATIONS} toggles: ${fmt(toggleTotal)}ms (${fmt(toggleTotal / TOGGLE_ITERATIONS)}ms/toggle)`);
document.body.removeChild(toggleEl);
console.log('└─');

// ════════════════════════════════════════════════════════════════════
// BENCHMARK 6: Cache effectiveness
// ════════════════════════════════════════════════════════════════════
console.log('\n┌─ Benchmark 6: Cache effectiveness');
window.AlbEdu.resetMetrics();
// Render a mix: 80% repeat, 20% unique
for (let i = 0; i < 10000; i++) {
  const name = Math.random() < 0.8 ? 'home' : allIcons[Math.floor(Math.random() * allIcons.length)];
  window.AlbEdu.icon(name);
}
const m = window.AlbEdu.getMetrics();
console.log(`│ Total renders: ${m.iconsRendered}`);
console.log(`│ Cache hits:    ${m.cacheHits}`);
console.log(`│ Cache misses:  ${m.cacheMisses}`);
console.log(`│ Hit rate:      ${(m.cacheHitRate * 100).toFixed(2)}%`);
console.log(`│ Cache size:    ${m.cacheSize} / ${m.cacheMaxEntries}`);
console.log(`│ Avg render time: ${fmt(m.avgRenderTimeUs / 1000)}ms`);
console.log('└─');

// ════════════════════════════════════════════════════════════════════
// BENCHMARK 7: Comparison with v6.0 legacy
// ════════════════════════════════════════════════════════════════════
console.log('\n┌─ Benchmark 7: v7.0 vs v6.0 (legacy) comparison');
const legacyEnv = setupEnv();
const legacyWindow = legacyEnv.window;
const legacyDocument = legacyEnv.document;

// Load legacy icons.js
const legacyCode = fs.readFileSync(path.join(ROOT, 'src/shared/icons/icons.legacy-v6.js'), 'utf8');
const legacyScript = legacyDocument.createElement('script');
legacyScript.textContent = legacyCode;
legacyDocument.head.appendChild(legacyScript);

await new Promise(r => setTimeout(r, 200));

if (legacyWindow.AlbEdu && legacyWindow.AlbEdu.icon) {
  // Warm up legacy
  for (let i = 0; i < 10; i++) legacyWindow.AlbEdu.icon('home');

  // Legacy: 10000 renders
  const legacyStart = legacyWindow.performance.now();
  for (let i = 0; i < WARM_ITERATIONS; i++) {
    legacyWindow.AlbEdu.icon('home');
  }
  const legacyTotal = legacyWindow.performance.now() - legacyStart;
  const legacyAvg = legacyTotal / WARM_ITERATIONS;

  // v7.0: 10000 renders (already warmed above)
  const v7Start = window.performance.now();
  for (let i = 0; i < WARM_ITERATIONS; i++) {
    window.AlbEdu.icon('home');
  }
  const v7Total = window.performance.now() - v7Start;
  const v7Avg = v7Total / WARM_ITERATIONS;

  console.log(`│ v6.0 (legacy) avg: ${fmt(legacyAvg)}ms/render`);
  console.log(`│ v7.0 (new)     avg: ${fmt(v7Avg)}ms/render`);
  console.log(`│ Speedup: ${(legacyAvg / v7Avg).toFixed(2)}x faster`);
  console.log(`│ Time saved per 1000 renders: ${fmt((legacyAvg - v7Avg) * 1000)}ms`);
} else {
  console.log('│ (legacy v6.0 not available for comparison)');
}
console.log('└─');

// ════════════════════════════════════════════════════════════════════
// SUMMARY
// ════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(72));
console.log('Benchmark Summary');
console.log('═'.repeat(72));
console.log(`Cold render (cache miss):     ${fmt(coldAvg)}ms/icon`);
console.log(`Warm render (cache hit):      ${fmt(warmAvg)}ms/icon`);
console.log(`Cache speedup:                ${(coldAvg / warmAvg).toFixed(1)}x`);
console.log(`Critical icon fast-path:      ${fmt(critBench.avg)}ms/render`);
console.log(`setIcon() toggle:             ${fmt(toggleTotal / TOGGLE_ITERATIONS)}ms/toggle`);
console.log(`Cache hit rate (steady state): ${(m.cacheHitRate * 100).toFixed(1)}%`);
console.log('═'.repeat(72));
console.log('Performance targets:');
console.log(`  Initial icon render < 1ms:    ${coldAvg < 1 ? '✓ PASS' : '✗ FAIL'} (${fmt(coldAvg)}ms)`);
console.log(`  Repeat icon render ~0ms:      ${warmAvg < 0.5 ? '✓ PASS' : '✗ FAIL'} (${fmt(warmAvg)}ms)`);
console.log(`  Cache hit rate > 95%:         ${m.cacheHitRate > 0.95 ? '✓ PASS' : '✗ FAIL'} (${(m.cacheHitRate * 100).toFixed(1)}%)`);
console.log('═'.repeat(72));
