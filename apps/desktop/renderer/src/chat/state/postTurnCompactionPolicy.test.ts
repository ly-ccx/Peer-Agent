import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const routerSource = readFileSync(
  new URL('../hooks/useConversationStreamRouter.ts', import.meta.url),
  'utf8',
);
const surfaceSource = readFileSync(
  new URL('../components/ChatSurface.tsx', import.meta.url),
  'utf8',
);
const displaySource = readFileSync(
  new URL('../components/thread/TokenUsageDisplay.tsx', import.meta.url),
  'utf8',
);

describe('post-turn compaction policy', () => {
  it('leaves automatic compaction inside the blocking runtime preflight path', () => {
    assert.doesNotMatch(routerSource, /onCompactionSuggested/);
    assert.doesNotMatch(surfaceSource, /scheduleAutomaticCompaction|handleCompactionSuggested/);
  });

  it('keeps the explicit compact command as the only renderer chatCompact caller', () => {
    assert.match(surfaceSource, /text === '\/compact'/);
    assert.equal(surfaceSource.match(/clientApi\.chatCompact\(/g)?.length, 1);
  });

  it('does not send or replace history before conversation recovery is ready', () => {
    assert.match(surfaceSource, /convActions\.beginLoad\(\)/);
    assert.match(surfaceSource, /convActions\.commitLoad\(\{[\s\S]*messages: loaded,[\s\S]*tokenUsage: usage/);
    assert.match(surfaceSource, /loadStatus !== 'ready'/);
    assert.match(surfaceSource, /submitMessage = useCallback[\s\S]*loadStatus !== 'ready'/);
  });

  it('splits ring occupancy and compaction pressure into dual fields', () => {
    assert.match(
      routerSource,
      /nextContextTokens/,
      'stream/compaction events must project actual sent context into the ring numerator',
    );
    assert.match(
      routerSource,
      /nextTriggerTokens/,
      'stream/compaction events must keep triggerTokens for compaction pressure',
    );
    assert.match(
      routerSource,
      /microcompacted\s*===\s*true\s*\?\s*'final'\s*:\s*'midturn'/,
      'a confirmed Layer 1 result must be allowed to lower the dual-field snapshot',
    );
    assert.match(
      displaySource,
      /isZh \? '上下文' : 'Context'/,
      'tooltip must label the ring occupancy as context',
    );
    assert.match(
      displaySource,
      /isZh \? '压缩压力' : 'Compaction pressure'/,
      'tooltip must still surface compaction pressure separately',
    );
    assert.doesNotMatch(
      surfaceSource,
      /setAuthoritativeContext\(null\)/,
      'conversation switching must not discard the selected conversation bucket dual-field snapshot',
    );
  });
});
