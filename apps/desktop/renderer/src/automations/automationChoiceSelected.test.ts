import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const cssUrl = new URL('./automations.css', import.meta.url);

test('Automation choice selected state is a restrained inset surface, not a double blue ring', async () => {
  const css = await readFile(cssUrl, 'utf8');
  const selectedRule = css.match(/\.automation-choice\.selected\{[^}]+\}/)?.[0] ?? '';
  const selectedRadioRule = css.match(/\.automation-choice\.selected \.automation-radio\{[^}]+\}/)?.[0] ?? '';

  assert.match(selectedRule, /background:var\(--ui-surface-selected\)/);
  assert.match(selectedRule, /border-color:var\(--za-line-strong\)/);
  assert.match(selectedRule, /box-shadow:none/);
  assert.equal(selectedRule.includes('box-shadow:0 0 0 1px'), false);
  assert.equal(selectedRule.includes('--ui-selected-border'), false);

  assert.match(selectedRadioRule, /border-color:var\(--za-accent\)/);
  assert.match(selectedRadioRule, /radial-gradient/);
  assert.equal(selectedRadioRule.includes('border:4px solid'), false);
  assert.equal(selectedRadioRule.includes('--ui-selected-border'), false);
});
