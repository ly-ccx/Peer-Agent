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

  assert.match(card, /background:\s*var\(--za-surface-0\)/);
  assert.match(card, /border-color:\s*var\(--za-line\)/);
  assert.doesNotMatch(card, /var\(--za-surface-1\)/);
  assert.doesNotMatch(card, /var\(--za-line-strong\)/);
  assert.doesNotMatch(card, /box-shadow\s*:/);

  assert.match(primaryButton, /background:\s*var\(--za-text\)/);
  assert.match(primaryButton, /color:\s*var\(--za-surface-0\)/);
});
