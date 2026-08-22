import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readPage = () => readFile(new URL('./TaskOverviewPage.tsx', import.meta.url), 'utf8');
const readStyles = () => readFile(new URL('../../styles/task-overview.css', import.meta.url), 'utf8');
const readApp = () => readFile(new URL('../../App.tsx', import.meta.url), 'utf8');

test('result acceptance waits for delivered before celebrating and preserves a removal snapshot', async () => {
  const source = await readPage();
  assert.match(source, /type AcceptancePhase/);
  assert.match(source, /await onAcceptResult\(item\);[\s\S]*交回在后台进行/);
  assert.match(source, /deliveryHandoffStatus === 'delivered'/);
  assert.match(source, /Object\.values\(acceptanceTransitions\)/);
  assert.match(source, /ParticleShatterOverlay/);
  assert.match(source, /acceptHandlerRef\.current = handleAccept/);
  assert.match(source, /is-shattering/);
  assert.match(source, /is-exiting/);
  assert.match(source, /正在交回…/);
  assert.match(source, /验收完成，任务已圆满结束/);
});

test('acceptance transitions freeze the complete taskId order instead of colliding single indexes', async () => {
  const source = await readPage();
  assert.match(source, /setAcceptanceOrderSnapshot\(resultReady\.map\(\(candidate\) => candidate\.taskId\)\)/);
  assert.match(source, /mergeAcceptanceTransitionItems\(\{/);
  assert.match(source, /orderSnapshot: acceptanceOrderSnapshot/);
  assert.doesNotMatch(source, /readonly orderIndex: number/);
});

test('a failed acceptance returns the card to a retryable idle state', async () => {
  const [source, app] = await Promise.all([readPage(), readApp()]);
  assert.match(source, /catch \{[\s\S]*delete next\[item\.taskId\]/);
  assert.match(app, /disabled=\{Boolean\(resultAcceptancePending\)\}/);
  assert.match(app, /accept result failed'[\s\S]*throw error/);
});

test('third-bucket card only offers 先看依据; accept and reject stay off the card', async () => {
  const source = await readPage();
  assert.match(source, /主按钮「先看依据」/);
  assert.match(source, /确认验收只出现在看过结果之后/);
  assert.match(source, />\s*先看依据\s*</);
  assert.doesNotMatch(source, /disabled=\{!canAccept \|\| Boolean\(phase\)\}/);
  const card = source.slice(source.indexOf('function ResultCard'));
  assert.match(card, /先看依据/);
  assert.doesNotMatch(card, /确认验收/);
  assert.doesNotMatch(card, /还不行/);
});

test('acceptance celebration has smoother timing and a reduced-motion fallback', async () => {
  const [source, styles] = await Promise.all([readPage(), readStyles()]);
  assert.match(source, /ACCEPTANCE_CELEBRATION_MS/);
  assert.match(source, /ACCEPTANCE_EXIT_MS/);
  assert.match(styles, /result-card-celebrate-lift/);
  assert.match(styles, /opacity 420ms cubic-bezier\(0\.33, 0, 0\.2, 1\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /\.result-card-celebration \{ display: none; \}/);
  assert.match(styles, /\.result-card--exiting/);
});

test('continue discussion only navigates; a later new Goal stays in the same conversation', async () => {
  const app = await readApp();
  const handler = app.match(/const handleContinueTask = useCallback\([\s\S]*?\n  \}, \[\]\);/)?.[0] ?? '';
  assert.match(handler, /continueTaskInConversation/);
  assert.match(handler, /focusComposer/);
  assert.doesNotMatch(handler, /goalPlansMarkRequestedUserInput/);
  assert.doesNotMatch(handler, /goalRunnerResume/);
  assert.match(app, /ChatSurface\.submitMessage → chatSend/);
});

test('result card prefers completedAt with completion-relative copy', async () => {
  const source = await readPage();
  assert.match(source, /item\.completedAt/);
  assert.match(source, /formatRelativeTime\(item\.completedAt, \{ completed: true \}\)/);
  assert.match(source, /分钟前完成/);
  assert.match(source, /刚刚完成/);
});
