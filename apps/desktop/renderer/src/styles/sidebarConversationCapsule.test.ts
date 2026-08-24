import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const stylesDir = dirname(fileURLToPath(import.meta.url));
const sidebarCss = readFileSync(join(stylesDir, 'sidebar.css'), 'utf8');
const chatSidebarCss = readFileSync(join(stylesDir, '../chat/styles/sidebar.css'), 'utf8');
const sidebarSource = readFileSync(join(stylesDir, '../chat/components/Sidebar.tsx'), 'utf8');

function ruleBody(css: string, selector: string) {
  const startToken = `${selector} {`;
  let searchFrom = 0;
  while (searchFrom < css.length) {
    const start = css.indexOf(startToken, searchFrom);
    assert.notEqual(start, -1, `Expected CSS rule for ${selector}`);
    if (start === 0 || css[start - 1] === '\n' || css[start - 1] === ' ') {
      const bodyStart = start + startToken.length;
      const end = css.indexOf('}', bodyStart);
      assert.notEqual(end, -1, `Expected closing brace for ${selector}`);
      return css.slice(bodyStart, end);
    }
    searchFrom = start + startToken.length;
  }
  assert.fail(`Expected CSS rule for ${selector}`);
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

test('conversation capsules stay compact and vertically centered', () => {
  const rowBody = ruleBody(sidebarCss, '.channel-conversation-list .conversation-row');
  const titleBody = ruleBody(sidebarCss, '.conversation-row .sidebar-conv-title');
  const timeBody = ruleBody(sidebarCss, '.sidebar-conv-time');
  const layeredChannelRow = ruleBody(
    chatSidebarCss,
    '.channel-conversation-list .conversation-row',
  );

  assert.match(rowBody, /align-items:\s*center;/);
  assert.match(rowBody, /line-height:\s*1;/);
  assert.match(rowBody, /min-height:\s*26px;/);
  assert.match(rowBody, /padding:\s*3px var\(--sidebar-conv-row-pad-x\);/);
  assert.match(titleBody, /line-height:\s*1;/);
  assert.match(titleBody, /font-size:\s*inherit;/);
  assert.match(timeBody, /line-height:\s*1;/);
  assert.match(layeredChannelRow, /min-height:\s*26px;/);
  assert.doesNotMatch(rowBody, /min-height:\s*32px;/);
  assert.doesNotMatch(layeredChannelRow, /min-h-8/);
});

test('pin lives in the trailing action slot instead of a leading gutter', () => {
  const pinIndex = sidebarSource.indexOf('sidebar-conv-pin ${isPinned');
  const actionsIndex = sidebarSource.indexOf('className="sidebar-conv-actions"');
  const archiveIndex = sidebarSource.indexOf('className="sidebar-conv-archive"');

  assert.notEqual(pinIndex, -1, 'expected trailing pin button');
  assert.notEqual(actionsIndex, -1, 'expected trailing action slot');
  assert.ok(pinIndex > actionsIndex, 'pin should render inside trailing actions');
  assert.ok(archiveIndex > pinIndex, 'archive should stay after pin');
  assert.doesNotMatch(sidebarSource, /sidebar-conv-pin-leading/);
  assert.doesNotMatch(sidebarSource, /sidebar-conv-edit/);
  assert.doesNotMatch(sidebarCss, /sidebar-conv-pin-leading/);
  assert.doesNotMatch(sidebarCss, /--sidebar-conv-leading-gutter/);
  assert.doesNotMatch(sidebarCss, /sidebar-conv-edit/);
  assert.match(
    sidebarCss,
    /\.conversation-row:hover:not\(\.is-editing\):not\(\.is-confirming-delete\) \.sidebar-conv-time,/,
  );
});

test('selected conversation capsules stay a fill instead of a lifted card', () => {
  const activeBody = ruleBody(
    sidebarCss,
    '.channel-conversation-list .conversation-row.active',
  );
  const layeredActiveBody = ruleBody(chatSidebarCss, '.conversation-row.active');
  const layeredActiveHoverBody = ruleBody(chatSidebarCss, '.conversation-row.active:hover');

  assert.match(activeBody, /box-shadow:\s*none;/);
  assert.doesNotMatch(activeBody, /--shadow-soft|--shadow-composer/);
  assert.match(layeredActiveBody, /box-shadow:\s*none;/);
  assert.doesNotMatch(layeredActiveBody, /--shadow-soft|--shadow-composer/);
  assert.match(layeredActiveHoverBody, /box-shadow:\s*none;/);
  assert.doesNotMatch(layeredActiveHoverBody, /--shadow-soft|--shadow-composer/);
});
