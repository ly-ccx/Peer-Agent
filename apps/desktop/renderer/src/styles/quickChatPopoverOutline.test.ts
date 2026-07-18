import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cssPath = join(dirname(fileURLToPath(import.meta.url)), 'quick-chat.css');
const css = readFileSync(cssPath, 'utf8');

function ruleBody(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing rule for ${selector}`);
  return match[1];
}

test('compact popover is a single full-outline card, not a bar extension seam', () => {
  const shellRule = ruleBody('.quick-chat-popover-shell');
  const panelRule = ruleBody('.quick-chat-popover-panel');
  const openBarRule = ruleBody('.quick-chat-shell.has-open-popover .quick-chat-bar');

  assert.match(shellRule, /border:\s*1px solid var\(--quick-border\)/);
  assert.match(shellRule, /border-radius:\s*12px/);
  assert.doesNotMatch(shellRule, /border-top-color:\s*transparent/);
  assert.doesNotMatch(shellRule, /border-radius:\s*0 0/);
  assert.match(shellRule, /background:\s*var\(--quick-surface\)/);
  assert.match(panelRule, /background:\s*transparent/);
  assert.doesNotMatch(openBarRule, /border-bottom-color:\s*transparent/);
  assert.doesNotMatch(openBarRule, /border-bottom-left-radius:\s*0/);
});
