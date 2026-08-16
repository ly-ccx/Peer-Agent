import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const stylesDir = dirname(fileURLToPath(import.meta.url));
const workbenchCss = readFileSync(join(stylesDir, 'workbench.css'), 'utf8');
const chatSurfaceCss = readFileSync(join(stylesDir, '../chat/styles/chat-surface.css'), 'utf8');

function ruleBody(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `Expected CSS rule for ${selector}`);
  return match[1];
}

test('chat header and workbench tab rail share a locked 40px chrome hairline', () => {
  const header = ruleBody(chatSurfaceCss, '.chat-header');
  const rail = ruleBody(workbenchCss, '.workbench-tab-rail');

  for (const [name, body] of [
    ['.chat-header', header],
    ['.workbench-tab-rail', rail],
  ] as const) {
    assert.match(body, /height:\s*40px;/, `${name} must be 40px tall`);
    assert.match(body, /min-height:\s*0;/, `${name} must defeat flex min-height:auto`);
    assert.match(body, /max-height:\s*40px;/, `${name} must not grow past 40px`);
  }

  assert.match(rail, /border-bottom:\s*1px solid var\(--chrome-hairline\);/);
  assert.match(
    ruleBody(chatSurfaceCss, ":root[data-workbench-open='true'] .chat-header"),
    /border-bottom-color:\s*var\(--chrome-hairline\);/,
  );
});
