import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  applyMicrocompaction,
  buildCompactionProviderConfig,
  buildPromptTooLongRecoveryError,
  computeContextBudget,
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

  it('emits compaction diagnostics only after transcript persistence succeeds', async () => {
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
    assert.equal('contextWindow' in done, false);
    assert.equal('nextRequestInputTokens' in done, false);
  });

  it('rethrows when a compacted persist fails and preserves a failed terminal state', async () => {
    // 大量消息 + force 触发结构化压缩 (compacted:true);persistCompaction 抛错。
    // 回归点:错误必须向上抛出，主进程必须发布可解释 failed，而不是 finally 清成 idle。
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
    assert.equal(stages.at(-1), 'failed');
    const failed = events.findLast(
      (event) => event.channel === 'chat:compaction' && event.payload.stage === 'failed',
    )?.payload;
    assert.equal(failed.conversationId, 'c1');
    assert.equal(failed.errorCode, 'CONTEXT_COMPACTION_PERSIST_FAILED');
    assert.match(failed.message, /persist boom/);
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
    const projected = applyMicrocompaction(full).messages;
    assert.deepEqual(projected, sent);
  });

  it('压缩建议与下一请求输入量来自同一预算', () => {
    const full = buildConversationWithBigToolResults();
    const projected = applyMicrocompaction(full).messages;
    const projectedTokens = estimateTokensFromMessages(projected);
    const ratio = COMPACTION_CONFIG.triggerRatio;
    const windowAbove = Math.floor(projectedTokens / ratio) - 1;
    const windowBelow = Math.ceil(projectedTokens / ratio) + 1;

    const above = computeContextBudget({ messages: projected, contextWindow: windowAbove });
    const below = computeContextBudget({ messages: projected, contextWindow: windowBelow });

    assert.equal(above.contextTokens, projectedTokens);
    assert.equal(above.overSoftLimit, true);
    assert.equal(below.contextTokens, projectedTokens);
    assert.equal(below.overSoftLimit, false);
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
    const budget = computeContextBudget({
      messages: full,
      contextWindow: 200_000,
      usageSnapshot,
    });
    assert.equal(budget.contextTokens, 1000, 'provider usage 必须成为权威分子');
    assert.equal(budget.usageTokens, 1000, 'usage = input + cacheRead');
    assert.equal(budget.contextSource, 'provider_usage');
  });

  it('有 provider usage 时不再让本地估算制造第二套触发事实', () => {
    const full = buildBigConversation();
    const projectedMessages = applyMicrocompaction(full).messages;
    const projected = computeContextBudget({
      messages: projectedMessages,
      contextWindow: 200_000,
    });
    const ratio = COMPACTION_CONFIG.triggerRatio;
    const windowAbove = Math.floor(projected.contextTokens / ratio) - 1;
    const budget = computeContextBudget({
      messages: projectedMessages,
      contextWindow: windowAbove,
      usageSnapshot: { inputTokens: 500, cacheReadTokens: 0 },
    });
    assert.equal(budget.contextTokens, 500, 'provider usage 是唯一权威数值');
    assert.equal(budget.shouldCompact, false, '未精确计量的新内容不能伪装成估算触发');
    assert.equal(budget.usageTokens, 500);
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

    const before = computeContextBudget({
      messages: applyMicrocompaction(beforeTurn).messages,
      contextWindow: 500_000,
      tools,
    });
    const after = computeContextBudget({
      messages: applyMicrocompaction(afterTurn).messages,
      contextWindow: 500_000,
      tools,
    });

    assert.ok(
      after.contextTokens > before.contextTokens + 4_000,
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

  it('runCompactionCheck：微压缩后只返回有效消息，不发布第二套容量状态', async () => {
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
    assert.equal(estimateTokensFromMessages(result.messages), microEstimated);
    assert.equal('nextRequestInputTokens' in result, false);
    assert.equal('contextWindow' in result, false);

    const idle = events.find((e) => e.channel === 'chat:compaction' && e.payload.stage === 'idle');
    assert.ok(idle, '应发送 chat:compaction idle 收尾横幅');
    assert.equal(idle.payload.microcompacted, true);
    assert.equal('nextRequestInputTokens' in idle.payload, false);
    assert.equal('contextWindow' in idle.payload, false);
    assert.ok(
      !events.some((e) => e.channel === 'chat:compaction' && e.payload.stage === 'done'),
      '取消语义压缩时不应发 done 横幅',
    );
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

describe('Milestone C Goal checkpoint transaction wiring', () => {
  it('runCompactionCheck source wires prepare/commit and mark persisted', () => {
    const source = readFileSync(new URL('./compaction-coordinator.mjs', import.meta.url), 'utf8');
    assert.match(source, /prepareContextCheckpoint/);
    assert.match(source, /commitContextCheckpoint/);
    assert.match(source, /markContextCompactionPersisted/);
    assert.match(source, /willAttemptLayer2/);
  });
});

