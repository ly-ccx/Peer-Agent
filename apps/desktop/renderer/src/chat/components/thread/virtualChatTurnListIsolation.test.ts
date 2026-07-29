import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const surfaceSource = readFileSync(new URL('../ChatSurface.tsx', import.meta.url), 'utf8');
const listSource = readFileSync(new URL('./VirtualChatTurnList.tsx', import.meta.url), 'utf8');

test('virtual range state stays inside the message-list subtree', () => {
  assert.doesNotMatch(surfaceSource, /useVirtualChatTurns\s*\(/);
  assert.match(surfaceSource, /<VirtualChatTurnList[\s\S]*?ref=\{virtualTurnListRef\}/);
  assert.match(listSource, /useVirtualChatTurns\s*\(\{/);
  assert.match(listSource, /useImperativeHandle\s*\(ref/);
});

test('the isolated list preserves viewport commands used by scroll restore and navigation', () => {
  assert.match(listSource, /scrollToTurn,/);
  assert.match(listSource, /updateViewport,/);
  assert.match(listSource, /resetMeasurements,/);
});
