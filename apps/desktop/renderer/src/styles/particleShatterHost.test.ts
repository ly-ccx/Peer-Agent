import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const cssUrl = new URL('./particle-shatter.css', import.meta.url);

function hostRule(css: string): string {
  const start = css.indexOf('.particle-shatter-host {');
  assert.notEqual(start, -1, 'missing .particle-shatter-host rule');
  const end = css.indexOf('\n}', start);
  assert.notEqual(end, -1, 'unterminated .particle-shatter-host rule');
  return css.slice(start, end);
}

test('particle shatter host height follows the card until it collapses', async () => {
  const css = await readFile(cssUrl, 'utf8');
  const resting = hostRule(css);

  assert.match(resting, /max-height:\s*none/);
  assert.doesNotMatch(resting, /max-height:\s*320px/);
  assert.match(css, /\.particle-shatter-host\.is-exiting\s*\{[\s\S]*?max-height:\s*0;/);
});
