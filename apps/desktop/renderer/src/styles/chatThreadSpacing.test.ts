import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const stylesDir = dirname(fileURLToPath(import.meta.url));
const chatSurfaceCss = readFileSync(join(stylesDir, '../chat/styles/chat-surface.css'), 'utf8');

function ruleBody(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `Expected CSS rule for ${selector}`);
  return match[1];
}

test('chat thread keeps visual spacing below the floating header', () => {
  const expectedTopPadding = /padding-top:\s*calc\(40px \+ var\(--space-4\)\)/;

  assert.match(ruleBody(chatSurfaceCss, '.chat-thread'), expectedTopPadding);
  assert.match(
    ruleBody(chatSurfaceCss, '.app-shell.is-fullscreen .chat-thread'),
    expectedTopPadding,
  );
});
