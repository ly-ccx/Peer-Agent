import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const cssUrl = new URL('./task-overview.css', import.meta.url);

function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing ${selector}`);
  const bodyStart = css.indexOf('{', start) + 1;
  const end = css.indexOf('}', bodyStart);
  assert.notEqual(end, -1, `unterminated ${selector}`);
  return css.slice(bodyStart, end);
}

test('work stream keeps responsive columns and caps its only card', async () => {
  const css = await readFile(cssUrl, 'utf8');

  const stream = ruleBody(css, '.task-overview-work-stream');
  assert.match(
    stream,
    /grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(100%,\s*28rem\),\s*1fr\)\)/,
  );

  const onlyCard = ruleBody(css, '.task-overview-work-stream:has(> :only-child)');
  assert.match(onlyCard, /grid-template-columns:\s*minmax\(0,\s*42rem\)/);
  assert.doesNotMatch(onlyCard, /width:|min-width:/);
});
