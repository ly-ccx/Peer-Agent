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
    assert.equal(done.conversationId, 'c1');
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

// microcompaction 预算回归：原始集合与 Layer 1 后集合是两个明确阶段；主圆环应投影
// 当前阶段真正用于下一步压缩判定的 triggerTokens，而不是混入 contextTokens。
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

  it('完整集合的 triggerTokens 显著大于微压缩后集合', () => {
    const full = buildConversationWithBigToolResults();
    const sent = applyMicrocompaction(full).messages;

    const fullInfo = computeContextInfo({ messages: full, contextWindow: 200_000 });
    const sentInfo = computeContextInfo({ messages: sent, contextWindow: 200_000 });

    assert.ok(
      fullInfo.triggerTokens > sentInfo.triggerTokens,
      `完整集合预算(${fullInfo.triggerTokens}) 应大于微压缩后(${sentInfo.triggerTokens})`,
    );
  });

  it('主圆环 triggerTokens 与压缩建议来自同一预算', () => {
    const full = buildConversationWithBigToolResults();
    const fullTokens = computeContextInfo({ messages: full, contextWindow: 200_000 }).triggerTokens;
    const ratio = COMPACTION_CONFIG.triggerRatio;
    const windowAbove = Math.floor(fullTokens / ratio) - 1; // 阈值 < fullTokens ⇒ 触发
    const windowBelow = Math.ceil(fullTokens / ratio) + 1; // 阈值 > fullTokens ⇒ 不触发

    const above = computeContextInfo({ messages: full, contextWindow: windowAbove });
    const below = computeContextInfo({ messages: full, contextWindow: windowBelow });

    assert.equal(above.triggerTokens, fullTokens, '主圆环分子必须就是触发判定预算');
    assert.equal(above.compactionSuggested, true);
    assert.equal(below.triggerTokens, fullTokens);
    assert.equal(below.compactionSuggested, false);
  });
});

describe('实际发送口径与压缩触发口径分离', () => {
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

  it('显示口径优先采用 provider usage 快照；触发取 max(估算, usage)', () => {
    const full = buildBigConversation();
    // 真实场景：压缩后实际发送量很小，provider usage 快照体现这一点。
    const usageSnapshot = { inputTokens: 800, outputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 200 };
    const info = computeContextInfo({ messages: full, contextWindow: 200_000, usageSnapshot });

    // 显示口径 = usage 快照的 input+cacheRead = 1000，反映实际发送上下文（压缩后回落）。
    assert.equal(info.contextTokens, 1000, '有 usage 快照时 contextTokens 必须采用显示口径');
    // 触发口径 = max(完整会话估算, usage)；此处估算更大。
    const fullTokens = estimateTokensFromMessages(full);
    assert.equal(
      info.triggerTokens,
      Math.max(fullTokens, 1000),
      `触发口径(${info.triggerTokens}) 应是 max(完整会话估算 ${fullTokens}, usage 1000)`,
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

  it('压缩触发判定：小显示口径不能压制「估算已越线」的建议', () => {
    const full = buildBigConversation();
    const fullTokens = estimateTokensFromMessages(full);
    const ratio = COMPACTION_CONFIG.triggerRatio;
    const windowAbove = Math.floor(fullTokens / ratio) - 1; // 完整集合越过触发线
    // 即便显示口径很小（usage 快照仅 500），估算已越线时 compactionSuggested 仍必须为 true。
    const info = computeContextInfo({
      messages: full,
      contextWindow: windowAbove,
      usageSnapshot: { inputTokens: 500, cacheReadTokens: 0 },
    });
    assert.equal(info.contextTokens, 500, '显示口径采用 usage 快照');
    assert.equal(info.compactionSuggested, true, '估算已越 soft 线时仍建议压缩，不被小显示口径压制');
  });

  it('usage 高水位触发：本地估算未超 soft 线但真实 usage 已超时，预算与建议均触发', () => {
    // 模拟用户截图场景：本地估算偏低，进度条 usage 已接近满窗。
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'short' },
      { role: 'assistant', content: 'ok' },
    ];
    const estimated = estimateTokensFromMessages(messages);
    const contextWindow = 100_000;
    const softLimit = Math.floor(contextWindow * COMPACTION_CONFIG.triggerRatio);
    assert.ok(estimated < softLimit, '本地估算必须低于 soft 线，才能验证 usage 路径');

    // usage 越过 soft 线但未到 hard 线（0.95），应走 soft 触发而非 force/emergency。
    const usageTokens = softLimit + 1;
    const usageSnapshot = { inputTokens: usageTokens, cacheReadTokens: 0 };

    const budget = computeContextBudget({ messages, contextWindow, usageSnapshot });
    assert.equal(budget.estimatedTokens, estimated);
    assert.equal(budget.usageTokens, usageTokens);
    assert.equal(budget.contextTokens, usageTokens, '触发量取 max(估算, usage)');
    assert.equal(budget.overSoftLimit, true);
    assert.equal(budget.shouldCompact, true);
    assert.equal(budget.force, false, '仅 soft 越线不应 force');
    assert.equal(budget.emergency, false, '仅 soft 越线不应 emergency');

    const info = computeContextInfo({ messages, contextWindow, usageSnapshot });
    assert.equal(info.contextTokens, usageTokens, '进度条显示 usage');
    assert.equal(info.triggerTokens, usageTokens, '触发与显示同源（均为 usage 高水位）');
    assert.equal(info.compactionSuggested, true, 'usage 过 soft 线时必须建议压缩');
  });

  it('runCompactionCheck 在 usage 高水位时也会走 threshold 路径（即便估算未超）', async () => {
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

    // 无 providerConfig 时走结构化/fallback 路径，但必须真正 compacted。
    assert.equal(result.compacted, true, 'usage 过 soft 线必须触发压缩');
    assert.ok(
      events.some((e) => e.channel === 'chat:compaction' && e.payload.stage === 'start'),
      '应发出压缩 start 横幅',
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

  it('runCompactionCheck：微压缩把占用压回 soft 线后取消语义压缩，但仍返回有效消息并上报 contextTokens', async () => {
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
      typeof result.contextTokens === 'number' && result.contextTokens > 0,
      '应回传有效 contextTokens',
    );
    assert.ok(
      result.contextTokens < fullEstimated,
      `有效占用应低于完整历史: effective=${result.contextTokens} full=${fullEstimated}`,
    );
    assert.ok(
      result.contextTokens <= soft,
      `有效占用应回到 soft 线以下: effective=${result.contextTokens} soft=${soft}`,
    );

    const idle = events.find((e) => e.channel === 'chat:compaction' && e.payload.stage === 'idle');
    assert.ok(idle, '应发送 chat:compaction idle 携带有效占用');
    assert.equal(idle.payload.microcompacted, true);
    assert.equal(idle.payload.contextTokens, result.contextTokens);
    assert.equal(result.triggerTokens, microEstimated);
    assert.equal(
      idle.payload.triggerTokens,
      microEstimated,
      'UI 压力圆环必须收到 Layer 1 后真正参与语义压缩判定的 triggerTokens',
    );
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
    assert.equal(info.contextTokens, estimateTokensFromMessages(sent));
    assert.ok(info.contextTokens < estimateTokensFromMessages(full));
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
      Math.floor(contextWindow * Math.max(COMPACTION_CONFIG.triggerRatio, CONTEXT_BUDGET_GUARD.hardRatio)),
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
