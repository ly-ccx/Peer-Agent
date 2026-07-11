import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyMicrocompaction,
  buildCompactionProviderConfig,
  buildPromptTooLongRecoveryError,
  computeContextBudget,
  computeContextInfo,
  contextTokensFromUsageSnapshot,
  CONTEXT_BUDGET_GUARD,
  isPromptTooLongResponse,
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
    assert.equal(isPromptTooLongResponse(500, 'temporary outage'), false);
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
    const hardWindow = Math.floor(totalTokens / CONTEXT_BUDGET_GUARD.hardRatio) - 1;
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
      persistCompaction: async () => {
        ordering.push('persist');
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
    assert.deepEqual(ordering, ['persist', 'done']);
    assert.equal(done.contextWindow, 200_000);
    assert.equal(
      done.contextTokens,
      estimateTokensFromMessages(result.messages) + estimateToolsTokens(tools),
      'done snapshot must use the same messages + tool schema budget as the context meter',
    );
    assert.ok(done.contextTokens > done.afterTokens, 'tool schema tokens must not be omitted');
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
    assert.equal(info.contextTokens, estimateTokensFromMessages(messages));
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
    assert.equal(withTools.contextTokens, withoutTools.contextTokens + toolTokens);
  });

  it('compactionSuggested 用与 shouldCompact 完全相同的 triggerRatio 阈值线', () => {
    const tokens = estimateTokensFromMessages(messages);
    const ratio = COMPACTION_CONFIG.triggerRatio;
    // 阈值线正下方（未越线）：不建议压缩。+1 是为了避开恰好相等的边界。
    const windowBelow = Math.ceil(tokens / ratio) + 1;
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
    assert.equal(computeContextInfo({ messages: null, contextWindow: 100_000 }).contextTokens, 0);
    assert.equal(computeContextInfo({ messages: undefined, contextWindow: 100_000 }).contextTokens, 0);
  });
});

// 方案 A（完整会话量口径）回归：进度条分子 / 压缩触发 / done 权威快照统一按「完整会话量」计算，
// 不再按微压缩后的发送副本计算。这些用例锁定 agent-loop 重构所依赖的两条不变量，防止回归到
// 「流式 ~200k 结束瞬间掉到 ~100k」的旧 bug。
describe('方案 A：完整会话量口径不变量', () => {
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

    // 入参对象与每个元素都不被原地改动：方案 A 据此保留完整 apiMessages 仅作度量，
    // 另用返回的发送副本发给 provider。
    assert.equal(JSON.stringify(messages), snapshot, 'applyMicrocompaction 不应原地修改入参 messages');
    assert.notEqual(result.messages, messages, '应返回新的数组而非原数组');
    assert.ok(result.stats.compactedCount > 0, '本样本应至少触发一次微压缩，用例才有意义');
  });

  it('完整集合的 contextTokens 显著大于微压缩后集合（这正是旧 bug 跳变的来源）', () => {
    const full = buildConversationWithBigToolResults();
    const sent = applyMicrocompaction(full).messages;

    const fullInfo = computeContextInfo({ messages: full, contextWindow: 200_000 });
    const sentInfo = computeContextInfo({ messages: sent, contextWindow: 200_000 });

    // 方案 A：进度条与触发都按 full 计算（更大、更安全）；旧实现误按 sent 计算，
    // 于是回合结束 done 快照从 full 掉到 sent，产生用户观察到的瞬间下降。
    assert.ok(
      fullInfo.contextTokens > sentInfo.contextTokens,
      `完整集合估算(${fullInfo.contextTokens}) 应大于微压缩后(${sentInfo.contextTokens})`,
    );
  });

  it('bar ≡ trigger：done 权威 contextTokens 与压缩触发判定来自同一完整集合', () => {
    const full = buildConversationWithBigToolResults();
    // 选一个窗口，使完整集合刚好越过触发线：证明「进度条所用数值」与「是否触发压缩」同源。
    const fullTokens = computeContextInfo({ messages: full, contextWindow: 200_000 }).contextTokens;
    const ratio = COMPACTION_CONFIG.triggerRatio;
    const windowAbove = Math.floor(fullTokens / ratio) - 1; // 阈值 < fullTokens ⇒ 触发
    const windowBelow = Math.ceil(fullTokens / ratio) + 1; // 阈值 > fullTokens ⇒ 不触发

    const above = computeContextInfo({ messages: full, contextWindow: windowAbove });
    const below = computeContextInfo({ messages: full, contextWindow: windowBelow });

    assert.equal(above.contextTokens, fullTokens, '触发判定所用的 contextTokens 必须就是进度条分子');
    assert.equal(above.compactionSuggested, true);
    assert.equal(below.contextTokens, fullTokens);
    assert.equal(below.compactionSuggested, false);
  });
});

describe('ADR 42：显示口径与压缩触发口径分离', () => {
  // 本地构造一段「完整会话量很大」的消息（含多条大 tool 结果），用于对比显示口径与触发口径。
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

  it('显示口径优先采用 provider usage 快照，且远小于完整会话触发口径', () => {
    const full = buildBigConversation();
    // 真实场景：压缩后实际发送量很小，provider usage 快照体现这一点。
    const usageSnapshot = { inputTokens: 800, outputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 200 };
    const info = computeContextInfo({ messages: full, contextWindow: 200_000, usageSnapshot });

    // 显示口径 = usage 快照的 input+cacheRead = 1000，反映实际发送上下文（压缩后回落）。
    assert.equal(info.contextTokens, 1000, '有 usage 快照时 contextTokens 必须采用显示口径');
    // 触发口径仍按完整会话集合估算，显著大于显示口径。
    const fullTokens = estimateTokensFromMessages(full);
    assert.ok(
      info.triggerTokens >= fullTokens,
      `触发口径(${info.triggerTokens}) 应基于完整会话(${fullTokens})，不受 usage 快照影响`,
    );
    assert.ok(
      info.contextTokens < info.triggerTokens,
      `显示口径(${info.contextTokens}) 应远小于触发口径(${info.triggerTokens})——这正是压缩后能回落的关键`,
    );
  });

  it('无 usage 快照但有 displayMessages 时，显示口径按发送切片估算（小于完整集合）', () => {
    const full = buildBigConversation();
    const sent = applyMicrocompaction(full).messages;
    const info = computeContextInfo({ messages: full, contextWindow: 200_000, displayMessages: sent });

    assert.equal(
      info.contextTokens,
      estimateTokensFromMessages(sent),
      '无 usage 时显示口径 = 对发送切片 displayMessages 的估算',
    );
    assert.ok(
      info.contextTokens < info.triggerTokens,
      '发送切片显示口径应小于完整会话触发口径',
    );
  });

  it('压缩触发判定只看触发口径：显示口径再小也不能压制该压缩的建议', () => {
    const full = buildBigConversation();
    const fullTokens = estimateTokensFromMessages(full);
    const ratio = COMPACTION_CONFIG.triggerRatio;
    const windowAbove = Math.floor(fullTokens / ratio) - 1; // 完整集合越过触发线
    // 即便显示口径很小（usage 快照仅 500），compactionSuggested 仍必须为 true。
    const info = computeContextInfo({
      messages: full,
      contextWindow: windowAbove,
      usageSnapshot: { inputTokens: 500, cacheReadTokens: 0 },
    });
    assert.equal(info.contextTokens, 500, '显示口径采用 usage 快照');
    assert.equal(info.compactionSuggested, true, '触发判定按完整会话口径，不被小显示口径压制');
  });
});
