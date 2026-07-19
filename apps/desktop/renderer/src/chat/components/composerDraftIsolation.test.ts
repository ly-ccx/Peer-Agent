import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readSource = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

test('draft input and draft token estimates stay in composer leaf subscriptions', async () => {
  const [surface, controls, tokenUsage] = await Promise.all([
    readSource('./ChatSurface.tsx'),
    readSource('./ComposerDraftControls.tsx'),
    readSource('./ComposerTokenUsageDisplay.tsx'),
  ]);

  assert.match(surface, /<ComposerDraftControls[\s\S]*?conversationId=\{conversationId\}/);
  assert.match(surface, /onPrimaryAction=\{stableHandlePrimaryAction\}/);
  assert.match(surface, /<ComposerTokenUsageDisplay[\s\S]*?historyContextTokens=\{historyContextTokens\}/);
  assert.doesNotMatch(surface, /const draft\s*=\s*convState\.draft/);
  assert.doesNotMatch(surface, /value=\{draft\}/);
  // 发送路径可用 estimateDraftTokens(text, sentAttachments) 固化权威种子；
  // 不得再订阅草稿字符串做展示估算。
  assert.doesNotMatch(surface, /estimateDraftTokens\(draft/);

  assert.match(controls, /const draft = useConversationDraft\(conversationId\)/);
  assert.match(controls, /value=\{draft\}/);
  assert.match(controls, /conversationStore\.setDraft\(conversationId, value\)/);
  assert.match(tokenUsage, /const draft = useConversationDraft\(conversationId\)/);
  assert.match(tokenUsage, /estimateDraftTokens\(draft, attachments\)/);
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

test('token usage prefers authoritative effective context over local full-history max', async () => {
  const tokenUsage = await readSource('./ComposerTokenUsageDisplay.tsx');
  // 有权威快照时必须走统一口径 resolveContextOccupancyTokens，不能再 Math.max 抬回本地完整历史。
  assert.match(tokenUsage, /resolveContextOccupancyTokens/);
  assert.match(
    tokenUsage,
    /authoritativeContextTokens,\s*historyContextTokens,\s*draftContextTokens/,
  );
  assert.doesNotMatch(
    tokenUsage,
    /Math\.max\(authoritativeWithDraft,\s*localContextTokens\)/,
  );
  // 流式仅用本轮 input+cacheRead 抬升，禁止把 lifetime 计费累计当上下文。
  assert.match(tokenUsage, /activeUsage\.input/);
  assert.match(tokenUsage, /activeUsage\.cacheRead/);
});

test('send path seeds authoritative occupancy before clearing the draft', async () => {
  const surface = await readSource('./ChatSurface.tsx');
  assert.match(surface, /seedAuthoritativeContextOnSend/);
  assert.match(surface, /setAuthoritativeContext\(seeded\)/);
  assert.match(surface, /estimateDraftTokens\(text, sentAttachments\)/);
});

test('context ring never falls back to billed lifetime totals', async () => {
  const display = await readSource('./thread/TokenUsageDisplay.tsx');
  assert.doesNotMatch(display, /contextTokens \?\? billedTokens/);
  assert.match(
    display,
    /typeof contextTokens === 'number' && Number\.isFinite\(contextTokens\)/,
  );
});
