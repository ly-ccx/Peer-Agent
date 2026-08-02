import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('observed-only restore uses provider-request observations and never billing totals', async () => {
  const source = await readFile(new URL('./main.mjs', import.meta.url), 'utf8');
  const handler = source.match(
    /async function handleChatContextRestored\(([\s\S]*?)\/\/ ── Local Tool Host ──/,
  )?.[1] ?? '';

  assert.ok(handler, 'restored context use case must remain discoverable');
  assert.doesNotMatch(handler, /latestObservedUsageFromMessages\(conv\.messages\)/);
  assert.doesNotMatch(handler, /conversationStore\.getLatestObservedUsage/);
  assert.match(handler, /conversationStore\.getLatestContextObservation/);
  assert.match(handler, /createRestoredObservedContextAccountingSnapshot/);
});

test('main terminal writer persists request usage with the final assistant message', async () => {
  const source = await readFile(new URL('./llm-chat-service.mjs', import.meta.url), 'utf8');

  assert.match(
    source,
    /final && hasBillableUsage\(streamRecord\.finalUsage\)[\s\S]*?patch\.usage/,
  );
});
