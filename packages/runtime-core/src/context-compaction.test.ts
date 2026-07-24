import assert from 'node:assert/strict';
import test from 'node:test';

import { runCompactionSummaryCascade, splitMessagesForCompaction } from './context-compaction.ts';

test('summary cascade prefers the injected LLM summarizer', async () => {
  const result = await runCompactionSummaryCascade({
    oldMessages: [{ role: 'user', content: 'old request' }],
    summarizeWithLlm: async () => 'semantic summary',
    summarizeStructurally: () => 'structural summary',
  });
  assert.deepEqual(result, { method: 'llm', summary: 'semantic summary' });
});

test('summary cascade falls back to structural summary when LLM fails', async () => {
  const result = await runCompactionSummaryCascade({
    oldMessages: [{ role: 'user', content: 'old request' }],
    summarizeWithLlm: async () => { throw new Error('provider unavailable'); },
    summarizeStructurally: () => 'structural summary',
  });
  assert.equal(result.method, 'structured');
  assert.equal(result.summary, 'structural summary');
  assert.equal(result.fallbackReason, 'llm_failed');
  assert.equal(result.fallbackDetail, 'provider unavailable');
});

test('summary cascade safely drops history when both summary paths are empty', async () => {
  const result = await runCompactionSummaryCascade({
    oldMessages: [{ role: 'user', content: 'old request' }],
    summarizeWithLlm: async () => '',
    summarizeStructurally: () => null,
    fallbackSummary: 'safe handoff',
  });
  assert.equal(result.method, 'fallback_drop');
  assert.equal(result.summary, 'safe handoff');
  assert.equal(result.fallbackReason, 'structured_empty');
});

test('automatic split preserves the latest human turn', () => {
  const oldUser = { role: 'user', content: 'old request' } as const;
  const oldAssistant = { role: 'assistant', content: 'old answer' } as const;
  const latestUser = { role: 'user', content: 'current request' } as const;
  const split = splitMessagesForCompaction(
    [{ role: 'system', content: 'system' }, oldUser, oldAssistant, latestUser],
    { preserveLatestUserTurn: true },
  );
  assert.deepEqual(split.oldMessages, [oldUser, oldAssistant]);
  assert.deepEqual(split.keepMessages, [latestUser]);
  assert.equal(split.systemMessages.length, 1);
});

test('manual split keeps the requested recent tail and never starts it with an orphan tool result', () => {
  const user = { role: 'user', content: 'run it' } as const;
  const assistant = {
    role: 'assistant',
    content: null,
    toolCalls: [{ id: 'call-1' }],
  } as const;
  const tool = { role: 'tool', toolCallId: 'call-1', content: 'done' } as const;
  const final = { role: 'assistant', content: 'complete' } as const;
  const split = splitMessagesForCompaction([user, assistant, tool, final], { keepRecentCount: 2 });
  assert.deepEqual(split.oldMessages, [user]);
  assert.deepEqual(split.keepMessages, [assistant, tool, final]);
});

test('automatic split keeps an unfinished tool call in the active tail', () => {
  const previous = { role: 'assistant', content: 'previous' } as const;
  const latestUser = { role: 'user', content: 'inspect' } as const;
  const toolUse = { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1' }] } as const;
  const split = splitMessagesForCompaction([previous, latestUser, toolUse], {
    preserveLatestUserTurn: true,
  });
  assert.deepEqual(split.oldMessages, [previous]);
  assert.deepEqual(split.keepMessages, [latestUser, toolUse]);
});
