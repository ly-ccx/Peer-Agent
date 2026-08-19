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

test('work stream lets short cards shrink to their content instead of matching the neighbor', async () => {
  const css = await readFile(cssUrl, 'utf8');
  const stream = ruleBody(css, '.task-overview-work-stream');
  assert.match(stream, /align-items:\s*start/);
  assert.doesNotMatch(stream, /align-items:\s*stretch/);
  assert.doesNotMatch(css, /\.task-overview-work-item[^{]*\{[^}]*min-height:/);

  const actions = ruleBody(css, '.work-item-actions');
  assert.doesNotMatch(actions, /mt-auto|margin-top:\s*auto/);
});

test('three-plus cards can pack into waterfall columns instead of equal-height rows', async () => {
  const css = await readFile(cssUrl, 'utf8');
  const waterfall = ruleBody(css, '.task-overview-work-stream.is-waterfall');
  assert.match(waterfall, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);

  const column = ruleBody(css, '.task-overview-work-stream__column');
  assert.match(column, /flex-direction:\s*column|flex-col/);
  assert.doesNotMatch(column, /min-height:/);
});

test('result stack no longer hard-cuts into a viewport two-column row grid', async () => {
  const css = await readFile(cssUrl, 'utf8');
  const stack = ruleBody(css, '.result-card-stack');
  assert.match(stack, /display:\s*contents/);
  assert.doesNotMatch(css, /@media \(min-width:\s*768px\)[\s\S]*?\.result-card-stack/);
  assert.doesNotMatch(
    css,
    /\.goal-thread-stream\s*\{[\s\S]*?grid-template-columns:\s*repeat\(auto-fit/,
  );
});
