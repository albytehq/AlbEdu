// smoke-test-icons.mjs — verify the icon system works end-to-end.
// Uses jsdom for realistic browser simulation.
import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ICONS_JS = path.join(ROOT, 'src/shared/icons/icons.js');
const CRITICAL_CSS_JS = path.join(ROOT, 'src/shared/head/critical-css.js');

console.log('AlbEdu Icon System — Smoke Test');

// Build a JSDOM environment that simulates a real browser.
const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body></body></html>`, {
  url: 'http://localhost/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
});

const { window } = dom;
const { document } = window;

// Polyfill APIs that jsdom doesn't provide
window.requestIdleCallback = window.requestIdleCallback || ((cb) => setTimeout(cb, 1));
window.cancelIdleCallback = window.cancelIdleCallback || ((id) => clearTimeout(id));
window.IntersectionObserver = class {
  observe() {} unobserve() {} disconnect() {}
};
window.MutationObserver = class {
  observe() {} disconnect() {}
};
if (!window.performance || !window.performance.now) {
  Object.defineProperty(window, 'performance', { value: { now: () => Date.now() }, configurable: true });
}

// Inject icons.js into the JSDOM window
const code = fs.readFileSync(ICONS_JS, 'utf8');
const scriptEl = document.createElement('script');
scriptEl.textContent = code;
document.head.appendChild(scriptEl);

// Inject critical-css.js (which adds the sprite)
const cssCode = fs.readFileSync(CRITICAL_CSS_JS, 'utf8');
const cssScriptEl = document.createElement('script');
cssScriptEl.textContent = cssCode;
document.head.appendChild(cssScriptEl);

// Allow microtasks to flush
await new Promise(r => setTimeout(r, 100));

let pass = 0, fail = 0;
function assert(label, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}` + (detail ? ` — ${detail}` : '')); }
}

console.log('\n[1] Public API surface');
assert('AlbEdu global exists', typeof window.AlbEdu === 'object');
assert('ICONS_VERSION is 7.0.0-enterprise', window.AlbEdu.ICONS_VERSION === '7.0.0-enterprise');
assert('AlbEdu.icon is a function', typeof window.AlbEdu.icon === 'function');
assert('AlbEdu.setIcon is a function', typeof window.AlbEdu.setIcon === 'function');
assert('AlbEdu.registerIcon is a function', typeof window.AlbEdu.registerIcon === 'function');
assert('AlbEdu.bindIcons is a function', typeof window.AlbEdu.bindIcons === 'function');
assert('AlbEdu.listIcons is a function', typeof window.AlbEdu.listIcons === 'function');
assert('AlbEdu.hasIcon is a function', typeof window.AlbEdu.hasIcon === 'function');
assert('AlbEdu.getMetrics is a function', typeof window.AlbEdu.getMetrics === 'function');
assert('AlbEdu.preloadIcons is a function', typeof window.AlbEdu.preloadIcons === 'function');
assert('AlbEdu.preloadAll is a function', typeof window.AlbEdu.preloadAll === 'function');

console.log('\n[2] Inline SVG sprite (critical icons)');
const sprite = document.getElementById('albedu-icon-sprite');
assert('Sprite element exists in DOM', !!sprite);
if (sprite) {
  const symbols = sprite.querySelectorAll('symbol');
  assert('Sprite has 16 <symbol> elements', symbols.length === 16, `got ${symbols.length}`);
  const expectedIds = ['i-menu', 'i-close', 'i-login', 'i-logout', 'i-person', 'i-person_add',
                       'i-manage_accounts', 'i-notifications', 'i-arrow_back', 'i-arrow_forward',
                       'i-chevron_right', 'i-chevron_left', 'i-search', 'i-home', 'i-language', 'i-refresh'];
  for (const id of expectedIds) {
    assert(`Symbol ${id} exists`, !!sprite.querySelector('#' + id));
  }
}

console.log('\n[3] Registry');
const icons = window.AlbEdu.listIcons();
assert('Registry has 100+ icons', icons.length >= 100, `got ${icons.length}`);
assert('Registry includes critical icons', ['login', 'logout', 'home', 'search', 'menu'].every(n => icons.includes(n)));
assert('Registry includes secondary icons', ['bar_chart', 'database', 'edit', 'save', 'warning'].every(n => icons.includes(n)));

console.log('\n[4] hasIcon (with aliases)');
assert('hasIcon(login) = true', window.AlbEdu.hasIcon('login') === true);
assert('hasIcon(person_add) = true', window.AlbEdu.hasIcon('person_add') === true);
assert('hasIcon(person-add) = true (hyphen alias)', window.AlbEdu.hasIcon('person-add') === true);
assert('hasIcon(personAdd) = true (camelCase alias)', window.AlbEdu.hasIcon('personAdd') === true);
assert('hasIcon(x) = true (alias for close)', window.AlbEdu.hasIcon('x') === true);
assert('hasIcon(nonexistent) = false', window.AlbEdu.hasIcon('nonexistent') === false);

console.log('\n[5] icon() string API');
const loginSvg = window.AlbEdu.icon('login');
assert('icon(login) returns string', typeof loginSvg === 'string');
assert('icon(login) starts with <svg', loginSvg.startsWith('<svg'));
assert('icon(login) contains class albedu-icon', loginSvg.includes('class="albedu-icon'));
assert('icon(login) contains the login path', loginSvg.includes('M15 12H3'));
assert('icon(login) is aria-hidden by default', loginSvg.includes('aria-hidden="true"'));

const sizedIcon = window.AlbEdu.icon('home', { size: 32 });
assert('icon(home, {size:32}) has width=32', sizedIcon.includes('width="32"'));
assert('icon(home, {size:32}) has height=32', sizedIcon.includes('height="32"'));

const labeledIcon = window.AlbEdu.icon('search', { 'aria-label': 'Search' });
assert('icon(search, {aria-label}) has role=img', labeledIcon.includes('role="img"'));
assert('icon(search, {aria-label}) has aria-label=Search', labeledIcon.includes('aria-label="Search"'));

const missingIcon = window.AlbEdu.icon('definitely-missing');
assert('icon(missing) returns fallback (has class albedu-icon--missing)', missingIcon.includes('albedu-icon--missing'));

const noFallback = window.AlbEdu.icon('definitely-missing', { fallback: false });
assert('icon(missing, {fallback:false}) returns empty string', noFallback === '');

console.log('\n[6] setIcon() DOM API');
const container = document.createElement('span');
container.setAttribute('data-albedu-icon', 'home');
document.body.appendChild(container);
window.AlbEdu.setIcon(container, 'login');
const svgInContainer = container.querySelector('svg.albedu-icon');
assert('setIcon(el, login) injects <svg class="albedu-icon">', !!svgInContainer);

console.log('\n[7] bindIcons() with [data-albedu-icon] elements');
// Create test elements
const testDiv = document.createElement('div');
testDiv.innerHTML = `
  <span data-albedu-icon="login"></span>
  <span data-albedu-icon="home"></span>
  <span data-albedu-icon="search"></span>
  <span data-albedu-icon="bar_chart"></span>
  <span data-albedu-icon="notifications"></span>
`;
document.body.appendChild(testDiv);
const result = window.AlbEdu.bindIcons(testDiv);
assert('bindIcons returns result with immediate count', typeof result.immediate === 'number');
assert('bindIcons bound 5 icons', result.immediate === 5, `got ${result.immediate}`);
const boundSvgs = testDiv.querySelectorAll('svg.albedu-icon');
assert('All 5 spans have <svg> children after bindIcons', boundSvgs.length === 5);

// Verify critical icons use <use href="#i-..."> fast path
const loginSpan = testDiv.querySelector('[data-albedu-icon="login"]');
const useEl = loginSpan.querySelector('use');
assert('Critical icon (login) uses <use href="#i-login"> fast path', !!useEl && useEl.getAttribute('href') === '#i-login');

// Verify secondary icons use full <svg> (cached template)
const chartSpan = testDiv.querySelector('[data-albedu-icon="bar_chart"]');
const chartSvg = chartSpan.querySelector('svg');
assert('Secondary icon (bar_chart) uses full <svg> with path content', !!chartSvg && chartSvg.innerHTML.includes('<path'));

console.log('\n[8] Performance metrics');
const m = window.AlbEdu.getMetrics();
assert('getMetrics returns object', typeof m === 'object');
assert('metrics.iconsRendered > 0', m.iconsRendered > 0, `got ${m.iconsRendered}`);
assert('metrics.iconsBound > 0', m.iconsBound > 0, `got ${m.iconsBound}`);
assert('metrics.totalIconsInRegistry >= 100', m.totalIconsInRegistry >= 100, `got ${m.totalIconsInRegistry}`);
assert('metrics.criticalIconsCount === 16', m.criticalIconsCount === 16, `got ${m.criticalIconsCount}`);
assert('metrics.cacheSize is a number', typeof m.cacheSize === 'number');

console.log('\n[9] Cache performance (repeat renders)');
window.AlbEdu.resetMetrics();
// First render — cache miss
const t1 = window.performance.now();
window.AlbEdu.icon('home');
const firstRender = window.performance.now() - t1;
// Repeat render — cache hit
const t2 = window.performance.now();
for (let i = 0; i < 100; i++) window.AlbEdu.icon('home');
const repeatRenders = (window.performance.now() - t2) / 100;
const m2 = window.AlbEdu.getMetrics();
assert('Cache miss recorded on first render', m2.cacheMisses >= 1);
assert('Cache hits recorded on repeat renders', m2.cacheHits >= 100);
assert('Cache hit rate > 0.99', m2.cacheHitRate > 0.99, `got ${m2.cacheHitRate.toFixed(3)}`);
console.log(`    First render: ${firstRender.toFixed(3)}ms`);
console.log(`    Repeat render (avg of 100): ${repeatRenders.toFixed(3)}ms`);

console.log('\n[10] Custom icon registration');
const customRegistered = window.AlbEdu.registerIcon('my_custom', '<circle cx="12" cy="12" r="10"></circle>');
assert('registerIcon returns true', customRegistered === true);
assert('hasIcon(my_custom) = true after registration', window.AlbEdu.hasIcon('my_custom'));
const customSvg = window.AlbEdu.icon('my_custom');
assert('icon(my_custom) returns SVG with custom path', customSvg.includes('circle') && customSvg.includes('cx="12"'));

console.log('\n[11] Event system');
let missingFired = false;
window.AlbEdu.addEventListener('icon-missing', () => { missingFired = true; });
window.AlbEdu.icon('totally-nonexistent-icon');
assert('icon-missing event fires for unknown icons', missingFired);

console.log('\n[12] Backward compatibility (legacy API)');
assert('AlbEdu.on alias works', typeof window.AlbEdu.on === 'function');
assert('AlbEdu.resetMetrics works', typeof window.AlbEdu.resetMetrics === 'function');

console.log('\nResults: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) {
  console.error('SMOKE TEST FAILED');
  process.exit(1);
} else {
  console.log('✓ All smoke tests passed — icon system is operational.');
}
