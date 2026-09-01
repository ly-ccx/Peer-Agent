import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readSource = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

test('conversation switch remeasures mounted turns without detaching their observers', async () => {
  const [surface, virtualList, virtualHook] = await Promise.all([
    readSource('../components/ChatSurface.tsx'),
    readSource('../components/thread/VirtualChatTurnList.tsx'),
    readSource('../hooks/useVirtualChatTurns.ts'),
  ]);

  assert.match(
    virtualList,
    /useVirtualChatTurns\(\{[\s\S]*?ownerKey:\s*conversationId/,
  );

  const pendingRestoreEffect = surface.match(
    /useLayoutEffect\(\(\) => \{\s*const pending = pendingThreadScrollRestoreRef\.current;[\s\S]*?\n\s*\}, \[[\s\S]*?\n\s*\]\);/,
  )?.[0] ?? '';
  assert.match(surface, /planThreadScrollOnConversationOpen\(/);
  assert.ok(pendingRestoreEffect, 'pending scroll restore effect should exist');
  assert.doesNotMatch(pendingRestoreEffect, /resetVirtualMeasurements/);
  assert.match(
    pendingRestoreEffect,
    /shouldShowConversationLoadingPlaceholder/,
    'opening a conversation must wait for the loading placeholder before sticking to bottom',
  );
  assert.match(
    pendingRestoreEffect,
    /scrollThreadToBottom/,
    'opening a conversation should stick to the latest messages after the list mounts',
  );

  assert.match(
    virtualHook,
    /if \(ownerKeyRef\.current !== ownerKey\) \{[\s\S]*?refreshMountedMeasurements\(\);[\s\S]*?\}/,
  );

  const destructiveClearCalls = virtualHook.match(/observersRef\.current\.clear\(\)/g) ?? [];
  assert.equal(destructiveClearCalls.length, 1);
  assert.match(
    virtualHook,
    /useEffect\(\(\) => \(\) => \{\s*observersRef\.current\.clear\(\);/,
  );
});
