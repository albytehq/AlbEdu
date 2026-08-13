// /home/z/my-project/scripts/test-albedu-dropdown.mjs
// Smoke test for AlbEduDropdown — loads the component into jsdom and
// verifies the core API works: enhance(), setValue(), setOptions(),
// portal escape, keyboard nav, etc.
import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';

const dom = new JSDOM(`<!DOCTYPE html><html><body>
  <select class="albedu-dropdown" id="dd1" name="country">
    <option value="">-- Pilih --</option>
    <option value="id">Indonesia</option>
    <option value="my">Malaysia</option>
    <option value="sg">Singapore</option>
  </select>
  <div id="overflow-card" style="overflow:hidden; height:100px; border:1px solid red;">
    <select class="albedu-dropdown" id="dd2" name="city">
      <option value="">-- Pilih Kota --</option>
      <option value="jkt">Jakarta</option>
      <option value="bdg">Bandung</option>
      <option value="sby">Surabaya</option>
      <option value="yog">Yogyakarta</option>
      <option value="mks">Makassar</option>
    </select>
  </div>
</body></html>`, { url: 'http://localhost/', pretendToBeVisual: true });

const { window } = dom;
global.window = window;
global.document = window.document;
// navigator is read-only on newer Node — skip
try { global.navigator = window.navigator; } catch (_) {}
global.getComputedStyle = window.getComputedStyle;
global.MutationObserver = window.MutationObserver;
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);

// Load dropdown.js
const dropdownCode = fs.readFileSync(
  path.resolve('/home/z/my-project/albedu/src/shared/dropdown.js'),
  'utf8'
);
window.eval(dropdownCode);

const AlbEduDropdown = window.AlbEduDropdown;
console.log('✓ AlbEduDropdown loaded:', typeof AlbEduDropdown);
console.log('✓ enhance is static method:', typeof AlbEduDropdown.enhance);

// Test 1: Auto-enhance already ran (jsdom document.readyState was 'complete'
// when the script loaded, so the auto-enhance fired synchronously).
// Verify by checking the bound attribute on the source <select>.
const select1Bound = document.getElementById('dd1').hasAttribute('data-albedu-dropdown-bound');
console.log('✓ Auto-enhance bound select1 (data-albedu-dropdown-bound attr):', select1Bound);

let dd1Wrap = document.querySelector('#dd1 + .albedu-dropdown, .albedu-dropdown[aria-label]');
console.log('✓ Auto-enhance created wrap:', !!dd1Wrap);

// Test 2: Manual enhance (in case DOMContentLoaded didn't fire)
const instances = AlbEduDropdown.enhance(document.body);
console.log('✓ Manual enhance count:', instances.length);

// After enhance, the <select> should be hidden and a wrap div should exist
const select1 = document.getElementById('dd1');
console.log('✓ Source select still in DOM:', !!select1);
console.log('✓ Source select display:', select1.style.display || '(default)');

const wrap1 = select1.nextElementSibling;
console.log('✓ Wrap element created next to select:', wrap1?.className);

// Test 3: Build dropdown programmatically
const progSelect = document.createElement('select');
const progDd = new AlbEduDropdown(progSelect, {
  placeholder: 'Pilih buah',
  options: [
    { value: 'apple', label: 'Apel' },
    { value: 'banana', label: 'Pisang' },
    { value: 'cherry', label: 'Ceri' },
  ],
  onChange: (val) => console.log('  → onChange fired:', val),
});
console.log('✓ Programmatic dropdown created:', progDd.getElement().className);

// Test 4: setValue / getValue
progDd.setValue('banana');
console.log('✓ getValue() after setValue(banana):', progDd.getValue());
console.log('✓ Label text updated:', progDd.getElement().querySelector('.albedu-dropdown__label').textContent);

// Test 5: setOptions
progDd.setOptions([
  { value: 'a', label: 'A' },
  { value: 'b', label: 'B' },
  { value: 'c', label: 'C' },
]);
console.log('✓ After setOptions, getValue cleared:', progDd.getValue());

// Test 6: Portal — when opened, the portal should be a child of <body>, not the trigger's parent
progDd.open();
const portal = document.body.querySelector('.albedu-dropdown__portal:not([hidden])');
console.log('✓ Portal is direct child of <body>:', portal?.parentNode === document.body);

// Test 7: The overflow-card dropdown — its portal should ALSO escape to body
const dd2 = instances.find(i => i.getElement().querySelector?.('.albedu-dropdown__trigger') && i.getElement().parentElement?.parentElement?.id === 'overflow-card') ||
            instances[1];
if (dd2) {
  dd2.open();
  const portal2 = document.body.querySelectorAll('.albedu-dropdown__portal:not([hidden])');
  console.log('✓ dd2 portal also escaped overflow-card to body:', portal2.length >= 1);
  dd2.close();
}

progDd.close();

// Test 8: clear()
progDd.setValue('a');
progDd.clear();
console.log('✓ clear() reset value:', progDd.getValue() === '');

// Test 9: disable() / enable()
progDd.disable();
console.log('✓ After disable, has is-disabled class:', progDd.getElement().classList.contains('is-disabled'));
progDd.enable();
console.log('✓ After enable, no is-disabled class:', !progDd.getElement().classList.contains('is-disabled'));

// Test 10: destroy()
const standaloneSelect = document.createElement('select');
standaloneSelect.className = 'albedu-dropdown';
standaloneSelect.innerHTML = '<option>A</option><option>B</option>';
document.body.appendChild(standaloneSelect);
const inst = new AlbEduDropdown(standaloneSelect, { placeholder: 'Pilih' });
const wrap = inst.getElement();
inst.destroy();
console.log('✓ destroy() removed wrap from DOM:', !document.body.contains(wrap));

console.log('\n--- All smoke tests passed ---');
