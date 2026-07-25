import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readSource = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

test('draft input stays in the composer leaf and never becomes context token authority', async () => {
  const [surface, controls, tokenUsage] = await Promise.all([
    readSource('./ChatSurface.tsx'),
    readSource('./ComposerDraftControls.tsx'),
    readSource('./ComposerTokenUsageDisplay.tsx'),
  ]);

  assert.match(surface, /<ComposerDraftControls[\s\S]*?conversationId=\{conversationId\}/);
  assert.match(surface, /onPrimaryAction=\{stableHandlePrimaryAction\}/);
  assert.doesNotMatch(surface, /estimateDraftTokens|estimateStreamDeltaTokens/);
  assert.match(controls, /const draft = useConversationDraft\(conversationId\)/);
  assert.match(controls, /conversationStore\.setDraft\(conversationId, value\)/);
  assert.match(tokenUsage, /useConversationContextAccounting\(conversationId\)/);
  assert.match(tokenUsage, /contextAccounting=\{contextAccounting\}/);
  assert.doesNotMatch(tokenUsage, /useConversationDraft|estimateDraftTokens|estimateStreamDeltaTokens/);
});

test('send actions read the latest draft from the conversation bucket', async () => {
  const surface = await readSource('./ChatSurface.tsx');

  assert.match(
    surface,
    /const text = conversationStore\.getSnapshot\(conversationId\)\.draft\.trim\(\)/,
  );
  assert.match(surface, /conversationStore\.setDraft\(conversationId, ''\)/);
  assert.doesNotMatch(surface, /\}, \[draft, attachments,/);
});

test('context ring renders the shared accounting snapshot without a local fallback', async () => {
  const display = await readSource('./thread/TokenUsageDisplay.tsx');

  assert.match(
    display,
    /contextAccounting\?\.authoritativeInputTokens/,
  );
  assert.match(display, /contextAccounting\?\.percent/);
  assert.match(display, /contextAccounting\?\.pendingUncountedChanges === true/);
  assert.match(display, /contextAccounting\?\.counterStatus === 'degraded'/);
  assert.match(display, /Exact count drifted from provider usage/);
  assert.doesNotMatch(display, /lifetimeUsage|resolveContextOccupancyTokens|estimateDraftTokens/);
  assert.doesNotMatch(display, /contextTokens \?\? billedTokens/);
});

test('send path does not seed or estimate context occupancy', async () => {
  const surface = await readSource('./ChatSurface.tsx');

  assert.doesNotMatch(surface, /seedAuthoritativeContextOnSend|seedContextAccountingOnSend/);
  assert.doesNotMatch(surface, /estimateDraftTokens\(text, sentAttachments\)/);
  assert.doesNotMatch(surface, /contextReady=/);
});

test('external conversation reload replaces or clears the shared accounting snapshot', async () => {
  const surface = await readSource('./ChatSurface.tsx');

  assert.match(
    surface,
    /contextAccounting: storedContextAccountingSnapshot,\s*\}\s*=\s*await loadConversationMessages/,
  );
  assert.match(
    surface,
    /convActions\.commitLoad\(\{[\s\S]*contextAccounting: storedContextAccountingSnapshot/,
  );
});

test('unknown restored context renders as unknown, never zero percent', async () => {
  const display = await readSource('./thread/TokenUsageDisplay.tsx');

  assert.match(display, /const ctxPercent =[\s\S]*contextAccounting\?\.percent/);
  assert.match(display, /ctxPercent == null \? '\?' : `\$\{Math\.round\(ctxPercent\)\}%`/);
  assert.match(display, /Context pending measurement/);
});
