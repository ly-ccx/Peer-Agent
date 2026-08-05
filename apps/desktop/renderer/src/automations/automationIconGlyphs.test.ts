import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const centerUrl = new URL('./AutomationCenter.tsx', import.meta.url);
const cssUrl = new URL('./automations.css', import.meta.url);

test('Automation disclosure chevrons use stroke SVG instead of character glyphs', async () => {
  const [center, css] = await Promise.all([
    readFile(centerUrl, 'utf8'),
    readFile(cssUrl, 'utf8'),
  ]);

  assert.match(center, /chevronDown: <path d="m6 9 6 6 6-6" \/>/);
  assert.match(center, /chevronRight: <path d="m9 6 6 6-6 6" \/>/);
  assert.match(center, /className="automation-advanced-summary"/);
  assert.match(center, /<Icon name="chevronDown" \/>/);
  assert.match(center, /<Icon name="chevronRight" \/>/);

  assert.equal(/[›▾▴▼▲▶▽△]/.test(center), false);
  assert.equal(css.includes("content:'▾'"), false);
  assert.equal(css.includes("content:'▴'"), false);
  assert.equal(css.includes("content:\"▾\""), false);
  assert.equal(css.includes("content:\"▴\""), false);

  assert.match(css, /\.automation-advanced-summary\{display:flex/);
  assert.match(css, /\.automation-advanced-chevron svg\{[^}]*stroke:currentColor/);
  assert.match(css, /\.automation-advanced\.is-open \.automation-advanced-chevron\{transform:rotate\(180deg\)\}/);
  assert.match(css, /\.automation-chevron svg\{[^}]*stroke:currentColor/);
});
