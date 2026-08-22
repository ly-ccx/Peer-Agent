import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('empty chat home offers issue-task and continue-task, not starter cards', async () => {
  const source = await readFile(new URL('./ChatSurface.tsx', import.meta.url), 'utf8');
  assert.match(source, /发出任务/);
  assert.match(source, /继续这条任务/);
  assert.match(source, /onContinueRecentTask/);
  assert.doesNotMatch(source, /chat-empty-card/);
  assert.doesNotMatch(source, /emptyStarterCards/);
});
