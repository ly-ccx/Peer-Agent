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

test('task overview buttons keep a stable native cursor region on macOS glass windows', async () => {
  const css = await readFile(new URL('./task-overview.css', import.meta.url), 'utf8');
  const button = ruleBody(css, '.task-overview-btn');

  assert.match(button, /cursor:\s*pointer/);
  assert.match(button, /-webkit-app-region:\s*no-drag/);
  assert.doesNotMatch(button, /transition-opacity/);
  assert.doesNotMatch(button, /opacity\s*:/);
  assert.doesNotMatch(css, /\.task-overview-btn:hover:not\(:disabled\)\s*\{[^}]*opacity\s*:/s);
});
