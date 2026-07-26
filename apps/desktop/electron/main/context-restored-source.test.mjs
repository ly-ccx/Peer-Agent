import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('observed-only restore uses durable provider usage before falling back to unknown', async () => {
  const source = await readFile(new URL('./main.mjs', import.meta.url), 'utf8');
  const handler = source.match(
    /ipcMain\.handle\('chat:context:restored'([\s\S]*?)ipcMain\.handle\('prompt-snapshots:list'/,
  )?.[1] ?? '';

  assert.ok(handler, 'restored context handler must remain discoverable');
  assert.match(handler, /latestObservedUsageFromMessages\(conv\.messages\)/);
  assert.match(handler, /conversationStore\.getLatestObservedUsage/);
  assert.match(handler, /createRestoredObservedContextAccountingSnapshot/);
});

test('main terminal writer persists request usage with the final assistant message', async () => {
  const source = await readFile(new URL('./llm-chat-service.mjs', import.meta.url), 'utf8');

  assert.match(
    source,
    /final && hasBillableUsage\(streamRecord\.finalUsage\)[\s\S]*?patch\.usage/,
  );
});
