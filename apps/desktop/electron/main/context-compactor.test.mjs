import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, it } from 'node:test';
import {
  COMPACTION_CONFIG,
  compactIfNeeded,
  estimateSummaryChars,
  estimateTextTokens,
  formatCompactSummary,
  estimateTokensFromMessages,
  estimateToolsTokens,
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

describe('estimateTextTokens（CJK 感知比例）', () => {
  it('counts CJK characters with a higher weight than latin text', () => {
    // 50 个中文字符：按 /1.7 ≈ 30 token，远高于旧的 /4 ≈ 13 token。
    const cjk = '中'.repeat(50);
    const tokens = estimateTextTokens(cjk);
    assert.ok(tokens >= 28 && tokens <= 32, `expected ~29 tokens, got ${tokens}`);
    // 与旧的 length/4 口径相比应明显更高（约 2 倍）。
    assert.ok(tokens > Math.ceil(cjk.length / 4), 'CJK should not be undercounted as /4');
  });

  it('keeps latin text at ~4 chars/token', () => {
    const latin = 'a'.repeat(40);
    assert.equal(estimateTextTokens(latin), 10);
  });

  it('handles mixed CJK + latin additively', () => {
    const mixed = `${'中'.repeat(17)}${'a'.repeat(40)}`; // ~10 + 10
    const tokens = estimateTextTokens(mixed);
    assert.ok(tokens >= 19 && tokens <= 21, `expected ~20 tokens, got ${tokens}`);
  });

  it('returns 0 for empty / nullish values', () => {
    assert.equal(estimateTextTokens(''), 0);
    assert.equal(estimateTextTokens(null), 0);
    assert.equal(estimateTextTokens(undefined), 0);
  });
});

describe('estimateToolsTokens（工具 schema 计入上下文）', () => {
  const anthropicTool = {
    name: 'search_files',
    description: 'Search file contents across the workspace',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring to search for' },
        path: { type: 'string', description: 'Optional scope directory' },
      },
      required: ['query'],
    },
  };

  it('returns 0 for nullish / empty tools', () => {
    assert.equal(estimateToolsTokens(null), 0);
    assert.equal(estimateToolsTokens(undefined), 0);
    assert.equal(estimateToolsTokens([]), 0);
  });

  it('counts a single tool definition as non-trivial token cost', () => {
    const tokens = estimateToolsTokens([anthropicTool]);
    assert.ok(tokens > 20, `expected meaningful tool token cost, got ${tokens}`);
  });

  it('scales roughly linearly with tool count (47 tools => sizable cost)', () => {
    const one = estimateToolsTokens([anthropicTool]);
    const fortySeven = estimateToolsTokens(Array.from({ length: 47 }, () => anthropicTool));
    assert.ok(
      fortySeven > one * 40,
      `expected ~47x growth, got ${fortySeven} vs ${one}`,
    );
    // 47 个这种中等体量工具应累积到数千 token 量级（旧实现完全为 0）。
    assert.ok(fortySeven > 2_000, `expected thousands of tokens, got ${fortySeven}`);
  });

  it('supports OpenAI chat function shape', () => {
    const openaiTool = {
      type: 'function',
      function: {
        name: anthropicTool.name,
        description: anthropicTool.description,
        parameters: anthropicTool.input_schema,
      },
    };
    assert.equal(estimateToolsTokens([openaiTool]), estimateToolsTokens([anthropicTool]));
  });

  it('supports Gemini functionDeclarations shape', () => {
    const geminiTools = {
      functionDeclarations: [
        {
          name: anthropicTool.name,
          description: anthropicTool.description,
          parameters: anthropicTool.input_schema,
        },
      ],
    };
    assert.equal(estimateToolsTokens(geminiTools), estimateToolsTokens([anthropicTool]));
  });
});

describe('compactIfNeeded（触发口径含工具 schema）', () => {
  beforeEach(() => {
    resetCircuitBreaker();
  });

  it('triggers compaction when tools push the estimate over the threshold', async () => {
    // 构造一个「仅看 messages 不会越线，但加上工具 schema 后越线」的场景。
    const messages = buildMessages(20, 400);
    const baseTokens = estimateTokensFromMessages(messages);
    // 选一个上下文窗口：messages 单独 < 0.8*window，但 messages + tools > 0.8*window。
    const bigTool = {
      name: 'huge_tool',
      description: 'x'.repeat(4_000),
      input_schema: { type: 'object', properties: {} },
    };
    const tools = [bigTool];
    const toolTokens = estimateToolsTokens(tools);
    // 让 window 落在二者之间。
    const contextWindow = Math.ceil((baseTokens + toolTokens / 2) / COMPACTION_CONFIG.triggerRatio);

    const withoutTools = await compactIfNeeded({
      messages,
      systemPrompt: 'system prompt',
      contextWindow,
      providerConfig: null,
    });
    assert.equal(withoutTools.compacted, false, 'messages alone should stay below threshold');

    const withTools = await compactIfNeeded({
      messages,
      systemPrompt: 'system prompt',
      contextWindow,
      providerConfig: null,
      tools,
    });
    // 工具把总预算推过触发线；压缩后仍把不可压缩的工具预算纳入验收。
    assert.equal(withTools.compacted, true);
    assert.ok(withTools.notification.afterTokens + toolTokens <= contextWindow * COMPACTION_CONFIG.triggerRatio);
  });

  it('fails explicitly when immutable tool schemas alone cannot fit below the trigger', async () => {
    const messages = buildMessages(12, 20);
    const tools = Array.from({ length: 10 }, () => ({
      name: 'huge_tool',
      description: 'x'.repeat(4_000),
      input_schema: { type: 'object', properties: {} },
    }));

    await assert.rejects(
      () => compactIfNeeded({
        messages,
        systemPrompt: 'system prompt',
        contextWindow: 6_599,
        providerConfig: null,
        tools,
      }),
      (error) => {
        assert.equal(error.code, 'CONTEXT_COMPACTION_INSUFFICIENT_REDUCTION');
        assert.match(error.message, /minimal candidate=/);
        return true;
      },
    );
  });
});

describe('estimateSummaryChars (progress denominator)', () => {
  // 物理上限 = maxOutputTokens(12000) * charsPerToken(4) = 48000。
  const maxSummaryChars = 12_000 * COMPACTION_CONFIG.charsPerToken;

  it('does not let a typical summary finish at ~30% of the denominator', () => {
    // 典型场景：~120k 字符输入对话。旧逻辑分母恒为 48000，
    // 真实摘要 ~14k 字符收完时 percent≈29% 即 done 跳满。
    const inputChars = 120_000;
    const denom = estimateSummaryChars({ inputChars, maxSummaryChars, receivedChars: 0 });

    // 新分母应按 input*0.12 ≈ 14400 估计，而不是 48000。
    assert.ok(
      denom < maxSummaryChars,
      `denominator should be below physical cap, got ${denom}`,
    );

    // 当真实摘要约 14k 字符收完时，percent 应已接近 100%（>=80%），
    // 而不是旧逻辑的 ~30%。
    const realSummaryChars = 14_000;
    const denomAtEnd = estimateSummaryChars({
      inputChars,
      maxSummaryChars,
      receivedChars: realSummaryChars,
    });
    const percent = (realSummaryChars / denomAtEnd) * 100;
    assert.ok(
      percent >= 80,
      `expected near-complete percent at stream end, got ${percent.toFixed(1)}%`,
    );
  });

  it('stays monotonic and never reaches 100% before done when output overshoots estimate', () => {
    // 低估场景：输入很短（基准估计被夹到下限），但实际产出远超估计。
    const inputChars = 2_000; // 估计基准 = 240 → 夹到 minEstimatedSummaryChars
    let prevPercent = -1;
    for (let received = 0; received <= 30_000; received += 1_000) {
      const denom = estimateSummaryChars({
        inputChars,
        maxSummaryChars,
        receivedChars: received,
      });
      const percent = Math.min(99, Math.round((received / denom) * 100));
      // 单调不回退
      assert.ok(
        percent >= prevPercent,
        `percent regressed: ${percent} < ${prevPercent} at received=${received}`,
      );
      prevPercent = percent;
      // 在物理上限内时，分母始终大于接收量 → 真实占比 < 100%
      if (received > 0 && denom < maxSummaryChars) {
        assert.ok(
          received < denom,
          `denominator should stay ahead of received (${received} >= ${denom})`,
        );
      }
    }
  });

  it('clamps to [min, maxSummaryChars] and handles invalid input', () => {
    // 下限夹逼：极短输入。
    assert.equal(
      estimateSummaryChars({ inputChars: 0, maxSummaryChars, receivedChars: 0 }),
      COMPACTION_CONFIG.minEstimatedSummaryChars,
    );
    // 上限夹逼：超大输入 × 压缩比会超过物理上限 → 夹到 maxSummaryChars。
    assert.equal(
      estimateSummaryChars({ inputChars: 10_000_000, maxSummaryChars, receivedChars: 0 }),
      maxSummaryChars,
    );
    // 动态扩张也不得突破物理上限。
    assert.equal(
      estimateSummaryChars({
        inputChars: 10_000_000,
        maxSummaryChars,
        receivedChars: maxSummaryChars,
      }),
      maxSummaryChars,
    );
    // 异常 maxSummaryChars 入参：回退到合理正数上限，结果仍为正。
    const denom = estimateSummaryChars({
      inputChars: 50_000,
      maxSummaryChars: NaN,
      receivedChars: 0,
    });
    assert.ok(denom > 0 && Number.isFinite(denom), `expected positive finite denom, got ${denom}`);
  });
});

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

  it('preserves the latest human user turn when automatic preflight compaction requests it', async () => {
    const messages = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'current turn question' },
    ];

    const result = await compactIfNeeded({
      messages,
      systemPrompt: 'system prompt',
      contextWindow: 100_000,
      providerConfig: null,
      force: true,
      preserveLatestUserTurn: true,
    });

    assert.equal(result.compacted, true);
    assert.equal(result.notification.oldMessageCount, 2);
    assert.equal(result.notification.keptMessageCount, 1);
    assert.equal(result.messages.length, 3);
    assert.equal(result.messages[0].role, 'system');
    assert.equal(result.messages[1].role, 'user');
    assert.match(result.messages[1].content, /^\[上下文交接 - 共压缩 2 条消息\]/);
    assert.equal(result.messages[2].role, 'user');
    assert.equal(result.messages[2].content, 'current turn question');
    assert.doesNotMatch(result.messages[1]._compaction.summary, /current turn question/);
  });

  it('compacts closed tool rounds inside the latest human turn while preserving the raw user request', async () => {
    const messages = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'current task' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'tool-9', type: 'function', function: { name: 'bash', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'tool-9', content: `tool output ${'x'.repeat(360_000)}` },
    ];

    const result = await compactIfNeeded({
      messages,
      systemPrompt: 'system prompt',
      contextWindow: 100_000,
      providerConfig: null,
      preserveLatestUserTurn: true,
    });

    assert.equal(result.compacted, true);
    assert.equal(result.notification.oldMessageCount, 4);
    assert.equal(result.notification.keptMessageCount, 1);
    assert.equal(result.messages.length, 3);
    assert.equal(result.messages.at(-1).role, 'user');
    assert.equal(result.messages.at(-1).content, 'current task');
    assert.ok(
      result.notification.afterTokens < result.notification.beforeTokens,
      'an automatic compaction must actually reduce the context',
    );
  });

  it('keeps an unclosed tool call with the latest user request for provider validity', async () => {
    const messages = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'current task' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'tool-open', type: 'function', function: { name: 'bash', arguments: '{}' } },
        ],
      },
    ];

    const result = await compactIfNeeded({
      messages,
      systemPrompt: 'system prompt',
      contextWindow: 100_000,
      providerConfig: null,
      force: true,
      preserveLatestUserTurn: true,
    });

    assert.equal(result.compacted, true);
    assert.equal(result.notification.oldMessageCount, 2);
    assert.equal(result.notification.keptMessageCount, 2);
    assert.deepEqual(result.messages.slice(-2), messages.slice(-2));
  });

  it('does not treat a pure Anthropic tool_result user message as latest human input', async () => {
    const messages = [
      { role: 'system', content: 'system prompt' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'bash', input: { command: 'pwd' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'workspace path' },
        ],
      },
    ];

    const result = await compactIfNeeded({
      messages,
      systemPrompt: 'system prompt',
      contextWindow: 100_000,
      providerConfig: null,
      force: true,
      preserveLatestUserTurn: true,
    });

    assert.equal(result.compacted, true);
    assert.equal(result.notification.oldMessageCount, 2);
    assert.equal(result.notification.keptMessageCount, 0);
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages.some((m) => m.role === 'tool'), false);
  });

  it('does not treat a compaction handoff user message as latest human input', async () => {
    const messages = [
      { role: 'system', content: 'system prompt' },
      {
        role: 'user',
        content: '[上下文交接 - 共压缩 100 条消息]\nsummary',
        _compaction: {
          method: 'structural',
          originalMessageCount: 100,
          beforeTokens: 1000,
          afterTokens: 100,
          summary: 'summary',
        },
      },
      { role: 'assistant', content: 'continued from summary' },
    ];

    const result = await compactIfNeeded({
      messages,
      systemPrompt: 'system prompt',
      contextWindow: 100_000,
      providerConfig: null,
      force: true,
      preserveLatestUserTurn: true,
    });

    assert.equal(result.compacted, true);
    assert.equal(result.notification.oldMessageCount, 2);
    assert.equal(result.notification.keptMessageCount, 0);
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[1]._compaction.originalMessageCount, 2);
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

  it('neutralizes pseudo tool-call syntax in compact summaries before continuity injection', () => {
    const formatted = formatCompactSummary('<functions.bash agext={{"command":"git diff"}} />');

    assert.doesNotMatch(formatted, /<functions\.bash/);
    assert.match(formatted, /&lt;functions\.bash/);
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
    assert.equal(result.notification.method, 'fallback_drop');
    assert.equal(result.notification.fallbackReason, 'insufficient_reduction');
    assert.ok(
      result.notification.afterTokens < result.notification.beforeTokens,
      'an over-threshold compaction must never be accepted when it increases the prompt',
    );
    assert.ok(result.notification.afterTokens <= 800, 'the compacted prompt must return below the trigger');
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
