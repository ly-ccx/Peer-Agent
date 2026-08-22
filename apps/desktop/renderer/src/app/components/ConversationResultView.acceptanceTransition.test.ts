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
  assert.match(source, /对照标准/);
  assert.match(source, /pairAcceptanceCriteria/);
  assert.match(source, /resolveEvidenceLabel/);
  assert.match(source, /acceptancePageMeta/);
  assert.match(source, /projectTaskOverviewArtifacts/);
  assert.match(source, /evaluateAcceptanceCloseGate/);
  assert.match(source, /projectAcceptanceBasis/);
  assert.match(source, /授权摘要/);
  assert.match(source, /依据时间线/);
  assert.match(source, /gitDiffRange/);
  assert.match(source, /建议合入/);
  assert.match(source, /代码改动/);
  assert.match(source, /conversation-result-view__diff/);
  assert.match(source, /conversation-result-view__mark/);
  assert.doesNotMatch(source, />\{\s*isZh \? '任务现场' : 'Task thread'\s*\}/);
  assert.doesNotMatch(source, /summaryProgress|plan\?\.progress|plan\?\.tasks/);
  assert.doesNotMatch(source, /conversation-result-view__evidence/);
  assert.doesNotMatch(source, /意图关|机械关|产物关|集成关/);
  assert.doesNotMatch(source, /Finding|第 N 轮|第\s*\d+\s*轮/);
});

test('result view is criteria-first and does not remount the task thread', async () => {
  const source = await readView();
  assert.doesNotMatch(source, /from '\.\.\/\.\.\/chat\/components\/thread\/ChatTurn'/);
  assert.doesNotMatch(source, /loadConversationMessages/);
  assert.doesNotMatch(source, /<ChatTurn/);
  assert.doesNotMatch(source, /function messageMarkdown/);
  assert.doesNotMatch(source, /conversation-result-view__msg/);
  assert.doesNotMatch(source, /conversation-result-view__progress/);
  assert.doesNotMatch(source, />子任务</);
});

test('result drawer keeps 确认验收 and 退回补充, without mounting a chat composer', async () => {
  const [app, styles] = await Promise.all([readApp(), readStyles()]);
  assert.doesNotMatch(app, /revealComposer/);
  assert.doesNotMatch(app, /hideComposer/);
  assert.doesNotMatch(app, /resultComposerVisible/);
  assert.doesNotMatch(app, /getTaskContinuationAction/);
  assert.match(app, /\? '确认验收'/);
  assert.match(app, /\? '退回补充'/);
  assert.match(app, /closeBlocked/);
  assert.match(app, /conversation-result-drawer__gate/);
  assert.match(styles, /conversation-result-view__checks/);
  assert.match(styles, /conversation-result-view__criteria/);
  assert.doesNotMatch(app, /意见表|请写下意见|交给 Peer/);
});

test('result drawer always shows ConversationResultView and keeps actions below the body', async () => {
  const source = await readApp();
  const styles = await readStyles();
  assert.doesNotMatch(source, /conversation-result-drawer__head/);
  assert.doesNotMatch(source, /查看结果|View result/);
  assert.match(source, /conversation-result-drawer__body/);
  assert.match(source, /<ConversationResultView/);
  assert.match(source, /onCloseGateChange=\{setResultCloseGate\}/);
  assert.doesNotMatch(source, /isPageActive=\{collectionDrawer === 'result'\}/);
  assert.match(source, /conversation-result-drawer__icon-close/);
  assert.match(source, /aria-label=\{isZh \? '关闭' : 'Close'\}/);
  assert.match(source, /<footer className="conversation-result-drawer__footer">/);
  assert.doesNotMatch(source, /resultBodyRef/);
  assert.doesNotMatch(source, /showResultScrollToBottom/);
  assert.doesNotMatch(source, /scrollResultToBottom/);
  assert.match(styles, /\.conversation-result-drawer__footer \{/);
  const resultPanelClass = source.match(
    /collectionDrawer === 'result'\s*\?[\s\S]*?: 'workbench-collection-drawer'/,
  )?.[0] ?? '';
  assert.match(resultPanelClass, /conversation-result-drawer/);
  assert.doesNotMatch(resultPanelClass, /conversation-chat-drawer/);
  assert.doesNotMatch(
    styles,
    /\.conversation-result-drawer\.conversation-chat-drawer \.conversation-result-drawer__body/,
  );
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
  assert.match(source, /resolveResultDrawerAcceptanceTargets\(pending, acceptTogether\)/);
  assert.match(source, /workbenchAcceptRef\.current\?\.\(pending\)/);
  assert.match(source, /void acceptResultFromWorkbench\(target\)/);
});

test('result drawer no longer mounts a fullscreen shatter layer', async () => {
  const [source, styles] = await Promise.all([readApp(), readStyles()]);
  assert.doesNotMatch(source, /conversation-result-drawer__shatter-host/);
  assert.doesNotMatch(source, /conversation-result-drawer__shatter-source/);
  assert.doesNotMatch(styles, /conversation-result-drawer__shatter-host/);
  assert.doesNotMatch(styles, /conversation-result-drawer__shatter-source/);
  assert.doesNotMatch(styles, /conversation-result-drawer--shattering/);
});

test('result drawer splits into scrolling body and independent footer without an outer header', async () => {
  const styles = await readStyles();
  const overlay = await readFile(
    new URL('../../styles/overlay.css', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(styles, /\.conversation-result-drawer__head/);
  assert.doesNotMatch(styles, /\.conversation-result-drawer__close/);
  assert.match(styles, /\.conversation-result-drawer__icon-close/);
  // body 是唯一滚动区，且必须 flex:1 1 0 吃掉剩余高度，避免空白落在 footer 下方。
  assert.match(
    styles,
    /\.conversation-result-drawer__body \{[\s\S]*?@apply min-h-0 overflow-y-auto px-5 py-4;[\s\S]*?flex: 1 1 0;/,
  );
  // footer 是 flex-none 的独立底部区域，用 margin-top:auto 贴底，动作右对齐（确认验收在右下角）。
  assert.match(
    styles,
    /\.conversation-result-drawer__footer \{[\s\S]*?@apply flex flex-none items-start justify-end gap-3 px-5 pb-4 pt-3;[\s\S]*?margin-top: auto;[\s\S]*?border-top: 1px solid var\(--za-line\);/,
  );
  // 抽屉本体自己吃满 panel，不再依赖粉碎包裹层撑高度。
  assert.match(
    styles,
    /\.conversation-result-drawer \{[\s\S]*?flex: 1 1 0;[\s\S]*?align-self: stretch;[\s\S]*?max-height: 100%;/,
  );
  // CRV 不再 h-full 叠百分比高度。
  assert.match(
    styles,
    /\.conversation-result-view \{[\s\S]*?@apply flex min-h-0 flex-col;[\s\S]*?height: auto;/,
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
