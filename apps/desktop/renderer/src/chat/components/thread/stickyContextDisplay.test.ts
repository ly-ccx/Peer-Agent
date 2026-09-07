import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { contextDisplayScopeKey, resolveStickyContextDisplay } from './stickyContextDisplay.ts';

const scope = (epoch: number, conversationId = 'conversation', modelKey = 'model') =>
  contextDisplayScopeKey(conversationId, modelKey, epoch);

for (const changedEpoch of [false, true]) {
  for (const known of [false, true]) {
    test(`${changedEpoch ? 'new' : 'same'} compaction epoch / ${known ? 'valid' : 'unknown'} accounting`, () => {
      const cached = { scopeKey: scope(0), percent: 80, tokens: 80000 };
      // Matches the component's synchronous guard, before its cache effect runs.
      const previous = cached.scopeKey === scope(changedEpoch ? 1 : 0)
        ? cached : { percent: null, tokens: null };
      assert.deepEqual(resolveStickyContextDisplay({
        livePercent: known ? 20 : null,
        liveTokens: known ? 20000 : null,
        lastKnownPercent: previous.percent,
        lastKnownTokens: previous.tokens,
      }), known ? { percent: 20, tokens: 20000 }
        : changedEpoch ? { percent: null, tokens: null }
          : { percent: 80, tokens: 80000 });
    });
  }
}

test('conversation and model changes invalidate cached accounting', () => {
  assert.notEqual(scope(0), scope(0, 'other'));
  assert.notEqual(scope(0), scope(0, 'conversation', 'other-model'));
});

test('component wires runtime epoch into the scope and guards breakdown synchronously', () => {
  const source = readFileSync(new URL('./TokenUsageDisplay.tsx', import.meta.url), 'utf8');
  assert.match(source, /const stickyScopeKey = contextDisplayScopeKey\([\s\S]*?contextAccounting\?\.compactionEpoch/);
  assert.match(source, /lastKnownContext.scopeKey === stickyScopeKey[\s\S]*?breakdown: null/);
  assert.match(source, /const stickyBreakdown = liveBreakdown \?\? stickyLastKnown.breakdown/);
});
