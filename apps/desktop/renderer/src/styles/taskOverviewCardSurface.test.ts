import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing ${selector}`);
  const bodyStart = css.indexOf('{', start) + 1;
  const end = css.indexOf('}', bodyStart);
  assert.notEqual(end, -1, `unterminated ${selector}`);
  return css.slice(bodyStart, end);
}

test('keeps running and acceptance cards on the light shared surface', async () => {
  const css = await readFile(new URL('./task-overview.css', import.meta.url), 'utf8');
  const card = ruleBody(css, '.task-overview-work-item');
  const primaryButton = ruleBody(css, '.task-overview-btn--primary');

  assert.match(card, /background:\s*var\(--paper-raised\)/);
  assert.match(card, /border-color:\s*var\(--chrome-hairline\)/);
  assert.doesNotMatch(card, /var\(--control-fill\)/);
  assert.doesNotMatch(card, /var\(--chrome-hairline-strong\)/);
  assert.doesNotMatch(card, /box-shadow\s*:/);

  assert.match(primaryButton, /background:\s*var\(--chrome-keycap-bg\)/);
  assert.match(primaryButton, /color:\s*var\(--chrome-keycap-fg\)/);
});

test('keeps cancel-row runtime meta on the left and actions on the right', async () => {
  const css = await readFile(new URL('./task-overview.css', import.meta.url), 'utf8');
  const actions = ruleBody(css, '.work-item-actions');
  const runtimeMeta = ruleBody(css, '.task-overview-work-meta--runtime');

  assert.match(actions, /justify-between/);
  assert.match(actions, /text-xs/);
  assert.match(runtimeMeta, /justify-start/);
  assert.match(runtimeMeta, /text-xs/);
});
