import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readPage = () => readFile(new URL('./TaskOverviewPage.tsx', import.meta.url), 'utf8');
const readStyles = () => readFile(new URL('../../styles/task-overview.css', import.meta.url), 'utf8');
const readApp = () => readFile(new URL('../../App.tsx', import.meta.url), 'utf8');

test('home no longer waits on result-ready celebration snapshots', async () => {
  const source = await readPage();
  assert.doesNotMatch(source, /<h2>结果待验收<\/h2>/);
});

test('home no longer renders a result-ready acceptance bucket', async () => {
  const source = await readPage();
  assert.match(source, /<h2>需要你<\/h2>/);
  assert.match(source, /<h2>正在推进<\/h2>/);
  assert.match(source, /<h2>未读<\/h2>/);
  assert.doesNotMatch(source, /<h2>结果待验收<\/h2>/);
  assert.doesNotMatch(source, /确认归档只出现在看过依据之后/);
});

test('home no longer depends on result-card celebration timing', async () => {
  const source = await readPage();
  assert.doesNotMatch(source, /<h2>结果待验收<\/h2>/);
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
