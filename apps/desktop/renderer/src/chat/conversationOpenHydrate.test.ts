import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('ChatSurface hydrates conversation messages in yielded chunks', async () => {
  const source = await readFile(new URL('./components/ChatSurface.tsx', import.meta.url), 'utf8');
  assert.match(source, /loadConversationMessages/);
  const hydration = await readFile(new URL('./state/conversationHydration.ts', import.meta.url), 'utf8');
  assert.match(hydration, /from ['"]\.\/yieldToMain['"]/);
  assert.match(hydration, /await mapInChunks\(/);
  assert.match(hydration, /chunkSize:\s*32/);
  assert.doesNotMatch(
    source,
    /const loaded = conv\.messages\.map\(\(m: Record<string, unknown>\) => \{/,
  );
});

test('shared conversationLoad also hydrates in yielded chunks', async () => {
  const source = await readFile(new URL('./state/conversationLoad.ts', import.meta.url), 'utf8');
  assert.match(source, /from ['"]\.\/yieldToMain['"]/);
  assert.match(source, /await mapInChunks\(/);
  assert.match(source, /chunkSize:\s*32/);
  assert.doesNotMatch(source, /const loaded = folded\.map\(/);
});
