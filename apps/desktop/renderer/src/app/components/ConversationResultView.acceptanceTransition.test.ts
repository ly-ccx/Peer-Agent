import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readView = () =>
  readFile(new URL('./ConversationResultView.tsx', import.meta.url), 'utf8');
const readApp = () => readFile(new URL('../../App.tsx', import.meta.url), 'utf8');
const readStyles = () =>
  readFile(new URL('../../styles/task-overview.css', import.meta.url), 'utf8');

test('result drawer accept view reports acceptance phases to the shell', async () => {
  const source = await readView();
  assert.match(source, /onAcceptancePhaseChange/);
  assert.match(source, /runAcceptanceTransition/);
  assert.match(source, /onAcceptancePhaseChange\?\.\(acceptancePhase\)/);
});

test('result actions stay in a separate footer region below the content', async () => {
  const source = await readView();
  const styles = await readStyles();
  assert.match(source, /<footer className="conversation-result-view__footer">/);
  assert.doesNotMatch(source, /<div className="conversation-result-view__actions">/);
  assert.match(styles, /\.conversation-result-view__footer \{/);
  assert.doesNotMatch(styles, /\.conversation-result-view__actions/);
});

test('result drawer shell shatters the whole panel before unload', async () => {
  const source = await readApp();
  assert.match(source, /ParticleShatterOverlay/);
  assert.match(source, /conversation-result-drawer__shatter-host/);
  assert.match(source, /conversation-result-drawer__shatter-source/);
  assert.match(source, /onAcceptancePhaseChange=\{setResultAcceptancePhase\}/);
  assert.match(source, /active=\{resultShattering\}/);
  assert.match(source, /targetRef=\{resultShatterRef\}/);
  assert.match(source, /keepResultDrawer: true/);
  assert.match(
    source,
    /ref=\{resultShatterRef\}[\s\S]*?<ConversationResultView[\s\S]*?<\/div>[\s\S]*?<ParticleShatterOverlay active=\{resultShattering\} targetRef=\{resultShatterRef\}/,
  );
  // 验收完成前不得立刻清空侧栏；收尾发生在 onAccepted / settled。
  assert.match(
    source,
    /onAccepted=\{\(\) => \{[\s\S]*?setResultDrawerItem\(null\);[\s\S]*?setCollectionDrawer\(null\);/,
  );
});

test('result drawer shatter styles keep canvas as a sibling of the source', async () => {
  const styles = await readStyles();
  assert.match(styles, /\.conversation-result-drawer__shatter-host/);
  assert.match(styles, /\.conversation-result-drawer__shatter-source/);
  assert.match(styles, /conversation-result-drawer--shattering/);
  assert.match(styles, /\.conversation-result-drawer__shatter-host \.particle-shatter-canvas/);
});

test('result drawer content collapses to natural height with a separate footer', async () => {
  const styles = await readStyles();
  // 根节点保持 h-full（铺满滚动容器），但消息列不再 flex-1，卡片按内容收口。
  assert.match(
    styles,
    /\.conversation-result-view \{[\s\S]*?@apply flex h-full min-h-0 flex-col gap-4;/,
  );
  assert.match(
    styles,
    /\.conversation-result-view__section--grow \{[\s\S]*?@apply flex min-h-0 flex-col;[\s\S]*?flex: 0 0 auto;/,
  );
  assert.match(
    styles,
    /\.conversation-result-view__messages \{[\s\S]*?@apply flex min-h-0 flex-col gap-3 pr-1;[\s\S]*?flex: 0 0 auto;[\s\S]*?overflow: visible;/,
  );
  // footer 独立操作区：与内容区通过边框分隔。
  assert.match(
    styles,
    /\.conversation-result-view__footer \{[\s\S]*?border-top: 1px solid var\(--za-line\);/,
  );
  // 粉碎包裹层不建独立滚动上下文；滚动仍在 drawer body。
  assert.match(
    styles,
    /\.conversation-result-drawer__body \{[\s\S]*?@apply min-h-0 flex-1 overflow-y-auto px-5 py-4;/,
  );
  assert.match(styles, /\.conversation-result-drawer__shatter-host \.particle-shatter-canvas/);
});
