import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPACTION_SUMMARY_PROMPT,
  COMPACTION_SUMMARY_SYSTEM_PROMPT,
  compactMessagesWithSummaryStrategy,
  formatCompactionMessagesForSummary,
  runCompactionSummaryCascade,
  splitMessagesForCompaction,
} from './context-compaction.ts';

test('summary projection bounds tool payloads and thinking while preserving identifiers', () => {
  const summaryInput = formatCompactionMessagesForSummary([
    {
      role: 'assistant',
      content: [
        { type: 'thinking', content: `THINK_HEAD-${'思考'.repeat(5_000)}-THINK_TAIL` },
        { type: 'tool_use', id: 'tool-call-1', name: 'read_file', input: { path: '/tmp/a', payload: `INPUT_HEAD-${'参'.repeat(8_000)}-INPUT_TAIL` } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tool-call-1', content: `RESULT_HEAD-${'结果'.repeat(12_000)}-RESULT_TAIL` },
      ],
    },
  ]);

  assert.match(summaryInput, /thinking block truncated:/);
  assert.match(summaryInput, /tool input truncated:/);
  assert.match(summaryInput, /tool result truncated:/);
  assert.match(summaryInput, /tool-call-1/);
  assert.match(summaryInput, /read_file/);
  assert.match(summaryInput, /INPUT_HEAD/);
  assert.match(summaryInput, /INPUT_TAIL/);
  assert.match(summaryInput, /RESULT_HEAD/);
  assert.match(summaryInput, /RESULT_TAIL/);
  assert.ok(summaryInput.length < 10_000, `bounded projection should remain small, got ${summaryInput.length}`);
});

test('continuity handoff prompt covers the long-session continuity questions', () => {
  const prompt = `${COMPACTION_SUMMARY_SYSTEM_PROMPT}\n${COMPACTION_SUMMARY_PROMPT}`;
  const requiredSignals = [
    '验收标准',
    'rejected (with reasons)',
    'Files and Code Sections',
    'real outcomes',
    'Current Work',
    'Exact Next Step',
    'Evidence and recovery',
    'Do Not Repeat',
  ];
  for (const signal of requiredSignals) assert.ok(prompt.includes(signal), `missing continuity signal: ${signal}`);
});

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

test('automatic split preserves the requested recent complete turns', () => {
  const messages = [
    { role: 'user', content: 'turn 1' },
    { role: 'assistant', content: 'answer 1' },
    { role: 'user', content: 'turn 2' },
    { role: 'assistant', toolCalls: [{ id: 'call-2' }], content: 'using tool' },
    { role: 'tool', toolCallId: 'call-2', content: 'tool result' },
    { role: 'assistant', content: 'answer 2' },
    { role: 'user', content: 'turn 3' },
    { role: 'assistant', content: 'answer 3' },
    { role: 'user', content: 'turn 4' },
  ] as const;

  const split = splitMessagesForCompaction(messages, {
    preserveLatestUserTurn: true,
    preserveRecentTurns: 3,
  });

  assert.deepEqual(split.oldMessages, messages.slice(0, 2));
  assert.deepEqual(split.keepMessages, messages.slice(2));
  assert.equal(split.keepMessages[1], messages[3]);
  assert.equal(split.keepMessages[2], messages[4]);
});

test('automatic split keeps every available turn when fewer than requested exist', () => {
  const messages = [
    { role: 'user', content: 'turn 1' },
    { role: 'assistant', content: 'answer 1' },
    { role: 'user', content: 'turn 2' },
  ] as const;
  const split = splitMessagesForCompaction(messages, {
    preserveLatestUserTurn: true,
    preserveRecentTurns: 4,
  });
  assert.deepEqual(split.oldMessages, []);
  assert.deepEqual(split.keepMessages, messages);
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

test('shared summary strategy owns split safety and fallback ordering', async () => {
  const result = await compactMessagesWithSummaryStrategy({
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'latest' },
    ],
    preserveLatestUserTurn: true,
    summarizeWithLlm: async () => 'semantic handoff',
    summarizeStructurally: () => 'structural handoff',
    buildHandoffContent: (summary, count) => `${count}:${summary}`,
  });

  assert.equal(result.compacted, true);
  assert.equal(result.method, 'llm');
  assert.equal(result.summary, 'semantic handoff');
  assert.equal(result.handoffContent, '2:semantic handoff');
  assert.deepEqual(result.keepMessages, [{ role: 'user', content: 'latest' }]);
});
