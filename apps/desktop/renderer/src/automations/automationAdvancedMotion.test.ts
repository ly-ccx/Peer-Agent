import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const centerUrl = new URL('./AutomationCenter.tsx', import.meta.url);
const cssUrl = new URL('./automations.css', import.meta.url);

test('Automation advanced settings animate open/close with motion tokens', async () => {
  const [center, css] = await Promise.all([
    readFile(centerUrl, 'utf8'),
    readFile(cssUrl, 'utf8'),
  ]);

  // Controlled disclosure, not native details instantaneous toggle.
  assert.equal(center.includes('<details'), false);
  assert.equal(center.includes('<summary'), false);
  assert.match(center, /className=\{`automation-advanced\$\{advancedOpen \? ' is-open' : ''\}`\}/);
  assert.match(center, /aria-expanded=\{advancedOpen\}/);
  assert.match(center, /setAdvancedOpen\(\(value\) => !value\)/);
  assert.match(center, /className="automation-advanced-body-inner"/);

  // Height + opacity transition using Peer Frost motion tokens.
  assert.match(css, /\.automation-advanced-body\{display:grid;grid-template-rows:0fr;transition:grid-template-rows var\(--za-motion-medium\) var\(--za-ease-out\)\}/);
  assert.match(css, /\.automation-advanced\.is-open \.automation-advanced-body\{grid-template-rows:1fr\}/);
  assert.match(css, /\.automation-advanced-body-inner\{overflow:hidden;[^}]*opacity:0;transition:opacity var\(--za-motion-medium\) var\(--za-ease-out\)/);
  assert.match(css, /\.automation-advanced\.is-open \.automation-advanced-body-inner\{opacity:1;padding:0 16px 16px\}/);
  assert.match(css, /\.automation-advanced-chevron\{[^}]*transition:transform var\(--za-motion-medium\) var\(--za-ease-out\)\}/);
  assert.match(css, /\.automation-advanced\.is-open \.automation-advanced-chevron\{transform:rotate\(180deg\)\}/);
});
