import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const stylesDir = dirname(fileURLToPath(import.meta.url));
const workbenchCss = readFileSync(join(stylesDir, 'workbench.css'), 'utf8');
const chatSurfaceCss = readFileSync(join(stylesDir, '../chat/styles/chat-surface.css'), 'utf8');

function ruleBody(css: string, selector: string): string {
  const marker = `${selector} {`;
  const start = css.indexOf(marker);
  assert.ok(start >= 0, `selector ${selector} missing`);
  const open = css.indexOf('{', start);
  let depth = 1;
  let i = open + 1;
  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') depth -= 1;
    i += 1;
  }
  return css.slice(open + 1, i - 1);
}

function ruleBodyAtLineStart(css: string, selector: string): string {
  const marker = `\n${selector} {`;
  const index = css.indexOf(marker);
  assert.ok(index >= 0, `selector ${selector} missing at line start`);
  return ruleBody(css.slice(index + 1), selector);
}

test('workbench panel uses the same paper surface as the chat area', () => {
  // 归一化缩进后锚定行首，避免命中 `:root[...] .workbench-panel` 这类复合选择器规则。
  const panel = ruleBodyAtLineStart(
    workbenchCss.replace(/\n\s+/g, '\n'),
    '.workbench-panel',
  );
  assert.match(
    panel,
    /background:\s*var\(--chrome-canvas,\s*var\(--za-app-bg\)\);/,
    '.workbench-panel must reference the chat paper token',
  );
  assert.doesNotMatch(
    panel,
    /background:\s*transparent/,
    '.workbench-panel must not fall back to a transparent glass shell',
  );
});

test('browser-view inside the panel uses the same paper surface', () => {
  const browser = ruleBody(workbenchCss, '.browser-view');
  assert.match(
    browser,
    /background:\s*var\(--chrome-canvas,\s*var\(--za-app-bg\)\);/,
    '.browser-view must reference the chat paper token',
  );
});

test('the chat paper token definition exists on .chat-surface', () => {
  const surface = ruleBody(chatSurfaceCss + '\n.chat-surface-x {', '.chat-surface');
  assert.match(
    surface,
    /background:\s*var\(--chrome-canvas\);/,
    'source of truth: .chat-surface background token',
  );
});
