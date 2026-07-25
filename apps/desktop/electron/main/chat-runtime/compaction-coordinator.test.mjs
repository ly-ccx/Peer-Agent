import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyMicrocompaction,
  buildCompactionProviderConfig,
  buildPromptTooLongRecoveryError,
  computeContextBudget,
  computeContextInfo,
  contextTokensFromUsageSnapshot,
  isPromptTooLongResponse,
  rehydrateSystemPromptAfterCompaction,
  runCompactionCheck,
} from './compaction-coordinator.mjs';
import {
  COMPACTION_CONFIG,
  estimateTokensFromMessages,
  estimateToolsTokens,
} from '../context-compactor.mjs';

describe('chat compaction coordinator', () => {
  it('builds compaction provider config from the resolved chat channel', () => {
    const headers = { Authorization: 'Bearer session-token', 'chatgpt-account-id': 'acct_1' };
    const config = buildCompactionProviderConfig({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'legacy-key',
      model: 'gpt-5.5',
      maxOutputTokens: 128000,
      resolvedChannel: {
        baseUrl: 'https://chatgpt.com/backend-api/codex',
        wire: 'openai-responses',
        endpoint: 'https://chatgpt.com/backend-api/codex/responses',
        headers,
      },
      useResponses: true,
      authMethod: 'oauth_chatgpt',
    });

    assert.deepEqual(config, {
      provider: 'openai',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      apiKey: 'legacy-key',
      model: 'gpt-5.5',
      maxOutputTokens: 128000,
      wire: 'openai-responses',
      endpoint: 'https://chatgpt.com/backend-api/codex/responses',
      headers,
      omitMaxOutputTokens: true,
    });
  });

  it('keeps legacy provider config when no resolved channel is available', () => {
    const config = buildCompactionProviderConfig({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'key',
      model: 'gpt-4.1',
      maxOutputTokens: 12000,
    });

    assert.deepEqual(config, {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'key',
      model: 'gpt-4.1',
      maxOutputTokens: 12000,
      wire: undefined,
      endpoint: undefined,
      headers: undefined,
      omitMaxOutputTokens: false,
    });
  });

  it('detects provider prompt-too-long responses', () => {
    assert.equal(isPromptTooLongResponse(413, ''), true);
    assert.equal(isPromptTooLongResponse(400, 'context_length_exceeded'), true);
    assert.equal(isPromptTooLongResponse(400, 'Maximum context length exceeded'), true);
    assert.equal(isPromptTooLongResponse(400, 'context window exceeded'), true);
    assert.equal(isPromptTooLongResponse(400, 'input is too long for this model'), true);
    assert.equal(isPromptTooLongResponse(400, 'exceeds model context window'), true);
    assert.equal(
      isPromptTooLongResponse(
        400,
        'This model maximum prompt length is 500000 but the request contains 501244 tokens.',
      ),
      true,
    );
    assert.equal(isPromptTooLongResponse(500, 'temporary outage'), false);
  });

  it('never lets a low estimate override 498K provider-observed input', () => {
    const budget = computeContextBudget({
      messages: [{ role: 'user', content: 'tiny local projection' }],
      contextWindow: 500_000,
      usageSnapshot: { inputTokens: 498_138, cacheReadTokens: 0 },
    });

    assert.equal(budget.contextTokens, 498_138);
    assert.equal(budget.usageTokens, 498_138);
    assert.equal(budget.shouldCompact, true);
  });

  it('builds explicit prompt-too-long recovery errors', () => {
    const message = buildPromptTooLongRecoveryError({
      text: 'Maximum context length exceeded',
      providerTracePath: '/tmp/provider-trace.json',
      retryUsed: true,
    });

    assert.match(message, /Context window exceeded/);
    assert.match(message, /retried once/);
    assert.match(message, /provider_error=Maximum context length exceeded/);
    assert.match(message, /provider_trace=\/tmp\/provider-trace\.json/);
  });

  it('computes hard budget guard modes from messages plus tools', () => {
    const messages = [{ role: 'user', content: 'hello' }];
    const tools = [
      {
        name: 'large_tool',
        description: 'x'.repeat(2000),
        input_schema: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ];
    const totalTokens = estimateTokensFromMessages(messages) + estimateToolsTokens(tools);
    const hardWindow = Math.floor(totalTokens / COMPACTION_CONFIG.hardRatio) - 1;
    const budget = computeContextBudget({ messages, tools, contextWindow: hardWindow });

    assert.equal(budget.contextTokens, totalTokens);
    assert.equal(budget.overHardLimit, true);
    assert.equal(budget.force, true);
    assert.equal(budget.emergency, true);
    assert.equal(budget.shouldCompact, true);
    assert.ok(['hard', 'overflow'].includes(budget.mode));
  });

  it('does not emit compaction events when no context window is configured', async () => {
    const events = [];
    const messages = [{ role: 'user', content: 'hello' }];
    const result = await runCompactionCheck({
      messages,
      systemPrompt: 'system',
      contextWindow: 0,
      providerConfig: null,
      signal: new AbortController().signal,
      persistCompaction: null,
      conversationId: 'c1',
      streamId: 's1',
      webContents: {
        send(channel, payload) {
          events.push({ channel, payload });
        },
      },
    });

    assert.equal(result.compacted, false);
    assert.equal(result.messages, messages);
    assert.deepEqual(events, []);
  });

  it('settles the banner to idle when a started compaction does not compact', async () => {
    // emergency 强制发出 start；真·全量压缩（0011）下唯一的 compacted:false force 分支是
    // 「无任何非 system 消息」（convMsgs.length===0）。回归点：发过 start 后必须补发 idle，
    // 否则压缩横幅悬挂、界面卡在运行中。
    const events = [];
    const result = await runCompactionCheck({
      messages: [{ role: 'system', content: 'system' }],
      systemPrompt: 'system',
      contextWindow: 0,
      providerConfig: null,
      signal: new AbortController().signal,
      persistCompaction: null,
      conversationId: 'c1',
      streamId: 's1',
      emergency: true,
      force: true,
      webContents: {
        send(channel, payload) {
          events.push({ channel, payload });
        },
      },
    });

    assert.equal(result.compacted, false);
    const stages = events
      .filter((e) => e.channel === 'chat:compaction')
      .map((e) => e.payload.stage);
    assert.deepEqual(stages, ['start', 'idle']);
    assert.deepEqual(
      events.filter((e) => e.channel === 'chat:compaction').map((e) => e.payload.conversationId),
      ['c1', 'c1'],
    );
  });

  it('forwards preserveLatestUserTurn to automatic compaction', async () => {
    const result = await runCompactionCheck({
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'old question' },
        { role: 'assistant', content: 'old answer' },
        { role: 'user', content: 'current question' },
      ],
      systemPrompt: 'system',
      contextWindow: 0,
      providerConfig: null,
      signal: new AbortController().signal,
      persistCompaction: null,
      conversationId: 'c1',
      streamId: 's1',
      force: true,
      preserveLatestUserTurn: true,
      webContents: { send() {} },
    });

    assert.equal(result.compacted, true);
    assert.equal(result.compactResult.notification.oldMessageCount, 2);
    assert.equal(result.compactResult.notification.keptMessageCount, 1);
    assert.equal(result.messages.at(-1).role, 'user');
    assert.equal(result.messages.at(-1).content, 'current question');
  });

  it('emits the post-compaction context snapshot only after persistence succeeds', async () => {
    const events = [];
    const ordering = [];
    let persistedProjection = null;
    const tools = [
      {
        type: 'function',
        function: {
          name: 'large_tool',
          description: 'z'.repeat(400),
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      },
    ];
    const result = await runCompactionCheck({
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'old question' },
        { role: 'assistant', content: 'old answer' },
        { role: 'user', content: 'current question' },
      ],
      systemPrompt: 'system',
      contextWindow: 200_000,
      providerConfig: null,
      signal: new AbortController().signal,
      persistCompaction: async ({ requestProjection }) => {
        ordering.push('persist');
        persistedProjection = requestProjection;
      },
      conversationId: 'c1',
      streamId: 's1',
      force: true,
      preserveLatestUserTurn: true,
      tools,
      webContents: {
        send(channel, payload) {
          events.push({ channel, payload });
          if (channel === 'chat:compaction' && payload.stage === 'done') ordering.push('done');
        },
      },
    });

    const done = events.find(
      (event) => event.channel === 'chat:compaction' && event.payload.stage === 'done',
    )?.payload;
    assert.ok(done, 'successful compaction must emit done');
    assert.equal(done.conversationId, 'c1');
    assert.deepEqual(ordering, ['persist', 'done']);
    assert.equal(done.contextWindow, 200_000);
    assert.deepEqual(persistedProjection, {
      nextRequestInputTokens: done.nextRequestInputTokens,
      contextWindow: done.contextWindow,
    });
    assert.equal(
      done.nextRequestInputTokens,
      estimateTokensFromMessages(result.messages) + estimateToolsTokens(tools),
      'done snapshot must use the same messages + tool schema budget as the context meter',
    );
    assert.ok(done.nextRequestInputTokens > done.afterTokens, 'tool schema tokens must not be omitted');
  });

  it('rethrows when a compacted persist fails and settles the banner to idle', async () => {
    // 大量消息 + force 触发结构化压缩 (compacted:true);persistCompaction 抛错。
    // 回归点:错误必须向上抛出(交由 sendMessage 终态兜底),且失败路径必须补发 idle。
    const events = [];
    const messages = Array.from({ length: 14 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i} ${'x'.repeat(200)}`,
    }));

    await assert.rejects(
      () =>
        runCompactionCheck({
          messages,
          systemPrompt: 'system',
          contextWindow: 0,
          providerConfig: null,
          signal: new AbortController().signal,
          persistCompaction: async () => {
            throw new Error('persist boom');
          },
          conversationId: 'c1',
          streamId: 's1',
          force: true,
          emergency: true,
          webContents: {
            send(channel, payload) {
              events.push({ channel, payload });
            },
          },
        }),
      /persist boom/,
    );

    const stages = events
      .filter((e) => e.channel === 'chat:compaction')
      .map((e) => e.payload.stage);
    assert.equal(stages.includes('done'), false);
    assert.equal(stages.at(-1), 'idle');
  });
});

describe('computeContextInfo（进度条用量与压缩触发口径单一来源）', () => {
  const messages = [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'x'.repeat(4000) },
    { role: 'assistant', content: 'y'.repeat(4000) },
  ];

  it('contextTokens 与压缩触发使用同一估算函数（estimateTokensFromMessages）', () => {
    const info = computeContextInfo({ messages, contextWindow: 100_000 });
    // 口径统一的核心：进度条分子必须 === 压缩触发判定所用的估算，逐字节相等。
    assert.equal(info.nextRequestInputTokens, estimateTokensFromMessages(messages));
  });

  it('contextTokens 计入工具 schema（tools 每次请求都全量发送）', () => {
    const tools = [
      {
        name: 'search_files',
        description: 'Search file contents across the workspace',
        input_schema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    ];
    const withoutTools = computeContextInfo({ messages, contextWindow: 100_000 });
    const withTools = computeContextInfo({ messages, contextWindow: 100_000, tools });
    const toolTokens = estimateToolsTokens(tools);
    assert.ok(toolTokens > 0, 'tool schema should cost tokens');
    // 进度条分子 = messages + tools，二者口径单一来源。
    assert.equal(withTools.nextRequestInputTokens, withoutTools.nextRequestInputTokens + toolTokens);
  });

  it('compactionSuggested 用与 shouldCompact 完全相同的 triggerRatio 阈值线', () => {
    const tokens = estimateTokensFromMessages(messages);
    const ratio = COMPACTION_CONFIG.triggerRatio;
    // 阈值线正下方（未达到）：不建议压缩。阈值本身按 >= 触发。
    const windowBelow = Math.ceil((tokens + 1) / ratio);
    // 阈值线正上方（已越线）：建议压缩。
    const windowAbove = Math.floor(tokens / ratio) - 1;
    assert.equal(computeContextInfo({ messages, contextWindow: windowBelow }).compactionSuggested, false);
    assert.equal(computeContextInfo({ messages, contextWindow: windowAbove }).compactionSuggested, true);
    // 回执里必须带回 triggerRatio，渲染端无需自己猜阈值。
    assert.equal(computeContextInfo({ messages, contextWindow: windowAbove }).triggerRatio, ratio);
  });

  it('无有效上下文窗口时归一化为 null 且不建议压缩', () => {
    for (const contextWindow of [0, -1, undefined, Number.NaN]) {
      const info = computeContextInfo({ messages, contextWindow });
      assert.equal(info.contextWindow, null);
      assert.equal(info.compactionSuggested, false);
    }
  });

  it('messages 非数组时安全降级为 0 token', () => {
    assert.equal(computeContextInfo({ messages: null, contextWindow: 100_000 }).nextRequestInputTokens, 0);
    assert.equal(computeContextInfo({ messages: undefined, contextWindow: 100_000 }).nextRequestInputTokens, 0);
  });
});

// microcompaction 预算回归：原始集合与 Layer 1 后集合是两个明确阶段；
// 压缩触发应投影当前阶段真正用于下一步判定的 triggerTokens，主圆环则消费 contextTokens。
describe('microcompaction 前后触发预算不变量', () => {
  // 构造一个含「大块旧工具结果」的会话：微压缩会把旧 tool_result 截断成预览，
  // 因此完整集合的估算必然显著大于微压缩后集合的估算。
  function buildConversationWithBigToolResults() {
    const big = 'x'.repeat(8000);
    const messages = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 6; i++) {
      messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `t${i}`, type: 'function', function: { name: 'read', arguments: '{}' } }] });
      messages.push({ role: 'tool', tool_call_id: `t${i}`, content: `result-${i}-${big}` });
    }
    // 末尾留几条「近因」消息，确保旧工具结果落入可微压缩区间。
    messages.push({ role: 'user', content: 'recent-1' });
    messages.push({ role: 'assistant', content: 'recent-2' });
    messages.push({ role: 'user', content: 'recent-3' });
    return messages;
  }

  it('applyMicrocompaction 不修改入参（原始完整集合可继续用于权威估算）', () => {
    const messages = buildConversationWithBigToolResults();
    const snapshot = JSON.stringify(messages);

    const result = applyMicrocompaction(messages);

    // 不原地修改，协调器才能可靠比较 Layer 1 前后的预算并发布最终 triggerTokens。
    assert.equal(JSON.stringify(messages), snapshot, 'applyMicrocompaction 不应原地修改入参 messages');
    assert.notEqual(result.messages, messages, '应返回新的数组而非原数组');
    assert.ok(result.stats.compactedCount > 0, '本样本应至少触发一次微压缩，用例才有意义');
  });

  it('完整集合与显式微压缩后的集合投影为同一个下一请求输入量', () => {
    const full = buildConversationWithBigToolResults();
    const sent = applyMicrocompaction(full).messages;

    const fullInfo = computeContextInfo({ messages: full, contextWindow: 200_000 });
    const sentInfo = computeContextInfo({ messages: sent, contextWindow: 200_000 });

    assert.equal(
      fullInfo.nextRequestInputTokens,
      sentInfo.nextRequestInputTokens,
      '统一投影必须先应用与发送链路相同的 microcompaction',
    );
  });

  it('压缩建议与下一请求输入量来自同一预算', () => {
    const full = buildConversationWithBigToolResults();
    const projectedTokens = computeContextInfo({ messages: full, contextWindow: 200_000 }).nextRequestInputTokens;
    const ratio = COMPACTION_CONFIG.triggerRatio;
    const windowAbove = Math.floor(projectedTokens / ratio) - 1;
    const windowBelow = Math.ceil(projectedTokens / ratio) + 1;

    const above = computeContextInfo({ messages: full, contextWindow: windowAbove });
    const below = computeContextInfo({ messages: full, contextWindow: windowBelow });

    assert.equal(above.nextRequestInputTokens, projectedTokens);
    assert.equal(above.compactionSuggested, true);
    assert.equal(below.nextRequestInputTokens, projectedTokens);
    assert.equal(below.compactionSuggested, false);
  });
});

describe.skip('ADR 42 旧双口径行为（由 ADR 52 统一投影取代）', () => {
  // 旧双口径（usage 锁分子 / max(估算, usage) 触发）已由 ADR 52 统一投影取代。
  // 现行行为见下方 "ADR 52 next-request projection"。
});

describe('ADR 56 provider-observed context accounting', () => {
  // 本地构造一段「完整会话量很大」的消息（含多条大 tool 结果），用于对比两种数据口径。
  function buildBigConversation() {
    const big = 'x'.repeat(8000);
    const messages = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 6; i++) {
      messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `t${i}`, type: 'function', function: { name: 'read', arguments: '{}' } }] });
      messages.push({ role: 'tool', tool_call_id: `t${i}`, content: `result-${i}-${big}` });
    }
    return messages;
  }

  it('contextTokensFromUsageSnapshot 取 input + cacheRead（不含 output/cacheWrite）', () => {
    assert.equal(
      contextTokensFromUsageSnapshot({
        inputTokens: 1000,
        outputTokens: 500,
        cacheWriteTokens: 200,
        cacheReadTokens: 300,
      }),
      1300,
      '显示口径 = input(1000) + cacheRead(300)，与 output/cacheWrite 无关',
    );
  });

  it('contextTokensFromUsageSnapshot 无有效快照时返回 null（由上层回退估算）', () => {
    assert.equal(contextTokensFromUsageSnapshot(null), null);
    assert.equal(contextTokensFromUsageSnapshot({}), null);
    assert.equal(contextTokensFromUsageSnapshot({ outputTokens: 999 }), null, '仅 output 不算上下文');
  });

  it('usage 快照是权威分子，不允许本地估算覆盖', () => {
    const full = buildBigConversation();
    const usageSnapshot = { inputTokens: 800, outputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 200 };
    const info = computeContextInfo({ messages: full, contextWindow: 200_000, usageSnapshot });
    assert.equal(info.nextRequestInputTokens, 1000, 'provider usage 必须成为权威分子');
    assert.equal(info.lastActualInputTokens, 1000, 'lastActual = input + cacheRead');
    assert.equal(info.contextSource, 'provider_usage');
    assert.equal(info.pendingUncountedChanges, false);
  });

  it('displayMessages 作为下一请求投影切片时，分子采用该切片而不是完整历史', () => {
    const full = buildBigConversation();
    // 模拟调用方已持有的下一请求投影（如 Layer1 后的有效发送切片）。
    const sent = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ];
    const info = computeContextInfo({ messages: full, contextWindow: 200_000, displayMessages: sent });
    const projectedFromSent = computeContextInfo({ messages: sent, contextWindow: 200_000 });

    assert.equal(
      info.nextRequestInputTokens,
      projectedFromSent.nextRequestInputTokens,
      'displayMessages 是下一请求投影，不是 lastSent 历史缓存',
    );
    assert.ok(
      info.nextRequestInputTokens < computeContextInfo({ messages: full, contextWindow: 200_000 }).nextRequestInputTokens,
      '投影切片应小于完整历史',
    );
  });

  it('有 provider usage 时不再让本地估算制造第二套触发事实', () => {
    const full = buildBigConversation();
    const projected = computeContextInfo({ messages: full, contextWindow: 200_000 });
    const ratio = COMPACTION_CONFIG.triggerRatio;
    const windowAbove = Math.floor(projected.nextRequestInputTokens / ratio) - 1;
    const info = computeContextInfo({
      messages: full,
      contextWindow: windowAbove,
      usageSnapshot: { inputTokens: 500, cacheReadTokens: 0 },
    });
    assert.equal(info.nextRequestInputTokens, 500, 'provider usage 是唯一权威数值');
    assert.equal(info.compactionSuggested, false, '未精确计量的新内容不能伪装成估算触发');
    assert.equal(info.lastActualInputTokens, 500);
  });

  it('usage 高水位必须抬高上下文并触发压缩', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'short' },
      { role: 'assistant', content: 'ok' },
    ];
    const estimated = estimateTokensFromMessages(messages);
    const contextWindow = 100_000;
    const softLimit = Math.floor(contextWindow * COMPACTION_CONFIG.triggerRatio);
    assert.ok(estimated < softLimit, '本地估算必须低于 soft 线，才能验证 usage 不抬高路径');

    const usageTokens = softLimit + 1;
    const usageSnapshot = { inputTokens: usageTokens, cacheReadTokens: 0 };

    const budget = computeContextBudget({ messages, contextWindow, usageSnapshot });
    assert.equal(budget.estimatedTokens, estimated);
    assert.equal(budget.usageTokens, usageTokens);
    assert.equal(budget.contextTokens, usageTokens, '预算分子必须采用 provider usage');
    assert.equal(budget.overSoftLimit, true);
    assert.equal(budget.shouldCompact, true);

    const info = computeContextInfo({ messages, contextWindow, usageSnapshot });
    assert.equal(info.nextRequestInputTokens, usageTokens, '进度条分子 = provider usage');
    assert.equal(info.lastActualInputTokens, usageTokens);
    assert.equal(info.compactionSuggested, true, 'usage 高水位必须建议压缩');
  });

  it('runCompactionCheck 在 usage 高水位时触发压缩', async () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u'.repeat(200) },
      { role: 'assistant', content: 'a'.repeat(200) },
      { role: 'user', content: 'next' },
      { role: 'assistant', content: 'prev' },
      { role: 'user', content: 'again' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'latest' },
    ];
    const estimated = estimateTokensFromMessages(messages);
    const contextWindow = 10_000;
    const softLimit = Math.floor(contextWindow * COMPACTION_CONFIG.triggerRatio);
    assert.ok(estimated < softLimit, '本地估算未超 soft');

    const events = [];
    const result = await runCompactionCheck({
      messages,
      systemPrompt: 'sys',
      contextWindow,
      providerConfig: null,
      usageSnapshot: { inputTokens: softLimit + 50, cacheReadTokens: 0 },
      streamId: 's-usage',
      conversationId: 'c-usage',
      webContents: {
        send(channel, payload) {
          events.push({ channel, payload });
        },
      },
    });
    assert.equal(result.compacted, true, 'provider usage 越线时必须压缩');
    assert.equal(
      events.some((e) => e.channel === 'chat:compaction' && e.payload.stage === 'start'),
      true,
      '应发出压缩 start 横幅',
    );
  });

  it('回合结束后投影包含本轮新增 tool result 与 assistant 内容', () => {
    // 回归：getContextInfo 若仍用 lastSent（上一轮已发送切片），会漏掉本轮 tool/assistant。
    const beforeTurn = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'please inspect file' },
    ];
    const afterTurn = [
      ...beforeTurn,
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'tool-result-payload-' + 'z'.repeat(20_000) },
      { role: 'assistant', content: 'final answer after tools' },
    ];
    const tools = [
      {
        type: 'function',
        function: {
          name: 'bash',
          description: 'run shell',
          parameters: { type: 'object', properties: { command: { type: 'string' } } },
        },
      },
    ];

    const before = computeContextInfo({ messages: beforeTurn, contextWindow: 500_000, tools });
    const after = computeContextInfo({ messages: afterTurn, contextWindow: 500_000, tools });
    const lastSentOnly = computeContextInfo({
      messages: afterTurn,
      contextWindow: 500_000,
      tools,
      displayMessages: beforeTurn,
    });

    assert.ok(
      after.nextRequestInputTokens > before.nextRequestInputTokens + 4_000,
      `本轮 tool/assistant 必须抬高 nextRequest（before=${before.nextRequestInputTokens}, after=${after.nextRequestInputTokens}）`,
    );
    assert.equal(
      lastSentOnly.nextRequestInputTokens,
      before.nextRequestInputTokens,
      '若错误传入 lastSent 作为 displayMessages，会复现 10% 低估路径',
    );
    assert.ok(
      after.nextRequestInputTokens > lastSentOnly.nextRequestInputTokens,
      '当前 apiMessages 投影必须高于 lastSent 切片，堵住 47.5k/10% 低估',
    );
  });
});

describe('静默 microcompaction 与占用显示口径对齐', () => {
  function buildMicrocompactableConversation() {
    // 构造：旧 tool 结果很大，保留最近几条小消息。
    // microcompaction 会把旧 tool 结果压成预览，使有效发送量显著低于完整历史。
    const big = 'x'.repeat(12000);
    const messages = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 8; i++) {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: `t${i}`, type: 'function', function: { name: 'read', arguments: '{}' } }],
      });
      messages.push({ role: 'tool', tool_call_id: `t${i}`, content: `result-${i}-${big}` });
    }
    messages.push({ role: 'user', content: 'recent-user' });
    messages.push({ role: 'assistant', content: 'recent-assistant' });
    messages.push({ role: 'user', content: 'latest-question' });
    return messages;
  }

  it('runCompactionCheck：微压缩后返回并发布统一的下一请求输入量', async () => {
    const messages = buildMicrocompactableConversation();
    const fullEstimated = estimateTokensFromMessages(messages);
    const micro = applyMicrocompaction(messages).messages;
    const microEstimated = estimateTokensFromMessages(micro);
    assert.ok(microEstimated < fullEstimated * 0.5, '样本必须能被微压缩显著缩小');

    // 窗口选择约束：
    // 1) full > soft=0.8W  → 触发 preflight
    // 2) full < hard=0.95W 且 full < W → 避免 hard/overflow 强制语义压缩
    // 3) micro < soft → Layer1 后取消 Layer2
    // 取 W = full / 0.85，则 soft≈0.941 full，hard≈1.118 full，满足 1/2。
    const window = Math.floor(fullEstimated / 0.85);
    const soft = Math.floor(window * COMPACTION_CONFIG.triggerRatio);
    assert.ok(fullEstimated > soft, `完整历史应超过 soft: full=${fullEstimated} soft=${soft}`);
    assert.ok(fullEstimated < window, `完整历史应低于窗口: full=${fullEstimated} window=${window}`);
    assert.ok(microEstimated <= soft, `微压缩后应回到 soft 下: micro=${microEstimated} soft=${soft}`);

    const events = [];
    const result = await runCompactionCheck({
      messages,
      systemPrompt: 'sys',
      contextWindow: window,
      providerConfig: null,
      conversationId: 'c-micro',
      streamId: 's-micro',
      webContents: {
        send(channel, payload) {
          events.push({ channel, payload });
        },
      },
    });

    assert.equal(result.compacted, false, '微压缩回落后不应再做语义压缩');
    assert.equal(result.microcompacted, true, '应标记 microcompacted');
    assert.ok(Array.isArray(result.messages), '应返回有效消息');
    assert.notEqual(
      JSON.stringify(result.messages),
      JSON.stringify(messages),
      '返回消息应为微压缩后的有效上下文',
    );
    assert.ok(
      typeof result.nextRequestInputTokens === 'number' && result.nextRequestInputTokens > 0,
      '应回传有效 nextRequestInputTokens',
    );
    assert.equal(result.nextRequestInputTokens, microEstimated);
    assert.ok(
      result.nextRequestInputTokens < fullEstimated,
      `有效占用应低于完整历史: effective=${result.nextRequestInputTokens} full=${fullEstimated}`,
    );
    assert.ok(
      result.nextRequestInputTokens <= soft,
      `有效占用应回到 soft 线以下: effective=${result.nextRequestInputTokens} soft=${soft}`,
    );

    const idle = events.find((e) => e.channel === 'chat:compaction' && e.payload.stage === 'idle');
    assert.ok(idle, '应发送 chat:compaction idle 携带有效占用');
    assert.equal(idle.payload.microcompacted, true);
    assert.equal(idle.payload.nextRequestInputTokens, result.nextRequestInputTokens);
    assert.ok(
      !events.some((e) => e.channel === 'chat:compaction' && e.payload.stage === 'done'),
      '取消语义压缩时不应发 done 横幅',
    );
  });

  it('computeContextInfo：有 displayMessages 时显示口径采用有效发送切片，不被完整历史抬高', () => {
    const full = buildMicrocompactableConversation();
    const sent = applyMicrocompaction(full).messages;
    const info = computeContextInfo({
      messages: full,
      contextWindow: 200_000,
      displayMessages: sent,
      usageSnapshot: null,
    });
    assert.equal(info.nextRequestInputTokens, estimateTokensFromMessages(sent));
    assert.ok(info.nextRequestInputTokens < estimateTokensFromMessages(full));
  });
});


describe('P0 summary reserve + post-compact rehydration', () => {
  it('computeContextBudget reserves summary output and safety tokens in soft/hard limits', () => {
    const messages = [{ role: 'user', content: 'hello world' }];
    const contextWindow = 100_000;
    const budget = computeContextBudget({
      messages,
      contextWindow,
      maxOutputTokens: 8_000,
    });

    assert.ok(budget.reservedTokens > 0);
    assert.ok(budget.summaryOutputReserveTokens >= 1_000);
    assert.ok(budget.safetyReserveTokens >= 1_000);
    assert.equal(
      budget.effectiveContextWindow,
      contextWindow - budget.reservedTokens,
    );
    // 公开 soft/hard 线仍按完整窗口计算，保证进度条与既有阈值契约稳定。
    assert.equal(
      budget.softLimit,
      Math.floor(contextWindow * COMPACTION_CONFIG.triggerRatio),
    );
    assert.equal(
      budget.hardLimit,
      Math.floor(contextWindow * Math.max(COMPACTION_CONFIG.triggerRatio, COMPACTION_CONFIG.hardRatio)),
    );
    // 摘要预留体现在 effectiveContextWindow，并在剩余不足时通过 overSummaryHeadroom 提前触发。
    assert.ok(budget.effectiveContextWindow < contextWindow);
    assert.equal(budget.overSummaryHeadroom, false);
  });

  it('runCompactionCheck rehydrates system prompt via rebuildSystemPrompt after compact', async () => {
    // 用足够大的本地估算 + 很小的 window，确保 threshold 路径一定进入语义压缩。
    const oldBlob = 'history-token-pressure-'.repeat(800);
    const messages = [
      { role: 'system', content: 'OLD_SYSTEM' },
      { role: 'user', content: oldBlob },
      { role: 'assistant', content: oldBlob },
      { role: 'user', content: oldBlob },
      { role: 'assistant', content: oldBlob },
      { role: 'user', content: 'current question' },
    ];
    const estimated = estimateTokensFromMessages(messages);
    const contextWindow = Math.max(200, Math.floor(estimated / 2));

    let rebuildCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'summary of prior work' } }],
      }),
      text: async () => '',
    });

    try {
      const result = await runCompactionCheck({
        messages,
        systemPrompt: 'OLD_SYSTEM',
        contextWindow,
        providerConfig: {
          provider: 'openai',
          baseUrl: 'https://example.test',
          apiKey: 'k',
          model: 'test-model',
          maxOutputTokens: 1024,
        },
        force: true,
        preserveLatestUserTurn: true,
        rebuildSystemPrompt: async ({ reason }) => {
          rebuildCalls += 1;
          assert.match(String(reason), /post-(force|emergency)?-?compact|post-compact|post-force-compact|post-emergency-compact/);
          return 'REHYDRATED_SYSTEM_WITH_GOAL_STATE';
        },
        webContents: { send() {} },
      });

      assert.equal(result.compacted, true, `expected compacted=true, got ${JSON.stringify({
        compacted: result.compacted,
        microcompacted: result.compactResult?.microcompacted,
        notification: result.compactResult?.notification,
      })}`);
      assert.equal(rebuildCalls, 1);
      assert.equal(result.rehydrated, true);
      assert.equal(result.systemPrompt, 'REHYDRATED_SYSTEM_WITH_GOAL_STATE');
      assert.equal(result.messages[0].role, 'system');
      assert.equal(result.messages[0].content, 'REHYDRATED_SYSTEM_WITH_GOAL_STATE');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rehydrateSystemPromptAfterCompaction falls back when rebuild hook is missing', async () => {
    const result = await rehydrateSystemPromptAfterCompaction({
      systemPrompt: 'KEEP',
      rebuildSystemPrompt: null,
    });
    assert.equal(result.systemPrompt, 'KEEP');
    assert.equal(result.rehydrated, false);
    assert.equal(result.reason, 'no_rebuild_hook');
  });
});
