import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readHook = () => readFile(new URL('./useTaskOverview.ts', import.meta.url), 'utf8');
const readChatSurface = () => readFile(new URL('../../chat/components/ChatSurface.tsx', import.meta.url), 'utf8');

test('TaskOverview hook sends the current conversation scope to main', async () => {
  const source = await readHook();

  assert.match(source, /conversationId\?: string \| null/);
  assert.match(source, /conversationId:\s*conversationId \?\? undefined/);
});

test('ChatSurface queries only its current conversation and follows page visibility', async () => {
  const source = await readChatSurface();
  const hookCall = source.match(/const taskOverviewItems = useTaskOverview\(\{([\s\S]*?)\}\);/)?.[1];

  assert.ok(hookCall, 'ChatSurface should keep TaskOverview as the main-owned projection source');
  assert.match(hookCall, /enabled:\s*Boolean\(conversationId\)\s*&&\s*isPageActive/);
  assert.match(hookCall, /conversationId/);
  assert.doesNotMatch(hookCall, /activeWithinMs:\s*0/);
});

test('TaskOverview hook preserves the previous array when projection contents are unchanged', async () => {
  const source = await readHook();

  assert.match(source, /areTaskOverviewItemsEqual/);
  assert.match(source, /setItems\(\(current\)\s*=>\s*areTaskOverviewItemsEqual\(current, result\)\s*\?\s*current\s*:\s*result\)/);
});
