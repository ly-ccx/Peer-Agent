import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  compactIfNeeded,
  microcompactMessagesForContext,
  resetCircuitBreaker,
} from './context-compactor.mjs';

const buildMessages = (count, charsPerMessage = 20) => [
  { role: 'system', content: 'system prompt' },
  ...Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message-${index}-${'x'.repeat(charsPerMessage)}`,
  })),
];

describe('context compactor', () => {
  beforeEach(() => {
    resetCircuitBreaker();
  });

  it('does not compact below threshold without force', async () => {
    const messages = buildMessages(12, 20);

    const result = await compactIfNeeded({
      messages,
      systemPrompt: 'system prompt',
      contextWindow: 100_000,
      providerConfig: null,
    });

    assert.equal(result.compacted, false);
    assert.equal(result.messages, messages);
  });

  it('force compacts and creates a user handoff message', async () => {
    const result = await compactIfNeeded({
      messages: buildMessages(12, 20),
      systemPrompt: 'system prompt',
      contextWindow: 100_000,
      providerConfig: null,
      force: true,
    });

    assert.equal(result.compacted, true);
    assert.equal(result.messages[0].role, 'system');
    assert.equal(result.messages[1].role, 'user');
    assert.match(result.messages[1].content, /^\[上下文交接 - 共压缩 2 条消息\]/);
    assert.equal(result.messages[1]._compaction.method, 'structural');
    assert.equal(result.messages[1]._compaction.originalMessageCount, 2);
    assert.equal(result.notification.keptMessageCount, 10);
  });

  it('carries forward prior continuity while reporting only the delta message count', async () => {
    const result = await compactIfNeeded({
      messages: buildMessages(12, 20),
      systemPrompt: 'system prompt',
      contextWindow: 100_000,
      providerConfig: null,
      force: true,
      continuityContext: [{
        id: 'previous-compact',
        method: 'structural',
        originalMessageCount: 100,
        beforeTokens: 38_500,
        afterTokens: 6_376,
        summary: 'previous summary',
      }],
    });

    assert.equal(result.compacted, true);
    assert.equal(result.notification.oldMessageCount, 2);
    assert.equal(result.notification.previousMessageCount, 100);
    assert.equal(result.notification.totalMessageCount, 102);
    assert.equal(result.messages[1]._compaction.originalMessageCount, 102);
    assert.equal(result.messages[1]._compaction.deltaMessageCount, 2);
    assert.equal(result.messages[1]._compaction.previousMessageCount, 100);
    assert.match(result.messages[1]._compaction.summary, /previous summary/);
    assert.match(result.messages[1]._compaction.summary, /Delta summary since previous compaction \(2 messages\)/);
  });

  it('keeps the assistant tool call when the recent window starts with a tool result', async () => {
    const messages = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'old request' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'tool-1', type: 'function', function: { name: 'bash', arguments: '{"command":"pwd"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'tool-1', content: 'workspace path' },
      ...Array.from({ length: 9 }, (_, index) => ({
        role: index % 2 === 0 ? 'assistant' : 'user',
        content: `recent-${index}`,
      })),
    ];

    const result = await compactIfNeeded({
      messages,
      systemPrompt: 'system prompt',
      contextWindow: 100_000,
      providerConfig: null,
      force: true,
    });

    assert.equal(result.compacted, true);
    assert.equal(result.notification.oldMessageCount, 1);
    assert.equal(result.notification.keptMessageCount, 11);
    assert.equal(result.messages[2].role, 'assistant');
    assert.equal(result.messages[2].tool_calls[0].id, 'tool-1');
    assert.equal(result.messages[3].role, 'tool');
    assert.equal(result.messages[3].tool_call_id, 'tool-1');
  });

  it('preflight compacts above threshold without throwing', async () => {
    const result = await compactIfNeeded({
      messages: buildMessages(20, 400),
      systemPrompt: 'system prompt',
      contextWindow: 1_000,
      providerConfig: null,
    });

    assert.equal(result.compacted, true);
    assert.equal(result.messages[1].role, 'user');
    assert.match(result.messages[1].content, /^\[上下文交接/);
    assert.equal(result.notification.method, 'structural');
  });

  it('microcompacts old local tool result refs while preserving retrieval fields', () => {
    const largeRef = JSON.stringify({
      kind: 'local_tool_result_ref',
      tool: 'bash',
      command: 'node big-output.js',
      cwd: '/tmp/workspace',
      status: 'success',
      exitCode: 0,
      stdoutPath: '/tmp/artifacts/stdout.log',
      stderrPath: '/tmp/artifacts/stderr.log',
      metadataPath: '/tmp/artifacts/metadata.json',
      stdoutChars: 12000,
      stdoutLines: 1,
      stdoutPreview: 'x'.repeat(9000),
      suggestedRetrieval: ['tail -n 120 /tmp/artifacts/stdout.log'],
    });
    const messages = [
      { role: 'system', content: 'system prompt' },
      { role: 'tool', content: largeRef },
      ...buildMessages(10, 20).slice(1),
    ];

    const result = microcompactMessagesForContext(messages, {
      keepRecentCount: 8,
      triggerChars: 6000,
      previewChars: 500,
    });

    assert.equal(result.stats.compactedCount, 1);
    assert.ok(result.stats.savedChars > 0);
    const compacted = JSON.parse(result.messages[1].content);
    assert.equal(compacted.kind, 'local_tool_result_ref');
    assert.equal(compacted.microCompacted, true);
    assert.equal(compacted.stdoutPath, '/tmp/artifacts/stdout.log');
    assert.deepEqual(compacted.suggestedRetrieval, ['tail -n 120 /tmp/artifacts/stdout.log']);
    assert.ok(compacted.stdoutPreview.length < 1000);
  });

  it('does not microcompact recent messages', () => {
    const recentLargeText = 'recent-output-'.repeat(1000);
    const messages = [
      { role: 'system', content: 'system prompt' },
      ...buildMessages(7, 20).slice(1),
      { role: 'tool', content: recentLargeText },
    ];

    const result = microcompactMessagesForContext(messages, {
      keepRecentCount: 8,
      triggerChars: 6000,
      previewChars: 500,
    });

    assert.equal(result.stats.compactedCount, 0);
    assert.equal(result.messages, messages);
  });
});

// ── 0007: 流式压缩字符级进度 ──

// 用一段文本构造一个 SSE ReadableStream，模拟 LLM 流式响应。
const makeSseResponse = (chunks) => ({
  ok: true,
  body: {
    getReader() {
      const encoder = new TextEncoder();
      let i = 0;
      return {
        read() {
          if (i >= chunks.length) return Promise.resolve({ done: true, value: undefined });
          const value = encoder.encode(chunks[i]);
          i += 1;
          return Promise.resolve({ done: false, value });
        },
      };
    },
  },
});

describe('context compactor · streaming progress (0007)', () => {
  let originalFetch;

  beforeEach(() => {
    resetCircuitBreaker();
    originalFetch = globalThis.fetch;
  });

  const restoreFetch = () => {
    globalThis.fetch = originalFetch;
  };

  it('reports incremental receivedChars via onProgress (anthropic stream) and uses LLM method', async () => {
    // Anthropic SSE：每个 content_block_delta 增加摘要文本。
    const deltas = ['## Summary', '\nfirst', '\nsecond', '\nthird'];
    const sseChunks = deltas.map(
      (t) => `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: t } })}\n\n`,
    );
    sseChunks.push('data: [DONE]\n\n');
    globalThis.fetch = async () => makeSseResponse(sseChunks);

    const progressEvents = [];
    const result = await compactIfNeeded({
      messages: buildMessages(12, 20),
      systemPrompt: 'system prompt',
      contextWindow: 100_000,
      providerConfig: {
        provider: 'anthropic',
        baseUrl: 'https://example.test',
        apiKey: 'k',
        model: 'claude-test',
      },
      force: true,
      onProgress: (p) => progressEvents.push(p),
    });

    restoreFetch();

    // 走了 LLM 语义压缩（非 structural 兜底）。
    assert.equal(result.compacted, true);
    assert.equal(result.messages[1]._compaction.method, 'llm');

    // onProgress 至少被每个 delta 调用一次，receivedChars 单调递增。
    assert.ok(progressEvents.length >= deltas.length);
    const expectedFinal = deltas.join('').length;
    assert.equal(progressEvents.at(-1).receivedChars, expectedFinal);
    for (let i = 1; i < progressEvents.length; i += 1) {
      assert.ok(progressEvents[i].receivedChars >= progressEvents[i - 1].receivedChars);
    }
    // estimatedTotalChars 为正，作为百分比分母。
    assert.ok(progressEvents.at(-1).estimatedTotalChars > 0);
  });

  it('falls back to structural when the stream errors', async () => {
    // body 不可读 → readSseStream 抛错 → catch 走 structural 兜底。
    globalThis.fetch = async () => ({ ok: true, body: null });

    const result = await compactIfNeeded({
      messages: buildMessages(12, 20),
      systemPrompt: 'system prompt',
      contextWindow: 100_000,
      providerConfig: {
        provider: 'anthropic',
        baseUrl: 'https://example.test',
        apiKey: 'k',
        model: 'claude-test',
      },
      force: true,
      onProgress: () => {},
    });

    restoreFetch();

    assert.equal(result.compacted, true);
    assert.equal(result.messages[1]._compaction.method, 'structural');
    assert.equal(result.messages[1]._compaction.fallbackReason, 'llm_error');
  });
});
