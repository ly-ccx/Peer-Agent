import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const TOKENS_PATH = new URL('./tokens.css', import.meta.url);
const SIDEBAR_PATH = new URL('./sidebar.css', import.meta.url);

function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing ${selector}`);
  const bodyStart = css.indexOf('{', start) + 1;
  const bodyEnd = css.indexOf('}', bodyStart);
  assert.notEqual(bodyEnd, -1, `unterminated rule for ${selector}`);
  return css.slice(bodyStart, bodyEnd);
}

test('--state-info is defined for Frost and Catppuccin themes', async () => {
  const css = await readFile(TOKENS_PATH, 'utf8');

  // Frost light + dark, Catppuccin latte + mocha
  const matches = css.match(/--state-info:\s*#[0-9A-Fa-f]{6}/g) ?? [];
  assert.equal(matches.length, 4, `expected 4 --state-info definitions, got ${matches.length}`);

  // Frost light must stay cold azure (not Tailwind blue-500)
  assert.match(css, /--state-info:\s*#3B7FAB/i);
  assert.match(css, /--state-info:\s*#5D9CBF/i);
});

test('.ws-running-dot consumes --state-info without hardcoded blue fallback', async () => {
  const css = await readFile(SIDEBAR_PATH, 'utf8');
  const body = ruleBody(css, '.ws-running-dot');

  assert.match(body, /background:\s*var\(--state-info\)/);
  assert.match(body, /--motion-ripple-color:\s*var\(--state-info\)/);
  assert.doesNotMatch(body, /#3b82f6/i);
  assert.doesNotMatch(body, /var\(--state-info,\s*#/i);
});

test('sidebar.css has no leftover #3b82f6 escape color', async () => {
  const css = await readFile(SIDEBAR_PATH, 'utf8');
  assert.doesNotMatch(css, /#3b82f6/i);
});
