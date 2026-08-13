// /home/z/my-project/albedu/scripts/test-identity-form-dropdown.mjs
// Integration test: Verify IdentityFormRenderer uses AlbEduDropdown for
// select-type fields, and that the portal escapes any overflow:hidden parent.
import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';

const dom = new JSDOM(`<!DOCTYPE html><html><body>
  <div id="id-card" style="overflow:hidden; max-height:200px; border:1px solid #ccc; padding:20px;">
    <div id="identity-mount"></div>
  </div>
</body></html>`, { url: 'http://localhost/', pretendToBeVisual: true });

const { window } = dom;
global.window = window;
global.document = window.document;
try { global.navigator = window.navigator; } catch (_) {}
global.getComputedStyle = window.getComputedStyle;
global.MutationObserver = window.MutationObserver;
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);
global.HTMLElement = window.HTMLElement;
global.Event = window.Event;
global.Node = window.Node;

// Load scripts in order
const scripts = [
  '/home/z/my-project/albedu/src/shared/dropdown.js',
  '/home/z/my-project/albedu/src/identity/form-renderer.js',
];

for (const s of scripts) {
  const code = fs.readFileSync(s, 'utf8');
  window.eval(code);
}

console.log('AlbEduDropdown available:', typeof window.AlbEduDropdown);
console.log('IdentityFormRenderer available:', typeof window.IdentityFormRenderer);

// Render a form with a select field
const mount = document.getElementById('identity-mount');
const fieldsConfig = [
  { id: 'nama', label: 'Nama Lengkap', type: 'text', required: true, max_length: 80 },
  {
    id: 'kelas',
    label: 'Kelas',
    type: 'select',
    required: true,
    options: ['7A', '7B', '7C', '8A', '8B', '9A', '9B', '9C'],
  },
  {
    id: 'gender',
    label: 'Jenis Kelamin',
    type: 'select',
    required: true,
    options: ['Laki-laki', 'Perempuan'],
  },
];

window.IdentityFormRenderer.mount(mount, fieldsConfig);

// Verify form rendered
const namaInput = document.querySelector('input[name="nama"]');
console.log('✓ Nama input rendered:', !!namaInput);

// Verify select-type fields became AlbEduDropdown instances
const dropdowns = mount.querySelectorAll('.albedu-dropdown');
console.log('✓ AlbEduDropdown instances created in mount:', dropdowns.length);

// Verify source selects are hidden
const hiddenSelects = mount.querySelectorAll('select[style*="display: none"], select[style*="display:none"]');
console.log('✓ Source <select> elements hidden:', hiddenSelects.length);

// Open one of the dropdowns
const kelasField = mount.querySelector('.ifr-field[data-field-id="kelas"]');
const kelasDropdownWrap = kelasField.querySelector('.albedu-dropdown');
console.log('✓ Kelas dropdown wrap found:', !!kelasDropdownWrap);

// Get the AlbEduDropdown instance (stashed on the wrap element)
const kelasInstance = kelasDropdownWrap._albeduDropdownInstance;
console.log('✓ Instance stashed on wrap:', !!kelasInstance);

// Open it
kelasInstance.open();

// Check that the portal escaped the #id-card (which has overflow:hidden)
const portals = document.body.querySelectorAll(':scope > .albedu-dropdown__portal');
console.log('✓ Portals direct children of <body>:', portals.length);

const openPortal = document.body.querySelector(':scope > .albedu-dropdown__portal:not([hidden])');
console.log('✓ Open portal found at body level (escapes #id-card overflow:hidden):', !!openPortal);

// Check that options rendered
const options = openPortal?.querySelectorAll('.albedu-dropdown__option');
console.log('✓ Options rendered in portal:', options?.length);

// Select an option
kelasInstance.setValue('7B');
console.log('✓ After setValue(7B), getValue():', kelasInstance.getValue());

// Verify IdentityFormRenderer can read the value back
const values = window.IdentityFormRenderer.getValues();
console.log('✓ IdentityFormRenderer.getValues() reads kelas="7B":', values.kelas === '7B');

// Validation test — empty required select should fail validation
const errors = window.IdentityFormRenderer.validate();
console.log('✓ Validation errors (empty select should fail):', errors.length, 'errors');

// Test reset()
kelasInstance.setValue('7A');
console.log('  Before reset: kelas =', window.IdentityFormRenderer.getValues().kelas);
window.IdentityFormRenderer.reset();
console.log('✓ After reset: kelas =', JSON.stringify(window.IdentityFormRenderer.getValues().kelas));

console.log('\n--- Identity form integration test passed ---');
