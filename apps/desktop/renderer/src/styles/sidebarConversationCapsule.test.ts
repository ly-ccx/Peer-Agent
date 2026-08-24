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
  const startToken = `\n${selector} {`;
  const indentedToken = `\n  ${selector} {`;
  const start = css.includes(startToken)
    ? css.indexOf(startToken)
    : css.indexOf(indentedToken);
  assert.notEqual(start, -1, `Expected CSS rule for ${selector}`);
  const token = css.includes(startToken) ? startToken : indentedToken;
  const bodyStart = start + token.length;
  const end = css.indexOf('}', bodyStart);
  assert.notEqual(end, -1, `Expected closing brace for ${selector}`);
  return css.slice(bodyStart, end);
}

test('workspace conversation rows keep resting left/right padding on one token', () => {
  const body = ruleBody(
    sidebarCss,
    '.sidebar-workspace-tasks.channel-conversation-list .conversation-row',
  );

  assert.match(body, /--sidebar-conv-row-pad-x:\s*8px;/);
  assert.match(body, /padding:\s*5px var\(--sidebar-conv-row-pad-x\);/);
  assert.doesNotMatch(body, /padding:\s*3px 8px 3px var\(--sidebar-conv-row-pad-x\)/);
  assert.doesNotMatch(body, /--sidebar-conv-row-pad-x:\s*4px;/);
});

test('conversation rows stay list geometry instead of capsules', () => {
  const rowBody = ruleBody(sidebarCss, '.channel-conversation-list .conversation-row');
  const titleBody = ruleBody(sidebarCss, '.conversation-row .sidebar-conv-title');
  const timeBody = ruleBody(sidebarCss, '.sidebar-conv-time');
  const layeredChannelRow = ruleBody(
    chatSidebarCss,
    '.channel-conversation-list .conversation-row',
  );
  const layeredRow = ruleBody(chatSidebarCss, '.conversation-row');

  assert.match(rowBody, /align-items:\s*center;/);
  assert.match(rowBody, /font-size:\s*var\(--ui-font-body\);/);
  assert.match(rowBody, /line-height:\s*1;/);
  assert.match(rowBody, /min-height:\s*28px;/);
  assert.match(rowBody, /padding:\s*5px var\(--sidebar-conv-row-pad-x\);/);
  assert.match(rowBody, /border-radius:\s*var\(--ui-radius-row, 8px\);/);
  assert.doesNotMatch(rowBody, /--ui-radius-panel/);
  assert.match(layeredRow, /border-radius:\s*var\(--ui-radius-row, 8px\);/);
  assert.doesNotMatch(layeredRow, /--ui-radius-panel/);
  assert.match(titleBody, /line-height:\s*1;/);
  assert.match(titleBody, /font-size:\s*var\(--ui-font-body\);/);
  assert.doesNotMatch(titleBody, /font-size:\s*inherit;/);
  assert.match(chatSidebarCss, /\.conversation-row \.sidebar-conv-title \{[\s\S]*?font-size:\s*var\(--ui-font-body\)/);
  assert.match(chatSidebarCss, /\.conversation-row span:not\(\.sidebar-conv-title\)/);
  assert.match(timeBody, /line-height:\s*1;/);
  assert.match(timeBody, /color:\s*var\(--graphite-mute\);/);
  assert.match(layeredChannelRow, /min-height:\s*28px;/);
  assert.doesNotMatch(rowBody, /min-height:\s*26px;/);
});

test('resting conversation rows keep quieter type; selected stays unbolded', () => {
  const rowBody = ruleBody(sidebarCss, '.channel-conversation-list .conversation-row');
  const activeBody = ruleBody(
    sidebarCss,
    '.channel-conversation-list .conversation-row.active',
  );

  assert.match(rowBody, /color:\s*var\(--graphite-soft\);/);
  assert.match(rowBody, /font-weight:\s*400;/);
  assert.match(activeBody, /font-weight:\s*400;/);
  assert.doesNotMatch(activeBody, /font-weight:\s*500;/);
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

test('selected conversation rows stay a fill instead of a lifted card', () => {
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
