import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'confirm-dialog.css'), 'utf8');

function ruleBody(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `Expected CSS rule for ${selector}`);
  return match[1];
}

test('confirm dialog inputs use theme-aware control fill, not a white fallback', () => {
  const input = ruleBody('.pa-confirm-input');
  assert.match(input, /appearance:\s*none/);
  assert.match(input, /-webkit-appearance:\s*none/);
  assert.match(input, /background:\s*var\(--za-control-fill\)/);
  assert.match(input, /color-scheme:\s*inherit/);
  assert.doesNotMatch(css, /--surface-vellum,\s*#fff/);
});

test('confirm dialog primary button uses theme primary control tokens', () => {
  const button = ruleBody('.pa-confirm-btn');
  assert.match(button, /appearance:\s*none/);
  assert.match(button, /-webkit-appearance:\s*none/);
  assert.match(button, /color-scheme:\s*inherit/);

  const primary = ruleBody('.pa-confirm-btn.primary');
  assert.match(primary, /background:\s*var\(--za-primary-control-bg\)/);
  assert.match(primary, /color:\s*var\(--za-primary-control-ink\)/);
  assert.doesNotMatch(primary, /--ink-base/);
});
