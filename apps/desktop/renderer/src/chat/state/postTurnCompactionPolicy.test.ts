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
});
