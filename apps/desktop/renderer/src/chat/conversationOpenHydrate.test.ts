import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { shouldLoadOlderHistory } from './state/conversationWindowPolicy.ts';

test('ChatSurface hydrates conversation messages in yielded chunks', async () => {
  const source = await readFile(new URL('./components/ChatSurface.tsx', import.meta.url), 'utf8');
  assert.match(source, /loadConversationMessages/);
  const hydration = await readFile(new URL('./state/conversationHydration.ts', import.meta.url), 'utf8');
  assert.match(hydration, /from ['"]\.\/yieldToMain['"]/);
  assert.match(hydration, /await mapInChunks\(/);
  assert.match(hydration, /chunkSize:\s*32/);
  assert.match(hydration, /page\?\.window/);
  assert.doesNotMatch(hydration, /full:\s*true/);
  assert.doesNotMatch(source, /full:\s*true/);
  assert.match(source, /shouldLoadOlderHistory/);
  assert.doesNotMatch(
    source,
    /const loaded = conv\.messages\.map\(\(m: Record<string, unknown>\) => \{/,
  );
});

test('upward pagination only starts from a user scroll near the top', () => {
  assert.equal(shouldLoadOlderHistory({ scrollTop: 10, hasMore: true, loading: false, userInitiated: true }), true);
  assert.equal(shouldLoadOlderHistory({ scrollTop: 10, hasMore: true, loading: false, userInitiated: false }), false);
  assert.equal(shouldLoadOlderHistory({ scrollTop: 400, hasMore: true, loading: false, userInitiated: true }), false);
  assert.equal(shouldLoadOlderHistory({ scrollTop: 0, hasMore: false, loading: false, userInitiated: true }), false);
  assert.equal(shouldLoadOlderHistory({ scrollTop: 0, hasMore: true, loading: true, userInitiated: true }), false);
});

test('shared conversationLoad also hydrates in yielded chunks', async () => {
  const source = await readFile(new URL('./state/conversationLoad.ts', import.meta.url), 'utf8');
  assert.match(source, /from ['"]\.\/yieldToMain['"]/);
  assert.match(source, /await mapInChunks\(/);
  assert.match(source, /chunkSize:\s*32/);
  assert.match(source, /page\.window/);
  assert.doesNotMatch(source, /full:\s*true/);
  assert.doesNotMatch(source, /const loaded = folded\.map\(/);
});
