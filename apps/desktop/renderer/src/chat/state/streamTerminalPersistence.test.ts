import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('normal stream completion does not rewrite durable messages after main persisted context accounting', async () => {
  const source = await readFile(
    new URL('../hooks/useConversationStreamRouter.ts', import.meta.url),
    'utf8',
  );
  const doneHandler = source.match(
    /const offDone = clientApi\.onChatStreamDone\(([\s\S]*?)const offUsage =/,
  )?.[1] ?? '';
  const normalCompletion = doneHandler.slice(
    doneHandler.indexOf("if (last?.role === 'assistant')"),
  );

  assert.ok(doneHandler, 'stream done handler must remain discoverable');
  assert.ok(normalCompletion, 'normal completion branch must remain discoverable');
  assert.doesNotMatch(
    normalCompletion,
    /persistMessages\(/,
    'renderer terminal projection must not clear the context snapshot through replaceMessages',
  );
});
