import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, it } from 'node:test';
import {
  compactIfNeeded,
  estimateTokensFromMessages,
  microcompactMessagesForContext,
  resetCircuitBreaker,
} from './context-compactor.mjs';

const COMPACTOR_SOURCE = readFileSync(
  fileURLToPath(new URL('./context-compactor.mjs', import.meta.url)),
  'utf8',
);

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

  it('estimates image_url / input_image blocks as fixed cost, not their base64 length', () => {
    // 模拟一张 ~3MB 图片的 data URL（base64 约 400 万字符）。
    const hugeDataUrl = `data:image/png;base64,${'A'.repeat(4_000_000)}`;
    const imageUrlMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image_url', image_url: { url: hugeDataUrl } },
      ],
    };
    const inputImageMessage = {
      role: 'user',
      content: [{ type: 'input_image', image_url: hugeDataUrl }],
    };

    // 修复前：image_url/input_image 会掉进 JSON.stringify(block) 分支，
    // 估算 ≈ 400 万字符 / 4 ≈ 100 万 token，导致每轮误触发压缩。
    // 修复后：按固定 2000 token/图计，两条消息合计应远低于阈值。
    const estimated = estimateTokensFromMessages([imageUrlMessage, inputImageMessage]);
    assert.ok(
      estimated < 10_000,
      `expected fixed image cost, got ${estimated} tokens`,
    );
  });

  it('does not compact a small conversation that contains a large image', async () => {
    const hugeDataUrl = `data:image/png;base64,${'A'.repeat(4_000_000)}`;
    const messages = [
      { role: 'system', content: 'system prompt' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '这个 MCP 的标题去哪了？' },
          { type: 'image_url', image_url: { url: hugeDataUrl } },
        ],
      },
      { role: 'assistant', content: 'short reply' },
    ];

    const result = await compactIfNeeded({
      messages,
      systemPrompt: 'system prompt',
      contextWindow: 1_000_000,
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
    // 真·全量压缩（0011）：buildMessages(12) 的 12 条会话消息全部进 old 摘要，
    // keep 为空、不保留任何原文。
    assert.match(result.messages[1].content, /^\[上下文交接 - 共压缩 12 条消息\]/);
    assert.equal(result.messages[1]._compaction.method, 'structural');
    assert.equal(result.messages[1]._compaction.originalMessageCount, 12);
    assert.equal(result.notification.keptMessageCount, 0);
    // keep 为空 → 交接 user 后不再追加任何保留消息。
    assert.equal(result.messages.length, 2);
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
    // 真·全量压缩（0011）：本轮 old=12（buildMessages(12) 全部进 old、keep 为空）。
    assert.equal(result.notification.oldMessageCount, 12);
    assert.equal(result.notification.previousMessageCount, 100);
    assert.equal(result.notification.totalMessageCount, 112);
    assert.equal(result.messages[1]._compaction.originalMessageCount, 112);
    assert.equal(result.messages[1]._compaction.deltaMessageCount, 12);
    assert.equal(result.messages[1]._compaction.previousMessageCount, 100);
    assert.match(result.messages[1]._compaction.summary, /previous summary/);
    assert.match(result.messages[1]._compaction.summary, /Delta summary since previous compaction \(12 messages\)/);
  });

  it('full-flush summarizes a trailing dangling tool pair without leaving an orphan tool message', async () => {
    // 真·全量压缩（0011）：keep 恒为空，末尾的 assistant(tool_call)+tool 一并进 old 摘要，
    // 交接后不留任何孤立 tool_result（不会让下一轮 provider 因配对缺失报错）。
    const messages = [
      { role: 'system', content: 'system prompt' },
      ...Array.from({ length: 8 }, (_, index) => ({
        role: 'assistant',
        content: `old-${index}`,
      })),
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'tool-1', type: 'function', function: { name: 'bash', arguments: '{"command":"pwd"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'tool-1', content: 'workspace path' },
    ];

    const result = await compactIfNeeded({
      messages,
      systemPrompt: 'system prompt',
      contextWindow: 100_000,
      providerConfig: null,
      force: true,
    });

    assert.equal(result.compacted, true);
    // keep 为空：10 条全部进 old 摘要、不保留原文。
    assert.equal(result.notification.keptMessageCount, 0);
    assert.equal(result.notification.oldMessageCount, 10);
    // 结果只有 system + 交接 user，不残留任何 role==='tool' 的孤立消息。
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0].role, 'system');
    assert.equal(result.messages[1].role, 'user');
    assert.equal(result.messages.some((m) => m.role === 'tool'), false);
  });

  it('flushes the current turn too — nothing original is kept (真·全量)', async () => {
    // 真·全量压缩（0011）：连「当前轮」（最后一个 user 到末尾）也不保留，全部进 old 摘要。
    const messages = [
      { role: 'system', content: 'system prompt' },
      ...Array.from({ length: 8 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `old-${index}`,
      })),
      { role: 'user', content: 'current turn question' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'tool-9', type: 'function', function: { name: 'bash', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'tool-9', content: 'tool output' },
      { role: 'assistant', content: 'final answer' },
    ];

    const result = await compactIfNeeded({
      messages,
      systemPrompt: 'system prompt',
      contextWindow: 100_000,
      providerConfig: null,
      force: true,
    });

    assert.equal(result.compacted, true);
    // 全部 12 条会话消息进 old、keep 为空。
    assert.equal(result.notification.keptMessageCount, 0);
    assert.equal(result.notification.oldMessageCount, 12);
    // 当前轮的 user 与 final answer 都不再以原文留存。
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[1].role, 'user');
    assert.match(result.messages[1].content, /^\[上下文交接/);
  });

  it('does not compact when there is no non-system message', async () => {
    // 真·全量压缩（0011）：无任何非 system 消息 → 不压缩，避免空压缩。
    const messages = [
      { role: 'system', content: 'system prompt' },
    ];

    const result = await compactIfNeeded({
      messages,
      systemPrompt: 'system prompt',
      contextWindow: 100_000,
      providerConfig: null,
      force: true,
    });

    assert.equal(result.compacted, false);
  });

  it('summary prompts require detailed user execution actions / operation steps (0011)', () => {
    // 真·全量压缩后原文不再保留，连续性靠摘要承载 → 摘要 prompt 必须显式要求记录执行动作/操作步骤。
    // SUMMARY_SYSTEM_PROMPT（中文 fallback 摘要）强调「执行动作/操作步骤」。
    assert.match(COMPACTOR_SOURCE, /执行动作/);
    assert.match(COMPACTOR_SOURCE, /操作步骤/);
    // COMPACT_PROMPT（英文 9 章节）第 8 节强调 execution actions / operation steps。
    assert.match(COMPACTOR_SOURCE, /concrete execution actions and operation steps/);
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

  it('uses OpenAI Responses wire for ChatGPT subscription compaction', async () => {
    const sseChunks = [
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'summary' })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: ' text' })}\n\n`,
      'data: [DONE]\n\n',
    ];
    const progressEvents = [];
    let capturedUrl = null;
    let capturedHeaders = null;
    let capturedBody = null;

    globalThis.fetch = async (url, init) => {
      capturedUrl = url;
      capturedHeaders = init?.headers;
      capturedBody = JSON.parse(init?.body || '{}');
      return makeSseResponse(sseChunks);
    };

    const result = await compactIfNeeded({
      messages: buildMessages(12, 20),
      systemPrompt: 'system prompt',
      contextWindow: 100_000,
      providerConfig: {
        provider: 'openai',
        baseUrl: 'https://chatgpt.com/backend-api/codex',
        apiKey: 'oauth-access',
        model: 'gpt-5.1-codex',
        wire: 'openai-responses',
        endpoint: 'https://chatgpt.com/backend-api/codex/responses',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer oauth-access',
          'OpenAI-Beta': 'responses=experimental',
          'chatgpt-account-id': 'acct-1',
        },
        omitMaxOutputTokens: true,
      },
      force: true,
      onProgress: (p) => progressEvents.push(p),
    });

    restoreFetch();

    assert.equal(capturedUrl, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(capturedHeaders.Authorization, 'Bearer oauth-access');
    assert.equal(capturedHeaders['chatgpt-account-id'], 'acct-1');
    assert.equal(capturedBody.stream, true);
    assert.equal(capturedBody.max_output_tokens, undefined);
    assert.equal(result.compacted, true);
    assert.equal(result.messages[1]._compaction.method, 'llm');
    assert.equal(progressEvents.at(-1).receivedChars, 'summary text'.length);
  });

  it('recovers compaction transport through Electron fetch when Node fetch hits corporate TLS', async () => {
    const sseChunks = [
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'recovered summary' })}\n\n`,
      'data: [DONE]\n\n',
    ];
    const events = [];
    const webContents = {
      send(channel, payload) {
        events.push({ channel, payload });
      },
    };
    let nodeFetchCalls = 0;
    let electronFetchCalls = 0;

    const result = await compactIfNeeded({
      messages: buildMessages(12, 20),
      systemPrompt: 'system prompt',
      contextWindow: 100_000,
      providerConfig: {
        provider: 'openai',
        baseUrl: 'https://chatgpt.com/backend-api/codex',
        apiKey: 'oauth-access',
        model: 'gpt-5.1-codex',
        wire: 'openai-responses',
        endpoint: 'https://chatgpt.com/backend-api/codex/responses',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer [REDACTED_TOKEN]',
          'OpenAI-Beta': 'responses=experimental',
        },
        omitMaxOutputTokens: true,
      },
      force: true,
      webContents,
      streamId: 'compact-1',
      connectionRecoveryOptions: {
        fetchImpl: async () => {
          nodeFetchCalls += 1;
          const error = new Error('self signed certificate in certificate chain');
          error.code = 'SELF_SIGNED_CERT_IN_CHAIN';
          throw error;
        },
        electronFetchImpl: async () => {
          electronFetchCalls += 1;
          return makeSseResponse(sseChunks);
        },
        waitImpl: async () => {},
      },
    });

    assert.equal(nodeFetchCalls, 1);
    assert.equal(electronFetchCalls, 1);
    assert.equal(result.compacted, true);
    assert.equal(result.messages[1]._compaction.method, 'llm');
    assert.equal(result.messages[1].content.includes('recovered summary'), true);
    assert.deepEqual(events.map((event) => event.payload.status), ['recovered']);
    assert.equal(events[0].payload.streamId, 'compact-1');
    assert.equal(events[0].payload.provider, 'openai');
    assert.equal(events[0].payload.model, 'gpt-5.1-codex');
    assert.equal(events[0].payload.fromConnection, 'node-fetch');
    assert.equal(events[0].payload.toConnection, 'electron-net-fetch');
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
