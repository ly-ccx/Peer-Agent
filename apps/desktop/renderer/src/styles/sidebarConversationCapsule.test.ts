import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const stylesDir = dirname(fileURLToPath(import.meta.url));
const sidebarCss = readFileSync(join(stylesDir, 'sidebar.css'), 'utf8');
const chatSidebarCss = readFileSync(join(stylesDir, '../chat/styles/sidebar.css'), 'utf8');
const tokensCss = readFileSync(join(stylesDir, 'tokens.css'), 'utf8');
const sidebarSource = readFileSync(join(stylesDir, '../chat/components/Sidebar.tsx'), 'utf8');
const sidebarRowSource = readFileSync(
  join(stylesDir, '../chat/components/SidebarConversationRow.tsx'),
  'utf8',
);

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
  assert.match(rowBody, /font-size:\s*var\(--ui-font-control\);/);
  assert.match(rowBody, /line-height:\s*1;/);
  assert.match(rowBody, /min-height:\s*28px;/);
  assert.match(rowBody, /padding:\s*5px var\(--sidebar-conv-row-pad-x\);/);
  assert.match(rowBody, /border-radius:\s*var\(--ui-radius-row, 8px\);/);
  assert.doesNotMatch(rowBody, /--ui-radius-panel/);
  assert.match(layeredRow, /border-radius:\s*var\(--ui-radius-row, 8px\);/);
  assert.doesNotMatch(layeredRow, /--ui-radius-panel/);
  assert.match(titleBody, /line-height:\s*1;/);
  assert.match(titleBody, /font-size:\s*var\(--ui-font-control\);/);
  assert.doesNotMatch(titleBody, /font-size:\s*inherit;/);
  assert.match(chatSidebarCss, /\.conversation-row \.sidebar-conv-title \{[\s\S]*?font-size:\s*var\(--ui-font-control\)/);
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
  const pinIndex = sidebarRowSource.indexOf('sidebar-conv-pin ${isPinned');
  const actionsIndex = sidebarRowSource.indexOf('className="sidebar-conv-actions"');
  const archiveIndex = sidebarRowSource.indexOf('className="sidebar-conv-archive"');

  assert.notEqual(pinIndex, -1, 'expected trailing pin button');
  assert.notEqual(actionsIndex, -1, 'expected trailing action slot');
  assert.ok(pinIndex > actionsIndex, 'pin should render inside trailing actions');
  assert.ok(archiveIndex > pinIndex, 'archive should stay after pin');
  assert.doesNotMatch(sidebarRowSource, /sidebar-conv-pin-leading/);
  assert.doesNotMatch(sidebarRowSource, /sidebar-conv-edit/);
  assert.doesNotMatch(sidebarCss, /sidebar-conv-pin-leading/);
  assert.doesNotMatch(sidebarCss, /--sidebar-conv-leading-gutter/);
  assert.doesNotMatch(sidebarCss, /sidebar-conv-edit/);
  assert.match(
    sidebarCss,
    /\.conversation-row:hover:not\(\.is-editing\):not\(\.is-confirming-delete\) \.sidebar-conv-time,/,
  );
});

test('selected conversation rows use a restrained ambient lift, not a card shadow', () => {
  const activeBody = ruleBody(
    sidebarCss,
    '.channel-conversation-list .conversation-row.active',
  );
  const layeredActiveBody = ruleBody(chatSidebarCss, '.conversation-row.active');
  const layeredActiveHoverBody = ruleBody(chatSidebarCss, '.conversation-row.active:hover');

  assert.match(activeBody, /box-shadow:\s*var\(--za-sidebar-active-shadow/);
  assert.doesNotMatch(activeBody, /--shadow-soft|--shadow-composer/);
  assert.match(layeredActiveBody, /box-shadow:\s*var\(--za-sidebar-active-shadow/);
  assert.doesNotMatch(layeredActiveBody, /--shadow-soft|--shadow-composer/);
  assert.match(layeredActiveHoverBody, /box-shadow:\s*var\(--za-sidebar-active-shadow/);
  assert.doesNotMatch(layeredActiveHoverBody, /--shadow-soft|--shadow-composer/);

  assert.match(tokensCss, /--za-sidebar-active-shadow:\s*0 0 0 0\.5px/);
});

test('nested workspace session lists do not crop a single selected capsule shadow', () => {
  const nestedListBody = ruleBody(
    sidebarCss,
    '.sidebar-workspace-tasks.channel-conversation-list',
  );
  const nestedRowBody = ruleBody(
    sidebarCss,
    '.sidebar-workspace-tasks.channel-conversation-list .conversation-row',
  );
  const activeBody = ruleBody(
    sidebarCss,
    '.channel-conversation-list .conversation-row.active',
  );

  assert.match(nestedListBody, /overflow:\s*visible;/);
  assert.doesNotMatch(nestedListBody, /overflow-x:\s*hidden;/);
  assert.doesNotMatch(nestedListBody, /overflow-y:\s*auto;/);
  assert.match(nestedListBody, /padding:\s*6px 4px 6px 6px;/);
  assert.doesNotMatch(nestedListBody, /padding:\s*0 var\(--space-2\);/);
  assert.match(nestedRowBody, /--sidebar-conv-row-pad-x:\s*8px;/);
  assert.match(activeBody, /box-shadow:\s*var\(--za-sidebar-active-shadow/);
});

test('selected highlight lives on the conversation, not the workspace row', () => {
  const workspaceActiveBody = ruleBody(
    sidebarCss,
    '.sidebar-workspace-node.is-home > .sidebar-workspace-row',
  );
  const activeBody = ruleBody(
    sidebarCss,
    '.channel-conversation-list .conversation-row.active',
  );
  const layeredActiveBody = ruleBody(chatSidebarCss, '.conversation-row.active');
  const layeredActiveHoverBody = ruleBody(chatSidebarCss, '.conversation-row.active:hover');

  assert.match(workspaceActiveBody, /background:\s*transparent;/);
  assert.doesNotMatch(workspaceActiveBody, /--za-sidebar-active-bg|--ui-surface-selected/);
  assert.match(activeBody, /background:\s*var\(--za-sidebar-active-bg/);
  assert.doesNotMatch(activeBody, /--ui-surface-selected|--za-sidebar-thread-active-bg/);
  assert.match(layeredActiveBody, /background:\s*var\(--za-sidebar-active-bg/);
  assert.doesNotMatch(layeredActiveBody, /--ui-surface-selected|--za-sidebar-thread-active-bg/);
  assert.match(layeredActiveHoverBody, /background:\s*var\(--za-sidebar-active-bg/);
  assert.doesNotMatch(layeredActiveHoverBody, /--ui-surface-selected|--za-sidebar-thread-active-bg/);
});

test('selected fill tracks frosted chrome hover across light and dark themes', () => {
  const activeBgBindings = tokensCss.match(/--za-sidebar-active-bg:\s*[^;]+;/g) ?? [];
  const threadActiveBgBindings =
    tokensCss.match(/--za-sidebar-thread-active-bg:\s*[^;]+;/g) ?? [];

  assert.equal(activeBgBindings.length, 4);
  assert.equal(threadActiveBgBindings.length, 4);
  for (const binding of [...activeBgBindings, ...threadActiveBgBindings]) {
    assert.match(binding, /var\(--glass-chrome-hover\)/);
  }

  assert.match(tokensCss, /--glass-chrome-hover:\s*hsla\(/);
  assert.match(tokensCss, /--ui-surface-hover:\s*var\(--za-hover\);/);

  assert.match(
    ruleBody(sidebarCss, '.channel-conversation-list .conversation-row.active'),
    /background:\s*var\(--za-sidebar-active-bg/,
  );
  assert.match(
    ruleBody(chatSidebarCss, '.conversation-row.active'),
    /background:\s*var\(--za-sidebar-active-bg/,
  );
});

test('workspace rows stack the path under the name so the name can use the full width', () => {
  const metaBody = ruleBody(sidebarCss, '.sidebar-workspace-meta');
  const nameBody = ruleBody(sidebarCss, '.sidebar-workspace-name');
  const pathBody = ruleBody(sidebarCss, '.sidebar-workspace-path');

  assert.match(metaBody, /flex-direction:\s*column;/);
  assert.doesNotMatch(metaBody, /flex-direction:\s*row;/);
  assert.doesNotMatch(nameBody, /flex:\s*0 1 auto;/);
  assert.doesNotMatch(pathBody, /flex:\s*1 1 auto;/);
});
