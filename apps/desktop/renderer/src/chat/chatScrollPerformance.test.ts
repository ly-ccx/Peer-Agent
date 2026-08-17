import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readChatSurface = () => readFile(new URL('./components/ChatSurface.tsx', import.meta.url), 'utf8');

test('current turn probing uses a point hit test instead of scanning every rendered turn', async () => {
  const source = await readChatSurface();
  const helper = source.match(/function findCurrentTurnIdForScroll[\s\S]*?\n\}/)?.[0];

  assert.ok(helper, 'ChatSurface should expose one current-turn probe helper');
  assert.match(helper, /elementFromPoint/);
  assert.doesNotMatch(helper, /querySelectorAll/);
  assert.doesNotMatch(helper, /getBoundingClientRect\(\)[\s\S]*for \(/);
});

test('one animation-frame scroll pass reuses a single current turn probe', async () => {
  const source = await readChatSurface();
  const scrollPass = source.match(/const processThreadScrollFrame = useCallback\([\s\S]*?\n\s*\}, \[/)?.[0];

  assert.ok(scrollPass, 'scroll work should remain coalesced behind one frame callback');
  assert.equal(
    (scrollPass.match(/findCurrentTurnIdForScroll\(/g) ?? []).length,
    1,
    'current turn must be computed once and shared by snapshot/sticky consumers',
  );
});

test('messageTarget navigation applies each requestId once so sending a message does not replay scrollToMessage', async () => {
  const source = await readChatSurface();
  assert.match(source, /lastAppliedMessageTargetRequestId = useRef<number \| null>\(null\)/);

  const effect = source.match(
    /useEffect\(\(\) => \{\n    if \(!messageTarget[\s\S]*?\}, \[conversationId, messageTarget, scrollToMessage\]\);/,
  )?.[0];

  assert.ok(effect, 'ChatSurface should consume messageTarget through one navigation effect');
  assert.match(effect, /lastAppliedMessageTargetRequestId\.current === messageTarget\.requestId/);
  assert.match(effect, /if \(scrollToMessage\(messageTarget\.messageId\)\)/);
  assert.match(effect, /lastAppliedMessageTargetRequestId\.current = messageTarget\.requestId/);
});
