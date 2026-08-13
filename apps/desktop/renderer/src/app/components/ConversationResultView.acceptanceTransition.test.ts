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
  // 三区：head / body / footer 都是 shatter-source 的直接兄弟，footer 在 body 之后。
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

test('result drawer shell shatters the whole panel before unload', async () => {
  const source = await readApp();
  assert.match(source, /ParticleShatterOverlay/);
  assert.match(source, /conversation-result-drawer__shatter-host/);
  assert.match(source, /conversation-result-drawer__shatter-source/);
  assert.match(source, /onPhase: setResultAcceptancePhase/);
  assert.match(source, /active=\{resultShattering\}/);
  assert.match(source, /targetRef=\{resultShatterRef\}/);
  assert.match(source, /keepResultDrawer: true/);
  assert.match(
    source,
    /ref=\{resultShatterRef\}[\s\S]*?conversation-result-drawer__head[\s\S]*?conversation-result-drawer__body[\s\S]*?conversation-result-drawer__footer[\s\S]*?<\/div>[\s\S]*?<ParticleShatterOverlay active=\{resultShattering\} targetRef=\{resultShatterRef\}/,
  );

  const acceptHandler = source.slice(
    source.indexOf('const acceptResultFromWorkbench'),
    source.indexOf('const cancelPlanFromWorkbench'),
  );
  const keepDrawerBranch = acceptHandler.match(
    /if \(!options\?\.keepResultDrawer\) \{\n([\s\S]*?)\n        \}/,
  );
  assert.ok(keepDrawerBranch, 'accept handler must have a keepResultDrawer guard');
  assert.match(keepDrawerBranch[1], /setResultDrawerItem/);
  assert.match(
    keepDrawerBranch[1],
    /setCollectionDrawer\(\(current\) => \(current === 'result' \? null : current\)\)/,
    'keepResultDrawer must preserve both the result item and its drawer until animation settles',
  );

  // 验收完成前不得立刻清空侧栏；收尾发生在 onSettled。
  assert.match(
    source,
    /onSettled: \(\) => \{[\s\S]*?setResultDrawerItem\(null\);[\s\S]*?setCollectionDrawer\(null\);/,
  );
});

test('result drawer shatter styles keep canvas as a sibling of the source', async () => {
  const styles = await readStyles();
  assert.match(styles, /\.conversation-result-drawer__shatter-host/);
  assert.match(styles, /\.conversation-result-drawer__shatter-source/);
  assert.match(styles, /conversation-result-drawer--shattering/);
  assert.match(styles, /\.conversation-result-drawer__shatter-host \.particle-shatter-canvas/);
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
  // 粉碎包裹层按列排布三区，并用 flex-basis:0 + max-height:100% 避免「100%+head」溢出底部空白。
  assert.match(
    styles,
    /\.conversation-result-drawer__shatter-host,[\s\S]*?\.conversation-result-drawer__shatter-source \{[\s\S]*?flex: 1 1 0;[\s\S]*?max-height: 100%;/,
  );
  // host 必须吃满 panel（flex:1 1 0，勿用 auto 覆盖），避免底部露出 vibrancy 色差条。
  assert.match(
    styles,
    /\.conversation-result-drawer__shatter-host \{[\s\S]*?flex: 1 1 0;[\s\S]*?align-self: stretch;/,
  );
  assert.doesNotMatch(
    styles,
    /\.conversation-result-drawer__shatter-host \{[\s\S]*?flex: 1 1 auto;/,
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
