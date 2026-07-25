import {
  createContextAccountingCompactionPipeline,
  createContextProjectionLifecycle,
  parseContextOverflowEvidence,
} from '@peer-agent/runtime-core';
import {
  applyMicrocompaction,
  computeContextInfo,
  runCompactionCheck,
} from './compaction-coordinator.mjs';

/**
 * Desktop provider 请求前的唯一协调入口。
 *
 * 所有 provider loop 都必须在真正调用传输 adapter 前经过这里。压缩判定和
 * request_preflight 投影因此读取同一份 Runtime messages/tools/contextWindow；
 * provider 只负责把压缩结果映射回自身的 system/messages 形态。
 */
export async function coordinateDesktopProviderRequest({
  messages,
  systemPrompt,
  contextWindow,
  providerConfig,
  signal,
  persistCompaction,
  conversationId,
  streamId,
  webContents,
  continuityContext = [],
  tools = null,
  preserveLatestUserTurn = true,
  usageSnapshot = null,
  rebuildSystemPrompt = null,
  force = false,
  emergency = false,
  // 21 号文档第十三章：优先复用 kernel 的 per-turn 生命周期，使同一 turn 内
  // preflight / post_compaction / tool_result / turn_complete 共用单调 revision。
  // 未注入时回退临时实例（仅供返回值，不对外发布）。
  contextLifecycle = null,
}) {
  const sourceMessages = Array.isArray(messages) ? messages : [];
  const compaction = await runCompactionCheck({
    messages: sourceMessages,
    systemPrompt,
    contextWindow,
    providerConfig,
    signal,
    persistCompaction,
    conversationId,
    streamId,
    webContents,
    continuityContext,
    tools,
    preserveLatestUserTurn,
    usageSnapshot,
    rebuildSystemPrompt,
    force,
    emergency,
  });

  const effectiveMessages = Array.isArray(compaction.messages)
    ? compaction.messages
    : sourceMessages;
  const projectedMessages = applyMicrocompaction(effectiveMessages, { log: () => {} }).messages;
  const contextInfo = computeContextInfo({
    messages: effectiveMessages,
    displayMessages: projectedMessages,
    contextWindow,
    tools,
    usageSnapshot,
  });
  const lifecycle = contextLifecycle ?? createContextProjectionLifecycle();
  const projectionInput = {
    messages: projectedMessages,
    tools,
    contextWindow,
    currentInputTokens: contextInfo.lastActualInputTokens,
  };
  // 压缩刚完成时先发 post_compaction 稳定投影（回落信号），再发本次请求的
  // request_preflight；未压缩时只发 request_preflight。
  if (compaction.compacted) {
    lifecycle.postCompaction({ ...projectionInput, reason: 'post_compaction' });
  }
  const projection = lifecycle.requestPreflight({
    ...projectionInput,
    reason: compaction.compacted
      ? 'post_compaction_request_preflight'
      : compaction.microcompacted
        ? 'post_microcompaction_request_preflight'
        : 'request_preflight',
  });

  return Object.freeze({
    ...compaction,
    compaction,
    messages: effectiveMessages,
    projectedMessages,
    contextInfo,
    projection,
  });
}

/**
 * Desktop provider 请求的共享执行入口。
 *
 * runtime-core 拥有 build -> count/observe -> decide -> compact -> rebuild ->
 * send -> observe -> overflow retry 的状态机；这里仅适配 Desktop 的消息形态、
 * compactor 与 provider transport。
 */
export async function executeDesktopProviderRequest({
  request,
  send,
  compactRequest = coordinateDesktopProviderRequest,
  getUsage = (response) => response?.streamUsage ?? null,
  buildCanonicalRequest = ({ messages, systemPrompt, tools, model }) => ({
    messages,
    systemPrompt,
    tools,
    model,
  }),
}) {
  const sourceMessages = Array.isArray(request?.messages) ? request.messages : [];
  const sourceSystemPrompt = typeof request?.systemPrompt === 'string'
    ? request.systemPrompt
    : '';
  const pipeline = createContextAccountingCompactionPipeline({
    contextWindow: request?.contextWindow,
    countCapability: { kind: 'observed_usage_only' },
    buildRequest(state) {
      const projectedMessages = applyMicrocompaction(state.messages, { log: () => {} }).messages;
      return buildCanonicalRequest({
        messages: projectedMessages,
        systemPrompt: state.systemPrompt,
        tools: request?.tools ?? null,
        model: request?.providerConfig?.model ?? null,
      });
    },
    async compact({ state, reason, emergency }) {
      const result = await compactRequest({
        ...request,
        messages: state.messages,
        systemPrompt: state.systemPrompt,
        usageSnapshot: null,
        force: true,
        emergency: emergency || reason === 'provider_overflow',
        // The shared pipeline publishes the external lifecycle once after the
        // canonical request has been rebuilt; suppress the legacy coordinator's
        // duplicate lifecycle emission inside the strategy adapter.
        contextLifecycle: null,
      });
      if (!result?.compacted) return { compacted: false, state };
      return {
        compacted: true,
        state: {
          messages: Array.isArray(result.messages) ? result.messages : state.messages,
          systemPrompt:
            typeof result.systemPrompt === 'string' && result.systemPrompt.trim()
              ? result.systemPrompt
              : state.systemPrompt,
        },
      };
    },
    send,
    getUsage,
    getOverflow(response) {
      if (response?.ok !== false) return null;
      return parseContextOverflowEvidence({
        status: response.status,
        errorText: response.errorText ?? '',
      });
    },
  });
  const accounting = await pipeline.execute({
    state: {
      messages: sourceMessages,
      systemPrompt: sourceSystemPrompt,
    },
    ...(request?.usageSnapshot ? { lastObservedUsage: request.usageSnapshot } : {}),
  });
  const finalMessages = accounting.state.messages;
  const projectedMessages = accounting.request.messages;
  const contextInfo = computeContextInfo({
    messages: finalMessages,
    displayMessages: projectedMessages,
    contextWindow: request?.contextWindow,
    tools: request?.tools,
    usageSnapshot: getUsage(accounting.response),
  });
  const lifecycle = request?.contextLifecycle ?? createContextProjectionLifecycle();
  const projectionInput = {
    messages: projectedMessages,
    tools: request?.tools,
    contextWindow: request?.contextWindow,
    currentInputTokens: accounting.snapshot.authoritativeInputTokens,
  };
  if (accounting.compacted) {
    lifecycle.postCompaction({ ...projectionInput, reason: 'post_compaction' });
  }
  const projection = lifecycle.requestPreflight({
    ...projectionInput,
    reason: accounting.retriedAfterOverflow
      ? 'post_overflow_retry'
      : accounting.compacted
        ? 'post_compaction_request_preflight'
        : 'request_preflight',
  });
  return Object.freeze({
    ...accounting,
    response: accounting.response,
    messages: finalMessages,
    systemPrompt: accounting.state.systemPrompt,
    projectedMessages,
    contextInfo,
    projection,
  });
}
