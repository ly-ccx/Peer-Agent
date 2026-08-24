import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const stylesDir = dirname(fileURLToPath(import.meta.url));
const sidebarCss = readFileSync(join(stylesDir, 'sidebar.css'), 'utf8');

function ruleBody(css: string, selector: string) {
  const startToken = `\n${selector} {`;
  const start = css.indexOf(startToken);
  assert.notEqual(start, -1, `Expected CSS rule for ${selector}`);
  const bodyStart = start + startToken.length;
  const end = css.indexOf('}', bodyStart);
  assert.notEqual(end, -1, `Expected closing brace for ${selector}`);
  return css.slice(bodyStart, end);
}

test('workspace conversation capsules keep resting left/right padding on one token', () => {
  const body = ruleBody(
    sidebarCss,
    '.sidebar-workspace-tasks.channel-conversation-list .conversation-row',
  );

  assert.match(body, /--sidebar-conv-row-pad-x:\s*8px;/);
  assert.match(body, /padding:\s*3px var\(--sidebar-conv-row-pad-x\);/);
  assert.doesNotMatch(body, /padding:\s*3px 8px 3px var\(--sidebar-conv-row-pad-x\)/);
  assert.doesNotMatch(body, /--sidebar-conv-row-pad-x:\s*4px;/);
});

test('conversation capsules stay compact on the vertical axis', () => {
  const body = ruleBody(sidebarCss, '.channel-conversation-list .conversation-row');

  assert.match(body, /min-height:\s*26px;/);
  assert.match(body, /padding:\s*3px var\(--sidebar-conv-row-pad-x\);/);
  assert.doesNotMatch(body, /min-height:\s*32px;/);
  assert.doesNotMatch(body, /padding:\s*5px var\(--sidebar-conv-row-pad-x\)/);
});

test('hover and focus still reserve only the leading pin gutter', () => {
  const pinGutter = /padding-left:\s*calc\(var\(--sidebar-conv-row-pad-x\) \+ var\(--sidebar-conv-leading-gutter\)\);/;

  assert.match(
    ruleBody(
      sidebarCss,
      '.channel-conversation-list .conversation-row:hover,\n.channel-conversation-list .conversation-row:focus-within',
    ),
    pinGutter,
  );
  assert.match(
    ruleBody(
      sidebarCss,
      '.sidebar-workspace-tasks.channel-conversation-list .conversation-row:hover,\n.sidebar-workspace-tasks.channel-conversation-list .conversation-row:focus-within',
    ),
    pinGutter,
  );
  assert.match(
    sidebarCss,
    /\.conversation-row:hover:not\(\.is-editing\):not\(\.is-confirming-delete\) \.sidebar-conv-time,/,
  );
});
