import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readView = () =>
  readFile(new URL('./ConversationResultView.tsx', import.meta.url), 'utf8');
const readApp = () => readFile(new URL('../../App.tsx', import.meta.url), 'utf8');
const readStyles = () =>
  readFile(new URL('../../styles/task-overview.css', import.meta.url), 'utf8');

test('result view stays a pure content component without acceptance logic', async () => {
  const source = await readView();
  assert.match(source, /export function ConversationResultView\(\{/);
  assert.doesNotMatch(source, /runAcceptanceTransition/);
  assert.doesNotMatch(source, /onAcceptancePhaseChange/);
  assert.doesNotMatch(source, /conversation-result-view__footer/);
  assert.doesNotMatch(source, /acceptancePhase/);
  // 打开结果侧栏时不得调用 scrollIntoView(...)，否则会带动 drawer body 整体上滚。
  assert.doesNotMatch(source, /scrollIntoView\s*\(/);
  assert.match(source, /交卷前查过/);
  assert.match(source, /item\.qualityChecks/);
  assert.doesNotMatch(source, /意图关|机械关|产物关|集成关/);
  assert.doesNotMatch(source, /Finding|第 N 轮|第\s*\d+\s*轮/);
});

test('result drawer keeps 确认验收 and routes 还不行 back to the conversation', async () => {
  const [app, styles] = await Promise.all([readApp(), readStyles()]);
  assert.match(app, /closeResult: item\.actionRight === 'result_ready'/);
  assert.match(app, /continuation\.label/);
  assert.match(app, /\? '确认验收'/);
  assert.match(styles, /conversation-result-view__checks/);
  assert.doesNotMatch(app, /意见表|请写下意见|交给 Peer/);
});

test('result drawer places actions in a separate footer sibling of the body', async () => {
  const source = await readApp();
  const styles = await readStyles();
  // 三区：head / body / footer 是抽屉的直接子节点，footer 在 body 之后。
  assert.match(source, /conversation-result-drawer__head/);
  assert.match(source, /conversation-result-drawer__body/);
  assert.match(
    source,
    /<div(?:\s+ref=\{resultBodyRef\})?\s+className="conversation-result-drawer__body">[\s\S]*?<ConversationResultView[\s\S]*?<\/div>[\s\S]*?<footer className="conversation-result-drawer__footer">/,
  );
  assert.match(source, /conversation-result-drawer__scroll-bottom/);
  assert.match(source, /chat-scroll-bottom-btn/);
  assert.match(source, /M12 5v14/);
  assert.match(source, /resultBodyRef/);
  assert.match(source, /showResultScrollToBottom/);
  assert.match(source, /scrollResultToBottom/);
  assert.match(styles, /\.conversation-result-drawer__footer \{/);
  assert.match(styles, /\.conversation-result-drawer__scroll-bottom\.chat-scroll-bottom-btn \{/);
  assert.doesNotMatch(styles, /\.conversation-result-view__footer/);
});

test('result drawer closes first and leaves shatter to the workbench card', async () => {
  const source = await readApp();
  assert.doesNotMatch(source, /ParticleShatterOverlay/);
  assert.doesNotMatch(source, /resultShatterRef/);
  assert.doesNotMatch(source, /resultShattering/);
  assert.doesNotMatch(source, /setResultAcceptancePhase/);
  assert.doesNotMatch(source, /runAcceptanceTransition/);
  assert.match(source, /setResultAcceptancePending\(item\)/);
  assert.match(source, /requestClose\(\)/);
  assert.match(source, /acceptHandlerRef=\{workbenchAcceptRef\}/);
  assert.match(source, /workbenchAcceptRef\.current\?\.\(pending\)/);
});

test('result drawer no longer mounts a fullscreen shatter layer', async () => {
  const [source, styles] = await Promise.all([readApp(), readStyles()]);
  assert.doesNotMatch(source, /conversation-result-drawer__shatter-host/);
  assert.doesNotMatch(source, /conversation-result-drawer__shatter-source/);
  assert.doesNotMatch(styles, /conversation-result-drawer__shatter-host/);
  assert.doesNotMatch(styles, /conversation-result-drawer__shatter-source/);
  assert.doesNotMatch(styles, /conversation-result-drawer--shattering/);
});

test('result drawer splits into head, scrolling body and independent footer', async () => {
  const styles = await readStyles();
  const overlay = await readFile(
    new URL('../../styles/overlay.css', import.meta.url),
    'utf8',
  );
  // head 固定，不参与高度抢占。
  assert.match(
    styles,
    /\.conversation-result-drawer__head \{[\s\S]*?@apply flex flex-none items-start/,
  );
  // body 是唯一滚动区，且必须 flex:1 1 0 吃掉剩余高度，避免空白落在 footer 下方。
  assert.match(
    styles,
    /\.conversation-result-drawer__body \{[\s\S]*?@apply min-h-0 overflow-y-auto px-5 py-4;[\s\S]*?flex: 1 1 0;/,
  );
  // footer 是 flex-none 的独立底部区域，并用 margin-top:auto 贴底。
  assert.match(
    styles,
    /\.conversation-result-drawer__footer \{[\s\S]*?@apply flex flex-none items-start justify-between gap-3 px-5 pb-4 pt-3;[\s\S]*?margin-top: auto;[\s\S]*?border-top: 1px solid var\(--za-line\);/,
  );
  // 抽屉本体自己吃满 panel，不再依赖粉碎包裹层撑高度。
  assert.match(
    styles,
    /\.conversation-result-drawer \{[\s\S]*?flex: 1 1 0;[\s\S]*?align-self: stretch;[\s\S]*?max-height: 100%;/,
  );
  // CRV 不再 h-full 叠百分比高度。
  assert.match(
    styles,
    /\.conversation-result-view \{[\s\S]*?@apply flex min-h-0 flex-col gap-4;[\s\S]*?height: auto;/,
  );
  // drawer panel 贴满 fixed backdrop，禁止用 100vh 造成底部色差缝。
  assert.match(
    overlay,
    /\.pa-overlay-backdrop--drawer \.pa-overlay-panel \{[\s\S]*?height: 100%;[\s\S]*?max-height: 100%;/,
  );
  assert.doesNotMatch(
    overlay,
    /\.pa-overlay-backdrop--drawer \.pa-overlay-panel \{[\s\S]*?height: 100vh;/,
  );
});
