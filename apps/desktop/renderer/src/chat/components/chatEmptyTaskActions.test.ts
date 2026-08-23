import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('empty chat home keeps connect-provider, not shortcut task buttons or starter cards', async () => {
  const source = await readFile(new URL('./ChatSurface.tsx', import.meta.url), 'utf8');
  assert.match(source, /连接 AI 服务/);
  assert.doesNotMatch(source, /发出任务/);
  assert.doesNotMatch(source, /继续这条任务/);
  assert.doesNotMatch(source, /onContinueRecentTask/);
  assert.doesNotMatch(source, /hasRecentTask/);
  assert.doesNotMatch(source, /chat-empty-card/);
  assert.doesNotMatch(source, /emptyStarterCards/);
});
